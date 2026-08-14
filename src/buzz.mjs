// 投稿生成の直前に「今バズっている投稿」をリサーチする。
// 優先順位:
//   0) 本日分のキャッシュ(outbox/buzz-cache.json)があればそれを使う（調査は1日1回だけ）
//   1) Threads公式のキーワード検索API（無料・実際の人気投稿。要 threads_keyword_search 権限）
//   2) OpenAIのWeb検索（有料のフォールバック。調査は安いモデルで行う）
// すべて失敗したら null を返し、呼び出し側はリサーチなしで生成を続行する（生成は止めない）。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import { ROOT } from './config.mjs';

// 調査は本文より知性が要らないので安いモデルで十分（本文生成は OPENAI_MODEL）
const RESEARCH_MODEL = process.env.BUZZ_MODEL || 'gpt-4o-mini';
const CACHE_PATH = join(ROOT, 'outbox', 'buzz-cache.json');

// JSTの日付文字列（キャッシュのキー。夕方18時と夜21時は同じ日付になる）
function jstDate() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function readCache() {
  try {
    const c = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (c.date === jstDate() && c.text) return c;
  } catch {}
  return null;
}

// --- 1) Threads公式キーワード検索（無料・生の人気投稿）---
// ※クエリはスペースなしの単語のみ有効（「AI 副業」のような複合語は0件になる）。
//   1語あたりの取得数が少ないため、5件集まるまで複数キーワードを合算する。
async function searchThreadsPosts() {
  const TOKEN = process.env.THREADS_ACCESS_TOKEN;
  if (!TOKEN) return null;
  const queries = ['AI副業', '副業', 'ChatGPT', '在宅ワーク'];
  const start = new Date().getUTCDate() % queries.length; // 日替わりで開始キーワードを回す
  const posts = [];
  const usedQueries = [];
  const seen = new Set();
  for (let i = 0; i < queries.length && posts.length < 5; i++) {
    const q = queries[(start + i) % queries.length];
    const url =
      `https://graph.threads.net/v1.0/keyword_search?q=${encodeURIComponent(q)}` +
      `&search_type=TOP&fields=id,text,username&limit=15&access_token=${TOKEN}`;
    const res = await (await fetch(url)).json();
    if (res.error || !Array.isArray(res.data)) {
      console.log(
        `🔎 Threads内検索エラー(${q}: ${res.error?.message || '不明'}) → Web検索にフォールバック`,
      );
      return null;
    }
    usedQueries.push(q);
    for (const p of res.data) {
      const t = (p.text || '').trim();
      if (t.length < 40) continue; // 短すぎる投稿は参考にならない
      if (p.username === 'aiwith_aris') continue; // 自分の投稿は除外
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      posts.push({ u: p.username, t });
      if (posts.length >= 5) break;
    }
  }
  if (!posts.length) return null;
  return (
    `【Threads内で「${usedQueries.join('」「')}」の上位表示投稿（実物・本日取得）】\n` +
    posts
      .map((p, i) => `--- 実例${i + 1}（@${p.u}）\n${p.t.slice(0, 300)}`)
      .join('\n')
  );
}

// --- 2) Web検索フォールバック（OpenAIのweb_search組み込みツール・Responses API）---
async function webResearch(theme) {
  const openai = new OpenAI();
  const prompt = `あなたはSNSグロースのリサーチャーです。Web検索を使って、日本語のThreads（Meta社のSNS）で「今」伸びている投稿を調べてください。

対象ジャンル: AI活用 × 副業（初心者向け）／在宅ワーク／ChatGPT活用術
今日の投稿テーマ: ${theme}

調べること:
1. 対象ジャンルで最近バズった投稿の「1行目（フック）」の実例を3〜5個（出典アカウント名があれば併記）
2. それらの構成・リズムの特徴（改行の仕方 締め方 絵文字の使い方）
3. 今このジャンルで話題になっているキーワードや切り口を2〜3個

出力ルール:
- この回答はそのまま別のAI（投稿ライター）に資料として渡します 前置きや感想は書かない
- 箇条書きで簡潔に 全体で500字以内
- 実例が見つからない項目は無理に埋めず「見つからず」と書く`;

  try {
    // Responses APIの組み込みweb_searchツール。検索の実行はモデル側で完結する。
    const res = await openai.responses.create({
      model: RESEARCH_MODEL,
      tools: [{ type: 'web_search_preview' }],
      max_output_tokens: 2500,
      input: prompt,
    });

    const text = (res.output_text || '').trim();
    if (!text)
      console.log(`🔎 Web検索リサーチ: 応答が空(status=${res.status})`);
    return text || null;
  } catch (e) {
    console.log('🔎 Web検索リサーチ失敗: ' + e.message);
    return null;
  }
}

export async function getBuzzExamples(theme) {
  const cached = readCache();
  if (cached) {
    console.log(`🔎 バズ調査: 本日分のキャッシュを再利用（取得元: ${cached.source}）`);
    return cached.text;
  }

  let source = 'threads';
  let text = null;
  try {
    text = await searchThreadsPosts();
  } catch (e) {
    console.log('🔎 Threads内検索エラー: ' + e.message);
  }
  if (!text) {
    source = 'web';
    text = await webResearch(theme);
  }
  if (!text) {
    console.log('🔎 バズ調査は全滅 → リサーチなしで生成を続行');
    return null;
  }

  try {
    writeFileSync(CACHE_PATH, JSON.stringify({ date: jstDate(), source, text }, null, 2));
  } catch {}
  console.log(`🔎 バズ実例（取得元: ${source}）:\n${text}\n`);
  return text;
}
