// Threads keyword_search の動作確認スクリプト（投稿はしない・CI/ローカル共用）
// 使い方: node src/checkSearch.mjs  （THREADS_ACCESS_TOKEN を環境変数か .env から読む）
// ※CIでは npm install なしで動かすため、依存ゼロ（config.mjs を読み込まない）
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// .env があれば読む（環境変数が既にあればそちらを優先）
const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (!process.env.THREADS_ACCESS_TOKEN && existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const BASE = 'https://graph.threads.net/v1.0';
if (!TOKEN) {
  console.error('THREADS_ACCESS_TOKEN がありません');
  process.exit(1);
}

const dbg = await (
  await fetch(`${BASE}/debug_token?input_token=${TOKEN}&access_token=${TOKEN}`)
).json();
const d = dbg.data || {};
console.log('トークン発行日時:', d.issued_at ? new Date(d.issued_at * 1000).toISOString() : '不明');
console.log('トークンの権限  :', JSON.stringify(d.scopes || []));
console.log('keyword_search権限:', (d.scopes || []).includes('threads_keyword_search') ? '✅ あり' : '❌ なし');

const res = await fetch(
  `${BASE}/keyword_search?q=${encodeURIComponent('AI 副業')}&search_type=TOP&fields=id,text,username&limit=5&access_token=${TOKEN}`,
);
const body = await res.text();
let r;
try {
  r = JSON.parse(body);
} catch {
  console.log(`検索テスト: 不正な応答 (HTTP ${res.status})`);
  process.exit(1);
}
if (r.error) {
  console.log('検索テスト: ❌ エラー →', JSON.stringify(r.error));
  process.exit(1);
}
console.log(`検索テスト: ✅ 成功（${(r.data || []).length}件取得）`);
for (const p of r.data || []) {
  console.log(`---\n@${p.username}: ${(p.text || '').replace(/\n/g, ' ').slice(0, 100)}`);
}
