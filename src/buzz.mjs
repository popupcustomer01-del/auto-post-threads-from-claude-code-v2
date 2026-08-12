// 投稿生成の直前に「今バズっている投稿」をWeb検索でリサーチする（Claudeのweb_searchサーバーツール使用）。
// 目的: 毎回同じ型の量産を避け、実際に伸びている投稿のフック・構成を真似られるようにする。
// 失敗したら null を返し、呼び出し側は従来どおりリサーチなしで生成する（生成を止めない）。
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

export async function getBuzzExamples(theme) {
  const anthropic = new Anthropic();

  const prompt = `あなたはSNSグロースのリサーチャーです。Web検索を使って、日本語のThreads（Meta社のSNS）で「今」伸びている投稿を調べてください。

対象ジャンル: AI活用 × 副業（初心者向け）／在宅ワーク／ChatGPT活用術
今日の投稿テーマ: ${theme}

調べること:
1. 対象ジャンルで最近バズった投稿の「1行目（フック）」の実例を3〜5個（出典アカウント名があれば併記）
2. それらの構成・リズムの特徴（改行の仕方 締め方 絵文字の使い方）
3. 今このジャンルで話題になっているキーワードや切り口を2〜3個

出力ルール:
- この回答はそのまま別のAI（投稿ライター）に資料として渡します 前置きや感想は書かない
- 箇条書きで簡潔に 全体で500字以内
- 実例が見つからない項目は無理に埋めず「見つからず」と書く`;

  try {
    let messages = [{ role: "user", content: prompt }];
    let res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2500,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
      messages,
    });

    // サーバーツールのループが一時停止した場合は続きを要求する（最大3回）
    for (let i = 0; i < 3 && res.stop_reason === "pause_turn"; i++) {
      messages = [...messages, { role: "assistant", content: res.content }];
      res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2500,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
        messages,
      });
    }

    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) return null;
    console.log("🔎 バズ実例リサーチ:\n" + text + "\n");
    return text;
  } catch (e) {
    console.log("🔎 バズ実例リサーチ失敗（リサーチなしで生成継続）: " + e.message);
    return null;
  }
}
