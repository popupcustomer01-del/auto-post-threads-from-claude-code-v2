// outbox/post.json を機械検品する CLI。
// 従来は generate.mjs が「OpenAIに書かせる→検品→NGなら指摘つきで再生成」を内部で回していた。
// BRIEFモード（本文をClaudeが書く運用）では、その検品だけを外から呼べるようにして
// Claude 自身が「書く→検品→直す」を回せるようにする。
//
// 使い方: npm run check
//   OK  → exit 0
//   NG  → 指摘を出して exit 1（指摘だけを直して post.json を書き直し もう一度実行する）
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.mjs';
import { validatePost } from './validate.mjs';

const postPath = join(ROOT, 'outbox', 'post.json');
const briefPath = join(ROOT, 'outbox', 'brief.json');

if (!existsSync(postPath)) {
  console.error('❌ outbox/post.json がありません。先に本文を書いて保存してください。');
  process.exit(1);
}

let post;
try {
  post = JSON.parse(readFileSync(postPath, 'utf8'));
} catch (e) {
  console.error('❌ outbox/post.json がJSONとして壊れています: ' + e.message);
  process.exit(1);
}

// 検品条件（行数上限・締め方）は brief.json を正とする。
// 無い場合は安全側の既定値にフォールバックする。
let brief = {};
if (existsSync(briefPath)) {
  try {
    brief = JSON.parse(readFileSync(briefPath, 'utf8'));
  } catch {
    console.log('⚠️ brief.json を読めませんでした → 既定の条件で検品します');
  }
} else {
  console.log('⚠️ brief.json がありません → 既定の条件で検品します');
}
const maxContentLines = brief.maxContentLines ?? 12;
const closingKey = brief.closingKey ?? null;

const isThread = Array.isArray(post.thread) && post.thread.length > 0;
const segments = isThread ? post.thread : [post];

// --- 形の検査（post.mjs が読める形になっているか）---
const shapeProblems = [];
segments.forEach((s, i) => {
  const label = isThread ? `${i + 1}本目` : '本文';
  if (typeof s?.text !== 'string' || !s.text.trim())
    shapeProblems.push(`${label}: text が空です`);
  if (s?.imageUrl && typeof s.imageUrl !== 'string')
    shapeProblems.push(`${label}: imageUrl は文字列か null にしてください`);
  if (isThread && i > 0 && s?.imageUrl)
    shapeProblems.push(`${label}: 画像は1本目だけです（2本目以降は null）`);
});
if (isThread && post.thread.length > 3)
  shapeProblems.push('ツリーは最大3本です');
if (brief.form === 'thread' && !isThread)
  shapeProblems.push('この枠はツリー投稿の指定です（thread 配列にしてください）');
if (brief.form === 'single' && isThread)
  shapeProblems.push('この枠は単発投稿の指定です（text にしてください）');
if (brief.imageUrl && segments[0]?.imageUrl !== brief.imageUrl)
  shapeProblems.push(`1本目の imageUrl が brief と違います（正: ${brief.imageUrl}）`);

// --- 本文の検査（表記ルール・行数・締め方）---
const textProblems = segments.flatMap((s, i) =>
  validatePost(String(s?.text ?? ''), {
    maxContentLines,
    closingKey,
    isLastPart: i === segments.length - 1,
  }).map((m) => (isThread ? `${i + 1}本目: ${m}` : m)),
);

const problems = [...shapeProblems, ...textProblems];

console.log(
  `🔍 検品: ${isThread ? `ツリー${segments.length}本` : '単発'} / 行数上限=${maxContentLines}行 / 締め=${closingKey ?? '指定なし'}`,
);
segments.forEach((s, i) => {
  const lines = String(s?.text ?? '').split('\n').filter((l) => l.trim()).length;
  const chars = String(s?.text ?? '').replace(/\s/g, '').length;
  console.log(`   ${isThread ? `${i + 1}本目` : '本文'}: ${lines}行 / ${chars}字`);
});

if (!problems.length) {
  console.log('✅ 検品OK → npm run post で公開できます');
  process.exit(0);
}

console.error('\n❌ 検品NG（下の指摘だけを直して post.json を書き直し もう一度 npm run check）');
for (const m of problems) console.error('   - ' + m);
process.exit(1);
