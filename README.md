# auto-threads — Threads 完全自動投稿

本文を **Claude が生成**し、基本はテキストのみ（朝の枠だけローカルで簡単な引用カードを添付）、
**GitHub Actions が毎日決まった時刻に自動で公開**します。画像生成の外部API（OpenAI/Pexels）は使いません。

## 仕組み

```
GitHub Actions（cron）
  → src/generate.mjs : persona.yml を読み、Claude で本文を生成（朝枠のみローカルで引用カード画像も）→ outbox/
  → （画像がある時だけ）画像をリポジトリに commit & push
  → src/post.mjs     : Threads に公開（テキスト、または raw.githubusercontent.com のURLで画像付き）
  → トークンは手動更新（npm run refresh-token → 新トークンを Secret に貼替）
```

## あなたが編集するファイル

- **`persona.yml` だけ**（発信ジャンル・ターゲット・キャラ・投稿時刻・ネタ・NG・画像の雰囲気）

## セットアップ手順

### 1. 依存インストール（ローカルでテストする場合）
```bash
npm install
```

### 2. キーを用意
- `THREADS_ACCESS_TOKEN` / `THREADS_USER_ID` … 取得済み（`.env` にあり）
- `ANTHROPIC_API_KEY` … **文章生成(Claude)用・必須**。https://console.anthropic.com で発行
- 画像は**外部API不要**。基本テキストのみ、朝の枠だけローカルで簡単な引用カードを生成します（OpenAI/Pexelsは使いません）
- （任意）`ANTHROPIC_MODEL` … 既定は `claude-opus-4-8`。コスト重視なら `claude-sonnet-5` / `claude-haiku-4-5` を指定可

`.env.example` をコピーして `.env` を作り、値を入れます（`.env` はGitに上がりません）。

### 3. ローカルで1本テスト（実際に投稿されます）
```bash
npm run generate   # 本文＋画像を outbox/ に生成
npm run post       # ※ローカルは THREADS_IMAGE_REPO か THREADS_IMAGE_BASE_URL が必要
```

### 4. GitHubへ上げて自動化
1. GitHubで**リポジトリを作成**（画像を raw URL で配るため **public** 推奨）
2. リポジトリの **Settings → Secrets and variables → Actions** に登録：
   - `THREADS_ACCESS_TOKEN`, `THREADS_USER_ID`
   - `ANTHROPIC_API_KEY`（文章生成・必須）
   - （任意）Variables に `ANTHROPIC_MODEL`
3. このフォルダを push
4. **Actions タブ → 「Threads 自動投稿」→ Run workflow** で手動テスト
5. うまくいったら、`.github/workflows/auto-post.yml` の `cron` を好きな時刻に調整

## 投稿時刻の変更

`.github/workflows/auto-post.yml` の cron はUTC。日本時間 = UTC+9。
- 朝7:00 JST → `0 22 * * *`
- 夜21:00 JST → `0 12 * * *`

## セキュリティ

- トークン類は `.env` / GitHub Secrets のみ。コードには書かない
- `.env` `.new_token` は `.gitignore` 済み
- トークンは60日で失効 → **手動更新運用**（`npm run refresh-token` → 新トークンをSecretに貼替）。詳細は `やることリスト.md`
