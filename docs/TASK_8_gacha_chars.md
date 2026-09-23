# 依頼8：キャラ3体の追加、ガチャを2種類に分ける、クエスト9ステージ

依頼7まで終わっている前提。新しいキャラ3体を入れ、ガチャを「通常」「限定」の2種類に分け、9ステージを追加する。
**戦闘の計算・ステージの中身・文章はすべて用意済み**。Codexはガチャの仕組みと画面、データの追加を行う。

## 0. 用意してあるファイル（アップロード済み）

| ファイル | 中身 |
|---|---|
| `js/battle.js` | **置き換え**。3体の技と弱点、13体ぶんの補正値、回復の目減りなどを反映 |
| `js/team.js` | **置き換え**。3体の集団戦用の技と補正値 |
| `data/stages.js` | **置き換え**。42ステージ（既存33＋新しい9） |
| `data/gachas.js` | **新規**。ガチャの一覧（通常・限定） |
| `data/battle-effects.js` | **置き換え**。13体ぶんの「戦闘時の効果」 |
| `stories/chr_011.js`〜`chr_013.js` | 新規。★1〜★5の文章 |
| `combat/chr_011.js`〜`chr_013.js` | 新規。戦闘能力の文章 |
| `img/chr_011_base_1.webp` ほか | 新規。3体の画像（大小） |
| `img/banner_normal_1.webp`／`img/banner_limited_1.webp` | 新規。ガチャのバナー画像 |

読み込み順：`data/characters.js` → `data/gachas.js` → `data/rules.js` → `js/battle.js` → `js/team.js` → `data/stages.js` → `data/team-stages.js` → `js/game.js`

## 1. キャラ3体を `data/characters.js` に追加

既存の形式に合わせて、末尾に次の3体を足す。

```js
{
  id: 'chr_011', name: 'カンカラッチ', title: '踏切音の化身', category: 'マッチ神', kind: '文化種',
  grade: 'E', resolve: 'mid', tags: ['近接', '音', '領域', '拘束'],
  stats: { atk: 50, def: 42, wis: 55, spd: 70, sta: 45, amb: 33 },
  story: true, combat: true, art: { base: 1, r4: 0, r5: 0 }, hue: 20,
  base_weight: 65, base_height: 210,
  speed_bias: 800, wisdom_bias: 500, luck_bias: 450, appetite_bias: 400,
  likely_natures: ['せっかち', 'やんちゃ', 'おしゃべり']
},
{
  id: 'chr_012', name: 'マッチ＝ネガヴォイド', title: '心淵次元の化身', category: 'マッチ神', kind: '概念種',
  grade: 'S', resolve: 'high', tags: ['遠距離', '分析', '精神干渉', '長期戦', '拘束'],
  stats: { atk: 58, def: 52, wis: 112, spd: 78, sta: 62, amb: 72 },
  story: true, combat: true, art: { base: 1, r4: 0, r5: 0 }, hue: 280,
  base_weight: 400, base_height: 300,
  speed_bias: 700, wisdom_bias: 950, luck_bias: 500, appetite_bias: 200,
  likely_natures: ['れいせい', 'しんちょう', 'ひかえめ']
},
{
  id: 'chr_013', name: 'タメリス', title: '備蓄の化身', category: 'マッチ神', kind: '欲望種',
  grade: 'A', resolve: 'high', tags: ['遠距離', '飛行', '長期戦', '領域'],
  stats: { atk: 48, def: 62, wis: 84, spd: 66, sta: 96, amb: 70 },
  story: true, combat: true, art: { base: 1, r4: 0, r5: 0 }, hue: 15,
  base_weight: 120, base_height: 200,
  speed_bias: 600, wisdom_bias: 800, luck_bias: 700, appetite_bias: 900,
  likely_natures: ['しっかりもの', 'しんちょう', 'くいしんぼう']
}
```

図鑑は13体になる（図鑑の総数・コンプ報酬の計算も13体に合わせる）。

## 2. ガチャを2種類に分ける

これまでガチャは1つだった。`data/gachas.js` を使って**ガチャを選ぶ形**にする。

### data/gachas.js の中身

| 名前 | 意味 |
|---|---|
| `GACHAS` | ガチャの一覧。`id` `name` `subtitle` `banner` `price`（1回）`price10`（10回）`chars`（出るキャラ）`guarantee`（10回の確定）`guaranteeText` `limited` `open` `note` |
| `LIMITED_ONLY` | 限定のあいだ、通常ガチャから出ないキャラ |
| `GACHA_RATES` | レアリティの確率（どのガチャも同じ） |

いまの中身は次の2つ。

| ガチャ | 値段 | 出るキャラ | 10回の確定 |
|---|---|---|---|
| 通常ガチャ vol.1 | 100／1000 | chr_001〜chr_010 | ★3以上が1体 |
| 万象顕現ガチャ Vol.1（限定） | 300／3000 | タメリス・ネガヴォイド・カンカラッチ・タルンルソルク・ヴァルガルド | **★4以上が1体** |

- キャラは、そのガチャの `chars` から**均等に**選ばれる
- レアリティは `GACHA_RATES` のとおり（どちらのガチャも同じ）
- 特異個体（0.5%）はこれまでどおり
- **抽選と個体値の生成は、これまでどおりサーバー（Edge Function）で行う**。どのガチャを引いたかをサーバーへ渡し、サーバー側が `GACHAS` と同じ定義を使って抽選する（ブラウザから出たキャラを送らない）

### ガチャ画面

- 上に**ガチャを選ぶタブか横スクロール**を置き、`banner` の画像を大きく表示する（画像は横長。幅いっぱい、角丸、タップでそのガチャを選ぶ）
- バナーの下に「1回 ◯◯コイン」「10回 ◯◯コイン」のボタン、`guaranteeText`、`note`（あれば）、出るキャラの一覧（絵と名前）、確率の内訳（今の「排出率」の欄をガチャごとに出す）
- 限定ガチャには「限定」の印を付ける
- `open: false` のガチャは表示しない

## 3. 限定から恒常へ移すとき（今回は作業不要。仕組みだけ用意する）

恒常化のときは、次の変更だけで済むようにしておく。
1. `limited_1` の `open` を `false` にする
2. `normal_1` の `chars` に3体を足す（または新しい `normal_2` を作る）
3. `LIMITED_ONLY` を空にする

ガチャが増えても画面を変えずに済むよう、**画面は `GACHAS` を読んで作る**こと（ガチャをコードに直接書かない）。

## 4. クエスト9ステージ

`data/stages.js` に、新キャラ3体ぶんの段階1〜3が入っている（`q011_1`〜`q013_3`）。
仕組みは既存と同じなので、**クエスト一覧に13体ぶんのカードが並ぶようにする**だけでよい。
`STAGE_HINTS` にも3体ぶんのヒントが入っている。

## 5. 戦闘時の効果と絞り込み

- `data/battle-effects.js` が13体ぶんになっているので、図鑑の「戦闘時の効果」はそのまま動く
- 依頼6の絞り込みは `tags` を見ているので、3体も自動で対象になる。**挑戦前の「おすすめの絞り込み」に3体ぶんを足す**

| ボス | おすすめの絞り込み |
|---|---|
| カンカラッチ（chr_011） | 大型／高揚 |
| ネガヴォイド（chr_012） | 覚悟：高い／短期決戦 |
| タメリス（chr_013） | 短期決戦／長期戦 |

## 6. 完了の条件

1. ガチャ画面でバナーが並び、2つのガチャを選んで引ける
2. 通常ガチャからは10体、限定ガチャからは5体だけが出る（新キャラ3体は通常ガチャから出ない）
3. 10回引くと、通常は★3以上が1体、限定は★4以上が1体確定する
4. 抽選と個体値の生成が、これまでどおりサーバーで行われている
5. 図鑑が13体になり、3体の絵・★1〜★5の文章・戦闘能力・戦闘時の効果が表示される
6. クエストに9ステージが増え、段階の解放・報酬・挑戦目標が既存と同じように動く
7. 挑戦前のおすすめ絞り込みに3体ぶんが出る
8. `node tools/battle-sim.js` のラウンド数の中央が30〜50、`node tools/stage-sim.js` の勝率が段階1で約75%、段階2で約50%、段階3で約25%
9. `node --check` が `js/game.js`・`js/battle.js`・`js/team.js`・`data/stages.js`・`data/gachas.js`・`data/battle-effects.js` で通る
10. 既存の保存データで開いてもエラーが出ない（図鑑の総数が10→13に増えるだけ）

## 7. 変えてほしくないもの

- `js/battle.js`・`js/team.js`・`data/stages.js`・`data/battle-effects.js`・`stories/`・`combat/` の中身と数値
- `data/gachas.js` の値段・確定・キャラの並び
- 既存キャラのデータ

## 8. 注意

- 集団戦クエストは、新キャラ3体ぶんは**まだ作っていない**（後回し）。既存10体ぶんはそのまま動く
- バナー画像は横長。スマホ縦画面で、文字が読める大きさで表示すること
