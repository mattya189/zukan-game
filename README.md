# ガチャ図鑑（フォルダ版）

## フォルダの中身

```
index.html            ゲームの入口（ほとんど触らない）
js/game.js            ゲーム本体（ほとんど触らない）
data/characters.js    キャラの一覧と縁（キャラを追加するときに触る）
data/artifacts.js     アーティファクトの一覧
data/quests.js        クエストの一覧
data/rules.js         数値やルール（出にくさ、報酬、称号、バトルの部品など）
stories/chr_022.js    キャラごとの図鑑の文章（図鑑を開いたときだけ読み込む）
img/chr_022_base_1.webp     キャラ画像（大：512px）
img/chr_022_base_1_s.webp   キャラ画像（小：160px、一覧用）
```

ファイル名とフォルダ名は、1文字でも違うと読み込めません。

## はじめての公開（GitHub Pages）

スマホのブラウザだけでできます。

1. github.com でアカウントを作る
2. 右上の「＋」→「New repository」。名前（例：zukan-game）を入れ、**Public** を選んで作成
3. **フォルダを先に作る**：「Add file」→「Create new file」で、名前の欄に次のように入力して保存（Commit changes）する。これを4回くり返す
   - `js/.keep`
   - `data/.keep`
   - `stories/.keep`
   - `img/.keep`
   （「/」を入れるとフォルダになります。.keep は空のままで大丈夫です）
4. **ファイルを置く**：
   - 一番上の場所で「Add file」→「Upload files」→ `index.html`
   - `js` フォルダを開いて「Add file」→「Upload files」→ `game.js`
   - `data` フォルダを開いて → `characters.js`、`artifacts.js`、`quests.js`、`rules.js`
   - `stories` フォルダを開いて → stories の中のファイル全部
   - `img` フォルダを開いて → img の中のファイル全部
   - それぞれ最後に「Commit changes」を押す
   - 「Add file」が見当たらないときは、ブラウザを「PC版サイトを表示」にする
5. 「Settings」→「Pages」→ Branch を「main」、フォルダを「/(root)」にして「Save」
6. 数分待つと、`https://（ユーザー名）.github.io/zukan-game/` で遊べる

## 更新するとき

**変わったファイルだけ**、同じフォルダに同じ名前でアップロードすれば上書きされます。
反映されるまで数分かかります。ゲームは10分ごとに新しいデータを取りに行くので、友達には「少し待ってから開き直してね」と伝えてください。

## キャラを追加するとき

1. `data/characters.js` の `const CHARACTERS = [ ... ]` の最後に1ブロック足す
   - `id` は続きの番号（例：`chr_031`）。一度決めたら変えない
   - 図鑑の文章があれば `story: true`
   - 画像があれば `art: { base: 1 }`（★4・★5もあれば `r4: 1, r5: 1`）
2. 図鑑の文章があれば `stories/chr_031.js` を置く
3. 画像があれば `img/chr_031_base_1.webp` と `img/chr_031_base_1_s.webp` を置く
   （★4なら `_r4_1`、★5なら `_r5_1`）
4. 縁を作るなら、`data/characters.js` の最後の `BONDS` に足す

このチャット（またはCodex）に「キャラを追加したい」と画像と設定を送れば、1〜4のファイルをまとめて作ります。

## 画像を差し替えるとき

同じ名前で上書きすると、友達のスマホに古い画像が残ることがあります。
**版番号を上げた新しい名前**（例：`chr_022_base_2.webp`）で置き、`characters.js` の `art: { base: 2 }` に変えてください。

## 確認用ファイル（preview.html）

全部を1つにまとめた確認用です。スマホで開くと、フォルダ版と同じゲームが動きます。
画像がすべて中に入るので、キャラが増えると重くなります。**公開にはフォルダ版を使ってください。**

## 注意

- 遊んだ記録は、それぞれのスマホのブラウザに保存されます
- リポジトリは公開なので、中のファイルは誰でも見られます
- GitHub Pages の目安：サイト全体1GBまで、通信量は月100GBまで
