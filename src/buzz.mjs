// 投稿生成の直前に「今バズっている投稿」をリサーチする。
// 優先順位:
//   0) 本日分のキャッシュ(outbox/buzz-cache.json)があればそれを使う（調査は1日1回だけ）
//   1) Threads公式のキーワード検索API（無料・実際の人気投稿。要 threads_keyword_search 権限）
//   2) ClaudeのWeb検索（有料のフォールバック。調査は安いSonnet 5で行う）
// すべて失敗したら null を返し、呼び出し側はリサーチなしで生成を続行する（生成は止めない）。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { ROOT } from './config.mjs';

// 調査は本文より知性が要らないので安いモデルで十分（本文生成は従来どおり ANTHROPIC_MODEL）
const RESEARCH_MODEL = process.env.BUZZ_MODEL || 'claude-sonnet-5';
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
async function searchThreadsPosts() {
  const TOKEN = process.env.THREADS_ACCESS_TOKEN;
  if (!TOKEN) return null;
  const queries = ['AI 副業', '副業 初心者', 'ChatGPT 活用', '在宅ワーク'];
  const q = queries[new Date().getUTCDate() % queries.length]; // 日替わりでキーワードを回す
  const url =
    `https://graph.threads.net/v1.0/keyword_search?q=${encodeURIComponent(q)}` +
    `&search_type=TOP&fields=id,text,username&limit=15&access_token=${TOKEN}`;
  const res = await (await fetch(url)).json();
  if (res.error || !Array.isArray(res.data)) {
    console.log(
      `🔎 Threads内検索は使えず(${res.error?.message || '不明'}) → Web検索にフォールバック`,
    );
    return null;
  }
  const posts = res.data
    .map((p) => ({ u: p.username, t: (p.text || '').trim() }))
    .filter((p) => p.t.length >= 40) // 短すぎる投稿は参考にならないので除外
    .slice(0, 5);
  if (!posts.length) return null;
  return (
    `【Threads内で「${q}」の上位表示投稿（実物・本日取得）】\n` +
    posts
      .map((p, i) => `--- 実例${i + 1}（@${p.u}）\n${p.t.slice(0, 300)}`)
      .join('\n')
  );
}

// --- 2) Web検索フォールバック（Claudeのweb_searchサーバーツール・Sonnet 5）---
async function webResearch(theme) {
  const anthropic = new Anthropic();
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
    let messages = [{ role: 'user', content: prompt }];
    let res = await anthropic.messages.create({
      model: RESEARCH_MODEL,
      max_tokens: 2500,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
      messages,
    });

    // サーバーツールのループが一時停止した場合は続きを要求する（最大3回）
    for (let i = 0; i < 3 && res.stop_reason === 'pause_turn'; i++) {
      messages = [...messages, { role: 'assistant', content: res.content }];
      res = await anthropic.messages.create({
        model: RESEARCH_MODEL,
        max_tokens: 2500,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
        messages,
      });
    }

    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
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
