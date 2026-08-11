// outbox/post.json を読み、画像付きで Threads に公開する（完全自動公開）
// 画像は Pexels等の公開URL(imageUrl)をそのまま使う。旧方式のローカル画像(imagePath)にも後方互換で対応。
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, loadEnv, requireEnv } from "./config.mjs";

loadEnv();
requireEnv(["THREADS_ACCESS_TOKEN"]);

const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const BASE = "https://graph.threads.net/v1.0";

const outboxPath = join(ROOT, "outbox", "post.json");
if (!existsSync(outboxPath)) {
  console.error("⚠️ outbox/post.json がありません。先に npm run generate を実行してください。");
  process.exit(1);
}
const post = JSON.parse(readFileSync(outboxPath, "utf8"));

// --- 各投稿の公開画像URLを決める ---
// 優先: imageUrl（Pexels等の公開URL。そのまま使う）
// 後方互換: imagePath（ローカル画像）→ GitHub raw の公開URLに変換
function rawGithubUrl(imagePath) {
  const path = imagePath.replace(/\\/g, "/");
  if (process.env.THREADS_IMAGE_BASE_URL) {
    return `${process.env.THREADS_IMAGE_BASE_URL.replace(/\/$/, "")}/${path}`;
  }
  const repo = process.env.GITHUB_REPOSITORY || process.env.THREADS_IMAGE_REPO;
  if (!repo) {
    throw new Error(
      "画像URLを決められません。GitHub Actions外で動かす場合は THREADS_IMAGE_BASE_URL か THREADS_IMAGE_REPO(owner/repo) を設定してください。"
    );
  }
  const sha = execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim();
  return `https://raw.githubusercontent.com/${repo}/${sha}/${path}`;
}
function resolveImage(s) {
  if (s.imageUrl) return s.imageUrl;               // Pexels等の公開URL
  if (s.imagePath) return rawGithubUrl(s.imagePath); // 旧: ローカル画像
  return null;
}

// --- 投稿本数を正規化：単発でもツリー(thread配列)でも同じ形で扱う ---
// 各要素は { text, image }（image は公開URL or null）。
const segments = Array.isArray(post.thread) && post.thread.length
  ? post.thread.map((s) => ({ text: s.text, image: resolveImage(s) }))
  : [{ text: post.text, image: resolveImage(post) }];

async function getUserId() {
  // トークンから正しいユーザーIDを取得（手動設定のズレを根本的に防ぐ）。
  // /me が通ればトークン自体も有効。失敗時のみ環境変数を予備に使う。
  const me = await (await fetch(`${BASE}/me?fields=id,username&access_token=${TOKEN}`)).json();
  if (me.id) {
    console.log(`👤 投稿アカウント: @${me.username}（id: ${me.id}）`);
    return me.id;
  }
  if (process.env.THREADS_USER_ID) return process.env.THREADS_USER_ID;
  throw new Error(
    "ユーザーID取得に失敗（トークンが無効/期限切れ/権限不足の可能性）: " + JSON.stringify(me)
  );
}

const userId = await getUserId();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1本を公開する。replyToId があれば、その投稿へのリプライ（＝ツリーの続き）になる。
// 戻り値: 公開された post_id（次の本の reply_to_id に使う）。
async function publishOne({ text, image }, replyToId) {
  // Step 1: コンテナ作成（画像があれば IMAGE、なければ TEXT）
  const params = { access_token: TOKEN, text };
  if (image) {
    console.log("🖼️  画像URL: " + image);
    params.media_type = "IMAGE";
    params.image_url = image;
  } else {
    console.log("📄 テキストのみ");
    params.media_type = "TEXT";
  }
  if (replyToId) params.reply_to_id = replyToId; // ← ツリーの肝：直前の投稿にぶら下げる

  const r1 = await fetch(`${BASE}/${userId}/threads`, {
    method: "POST",
    body: new URLSearchParams(params),
  });
  const c = await r1.json();
  if (!c.id) {
    throw new Error(
      "コンテナ作成に失敗: " +
        JSON.stringify(c) +
        "\nヒント: トークンに『threads_content_publish』権限が無い可能性があります。" +
        "Metaアプリの権限設定を確認し、その権限を含めてトークンを再発行してください。"
    );
  }

  // Step 2: 公開。画像は取り込みに時間がかかるため長めに待つ（公式推奨: 画像は最低30秒）
  const waitMs = image ? 30000 : 3000;
  console.log(`⏳ ${waitMs / 1000}秒待ってから公開します`);
  await sleep(waitMs);
  const r2 = await fetch(`${BASE}/${userId}/threads_publish`, {
    method: "POST",
    body: new URLSearchParams({ creation_id: c.id, access_token: TOKEN }),
  });
  const p = await r2.json();
  if (!p.id) throw new Error("公開に失敗: " + JSON.stringify(p));
  return p.id;
}

// --- 実行：単発は1本、ツリーは reply_to_id で数珠つなぎに連投 ---
const isThread = segments.length > 1;
if (isThread) console.log(`🧵 ツリー投稿：全${segments.length}本`);

let prevId = null;
const publishedIds = [];
for (let i = 0; i < segments.length; i++) {
  if (isThread) console.log(`\n— ${i + 1}/${segments.length}本目 —`);
  const id = await publishOne(segments[i], prevId);
  publishedIds.push(id);
  console.log(`✅ 公開: post_id ${id}`);
  prevId = id; // 次の本はこの投稿へのリプライにする
  if (i < segments.length - 1) await sleep(2000); // 連投の間隔を少し空ける
}

if (isThread) {
  console.log(`\n🎉 ツリー投稿できました！ 先頭 post_id: ${publishedIds[0]}（全${publishedIds.length}本）`);
} else {
  console.log(`\n🎉 投稿できました！ post_id: ${publishedIds[0]}`);
}
