// 本文生成（OpenAI）＋ 朝の枠だけ Pexels のストック写真を1枚添付。
// 調査結論に基づき「テキスト中心・画像は時々・AI顔合成/文字焼き込みはしない」方針。
// 出力: outbox/post.json（本文・imageUrl は画像なしなら null）
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import { ROOT, loadEnv, loadPersona, requireEnv } from './config.mjs';
import { getFreshNews } from './news.mjs';
import { getStockPhoto } from './pexels.mjs';
import { getBuzzExamples } from './buzz.mjs';
import {
  readHistory,
  writeHistory,
  refreshRecentMetrics,
  buildRecentPostsText,
  buildLearningsText,
} from './history.mjs';
import { validatePost, buildFeedback } from './validate.mjs';

loadEnv();
// 文章=OpenAI（必須）。画像はローカルでカード生成のみ（外部API不要）。
requireEnv(['OPENAI_API_KEY']);
const persona = loadPersona();

// --- 投稿履歴（学習・重複防止）を読み込む（失敗しても生成は続行）---
// threads-auto-post から移植: 反応データ(insights)で「何が良かったか」を学習し、
// 直近投稿の本文を「同じネタ・言い回しの禁止リスト」としてプロンプトに渡す。
let learningsText = '';
let recentPostsText = '';
try {
  let history = readHistory();
  if (process.env.THREADS_ACCESS_TOKEN) {
    history = await refreshRecentMetrics(history, process.env.THREADS_ACCESS_TOKEN);
    writeHistory(history);
  }
  learningsText = buildLearningsText(history);
  recentPostsText = buildRecentPostsText(history);
  console.log(
    `📚 投稿履歴${history.length}件 学習データ=${learningsText ? 'あり' : 'まだ不足'} 重複禁止リスト=${recentPostsText ? 'あり' : 'なし'}`,
  );
} catch (e) {
  console.log('📚 履歴の読み込みに失敗（生成は続行）: ' + e.message);
}

const openai = new OpenAI(); // OPENAI_API_KEY を自動で読む
const TEXT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
// OpenAIプロジェクトのModel limitsで既定モデルが未許可の場合に自動で切り替える先
// (gpt-4.1を使いたい場合は platform.openai.com のプロジェクト設定 → Limits で許可する)
const FALLBACK_MODEL = 'gpt-4o';
let activeModel = TEXT_MODEL;

async function createChat(params) {
  try {
    return await openai.chat.completions.create({ model: activeModel, ...params });
  } catch (e) {
    if (e?.code === 'model_not_found' && activeModel !== FALLBACK_MODEL) {
      console.log(
        `⚠️ ${activeModel} はこのOpenAIプロジェクトで未許可 → ${FALLBACK_MODEL} で続行します`,
      );
      activeModel = FALLBACK_MODEL;
      return await openai.chat.completions.create({ model: activeModel, ...params });
    }
    throw e;
  }
}

// --- ネタと型を決める（乱数を使わず、日付＋時刻で決定的に回す）---
// 1日に複数回走っても、時刻(UTC hour)が違うので別のネタ・型になる。
// ※旧実装は「日番号×24＋時刻」だったが、24がネタ数(8)で割り切れるため
//   日付の効果が消え「毎日同じ時刻＝同じネタ」になるバグがあった。日番号＋時刻に修正。
function pick(arr, offset = 0) {
  const now = new Date();
  const dayOfYear = Math.floor(
    (now - new Date(now.getFullYear(), 0, 0)) / 86400000,
  );
  const slot = dayOfYear + now.getUTCHours();
  return arr[(slot + offset) % arr.length];
}

// --- 乱数ユーティリティ（投稿の反復を防ぐ・毎回ゆらぎを出す）---------------
// 旧実装は「日付＋時刻」の決定的選択で、ネタは8日周期で固定・型はスロット固定
// だった。これが「毎回同じような投稿」の構造的原因。ここを乱択に変え、
// ネタ / 型 / フック / 締め方 / 切り口 に毎回ランダム性を持たせる。
// ※テストで結果を再現したいときだけ GEN_SEED=数値 を渡すと決定的になる。
let _seed = process.env.GEN_SEED ? Number(process.env.GEN_SEED) >>> 0 || 1 : null;
function rnd() {
  if (_seed == null) return Math.random();
  _seed ^= _seed << 13;
  _seed ^= _seed >>> 17;
  _seed ^= _seed << 5;
  return ((_seed >>> 0) % 100000) / 100000;
}
function rand(arr, fallback = undefined) {
  if (!Array.isArray(arr) || !arr.length) return fallback;
  return arr[Math.floor(rnd() * arr.length)];
}

// --- フックの型メニュー（型リファレンス.mdのフック表より・毎回1つ乱択）------
// 全部を並べて丸投げすると同じ型に収束するため、今回使う型を1つだけ指定する。
const HOOK_MENU = [
  '数字から始める（例「15分で」「月+5万まで」「3年間」など具体数字を1行目に置く）',
  '「これ」で先に指してから中身を言う（例「これ 知らずにずっと損してた」）',
  '「最近」「今日」「昔」など時間の言葉から入る実況風（例「昔のわたしは〜」）',
  'セリフを「」で始める（例「いい感じにして しか言えなかった頃」）',
  '属性を名指しする（例「AI副業を始めたばかりの人へ」）',
  '常識をひっくり返す（例「◯◯だと思ってたけど 実は逆だった」）',
];

// --- 締め方メニュー（毎回「質問」で終わる問題を解消）-----------------------
// save=保存うながし / action=具体アクション / assert=言い切り持論
// soft=静かな余韻 / question=一言で返せる問い。question は夜枠中心に絞る。
const CLOSING_MENU = {
  save: '最後は「保存して見返してね」など保存を1行うながして締める 質問は付けない',
  action: '最後は「今日はこれだけやってみて」と具体的なアクションを1つ置いて締める 質問は付けない',
  assert:
    '最後は失敗ベースの言い切り持論で締める（例「結局 続けた人だけが残る」）質問は付けない',
  soft: '最後は静かな余韻か「…」で締める 説明しすぎない 質問はしない',
  question:
    '最後は「〜な人います？」か答えやすい二択で 一言で返信できる問いで締める',
};
const CLOSING_DEFAULT_POOL = {
  save: ['save', 'action', 'assert', 'save'],
  soft: ['soft', 'assert', 'action', 'soft'],
  question: ['question', 'assert', 'question', 'action'],
};

// --- 切り口スパイス（毎回1つ乱択・具体性と多様性を強制する仕掛け）----------
// 同じネタ・同じ型でも「切り口」を変えることで投稿の見え方が毎回変わる。
const SPICE_MENU = [
  '残業つづき→月+5万のV字を 前の状態→期間→今 の時系列で語る',
  'before→after を具体的な2つの数字で示す（例 40分→10分 週3時間→30分）',
  '実在ツール名を最低2つ具体的に出す（ChatGPT Gemini Canva Notion など）',
  'うまくいった話ではなく わたしがつまずいた具体場面から書き始める',
  '手順を①②③の3ステップで だれでも今日できる粒度まで具体化する',
  'ありがちな勘違いを1つ名指しして 正しいやり方に置き換えて見せる',
  '数字は出さず 時間帯・場所・気持ちなど具体的な場面描写で読ませる',
  'あるあるを①②③で3つ並べ 最後に「全部わたしです」と自己開示する',
];

// --- 長さモード（単発投稿の長短を毎回振り分ける）----------------------------
// 「朝昼晩ぜんぶ長文になる」への対応。ツリー(news/thread)は保存狙いなので長いまま。
// 単発投稿だけ short/medium/long を枠のプールから乱択して長短を混ぜる。
//   contentLines: 空行を除いた本文行数の上限。プロンプトと検品(validate.mjs)の両方が
//                 この同じ値を参照する（基準がズレると検品NGが再生成でも直らないため）。
//                 short=3行はタイムライン実測(伸びる投稿は3行程度)による
//   substance: その長さでの「中身の濃さ」ルール（短いほど詰め込まない）
const LENGTH_MENU = {
  short: {
    label: 'ショート',
    chars: '40〜120字',
    contentLines: 3,
    substance:
      '短文なので詰め込まない 言いたいことは1つだけ 具体(ツール名/数字/手順)は入れても1つまで 共感や問いかけ 短い持論で一撃で刺す 一言で返せる余白を残す',
  },
  medium: {
    label: 'ミドル',
    chars: '150〜250字',
    contentLines: 7,
    substance:
      '次のうち最低1つは具体を入れる (a)数字 (b)実在ツール名 (c)今日試せる一手 要点だけに絞り 説明しすぎない',
  },
  long: {
    label: 'ロング',
    chars: '400〜500字',
    contentLines: 11,
    substance:
      '次のうち最低2つを必ず入れる (a)具体的な数字 (b)わたしが実際にAIを使った具体場面(ツール名を出してもよい) (c)つまずいた失敗と感情 (d)賛否が分かれる持論 (e)在宅・副業初心者のあるある 読み終えた瞬間に「わかる」か「やってみよう」が1つ残る プロンプトやテンプレの全文配布はしない',
  },
};

// 短文用の切り口（重い実物提示を避け ワンフレーズで刺す方向に寄せる）
const SHORT_SPICE_MENU = [
  '言いたいことを1つに絞り ワンフレーズで言い切る',
  '「これ自分だ」と思わせる あるある場面を1つだけ描く',
  '答えやすい二択で終わり 一言で返せる余白を残す',
  '今日できる一手だけを1つ 手順や説明は書かない',
  '世間の建前→実際の本音 のギャップを1つだけ見せる',
];

const topics = (persona.topics_pool || []).filter(
  (t) => t && !String(t).includes('<'),
);
const styles = persona.use_styles || ['③質問・問いかけ型'];
// ★毎回ランダムに選ぶ（旧: pick() は8日周期で同じネタに戻っていた）
const topic = topics.length ? rand(topics) : persona.genre;
// この投稿の「切り口」を1つ乱択（具体性と多様性を強制）
const spice = rand(SPICE_MENU);

// --- 投稿枠(スロット)を決める：実行時刻(UTC)に最も近い枠を選ぶ ---
// 朝=価値提供 / 夕=共感ストーリー / 夜=問いかけ、と役割を固定してローテを避ける。
// slots が無い設定なら従来どおり use_styles を時刻でローテ（後方互換）。
function currentSlot() {
  const slots = Array.isArray(persona.slots) ? persona.slots : [];
  if (!slots.length) return null;
  // テスト/手動実行用：FORCE_SLOT=morning などで枠を固定できる
  if (process.env.FORCE_SLOT) {
    const forced = slots.find((s) => s.key === process.env.FORCE_SLOT);
    if (forced) return forced;
  }
  const h = new Date().getUTCHours();
  let best = null,
    bestD = 99;
  for (const s of slots) {
    const t = Number(s.utc_hour);
    if (Number.isNaN(t)) continue;
    const raw = Math.abs(h - t);
    const d = Math.min(raw, 24 - raw); // 円環距離（23時と1時は近い）
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}
const slot = currentSlot();
// ★型もスロット内の候補から毎回乱択（旧: slot.style 固定で毎日同じ型だった）
const style =
  rand(slot?.styles) || slot?.style || rand(styles) || '①数字・実績型';

// --- 単発投稿の長さを枠のプールから乱択（thread/newsツリーは対象外＝従来どおり長い）---
// short=40〜120字 / medium=150〜250字 / long=400〜500字。夜は短文中心 朝の単発日は短〜中。
// slot.lengths が無い枠は ['medium','long'] を既定にする。
const lengthPool =
  (Array.isArray(slot?.lengths) && slot.lengths.length && slot.lengths) || [
    'medium',
    'long',
  ];
const lengthKey = rand(lengthPool);
const lengthSpec = LENGTH_MENU[lengthKey] || LENGTH_MENU.long;
// 短文のときは重い切り口(時系列V字/場面描写など)を避け ワンフレーズ系に差し替える
const singleSpice = lengthKey === 'short' ? rand(SHORT_SPICE_MENU) : spice;
const singleSpiceNote = `【今回の切り口（必ず反映）】${singleSpice}`;

// 締め方は毎回プールから乱択する（旧仕様は保存枠にも質問を足していて
// 「毎回 問いかけで終わる」主因だった）。質問は夜枠のプールに集中させる。
const closingPool =
  (Array.isArray(slot?.closings) && slot.closings.length && slot.closings) ||
  CLOSING_DEFAULT_POOL[slot?.closing] ||
  ['action', 'assert', 'question'];
const closingKey = rand(closingPool);
const closing = CLOSING_MENU[closingKey] || CLOSING_MENU.action;
// この投稿のフックの型を1つ乱択
const chosenHook = rand(HOOK_MENU);

if (slot) {
  console.log(
    `🕒 投稿枠: ${slot.jst} [${slot.role}] 型=${style} 長さ=${lengthSpec.label} 締め=${closingKey} フック=${chosenHook.slice(0, 14)}… 切り口=${spice.slice(0, 16)}…`,
  );
}

// --- 全生成で共通のルールブロック（2026-08 バズアカウント調査の結論を反映）---
// キャラの一貫性: 過去投稿で「僕」や「元営業」など別人格が混ざりAI臭の原因になったため、
// 語ってよい実体験を固定し それ以外の実績捏造を明示的に禁止する。
const FIRST = persona.persona?.first_person || 'わたし';
const personaGuard = `【キャラの一貫性（最重要・厳守）】
- 一人称は「${FIRST}」だけ 「僕」「俺」「私」は絶対に使わない
- 経歴は固定: ${persona.persona?.role || ''}
- 実体験として語ってよいのはこれだけ: ${persona.persona?.episode || ''}
- 上記以外の実績（画像制作代行 動画納品 別ジャンルの副業など）を「やっている」と語らない やっていないことは「調べた」「見かけた」「気になってる」と正直な立場で書く
- 実績を語るときは「以前のダメな状態→期間→今の数字→変えたことは1つ」の順で語る
- 数字は月3〜5万円や時給・分単位の時短など読者が自分事にできる規模だけ 月30万や月100万など遠い数字は出さない
- 自分の実績の「期間・金額」は毎回同じ事実に固定する: 月+5万の達成までは「約半年」 それ以外の期間(「3ヶ月で達成」など)を新しく作らない 過去の投稿と経歴の数字が矛盾すると信頼を失う
- 同じ実体験でも毎回同じ言い回し・同じ数字の組み合わせを繰り返さない（類似投稿の反復はスパム判定リスク） 実体験に触れない投稿があってもよい`;

const hookRules = `【1行目（フック）ルール】
- 今回のフックはこの型で始める → ${chosenHook}
- 1行目に結論や答えを全部書かない 文を切って続きを読ませる
- 【】で囲む宣言タイトルは使わない（宣伝臭が出て伸びない）`;

const formatRules = `【表記ルール（Threads特有・厳守）】
- 句読点「。」「、」は使わない 半角スペースか改行で間を取る
- 1行は30字前後まで 意味のかたまりで改行し 2〜3行ごとに空行を入れる
- 体言止め・言い切り・話し言葉（〜ですよね 〜かな 〜なんです）を混ぜて機械っぽい均質さを消す
- 絵文字は①②③など構造化の目的だけに使う 最大3個 装飾目的では使わない
- ハッシュタグ・リンクURLは入れない`;

// ★中身の濃さ・具体性を強制するブロック（薄い/抽象的な投稿の再発防止）
const substanceRules = `【中身の濃さ・具体性（最重要・厳守）】
- 「便利」「効率化」「いい感じ」だけで終わる抽象文は禁止 必ず具体に落とす
- 次のうち最低2つを必ず入れる:
  (a)自分事サイズの具体数字（月+5万 22時帰り ◯分→◯分 など）
  (b)${FIRST}が実際にAIを使った具体場面（ツール名を出してもよい）
  (c)つまずいた失敗と そのときの感情（焦り 孤独 ほっとした等）
  (d)賛否が分かれる持論や逆張りの気づき
  (e)在宅ワーク・副業初心者のあるある
- このアカウントはプロンプトやテンプレートの全文配布はしない 読者に配る"実物"ではなく ${FIRST}の体験・数字・気づきで価値を出す
- ノウハウの箇条書き列挙だけで終わらせない（列挙は拡散しない）必ず体験か感情を絡める
- 読み終えた瞬間に「わかる」か「やってみよう」が1つ残る
- 一般論やどこかで聞いた話は書かない ${FIRST}が実際に体験した粒度で書く
- 前回までと同じ言い回し・数字・型の使い回しはしない 毎回ちがう切り口にする
- 説明しすぎず 少し余白（ツッコミどころ）を残す`;

// ★長さに応じた「中身の濃さ」ルールを組み立てる（単発投稿用・短いほど詰め込まない）
function buildSubstanceRules(spec) {
  return `【中身の濃さ・具体性（${spec.label}・厳守）】
- 「便利」「効率化」「いい感じ」だけで終わる抽象文は禁止
- ${spec.substance}
- 一般論やどこかで聞いた話は書かない ${FIRST}が実際に試した粒度か 実感のこもった本音で書く
- 前回までと同じ言い回し・数字・型の使い回しはしない 毎回ちがう切り口にする
- 全体は${spec.chars}目安 説明しすぎず 少し余白（ツッコミどころ）を残す`;
}
const singleSubstanceRules = buildSubstanceRules(lengthSpec);

// ★今回の投稿だけの「切り口」指定（毎回変わる・多様性の主エンジン）
const spiceNote = `【今回の切り口（必ず反映）】${spice}`;

// --- 本文生成（単発投稿用システムプロンプト）---
const systemPrompt = `あなたはThreads運用のプロライターです。以下のルールを厳守して投稿本文を1本だけ書きます。

${personaGuard}

${hookRules}

${formatRules}

${singleSubstanceRules}
- ${closing}
- 本文は空行を除いて最大${lengthSpec.contentLines}行 空行は行数に数えない

${singleSpiceNote}

【この投稿の役割】${slot?.role || '汎用'}${slot?.guide ? '（' + slot.guide + '）' : ''}
【使う型】${style}

【出力（最重要）】本文テキストのみ。空行を除いた行数が${lengthSpec.contentLines}行を1行でも超えたら不採用。書き終えたら行数を数え 超えていたら削ってから出力する。前置き・説明・引用符・ハッシュタグは付けない。`;

const userPrompt = `ジャンル: ${persona.genre}
今日のテーマ: ${topic}
ターゲット: ${JSON.stringify(persona.target || {})}
発信者の立場: ${persona.persona?.role || ''} / 得意: ${persona.persona?.strength || ''} / 実体験: ${persona.persona?.episode || ''}
避ける話題: ${(persona.ng?.topics || []).join(', ')}
使わない言葉: ${(persona.ng?.words || []).join(', ')}

この投稿の役割: ${slot?.role || '汎用'} / 狙い: ${slot?.goal || ''}
上記に沿って「${style}」で投稿本文を1本書いてください。${recentPostsText}${learningsText}`;

async function generateText(extraNote = '', opts = {}) {
  // OpenAI（公式SDK・Chat Completions）で本文生成。
  const res = await createChat({
    max_tokens: 1024,
    // ★文面のゆらぎを増やし 反復を減らす（temperature高め＋反復ペナルティ）
    // 検品NG後の再生成では opts.temperature で下げ 指示遵守を優先する
    temperature: opts.temperature ?? 0.95,
    top_p: 0.95,
    frequency_penalty: 0.4,
    presence_penalty: 0.3,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt + extraNote },
    ],
  });
  const text = (res.choices?.[0]?.message?.content || '').trim();
  if (!text)
    throw new Error('OpenAI本文生成に失敗: 空の応答 ' + JSON.stringify(res));
  return text;
}

// 保険：句読点が混ざったら除去（ルール徹底）
function sanitize(text) {
  return text
    .replace(/[。、]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// --- 機械検品つき生成（threads-auto-post から移植 2026-08-18 統合）---
// プロンプト指示だけではルール(行数・締め方・NGワード等)が守られないことがあるため
// validate.mjs でコード検品し 違反があれば指摘を付けて再生成させる
const MAX_GEN_ATTEMPTS = 3;
// ツリー各本の行数上限（空行除き）。プロンプトと検品の両方で使う
const THREAD_CONTENT_LINES = 12;

// 行数オーバーの本文を「圧縮」で直す。ゼロから書き直させると同じ長さで再発するが、
// 出来た本文を渡して縮めさせるのは確実に守られる（2026-08-19 実測: 再生成3回でも
// ショート3行が一度も守られなかったため導入）。
async function compressText(text, maxContentLines) {
  const res = await createChat({
    max_tokens: 1024,
    temperature: 0.4,
    messages: [
      {
        role: 'system',
        content: `あなたはThreads投稿の圧縮担当です。渡された本文を 話題・口調・一人称（${FIRST}）・最後の行の締め方（問いなら問いのまま 言い切りなら言い切りのまま）を保ったまま 空行を除いて最大${maxContentLines}行に圧縮します。
- いちばん刺さる1点だけ残し 説明・列挙・経緯は思い切って捨てる
- 句読点「。」「、」は使わない 1行30字前後 ハッシュタグ・URLは入れない
- 出力は本文のみ 前置きや説明は書かない`,
      },
      { role: 'user', content: text },
    ],
  });
  return (res.choices?.[0]?.message?.content || '').trim();
}

async function generateSingleValidated(extraNote) {
  // 行数上限はプロンプトに書いた LENGTH_MENU.contentLines と同じ値で検品する
  const maxContentLines = lengthSpec.contentLines ?? 10;
  let text = '';
  let feedback = '';
  for (let attempt = 1; attempt <= MAX_GEN_ATTEMPTS; attempt++) {
    // 2回目以降は温度を下げてルール遵守（特に行数）を優先する
    text = sanitize(
      await generateText(
        extraNote + feedback,
        attempt > 1 ? { temperature: 0.7 } : {},
      ),
    );
    let problems = validatePost(text, { maxContentLines, closingKey });
    if (!problems.length) return text;

    // 行数違反は再生成より圧縮のほうが確実 → 圧縮してもう一度検品する
    if (problems.some((p) => p.includes('行数'))) {
      const compressed = sanitize(await compressText(text, maxContentLines));
      const after = validatePost(compressed, { maxContentLines, closingKey });
      if (!after.length) {
        console.log(`🔍 行数オーバーを圧縮で修正しました(${attempt}回目)`);
        return compressed;
      }
      // 圧縮後も別の違反が残る場合のみ再生成に回す（違反内容は圧縮後のもの）
      text = compressed;
      problems = after;
    }
    console.log(`🔍 検品NG(${attempt}回目): ${problems.join(' / ')}`);
    feedback = buildFeedback(problems);
  }
  console.log('🔍 検品違反が残ったまま規定回数に達したため 最後の生成を採用します');
  return text;
}

async function withThreadValidation(genFn, label) {
  let parts = [];
  let feedback = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    parts = await genFn(feedback);
    const problems = parts.flatMap((p, i) =>
      validatePost(p, {
        maxContentLines: THREAD_CONTENT_LINES,
        closingKey,
        isLastPart: i === parts.length - 1,
      }).map((m) => `${i + 1}本目: ${m}`),
    );
    if (!problems.length) return parts;
    console.log(`🔍 ${label}検品NG(${attempt}回目): ${problems.join(' / ')}`);
    feedback = buildFeedback(problems);
  }
  console.log('🔍 検品違反が残ったまま規定回数に達したため 最後の生成を採用します');
  return parts;
}

// --- ニュース解説ツリー（朝の枠用）---
// ★「見出し＋一言」の速報型は最弱（2026-08調査）。ここでは読者が元記事を読まなくても
//   中身がわかる「詳しい初心者向け解説」に変換する: 何が起きた→かみ砕き解説→今日やること。
async function generateThread(article, extraNote = '') {
  const sys = `あなたはThreads運用のプロライターです。最新AIニュースを「3本のツリー投稿」で初心者向けに詳しく解説します。
目標は「ニュースサイトを読まなくても このツリーだけで中身がわかって 今日やることまで決まる」状態です。

${personaGuard}

${hookRules}

${formatRules}

${substanceRules}
- 各本は空行を除いて最大${THREAD_CONTENT_LINES}行 空行は行数に数えない
- 煽りワード禁止（${(persona.ng?.words || []).join(' / ')}）
- タイトルや要約に無い事実は断定しない 推測で補うときは「〜みたい」「〜かも」と正直に書く

【読者レベル（最重要・厳守）】
- 読者はAI副業の初心者 専門用語が出たらその場で言い換える（例: API→アプリ同士をつなぐ窓口）
- 会社の売上・株価・利用者数など「会社側の数字」を主役にしない 読者の生活や副業がどう変わるかを主役にする

【3本の役割】
1本目（フック＋何が起きたか）: 1行目はフックルールに従う 続けてニュースの内容を2〜3行でわかりやすく伝え これが初心者にどう関係あるかを1行 詳しい中身は「詳しく説明すると」で切って2本目へつなぐ
2本目（ここが主役・詳しい解説）: 何がどう変わったのかを①②③の番号付きでかみ砕いて解説する 各項目は「見出し1行＋説明1〜2行」 具体的な操作やツール名まで踏み込む 途中に「つまり◯◯ということ」の要約を入れる
3本目（今日やること）: 初心者が今日スマホやPCで試せる具体的な一歩を手順で示す ${FIRST}の率直な感想を1行そえる ${closing}

${spiceNote}

【出力形式】3本を「===」だけの行で区切って出力する 本文のみ 前置き説明は書かない 各本は空行を除いて最大${THREAD_CONTENT_LINES}行（超えたら不採用）`;

  const usr = `ニュース見出し: ${article.title}
出典: ${article.source}
要約: ${article.summary || '（要約なし・見出しから推測しすぎない）'}
発信者: ${persona.persona?.role || ''}
ターゲット: ${JSON.stringify(persona.target || {})}

上記ニュースについて 初心者がすぐ使える形で 3本のツリー投稿を書いてください${recentPostsText}${extraNote}`;

  const res = await createChat({
    max_tokens: 1500,
    temperature: 0.9,
    top_p: 0.95,
    frequency_penalty: 0.4,
    presence_penalty: 0.3,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: usr },
    ],
  });
  const raw = (res.choices?.[0]?.message?.content || '').trim();
  const parts = raw
    .split(/^\s*={3,}\s*$/m)
    .map((s) => sanitize(s))
    .filter(Boolean);
  if (parts.length < 2)
    throw new Error(
      'ツリー生成に失敗（区切りが検出できず）: ' + raw.slice(0, 200),
    );
  return parts.slice(0, 3); // 念のため最大3本
}

// --- ノウハウツリーを生成（ニュース不要・トピック起点）---
// ★2026-08調査: 日本語Threadsの主流は「1本目にフック＋価値の8割、2本目以降は補足」の
//   2〜3本構成。長尺連投は読まれない。1本目だけで完結して見えることが大事。
async function generateValueThread(topic, extraNote = '') {
  const sys = `あなたはThreads運用のプロライターです。1つのテーマを「2〜3本のツリー投稿」に分けて書きます。

${personaGuard}

${hookRules}

${formatRules}

${substanceRules}
- 各本は空行を除いて最大${THREAD_CONTENT_LINES}行 空行は行数に数えない
- 煽りワード禁止（${(persona.ng?.words || []).join(' / ')}）

【読者レベル（最重要・厳守）】
- 読者はAI副業の初心者 専門用語や難しい話は避ける 中学生でもわかる言葉で
- 抽象論で終わらせず 今日すぐ試せる具体アクションに落とす 実在ツール名や具体手順まで踏み込む

【ツリーの型（2〜3本・1本目が主役）】
- 1本目（ここに価値の8割を入れる）: 1行目はフックルールに従う → すぐに①②③…の番号付き具体ノウハウを続ける 項目は3個か5個 各項目「見出し1行＋補足1行」 1本目だけ読んでも役に立つ状態にする
- 2本目: いちばん大事な1項目の深掘り or 補足 ${FIRST}の失敗談と そのときの感情を1つ混ぜて人間味を出す
- 最終の本: 要点を一言でまとめ 「フォローして一緒に頑張ろう」等のやわらかい誘導 ${closing}

【本数の決め方】
- 基本は2本 深掘りに値する内容があるときだけ3本 無理に引き伸ばさない

${spiceNote}

【出力形式】各本を「===」だけの行で区切って出力する 本文のみ 前置き説明は書かない 各本は空行を除いて最大${THREAD_CONTENT_LINES}行（超えたら不採用）`;

  const usr = `テーマ: ${topic}
発信者の立場: ${persona.persona?.role || ''} / 得意: ${persona.persona?.strength || ''} / 実体験: ${persona.persona?.episode || ''}
ターゲット: ${JSON.stringify(persona.target || {})}
避ける話題: ${(persona.ng?.topics || []).join(', ')}

上記テーマで お手本の型に沿って ノウハウ長文ツリーを書いてください${recentPostsText}`;

  const res = await createChat({
    max_tokens: 2000,
    temperature: 0.9,
    top_p: 0.95,
    frequency_penalty: 0.4,
    presence_penalty: 0.3,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: usr + extraNote },
    ],
  });
  const raw = (res.choices?.[0]?.message?.content || '').trim();
  const parts = raw
    .split(/^\s*={3,}\s*$/m)
    .map((s) => sanitize(s))
    .filter(Boolean);
  if (parts.length < 2)
    throw new Error(
      'ノウハウツリー生成に失敗（区切りが検出できず）: ' + raw.slice(0, 200),
    );
  return parts.slice(0, 3); // 最大3本（日本語Threadsは短いツリーが主流）
}

// --- 画像（Pexelsのストック写真）---
// image: true の枠だけ、Pexelsから在宅ワーク感の写真を1枚選んで公開URLを返す。
// 乱数を使わず日付＋時刻をseedにして毎日ちがう写真にする。キー無し/失敗時は null。
async function pickPhotoUrl() {
  const now = new Date();
  const dayOfYear = Math.floor(
    (now - new Date(now.getFullYear(), 0, 0)) / 86400000,
  );
  const seed = dayOfYear * 24 + now.getUTCHours();
  const photo = await getStockPhoto(persona.image?.pexels || {}, seed);
  return photo?.url || null;
}

// --- 実行 ---
// 朝のニュース枠 かつ 副業向けの新着あり → 3本ツリー。それ以外は従来の単発投稿。
let article = null;
if (slot?.news === true) {
  try {
    article = await getFreshNews(persona.news || {});
  } catch (e) {
    console.log('📰 ニュース取得でエラー → エバーグリーンに切替: ' + e.message);
  }
}

// --- バズ実例リサーチ（buzz: true の枠のみ・失敗しても生成は続行）---
// 実際に伸びている投稿のフック・構成をWeb検索で拾い、参考資料としてプロンプトに渡す。
let buzzNote = '';
if (!article && slot?.buzz === true) {
  const buzz = await getBuzzExamples(topic);
  if (buzz) {
    buzzNote = `

【参考資料: 今Threadsで実際に伸びている投稿の調査メモ】
${buzz}

※参考資料の使い方（厳守）: 実例の文章・実績・数字をコピーしない 他人の体験を自分の体験として書かない 真似てよいのはフックの型 構成 リズムだけ 話題のキーワードはテーマに合うときだけ取り入れる`;
  }
}

let outbox;
if (article) {
  // ===== ニュース速報ツリー =====
  console.log(`🧵 ニュース枠：3本ツリーを生成します → ${article.title}`);
  const parts = await withThreadValidation(
    (fb) => generateThread(article, fb),
    'ニュースツリー',
  );
  console.log(
    '📝 ツリー生成:\n' +
      parts.map((p, i) => `【${i + 1}】\n${p}`).join('\n\n') +
      '\n',
  );
  const thread = parts.map((t) => ({ text: t, imageUrl: null }));
  // 先頭だけ写真を添付（slot.image が true のとき）
  if (slot?.image === true) thread[0].imageUrl = await pickPhotoUrl();
  else console.log('📄 テキストのみツリー（画像なし）');
  outbox = {
    thread,
    kind: 'news',
    source: {
      title: article.title,
      link: article.link,
      source: article.source,
    },
    slot: slot?.key || null,
    createdAt: new Date().toISOString(),
  };
} else if (slot?.thread === true) {
  // ===== ノウハウ長文ツリー（ニュース不要・トピック起点）=====
  console.log(`🧵 ノウハウ枠：長文ツリーを生成します → ${topic}`);
  const parts = await withThreadValidation(
    (fb) => generateValueThread(topic, buzzNote + fb),
    'ノウハウツリー',
  );
  console.log(
    `📝 ツリー生成（全${parts.length}本）:\n` +
      parts.map((p, i) => `【${i + 1}】\n${p}`).join('\n\n') +
      '\n',
  );
  const thread = parts.map((t) => ({ text: t, imageUrl: null }));
  // 先頭だけ写真を添付（slot.image が true のとき）
  if (slot?.image === true) thread[0].imageUrl = await pickPhotoUrl();
  else console.log('📄 テキストのみツリー（画像なし）');
  outbox = {
    thread,
    kind: 'value',
    topic,
    style,
    slot: slot?.key || null,
    createdAt: new Date().toISOString(),
  };
} else {
  // ===== 従来の単発投稿（エバーグリーン）=====
  const text = await generateSingleValidated(buzzNote);
  console.log('📝 本文生成:\n' + text + '\n');
  let imageUrl = null;
  if (slot?.image === true) imageUrl = await pickPhotoUrl();
  else console.log('📄 この枠はテキストのみ投稿（画像なし）');
  outbox = {
    text,
    imageUrl,
    topic,
    style,
    slot: slot?.key || null,
    createdAt: new Date().toISOString(),
  };
}

// outbox/ 配下は全部gitignoreされているためCIのチェックアウトには存在しない → 毎回作る
mkdirSync(join(ROOT, 'outbox'), { recursive: true });
writeFileSync(
  join(ROOT, 'outbox', 'post.json'),
  JSON.stringify(outbox, null, 2),
);
console.log('✅ 生成完了 → 次は src/post.mjs で公開します');
