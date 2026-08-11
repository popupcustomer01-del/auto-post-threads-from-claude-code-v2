// Pexels から「在宅ワーク/AI副業」に合うストック写真の公開URLを1枚返す。
// 方針:
//   - まず persona.yml の image.pexels.photos（人手で厳選したURL集）を最優先でローテする。
//     ライブ検索はブランド物・人物の混入が避けられないため、厳選ローテを既定にする。
//   - 厳選リストが無い場合のみ、フォールとしてライブ検索する（queries）。
//   - 乱数は使わず seed（日付＋時刻）で決定的に選ぶ（毎日ちがう写真になる）。
//   - どのルートでも取れなければ null を返し、呼び出し側は画像なしで続行する。
const API = "https://api.pexels.com/v1/search";

const DEFAULT_QUERIES = ["coffee", "office", "notebook", "plant"];

export async function getStockPhoto(cfg = {}, seed = 0) {
  const s = Math.abs(Math.trunc(seed));

  // --- 最優先: 厳選写真URLのローテ（APIを叩かない＝安定・ブランド安全）---
  const curated = Array.isArray(cfg.photos) ? cfg.photos.filter((u) => typeof u === "string" && u.startsWith("http")) : [];
  if (curated.length) {
    const url = curated[s % curated.length];
    console.log(`🖼️  厳選写真を採用（${(s % curated.length) + 1}/${curated.length}）`);
    return { url, curated: true };
  }

  // --- フォールバック: ライブ検索（厳選リストが無いときだけ）---
  const key = process.env.PEXELS_API_KEY;
  if (!key) {
    console.log("🖼️  厳選写真もPEXELS_API_KEYも無し → 画像なしで続行");
    return null;
  }

  const queries = Array.isArray(cfg.queries) && cfg.queries.length ? cfg.queries : DEFAULT_QUERIES;
  const perPage = Number(cfg.per_page) > 0 ? Number(cfg.per_page) : 15;
  const orientation = cfg.orientation || "square";
  const q = queries[s % queries.length];

  const url = `${API}?query=${encodeURIComponent(q)}&per_page=${perPage}&orientation=${orientation}`;
  let json;
  try {
    const res = await fetch(url, { headers: { Authorization: key } });
    if (!res.ok) {
      console.log(`🖼️  Pexels取得失敗 status=${res.status} → 画像なしで続行`);
      return null;
    }
    json = await res.json();
  } catch (e) {
    console.log("🖼️  Pexels取得エラー → 画像なしで続行: " + e.message);
    return null;
  }

  const photos = Array.isArray(json.photos) ? json.photos : [];
  if (!photos.length) {
    console.log(`🖼️  Pexels該当なし（query="${q}"）→ 画像なしで続行`);
    return null;
  }

  const p = photos[s % photos.length];
  // Threads仕様（幅320〜1440・sRGB）に合わせ、1080x1080でクロップしたURLを組み立てる
  const imageUrl = `${p.src.original}?auto=compress&cs=tinysrgb&fit=crop&w=1080&h=1080`;
  console.log(`🖼️  Pexels採用: "${q}" by ${p.photographer}`);
  return { url: imageUrl, pexelsUrl: p.url, photographer: p.photographer, alt: p.alt || "" };
}
