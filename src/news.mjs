// 最新AIニュースをRSSから取得する（依存追加なし・軽量パーサ）。
// 方針: 「直近N時間の新着」だけを対象にし、キーワードでスコアリングして1件選ぶ。
//   → 状態ファイル不要（朝は1日1回なので、24時間より前の記事は自然に対象外になる）。
//   → ネタが無い静かな日は null を返し、呼び出し側がエバーグリーンに切り替える。

// タグの中身を1つ取り出す（CDATA・属性つきにも対応）
function pickTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

// Atom の <link href="..."/> か RSS の <link>...</link> を取り出す
function pickLink(xml) {
  const rss = pickTag(xml, "link");
  if (rss) return rss;
  const atom = xml.match(/<link[^>]*href="([^"]+)"[^>]*\/?>(?:<\/link>)?/i);
  return atom ? atom[1] : "";
}

// HTMLタグと実体参照をざっくり除去してプレーンテキスト化
function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// 1本のフィードを取得して記事配列にする（title/link/date/summary/source）
async function fetchFeed(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "auto-threads-news/1.0" },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || [];
    const host = (() => {
      try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
    })();
    return blocks.map((b) => {
      const dateStr =
        pickTag(b, "pubDate") || pickTag(b, "updated") || pickTag(b, "published") || pickTag(b, "dc:date");
      const t = Date.parse(dateStr);
      return {
        title: stripHtml(pickTag(b, "title")),
        link: pickLink(b),
        date: Number.isNaN(t) ? 0 : t,
        summary: stripHtml(pickTag(b, "description") || pickTag(b, "summary") || pickTag(b, "content")).slice(0, 400),
        source: host,
      };
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const DEFAULT_FEEDS = [
  "https://openai.com/news/rss.xml",
  "https://deepmind.google/blog/feed/basic/",
  "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml",
];

// ★副業初心者が「今日すぐ使える」話題を加点（企業名や"AI"だけの汎用語は入れない）
const DEFAULT_KEYWORDS = [
  "ChatGPT", "Gemini", "Copilot", "画像生成", "動画生成", "音声", "文字起こし",
  "文章", "ライティング", "翻訳", "プロンプト", "テンプレート", "Canva", "Notion",
  "無料", "無料化", "使い方", "使ってみた", "新機能", "アプリ", "スマホ",
  "個人", "クリエイター", "副業", "時短", "自動化", "日本語対応", "初心者",
];

// ★難しすぎ/副業に関係ない話題は除外（1つでも含めば不採用）
const DEFAULT_EXCLUDE = [
  "セキュリティ", "サイバー", "防御", "脆弱性", "攻撃", "ハッキング",
  "規制", "法規制", "訴訟", "裁判", "著作権侵害", "軍事", "政府", "選挙",
  "決算", "業績", "出資", "資金調達", "買収", "上場", "株価", "IPO", "特許",
  "半導体", "GPU", "データセンター", "インフラ", "量子",
  "研究", "論文", "学会", "エンタープライズ", "企業向け", "API仕様",
];

// 記事にキーワードスコアを付ける（タイトルは重み2・要約は重み1）
function score(article, keywords) {
  const title = article.title || "";
  const sum = article.summary || "";
  let s = 0;
  for (const k of keywords) {
    if (title.includes(k)) s += 2;
    if (sum.includes(k)) s += 1;
  }
  return s;
}

// 除外ワードを1つでも含むか（タイトル or 要約）
function isExcluded(article, excludes) {
  const hay = `${article.title || ""} ${article.summary || ""}`;
  return excludes.some((k) => hay.includes(k));
}

// 直近 freshHours 時間の新着から、スコア最上位（同点は新しい方）を1件返す。無ければ null。
export async function getFreshNews(cfg = {}) {
  const feeds = Array.isArray(cfg.feeds) && cfg.feeds.length ? cfg.feeds : DEFAULT_FEEDS;
  const keywords = Array.isArray(cfg.keywords) && cfg.keywords.length ? cfg.keywords : DEFAULT_KEYWORDS;
  const excludes = Array.isArray(cfg.exclude) && cfg.exclude.length ? cfg.exclude : DEFAULT_EXCLUDE;
  const freshHours = Number(cfg.fresh_hours) > 0 ? Number(cfg.fresh_hours) : 24;
  const minScore = Number(cfg.min_score) >= 0 ? Number(cfg.min_score) : 3;

  const now = Date.now();
  const cutoff = now - freshHours * 3600 * 1000;

  const all = (await Promise.all(feeds.map((f) => fetchFeed(f)))).flat();
  const fresh = all.filter((a) => a.title && a.link && a.date >= cutoff);

  if (!fresh.length) {
    console.log(`📰 直近${freshHours}時間の新着ニュースなし（全${all.length}件中0件が対象内）`);
    return null;
  }

  // ① 難しすぎ/無関係な話題を除外 → ② 副業キーワードでスコアリング → ③ min_score以上のみ
  const excluded = fresh.filter((a) => isExcluded(a, excludes));
  if (excluded.length) {
    console.log(`📰 除外(難しい/無関係): ${excluded.length}件 → 例「${excluded[0].title}」`);
  }
  const ranked = fresh
    .filter((a) => !isExcluded(a, excludes))
    .map((a) => ({ ...a, _score: score(a, keywords) }))
    .filter((a) => a._score >= minScore)
    .sort((a, b) => b._score - a._score || b.date - a.date);

  if (!ranked.length) {
    console.log(`📰 副業向けの新着なし（min_score=${minScore}）→ 今日はHow-toにフォールバック`);
    return null;
  }

  const top = ranked[0];
  console.log(`📰 ニュース候補(副業向け): [${top.source}] ${top.title}（score=${top._score}）`);
  return { title: top.title, link: top.link, summary: top.summary, source: top.source };
}
