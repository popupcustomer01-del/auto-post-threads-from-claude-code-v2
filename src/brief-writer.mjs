// BRIEF モード（OPENAI_API_KEY 不要）の出力係。
// generate.mjs が決めた「今回の投稿設計」を、そのまま Claude が読んで本文を書ける
// 指示書 outbox/brief.md と、機械が読む outbox/brief.json に落とす。
//
// 役割分担:
//   生成の"判断"（枠・型・締め・長さ・ニュース選定・検品・投稿）= このリポジトリのJS（決定論的）
//   本文の"執筆"                                                = Claude（ルーティン）
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.mjs';

// post.json の書式見本（post.mjs が読む形）。単発とツリーで形が変わる。
const SHAPE_SINGLE = `{
  "text": "本文をここに（改行はJSONの改行エスケープで表す）",
  "imageUrl": null,
  "topic": "<topic>",
  "style": "<style>",
  "slot": "<slot>",
  "createdAt": "<ISO日時>"
}`;

const SHAPE_THREAD = `{
  "thread": [
    { "text": "1本目の本文", "imageUrl": <imageUrl> },
    { "text": "2本目の本文", "imageUrl": null }
  ],
  "kind": "<kind>",
  "topic": "<topic>",
  "style": "<style>",
  "slot": "<slot>",
  "createdAt": "<ISO日時>"
}`;

export function writeBrief({
  kind,
  prompt,
  maxContentLines,
  slot,
  style,
  topic,
  closingKey,
  lengthKey,
  imageUrl,
  threadFormat,
  article,
}) {
  const isThread = kind !== 'single';
  const now = new Date();
  const brief = {
    kind, // news=ニュース解説ツリー / value=ノウハウツリー / single=単発
    form: isThread ? 'thread' : 'single',
    slot: slot?.key || null,
    slotJst: slot?.jst || null,
    role: slot?.role || null,
    goal: slot?.goal || null,
    style,
    topic,
    closingKey,
    lengthKey: isThread ? null : lengthKey,
    maxContentLines, // ← check.mjs がこの値で行数を検品する
    imageUrl: imageUrl || null,
    threadFormat: kind === 'value' ? threadFormat : null,
    buzzResearch: slot?.buzz === true, // true なら Claude が WebSearch でバズ調査してから書く
    article: article
      ? {
          title: article.title,
          link: article.link,
          source: article.source,
          summary: article.summary || null,
        }
      : null,
    createdAt: now.toISOString(),
  };

  const buzzBlock = brief.buzzResearch
    ? `## 0. 先にバズ調査（この枠は buzz: true）

WebSearch で「今 Threads で伸びている ${topic} 系の投稿」を調べ、**フックの型・構成・リズムだけ**を参考にする。
- 実例の文章・実績・数字はコピーしない
- 他人の体験を自分の体験として書かない
- 話題のキーワードはテーマに合うときだけ取り入れる
`
    : `## 0. バズ調査

この枠は不要（brief.json の buzzResearch=false）。そのまま執筆に入る。
`;

  const newsBlock = article
    ? `## 参考: 採用されたニュース（RSSから自動選定済み）

- 見出し: ${article.title}
- 出典: ${article.source}
- リンク: ${article.link}
- 要約: ${article.summary || '（要約なし・見出しから推測しすぎない）'}
`
    : '';

  const md = `# きょうの投稿ブリーフ（本文は未執筆 / 書くのはあなた）

これは \`node src/generate.mjs --brief\` が自動生成した指示書です。
枠・型・締め方・長さ・ネタは**すでに決定済み**なので、あなたは本文だけを書きます。

| 項目 | 値 |
|---|---|
| 投稿枠 | ${brief.slot || '(枠なし)'} ${brief.slotJst || ''} 〔${brief.role || ''}〕 |
| 狙い | ${brief.goal || ''} |
| 形式 | ${isThread ? 'ツリー投稿（2〜3本）' : '単発投稿'}${kind === 'news' ? '（ニュース解説3本）' : ''} |
| 型 | ${style} |
| 締め方 | ${closingKey} |
| 長さ | ${isThread ? 'ツリー各本' : lengthKey} / 空行を除き **最大${maxContentLines}行** |
| ツリー構成 | ${brief.threadFormat || '—'} |
| 画像 | ${imageUrl ? imageUrl : 'なし（テキストのみ）'} |
| 生成日時 | ${now.toISOString()} |

${buzzBlock}
${newsBlock}
## 1. 本文を書く

下の【執筆ルール】【今回のお題】に**厳密に**従って本文を書く。ルールはすべて実測に基づく運用ルールなので、良かれと思っての逸脱はしない。

## 2. outbox/post.json に保存する

${isThread ? SHAPE_THREAD : SHAPE_SINGLE}

- \`topic\` = ${JSON.stringify(topic)}
- \`style\` = ${JSON.stringify(style)}
- \`slot\` = ${JSON.stringify(brief.slot)}
${isThread ? `- \`kind\` = ${JSON.stringify(kind)}\n- 1本目の \`imageUrl\` = ${imageUrl ? JSON.stringify(imageUrl) : 'null'}（2本目以降は必ず null）` : `- \`imageUrl\` = ${imageUrl ? JSON.stringify(imageUrl) : 'null'}`}

## 3. 機械検品にかける（必須）

\`\`\`bash
npm run check
\`\`\`

NG が出たら**指摘だけを直して**書き直し、OK になるまで繰り返す。
検品は句読点・ハッシュタグ・URL・一人称・誇大表現・出し惜しみ・行数・締め方を見ている。

## 4. 公開する

\`\`\`bash
npm run post
\`\`\`

投稿後、\`data/post-history.json\` に履歴が追記される。これを commit & push すること（次回の重複防止と学習に使う）。

---

## 【執筆ルール】

${prompt.sys}

---

## 【今回のお題】

${prompt.usr}
`;

  const dir = join(ROOT, 'outbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brief.json'), JSON.stringify(brief, null, 2));
  writeFileSync(join(dir, 'brief.md'), md);
  return brief;
}
