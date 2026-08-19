// 表記ルールの機械検品(threads-auto-post から移植・アリス仕様 2026-08-18 統合)
// プロンプトの指示だけではモデルが守らないことがあるため コード側で違反を検出し
// 呼び出し側(generate.mjs)が指摘付きで再生成する
//
// maxContentLines: 空行を除いた本文行数の上限
//   値は generate.mjs 側の LENGTH_MENU.contentLines / THREAD_CONTENT_LINES から渡される
//   （プロンプトの行数指定と検品が同じ値を共有し 基準ズレで検品NGが直らない事態を防ぐ）
// closingKey: 枠の締め方(question のときだけ問いで終わることを要求 それ以外は問い禁止)
// isLastPart: ツリーの最終本かどうか(締めルールは最終本にだけ適用)
export function validatePost(
  text,
  { maxContentLines = 10, closingKey = null, isLastPart = true } = {},
) {
  const problems = [];
  const lines = String(text)
    .split('\n')
    .filter((l) => l.trim().length > 0);

  if (/[。、]/.test(text)) problems.push('句読点「。」「、」を使っている');
  if (/[#＃]/.test(text)) problems.push('ハッシュタグを使っている');
  if (/https?:\/\//.test(text)) problems.push('リンクURLを入れている');
  if (/[僕俺]/.test(text))
    problems.push('一人称が「わたし」以外になっている(僕・俺は禁止)');
  if (/誰でも簡単に|完全放置|絶対に稼げる|絶対に損しない|月100万/.test(text))
    problems.push('NGワード(誇大表現)を使っている');
  if (/知りたくない[?？]|知りたい人は|続きは(プロフ|リプ|次)|詳しくはプロフ/.test(text))
    problems.push('中身を隠して引っ張る出し惜しみ表現がある');
  if (lines.length > maxContentLines)
    problems.push(`行数が多すぎる(空行を除き最大${maxContentLines}行にする)`);

  const questionLines = lines.filter((l) => /[?？]/.test(l)).length;
  if (questionLines > 1) problems.push('問いかけが複数ある(多くても1つ)');

  const lastLine = lines[lines.length - 1] ?? '';
  if (isLastPart && closingKey) {
    if (closingKey === 'question') {
      if (!/[?？]/.test(lastLine))
        problems.push('問いかけ枠なのに最後の行が問いで終わっていない');
    } else if (/[?？]/.test(lastLine)) {
      problems.push(
        'この枠は質問で締めない(最後の問いを削り 言い切り・アクション・余韻で締める)',
      );
    }
  }

  return problems;
}

// 検品結果を再生成プロンプト用のフィードバック文にする
export function buildFeedback(problems) {
  return `

【前回の出力は以下のルール違反で不採用 内容の方向性は保ちつつ違反だけ直して全文を書き直すこと】
- ${problems.join('\n- ')}`;
}
