// 投稿履歴の読み書き・反応データ(Insights)取得・学習/重複防止テキスト生成
// threads-auto-post リポジトリから移植(2026-08-18 統合)
// 履歴は data/post-history.json に保存し、GitHub Actionsが投稿後にコミットして書き戻す
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT } from './config.mjs';

const HISTORY_PATH = join(ROOT, 'data', 'post-history.json');
const MAX_HISTORY = 200;
const METRICS_MIN_AGE_MS = 60 * 60 * 1000; // 投稿1時間後から反応を見る
const METRICS_REFRESH_MS = 6 * 60 * 60 * 1000; // 6時間ごとに最新化
const MAX_METRICS_FETCH_PER_RUN = 15; // 1回の実行で叩くinsights件数の上限
const INSIGHTS_FETCH_TIMEOUT_MS = 8_000;
const METRICS_REFRESH_BUDGET_MS = 25_000; // このステップ全体の時間上限

export function readHistory() {
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
  } catch {
    return []; // ファイル未作成・パース失敗は履歴なしとして扱う
  }
}

export function writeHistory(history) {
  const trimmed = history.slice(-MAX_HISTORY);
  if (!existsSync(dirname(HISTORY_PATH))) {
    mkdirSync(dirname(HISTORY_PATH), { recursive: true });
  }
  writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2) + '\n', 'utf8');
}

async function fetchInsights(mediaId, token) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), INSIGHTS_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(
      `https://graph.threads.net/v1.0/${mediaId}/insights?metric=likes,views,replies&access_token=${token}`,
      { signal: controller.signal },
    );
  } catch {
    return {}; // タイムアウト・ネットワークエラーは学習データ更新をスキップするだけ
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) return {};
  const data = await res.json().catch(() => ({}));
  const metrics = {};
  if (Array.isArray(data?.data)) {
    for (const item of data.data) {
      const value = item?.total_value?.value ?? item?.values?.[0]?.value;
      if (typeof value === 'number' && typeof item?.name === 'string') {
        metrics[item.name] = value;
      }
    }
  }
  return metrics;
}

// 過去の投稿のうち、反応を見る頃合いのものだけinsightsを取得して更新する
export async function refreshRecentMetrics(history, token) {
  const now = Date.now();
  const startedAt = Date.now();
  let updatedCount = 0;

  for (const record of history) {
    if (updatedCount >= MAX_METRICS_FETCH_PER_RUN) break;
    if (Date.now() - startedAt > METRICS_REFRESH_BUDGET_MS) break;

    const postedAgo = now - Date.parse(record.postedAt);
    if (postedAgo < METRICS_MIN_AGE_MS) continue;

    const lastUpdatedAgo = record.metricsUpdatedAt
      ? now - Date.parse(record.metricsUpdatedAt)
      : Infinity;
    if (lastUpdatedAgo < METRICS_REFRESH_MS) continue;

    const metrics = await fetchInsights(record.postId, token);
    if (Object.keys(metrics).length > 0) {
      record.likes = metrics.likes;
      record.views = metrics.views;
      record.replies = metrics.replies;
      record.metricsUpdatedAt = new Date().toISOString();
      updatedCount++;
    }
  }

  return history;
}

// 直近の投稿本文を「同じネタ・切り口の禁止リスト」としてプロンプトに渡すテキストを作る
// これがないとモデルは昨日何を投稿したか知らないまま書くため 既視感のある投稿を繰り返す
export function buildRecentPostsText(history, count = 10) {
  const recent = history.slice(-count).reverse();
  if (!recent.length) return '';

  const format = (r, i) =>
    `${i + 1}. 「${String(r.text || '').replace(/\n/g, ' ').slice(0, 100)}」(${String(r.postedAt || '').slice(0, 10)})`;

  return `

【直近の投稿(新しい順)】
${recent.map(format).join('\n')}

これらと同じネタ・同じ言い回し・同じ数字の組み合わせ・同じ切り口は禁止 フォロワーは全部読んでいる前提で 必ず別の話題か別の角度にすること`;
}

// Threadsのアルゴリズムはいいねよりリプライ(会話)を強く重視するため
// リプライを重み付けしたスコアで投稿の良し悪しを判定する
function engagementScore(r) {
  return (r.replies ?? 0) * 10 + (r.likes ?? 0);
}

// 反応が良かった投稿・悪かった投稿の傾向をプロンプトに渡すテキストを作る
export function buildLearningsText(history) {
  const withMetrics = history.filter((r) => typeof r.likes === 'number');
  if (withMetrics.length < 3) return '';

  const sorted = [...withMetrics].sort((a, b) => engagementScore(b) - engagementScore(a));
  const top = sorted.slice(0, 3);
  const bottom = sorted.slice(-3).reverse();

  const format = (r) =>
    `- 「${String(r.text || '').replace(/\n/g, ' ').slice(0, 80)}」(いいね${r.likes ?? 0} 閲覧${r.views ?? 0} 返信${r.replies ?? 0})`;

  return `

【過去投稿の反応データ(参考にする)】
反応が良かった投稿:
${top.map(format).join('\n')}

反応が薄かった投稿:
${bottom.map(format).join('\n')}

このデータから傾向を読み取り 反応が良かった投稿に近い書き方(切り口・トーン・具体性)を意識すること 特にリプライ(返信)が付いた投稿の共通点を最優先で参考にする ただし内容やネタ自体は毎回変えること`;
}

// 公開済み投稿を履歴に追記する(post.mjsから呼ぶ 失敗しても投稿自体には影響させない)
export function appendHistory({ postId, text, slot = null, kind = null }) {
  const history = readHistory();
  history.push({
    postId,
    text,
    slot,
    kind,
    postedAt: new Date().toISOString(),
  });
  writeHistory(history);
}
