# Claude ルーティン運用（OPENAI_API_KEY 不要）

本文を **Claude が書く**運用の手順書。OpenAI は使わない。

## 役割分担

```
node src/generate.mjs --brief   ← 決定論的（LLM不要）
  枠(朝/夕/夜)の決定 / 型・フック・締め・長さ・切り口の乱択 / ニュース選定(RSS)
  / 投稿履歴の読み込み(重複禁止リスト・反応データ) → outbox/brief.md ＋ brief.json

Claude（ルーティン）                ← ここだけが「書く」仕事
  brief.md を読む → (buzz枠なら WebSearch) → 本文を書く → outbox/post.json

node src/check.mjs               ← 決定論的（機械検品）
  句読点/ハッシュタグ/URL/一人称/誇大表現/出し惜しみ/行数/締め方 → NGなら Claude が直す

node src/post.mjs                ← 決定論的（Threads API で公開・履歴追記）
```

つまり **OpenAI が担っていた「執筆」だけを Claude に置き換える**。判断ロジックと検品と投稿は
これまでどおりコードが持つので、挙動のブレは執筆の範囲に閉じる。

## 必要な環境変数

| 変数 | 用途 | 必須 |
|---|---|---|
| `THREADS_ACCESS_TOKEN` | 投稿・履歴の反応取得 | ✅ |
| `THREADS_USER_ID` | 予備（通常は /me から自動取得） | 任意 |
| `OPENAI_API_KEY` | **不要になった** | — |
| `PEXELS_API_KEY` | 画像枠のみ（現在は全枠 image: false なので未使用） | — |

## ルーティンに貼るプロンプト

以下をそのままルーティンの prompt に入れる（毎回まっさらな環境で動く前提の自己完結型）。

---

```
リポジトリ auto-threads で、きょうの Threads 投稿を1本つくって公開する。

手順:
1. `npm ci || npm install`
2. `npm run brief` を実行する（OpenAI は使わない。枠・型・ネタが自動で決まり
   outbox/brief.md と outbox/brief.json が出る）
3. outbox/brief.md を最後まで読む。ここに書かれた執筆ルールは実測に基づく運用ルールなので、
   良かれと思っての逸脱はしない。
4. brief.json の buzzResearch が true なら、WebSearch で「いま Threads で伸びている同ジャンルの
   投稿」を調べ、フックの型・構成・リズムだけを参考にする。実例の文章・実績・数字はコピーしない。
   他人の体験を自分の体験として書かない。
5. brief.md の指示どおり本文を書き、outbox/post.json に保存する（書式見本は brief.md の中）。
   - 直近の投稿一覧が brief.md に載っている。同じネタ・同じ言い回し・同じ切り口は禁止。
   - 反応データがあるときは、返信が付いた投稿の共通点を最優先で参考にする。
6. `npm run check` を実行する。NG が出たら指摘だけを直して post.json を書き直し、
   OK になるまで繰り返す（最大5回。それでも通らなければ公開せず中止して理由を報告する）。
7. 検品 OK なら `npm run post` で公開する。
8. 公開後、data/post-history.json を commit して push する（次回の重複防止と学習に使う）。
   コミットメッセージは `chore: 投稿履歴を更新`。

制約:
- persona.yml と .github/ は書き換えない。
- outbox/ 以外のファイルを新規作成しない。
- 公開に失敗したら履歴を汚さず、エラー全文を報告して終わる。
```

---

## 手元で試す

```bash
FORCE_SLOT=night npm run brief   # 枠を固定して指示書だけ作る（morning / evening / night）
npm run check                    # 書いた post.json を検品
npm run post                     # ← 実際に公開される。テスト時は注意
```

## GitHub Actions との関係

`.github/workflows/auto-post.yml` は `npm run generate`（= OpenAI 版）を呼んでいる。
ルーティンに完全移行するなら、この workflow の `schedule:` を止めて二重投稿を防ぐこと。
併用したい場合は「Actions=平日 / ルーティン=土日」のように担当枠を分ける。

## 作成済みのクラウドルーティン（2026-08-20）

| 枠 | cron (UTC) | JST | ルーティン |
|---|---|---|---|
| 朝 | `7 22 * * *` | 07:07 | https://claude.ai/code/routines/trig_019QXHzSdREFJ8A1u7e2b67s |
| 夕 | `17 10 * * *` | 19:17 | https://claude.ai/code/routines/trig_019ZGcW7dmAXmoQcH5dwZuqA |
| 夜 | `37 11 * * *` | 20:37 | https://claude.ai/code/routines/trig_013yeT6Y4jW3T8ACMg3w7hha |

- モデル: `claude-opus-5`（本文の質がアカウントの価値そのものなので上位モデルにしている）
- 作業ブランチ: `from-claude-code`（プロンプト内で `git checkout` している）
- **現在すべて無効（enabled: false）**

### 有効化する前に必要な2つ

1. **クラウド環境に `THREADS_ACCESS_TOKEN` を登録する**
   ルーティンはローカルの `.env` を読めない。https://claude.ai/code の環境設定で登録する。
   未登録のまま動かすと `npm run post` が「必要な環境変数が未設定です」で止まる（投稿はされない）。

2. **`main` の GitHub Actions cron を止める**
   `main` の `.github/workflows/auto-post.yml` は今も1日3回 OpenAI 版で投稿している。
   ルーティンを有効にすると**1日6投稿**になる。GitHub の Actions タブ → 「Threads 自動投稿」→
   `···` → Disable workflow で止めるのが、`main` のコードを触らずに済む方法。

この2つが済んだら、ルーティンを有効化する（3つとも）。
