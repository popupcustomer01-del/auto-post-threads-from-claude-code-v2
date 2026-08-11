// Pexels から「在宅ワーク/AI副業」に合うストック写真の公開URLを1枚返す。
// モード:
//   - search: true → 毎回ライブ検索する（既定運用）。人物・他社ロゴ混入を alt フィルタで除外し、
//             取れない/全部弾かれた日は厳選写真(photos)に自動退避する。
//   - search 未指定 → 厳選写真(photos)を最優先でローテ。無ければライブ検索。
// 共通:
//   - 乱数は使わず seed（日付＋時刻）で決定的に選ぶ（毎日ちがう写真）。
//   - 取得したPexelsの画像URLはそのまま公開URLとして使える（ダウンロード/コミット不要）。
//   - どのルートでも取れなければ null を返し、呼び出し側は画像なしで続行する。
const API = "https://api.pexels.com/v1/search";

const DEFAULT_QUERIES = ["coffee", "latte", "tea", "office", "workspace", "notebook"];

// alt にこれらを含む写真は不採用（人物・他社ロゴ・ブランド物を避ける）
const BLOCK_WORDS = [
  "person", "people", "man", "woman", "men", "women", "boy", "girl", "child", "kid",
  "hand", "arm", "face", "model", "portrait", "selfie", "magazine", "watch", "logo", "brand",
];

function cropUrl(original) {
  // Threads仕様（幅320〜1440・sRGB）に合わせ、1080x1080でクロップ
  return `${original}?auto=compress&cs=tinysrgb&fit=crop&w=1080&h=1080`;
}

function isClean(photo) {
  const alt = (photo.alt || "").toLowerCase();
  return !BLOCK_WORDS.some((w) => alt.includes(w));
}

function pickCurated(cfg, s) {
  const curated = Array.isArray(cfg.photos)
    ? cfg.photos.filter((u) => typeof u === "string" && u.startsWith("http"))
    : [];
  if (!curated.length) return null;
  const idx = s % curated.length;
  console.log(`🖼️  厳選写真を採用（${idx + 1}/${curated.length}）`);
  return { url: curated[idx], curated: true };
}

async function liveSearch(cfg, s) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) {
    console.log("🖼️  PEXELS_API_KEY 未設定 → 検索できません");
    return null;
  }
  const queries = Array.isArray(cfg.queries) && cfg.queries.length ? cfg.queries : DEFAULT_QUERIES;
  const perPage = Number(cfg.per_page) > 0 ? Number(cfg.per_page) : 20;
  const q = queries[s % queries.length];
  // orientation は既定で指定しない（正方形固定はブランド撮影シリーズに偏るため）。最後にURLで1080角にクロップする。
  const orientationParam = cfg.orientation ? `&orientation=${cfg.orientation}` : "";

  let json;
  try {
    const res = await fetch(`${API}?query=${encodeURIComponent(q)}&per_page=${perPage}${orientationParam}`, {
      headers: { Authorization: key },
    });
    if (!res.ok) {
      console.log(`🖼️  Pexels検索失敗 status=${res.status}（query="${q}"）`);
      return null;
    }
    json = await res.json();
  } catch (e) {
    console.log("🖼️  Pexels検索エラー: " + e.message);
    return null;
  }

  const photos = Array.isArray(json.photos) ? json.photos : [];
  if (!photos.length) {
    console.log(`🖼️  Pexels該当なし（query="${q}"）`);
    return null;
  }

  // 人物・ブランド物っぽいものを alt で除外 → 残りから決定的に1枚。全滅なら不採用（呼び出し側が退避）。
  const clean = photos.filter(isClean);
  if (!clean.length) {
    console.log(`🖼️  クリーンな候補なし（query="${q}" 全${photos.length}件が人物/ブランド疑い）`);
    return null;
  }
  const p = clean[s % clean.length];
  console.log(`🖼️  Pexels検索採用: "${q}" by ${p.photographer}（候補${clean.length}/${photos.length}）`);
  return { url: cropUrl(p.src.original), pexelsUrl: p.url, photographer: p.photographer, alt: p.alt || "" };
}

export async function getStockPhoto(cfg = {}, seed = 0) {
  const s = Math.abs(Math.trunc(seed));

  if (cfg.search === true) {
    // 毎回ライブ検索。取れなければ厳選写真に退避。
    const found = await liveSearch(cfg, s);
    if (found) return found;
    console.log("🖼️  検索が使えないため厳選写真に退避します");
    return pickCurated(cfg, s); // null の可能性あり（呼び出し側は画像なしで続行）
  }

  // 既定: 厳選写真を優先、無ければライブ検索
  return pickCurated(cfg, s) || (await liveSearch(cfg, s));
}
