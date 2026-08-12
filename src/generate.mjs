// 本文生成（Claude）＋ 朝の枠だけ Pexels のストック写真を1枚添付。
// 調査結論に基づき「テキスト中心・画像は時々・AI顔合成/文字焼き込みはしない」方針。
// 出力: outbox/post.json（本文・imageUrl は画像なしなら null）
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ROOT, loadEnv, loadPersona, requireEnv } from "./config.mjs";
import { getFreshNews } from "./news.mjs";
import { getStockPhoto } from "./pexels.mjs";

loadEnv();
// 文章=Claude（必須）。画像はローカルでカード生成のみ（外部API不要）。
requireEnv(["ANTHROPIC_API_KEY"]);
const persona = loadPersona();

const anthropic = new Anthropic(); // ANTHROPIC_API_KEY を自動で読む
const TEXT_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

// --- ネタと型を決める（乱数を使わず、日付＋時刻で決定的に回す）---
// 1日に複数回走っても、時刻(UTC hour)が違うので別のネタ・型になる。
function pick(arr, offset = 0) {
  const now = new Date();
  const dayOfYear = Math.floor(
    (now - new Date(now.getFullYear(), 0, 0)) / 86400000
  );
  const slot = dayOfYear * 24 + now.getUTCHours();
  return arr[(slot + offset) % arr.length];
}

const topics = (persona.topics_pool || []).filter((t) => t && !String(t).includes("<"));
const styles = persona.use_styles || ["③質問・問いかけ型"];
const topic = topics.length ? pick(topics) : persona.genre;

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
  let best = null, bestD = 99;
  for (const s of slots) {
    const t = Number(s.utc_hour);
    if (Number.isNaN(t)) continue;
    const raw = Math.abs(h - t);
    const d = Math.min(raw, 24 - raw); // 円環距離（23時と1時は近い）
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}
const slot = currentSlot();
const style = slot?.style || pick(styles, 1);

// 締め方は枠ごとに変える（毎回"質問締め"を避ける。質問は夜の枠だけに集中させる）
// 返信はアルゴリズム最重要シグナルのため、保存枠でも最後に「一言で答えられる質問」を添える
const closingRules = {
  save: "締めは「保存して見返してね」など保存を促す一言 そのあとに「どれから試す？」のような一言で答えられる軽い質問を1行だけ足す",
  soft: "締めは静かな余韻かやわらかいフォロー誘導 長い質問はしない",
  question: "締めは「〜な人います？」または二択の質問で終え 一言で返信できる形にする",
};
const closing = closingRules[slot?.closing] || closingRules.question;

if (slot) {
  console.log(`🕒 投稿枠: ${slot.jst} [${slot.role}] 型=${style} 締め=${slot.closing}`);
}

// --- 全生成で共通のルールブロック（2026-08 バズアカウント調査の結論を反映）---
// キャラの一貫性: 過去投稿で「僕」や「元営業」など別人格が混ざりAI臭の原因になったため、
// 語ってよい実体験を固定し それ以外の実績捏造を明示的に禁止する。
const FIRST = persona.persona?.first_person || "わたし";
const personaGuard = `【キャラの一貫性（最重要・厳守）】
- 一人称は「${FIRST}」だけ 「僕」「俺」「私」は絶対に使わない
- 経歴は固定: ${persona.persona?.role || ""}
- 実体験として語ってよいのはこれだけ: ${persona.persona?.episode || ""}
- 上記以外の実績（画像制作代行 動画納品 別ジャンルの副業など）を「やっている」と語らない やっていないことは「調べた」「見かけた」「気になってる」と正直な立場で書く
- 実績を語るときは「以前のダメな状態→期間→今の数字→変えたことは1つ」の順で語る
- 数字は月3〜5万円や時給・分単位の時短など読者が自分事にできる規模だけ 月30万や月100万など遠い数字は出さない
- 同じ実体験でも毎回同じ言い回し・同じ数字の組み合わせを繰り返さない（類似投稿の反復はスパム判定リスク） 実体験に触れない投稿があってもよい`;

const hookRules = `【1行目（フック）ルール】
- 次のいずれかで始める: (a)数字 (b)「◯◯と思ってる人 多いけど実は違う」型の常識くつがえし (c)「◯◯な人へ」の属性名指し (d)「これ」or セリフ
- 1行目に結論や答えを書かない 「方法は3つあって」「違いは1つで」のように文を切って続きを読ませる
- 【】で囲む宣言タイトルは使わない`;

const formatRules = `【表記ルール（Threads特有・厳守）】
- 句読点「。」「、」は使わない 半角スペースか改行で間を取る
- 1行は20字前後まで 1〜2行ごとに空行を入れて縦にスラスラ読める形にする
- 体言止め・言い切り・話し言葉（〜ですよね 〜かな 〜なんです）を混ぜて機械っぽい均質さを消す
- 絵文字は✅や①②③など構造化の目的だけに使う 最大3個 装飾目的では使わない
- 数字を必ず1つ入れる
- ハッシュタグ・リンクURLは入れない`;

// --- 本文生成（単発投稿用システムプロンプト）---
const systemPrompt = `あなたはThreads運用のプロライターです。以下のルールを厳守して投稿本文を1本だけ書きます。

${personaGuard}

${hookRules}

${formatRules}
- ${closing}
- 全体で最大12行（空行を含む）

【この投稿の役割】${slot?.role || "汎用"}${slot?.guide ? "（" + slot.guide + "）" : ""}
【使う型】${style}

【出力】本文テキストのみ。前置き・説明・引用符・ハッシュタグは付けない。`;

const userPrompt = `ジャンル: ${persona.genre}
今日のテーマ: ${topic}
ターゲット: ${JSON.stringify(persona.target || {})}
発信者の立場: ${persona.persona?.role || ""} / 得意: ${persona.persona?.strength || ""} / 実体験: ${persona.persona?.episode || ""}
避ける話題: ${(persona.ng?.topics || []).join(", ")}
使わない言葉: ${(persona.ng?.words || []).join(", ")}

この投稿の役割: ${slot?.role || "汎用"} / 狙い: ${slot?.goal || ""}
上記に沿って「${style}」で投稿本文を1本書いてください。`;

async function generateText() {
  // Claude（公式Anthropic SDK）で本文生成。Opus 4.8 は temperature 非対応なので渡さない。
  const res = await anthropic.messages.create({
    model: TEXT_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("Claude本文生成に失敗: 空の応答 " + JSON.stringify(res));
  return text;
}

// 保険：句読点が混ざったら除去（ルール徹底）
function sanitize(text) {
  return text.replace(/[。、]/g, " ").replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}

// --- ニュース起点ツリー（news: true の枠用・現在は全枠オフ）---
// ★2026-08調査: ニュース速報型はThreadsで最弱。再開する場合も「速報」ではなく
//   「ニュースを題材にした一人称の体験談」に変換して書く。
async function generateThread(article) {
  const sys = `あなたはThreads運用のプロライターです。最新AIニュースを題材に「3本のツリー投稿」を書きます。
ただしニュースの紹介・速報はしません。ニュースは話のきっかけにすぎず、主役は${FIRST}の体験と読者のメリットです。

${personaGuard}

${hookRules}

${formatRules}
- 各本は最大10行（空行を含む） 短く読みやすく
- 煽りワード禁止（${(persona.ng?.words || []).join(" / ")}）
- タイトルや要約に無い事実は断定しない 憶測を事実のように書かない

【読者レベル（最重要・厳守）】
- 読者はAI副業の初心者 専門用語や難しい話は避ける 中学生でもわかる言葉で
- 企業の業績・利用者数・ライセンスなど「会社側の数字」は話題にしない 読者の生活が変わる1点だけ拾う
- 必ず「初心者が今日スマホやPCですぐ試せる」具体的な使い方に落とし込む

【3本の役割】
1本目: フックルールに従って始め ${FIRST}がこのニュースで何を試したか/試そうとしているかを体験として語る
2本目: すぐ真似できる手順や例を1つ ①②③の番号付きで具体的に
3本目: ${FIRST}の率直な感想 最後は読者が一言で答えられる問いかけで締める（「〜な人います？」等）

【出力形式】3本を「===」だけの行で区切って出力する 本文のみ 前置き説明は書かない`;

  const usr = `ニュース見出し: ${article.title}
出典: ${article.source}
要約: ${article.summary || "（要約なし・見出しから推測しすぎない）"}
発信者: ${persona.persona?.role || ""}
ターゲット: ${JSON.stringify(persona.target || {})}

上記ニュースについて 初心者がすぐ使える形で 3本のツリー投稿を書いてください`;

  const res = await anthropic.messages.create({
    model: TEXT_MODEL,
    max_tokens: 1500,
    system: sys,
    messages: [{ role: "user", content: usr }],
  });
  const raw = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const parts = raw
    .split(/^\s*={3,}\s*$/m)
    .map((s) => sanitize(s))
    .filter(Boolean);
  if (parts.length < 2) throw new Error("ツリー生成に失敗（区切りが検出できず）: " + raw.slice(0, 200));
  return parts.slice(0, 3); // 念のため最大3本
}

// --- ノウハウツリーを生成（ニュース不要・トピック起点）---
// ★2026-08調査: 日本語Threadsの主流は「1本目にフック＋価値の8割、2本目以降は補足」の
//   2〜3本構成。長尺連投は読まれない。1本目だけで完結して見えることが大事。
async function generateValueThread(topic) {
  const sys = `あなたはThreads運用のプロライターです。1つのテーマを「2〜3本のツリー投稿」に分けて書きます。

${personaGuard}

${hookRules}

${formatRules}
- 煽りワード禁止（${(persona.ng?.words || []).join(" / ")}）

【読者レベル（最重要・厳守）】
- 読者はAI副業の初心者 専門用語や難しい話は避ける 中学生でもわかる言葉で
- 抽象論で終わらせず 今日すぐ試せる具体アクションに落とす

【ツリーの型（2〜3本・1本目が主役）】
- 1本目（ここに価値の8割を入れる）: 1行目はフックルールに従う → すぐに①②③…の番号付き具体ノウハウを続ける 項目は3個か5個 各項目「見出し1行＋補足1行」 1本目だけ読んでも役に立つ状態にする
- 2本目: いちばん大事な1項目の深掘り or 補足 ${FIRST}の失敗談を1つ混ぜて人間味を出す
- 最終の本: 要点を一言でまとめ 「フォローして一緒に頑張ろう」等のやわらかい誘導 最後は読者が一言で答えられる問いかけを1つ添える

【本数の決め方】
- 基本は2本 深掘りに値する内容があるときだけ3本 無理に引き伸ばさない

【出力形式】各本を「===」だけの行で区切って出力する 本文のみ 前置き説明は書かない`;

  const usr = `テーマ: ${topic}
発信者の立場: ${persona.persona?.role || ""} / 得意: ${persona.persona?.strength || ""} / 実体験: ${persona.persona?.episode || ""}
ターゲット: ${JSON.stringify(persona.target || {})}
避ける話題: ${(persona.ng?.topics || []).join(", ")}

上記テーマで お手本の型に沿って ノウハウ長文ツリーを書いてください`;

  const res = await anthropic.messages.create({
    model: TEXT_MODEL,
    max_tokens: 2000,
    system: sys,
    messages: [{ role: "user", content: usr }],
  });
  const raw = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const parts = raw
    .split(/^\s*={3,}\s*$/m)
    .map((s) => sanitize(s))
    .filter(Boolean);
  if (parts.length < 2) throw new Error("ノウハウツリー生成に失敗（区切りが検出できず）: " + raw.slice(0, 200));
  return parts.slice(0, 3); // 最大3本（日本語Threadsは短いツリーが主流）
}

// --- 画像（Pexelsのストック写真）---
// image: true の枠だけ、Pexelsから在宅ワーク感の写真を1枚選んで公開URLを返す。
// 乱数を使わず日付＋時刻をseedにして毎日ちがう写真にする。キー無し/失敗時は null。
async function pickPhotoUrl() {
  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
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
    console.log("📰 ニュース取得でエラー → エバーグリーンに切替: " + e.message);
  }
}

let outbox;
if (article) {
  // ===== ニュース速報ツリー =====
  console.log(`🧵 ニュース枠：3本ツリーを生成します → ${article.title}`);
  const parts = await generateThread(article);
  console.log("📝 ツリー生成:\n" + parts.map((p, i) => `【${i + 1}】\n${p}`).join("\n\n") + "\n");
  const thread = parts.map((t) => ({ text: t, imageUrl: null }));
  // 先頭だけ写真を添付（slot.image が true のとき）
  if (slot?.image === true) thread[0].imageUrl = await pickPhotoUrl();
  else console.log("📄 テキストのみツリー（画像なし）");
  outbox = {
    thread,
    kind: "news",
    source: { title: article.title, link: article.link, source: article.source },
    slot: slot?.key || null,
    createdAt: new Date().toISOString(),
  };
} else if (slot?.thread === true) {
  // ===== ノウハウ長文ツリー（ニュース不要・トピック起点）=====
  console.log(`🧵 ノウハウ枠：長文ツリーを生成します → ${topic}`);
  const parts = await generateValueThread(topic);
  console.log(`📝 ツリー生成（全${parts.length}本）:\n` + parts.map((p, i) => `【${i + 1}】\n${p}`).join("\n\n") + "\n");
  const thread = parts.map((t) => ({ text: t, imageUrl: null }));
  // 先頭だけ写真を添付（slot.image が true のとき）
  if (slot?.image === true) thread[0].imageUrl = await pickPhotoUrl();
  else console.log("📄 テキストのみツリー（画像なし）");
  outbox = {
    thread,
    kind: "value",
    topic,
    style,
    slot: slot?.key || null,
    createdAt: new Date().toISOString(),
  };
} else {
  // ===== 従来の単発投稿（エバーグリーン）=====
  const text = sanitize(await generateText());
  console.log("📝 本文生成:\n" + text + "\n");
  let imageUrl = null;
  if (slot?.image === true) imageUrl = await pickPhotoUrl();
  else console.log("📄 この枠はテキストのみ投稿（画像なし）");
  outbox = {
    text,
    imageUrl,
    topic,
    style,
    slot: slot?.key || null,
    createdAt: new Date().toISOString(),
  };
}

writeFileSync(join(ROOT, "outbox", "post.json"), JSON.stringify(outbox, null, 2));
console.log("✅ 生成完了 → 次は src/post.mjs で公開します");
