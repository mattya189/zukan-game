# キャラ追加時の必須チェック

新しいキャラを追加するときは、次をすべて揃える。

- `data/characters.js`：基本データ、能力値、タグ
- `img/`：通常画像と小型画像（背景透過、全身表示）
- `stories/chr_xxx.js`：★1〜5の図鑑文章
- `combat/chr_xxx.js`：戦闘能力ページ
- `js/battle.js`：1対1の戦闘処理と `KIT_TUNE`
- `js/team.js`：集団戦専用処理がある場合
- `data/battle-effects.js`：図鑑の「ゲームでの動き」。集団戦専用効果があれば `TEAM_EFFECTS` も追加
- `data/gachas.js` とサーバー抽選：排出対象にする場合
- `index.html`：必要な読み込み設定

最後に図鑑の「戦闘能力」タブをスマホ幅で開き、「ゲームでの動き」が表示されることを確認する。
