// =====================================================================
// キャラデータ（1キャラ＝1ブロック。キャラを増やすときは最後に足す）
//
//   id         … chr_ + 3桁の番号。図鑑の番号になる。一度決めたら変えない
//   name       … 名前　category … 分類（★1で表示）
//   story      … stories/（id）.js に図鑑の文章があるなら true
//   art        … 画像の版番号。0 は画像なし（仮の絵を表示）
//                1 以上なら img/（id）_（枠）_（版番号）.webp と _s.webp（小さい画像）を読む
//                例）art: { base: 1 } → img/chr_022_base_1.webp と img/chr_022_base_1_s.webp
//                画像を差し替えるときは、新しい版番号でファイルを置き、ここの数字を上げる
//   hue, shape … 画像がないときの仮の絵の色と形
//   base_weight, base_height … 体重・身長の基準（ここから多い方にも少ない方にも伸びる）
//   speed_bias など … すばやさ・かしこさ・うんのよさの傾向（÷5が出発点）、食欲の基準
//   likely_natures … 出やすい性格
//   element … 属性（火・水・風・土・光・闇）　tribes … 種族（2つまで）
//   cost … コスト　ratio … 攻撃寄りの度合い（0〜1）　keywords … キーワード（0〜2個）
//   skill … 固有能力の名前　ability … { trigger, cond, effect }（null なら固有能力なし）
// =====================================================================
const CHARACTERS = [
  {
    id: 'chr_001', name: 'ミナト', category: '水辺のいきもの',
    story: true, art: { base: 0, r4: 0, r5: 0 }, hue: 200, shape: 1,
    base_weight: 45, base_height: 158,
    speed_bias: 520, wisdom_bias: 600, luck_bias: 450, appetite_bias: 480,
    likely_natures: ['のんき', 'さみしがり'],
    element: '水', tribes: ['水辺'], cost: 3, ratio: 0.4, keywords: [], skill: '潮だまり',
    ability: { trigger: 'turnEnd', effect: { type: 'heal', target: 'lowestAlly', amount: 2 } }
  },
  {
    id: 'chr_002', name: 'コハク', category: '森のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 35, shape: 1,
    base_weight: 12, base_height: 60,
    speed_bias: 700, wisdom_bias: 420, luck_bias: 520, appetite_bias: 610,
    likely_natures: ['やんちゃ', 'くいしんぼう'],
    element: '風', tribes: ['森'], cost: 2, ratio: 0.6, keywords: ['飛行'], skill: '木の実拾い',
    ability: { trigger: 'play', effect: { type: 'energy', amount: 1 } }
  },
  {
    id: 'chr_003', name: 'ルゥ', category: '夜空のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 255, shape: 2,
    base_weight: 6, base_height: 40,
    speed_bias: 620, wisdom_bias: 720, luck_bias: 600, appetite_bias: 300,
    likely_natures: ['てれや', 'ロマンチスト'],
    element: '光', tribes: ['夜'], cost: 5, ratio: 0.65, keywords: ['飛行'], skill: '流れ星',
    ability: { trigger: 'turnStart', effect: { type: 'damage', target: 'randomEnemy', amount: 1 } }
  },
  {
    id: 'chr_004', name: 'ガンテツ', category: '岩山のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 20, shape: 0,
    base_weight: 180, base_height: 210,
    speed_bias: 250, wisdom_bias: 380, luck_bias: 420, appetite_bias: 800,
    likely_natures: ['がんこ', 'まじめ'],
    element: '土', tribes: ['岩山'], cost: 4, ratio: 0.25, keywords: ['守護', '反撃'], skill: '岩のかまえ',
    ability: null
  },
  {
    id: 'chr_005', name: 'シズク', category: '雨のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 190, shape: 0,
    base_weight: 3.2, base_height: 28,
    speed_bias: 560, wisdom_bias: 540, luck_bias: 680, appetite_bias: 220,
    likely_natures: ['ひかえめ', 'すなお'],
    element: '水', tribes: ['雨', '水辺'], cost: 2, ratio: 0.45, keywords: ['射程'], skill: 'しずくの矢',
    ability: { trigger: 'attack', effect: { type: 'status', status: 'freeze', target: 'attackTarget' } }
  },
  {
    id: 'chr_006', name: 'ホムラ', category: '火山のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 8, shape: 2,
    base_weight: 70, base_height: 175,
    speed_bias: 680, wisdom_bias: 400, luck_bias: 380, appetite_bias: 700,
    likely_natures: ['負けず嫌い', 'せっかち'],
    element: '火', tribes: ['火山'], cost: 4, ratio: 0.65, keywords: ['先制'], skill: '逆鱗',
    ability: { trigger: 'hurt', cond: { type: 'hpHalf' }, effect: { type: 'buff', target: 'self', atk: 2 } }
  },
  {
    id: 'chr_007', name: 'ツムギ', category: '草原のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 95, shape: 1,
    base_weight: 25, base_height: 110,
    speed_bias: 450, wisdom_bias: 620, luck_bias: 560, appetite_bias: 500,
    likely_natures: ['おっとり', 'しっかりもの'],
    element: '土', tribes: ['草原'], cost: 3, ratio: 0.3, keywords: [], skill: 'わた帽子',
    ability: { trigger: 'play', effect: { type: 'buff', target: 'allAllies', hp: 1 } }
  },
  {
    id: 'chr_008', name: 'ヨイチ', category: '風のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 160, shape: 2,
    base_weight: 18, base_height: 95,
    speed_bias: 820, wisdom_bias: 500, luck_bias: 470, appetite_bias: 400,
    likely_natures: ['れいせい', 'マイペース'],
    element: '風', tribes: ['空'], cost: 4, ratio: 0.6, keywords: ['先制', '連撃'], skill: 'つむじ風',
    ability: null
  },
  {
    id: 'chr_009', name: 'ペコ', category: '台所のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 50, shape: 0,
    base_weight: 9, base_height: 45,
    speed_bias: 380, wisdom_bias: 350, luck_bias: 610, appetite_bias: 900,
    likely_natures: ['くいしんぼう', 'ようき'],
    element: '火', tribes: ['台所'], cost: 2, ratio: 0.2, keywords: [], skill: 'まかない',
    ability: { trigger: 'allyPlay', cond: { type: 'playedTribe', tribe: '台所' }, effect: { type: 'buff', target: 'playedAlly', atk: 1, hp: 2 } }
  },
  {
    id: 'chr_010', name: 'オボロ', category: '霧のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 280, shape: 0,
    base_weight: 30, base_height: 130,
    speed_bias: 500, wisdom_bias: 760, luck_bias: 400, appetite_bias: 350,
    likely_natures: ['きまぐれ', 'しんちょう'],
    element: '闇', tribes: ['霧'], cost: 4, ratio: 0.45, keywords: ['毒'], skill: 'かすみ隠れ',
    ability: { trigger: 'death', effect: { type: 'status', status: 'poison', target: 'allEnemies', amount: 1 } }
  },
  {
    id: 'chr_011', name: 'キララ', category: '洞くつのいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 320, shape: 2,
    base_weight: 14, base_height: 70,
    speed_bias: 540, wisdom_bias: 580, luck_bias: 720, appetite_bias: 420,
    likely_natures: ['むじゃき', 'おしゃべり'],
    element: '光', tribes: ['洞くつ'], cost: 3, ratio: 0.5, keywords: [], skill: 'きらめき',
    ability: { trigger: 'play', effect: { type: 'shield', target: 'randomAlly' } }
  },
  {
    id: 'chr_012', name: 'ダイゴ', category: '海のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 220, shape: 1,
    base_weight: 320, base_height: 260,
    speed_bias: 300, wisdom_bias: 480, luck_bias: 500, appetite_bias: 850,
    likely_natures: ['ゆうかん', 'ねぼすけ'],
    element: '水', tribes: ['海'], cost: 7, ratio: 0.45, keywords: ['守護'], skill: '大津波',
    ability: { trigger: 'play', effect: { type: 'status', status: 'freeze', target: 'allEnemies' } }
  },
  {
    id: 'chr_013', name: 'ハナビ', category: '火山のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 340, shape: 2,
    base_weight: 8, base_height: 50,
    speed_bias: 600, wisdom_bias: 450, luck_bias: 550, appetite_bias: 500,
    likely_natures: ['ようき', 'せっかち'],
    element: '火', tribes: ['夜', '火山'], cost: 3, ratio: 0.5, keywords: ['射程'], skill: '大輪',
    ability: { trigger: 'death', effect: { type: 'damage', target: 'allEnemies', amount: 1 } }
  },
  {
    id: 'chr_014', name: 'ジャム', category: '台所のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 355, shape: 0,
    base_weight: 2.5, base_height: 22,
    speed_bias: 550, wisdom_bias: 400, luck_bias: 600, appetite_bias: 800,
    likely_natures: ['くいしんぼう', 'むじゃき'],
    element: '火', tribes: ['台所'], cost: 1, ratio: 0.6, keywords: [], skill: 'つまみ食い',
    ability: { trigger: 'play', cond: { type: 'tribeCount', tribe: '台所', n: 2 }, effect: { type: 'buff', target: 'self', atk: 1, hp: 1 } }
  },
  {
    id: 'chr_015', name: 'カゲロウ', category: '草原のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 25, shape: 1,
    base_weight: 40, base_height: 150,
    speed_bias: 700, wisdom_bias: 500, luck_bias: 450, appetite_bias: 500,
    likely_natures: ['れいせい', '負けず嫌い'],
    element: '火', tribes: ['草原'], cost: 5, ratio: 0.6, keywords: ['貫通'], skill: '陽炎の一閃',
    ability: { trigger: 'kill', effect: { type: 'damage', target: 'enemyLeader', amount: 2 } }
  },
  {
    id: 'chr_016', name: 'ツララ', category: '洞くつのいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 185, shape: 2,
    base_weight: 20, base_height: 90,
    speed_bias: 450, wisdom_bias: 600, luck_bias: 450, appetite_bias: 300,
    likely_natures: ['れいせい', 'いじっぱり'],
    element: '水', tribes: ['洞くつ'], cost: 3, ratio: 0.6, keywords: ['凍結'], skill: 'つららおとし',
    ability: null
  },
  {
    id: 'chr_017', name: 'マリモ', category: '水辺のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 130, shape: 0,
    base_weight: 1.5, base_height: 15,
    speed_bias: 300, wisdom_bias: 450, luck_bias: 650, appetite_bias: 400,
    likely_natures: ['のんき', 'マイペース'],
    element: '水', tribes: ['水辺'], cost: 1, ratio: 0.3, keywords: ['再生'], skill: 'ころころ',
    ability: { trigger: 'play', cond: { type: 'tribeCount', tribe: '水辺', n: 2 }, effect: { type: 'draw', amount: 1 } }
  },
  {
    id: 'chr_018', name: 'ソヨカゼ', category: '草原のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 100, shape: 1,
    base_weight: 10, base_height: 70,
    speed_bias: 750, wisdom_bias: 550, luck_bias: 500, appetite_bias: 400,
    likely_natures: ['おっとり', 'ロマンチスト'],
    element: '風', tribes: ['草原', '空'], cost: 3, ratio: 0.4, keywords: ['鼓舞'], skill: '追い風',
    ability: { trigger: 'allyPlay', cond: { type: 'playedTribe', tribe: '空' }, effect: { type: 'buff', target: 'playedAlly', atk: 1 } }
  },
  {
    id: 'chr_019', name: 'ポポ', category: '空のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 60, shape: 0,
    base_weight: 0.8, base_height: 25,
    speed_bias: 650, wisdom_bias: 350, luck_bias: 700, appetite_bias: 350,
    likely_natures: ['むじゃき', 'きまぐれ'],
    element: '風', tribes: ['空'], cost: 1, ratio: 0.55, keywords: ['飛行'], skill: 'わたげ',
    ability: { trigger: 'death', effect: { type: 'draw', amount: 1 } }
  },
  {
    id: 'chr_020', name: 'ナギ', category: '海のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 175, shape: 2,
    base_weight: 90, base_height: 200,
    speed_bias: 700, wisdom_bias: 600, luck_bias: 450, appetite_bias: 600,
    likely_natures: ['しんちょう', 'ゆうかん'],
    element: '風', tribes: ['海'], cost: 6, ratio: 0.55, keywords: ['飛行'], skill: '凪ぎ払い',
    ability: { trigger: 'attack', effect: { type: 'damage', target: 'randomEnemy', amount: 1 } }
  },
  {
    id: 'chr_021', name: 'モグ', category: '洞くつのいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 30, shape: 1,
    base_weight: 6, base_height: 35,
    speed_bias: 500, wisdom_bias: 450, luck_bias: 500, appetite_bias: 650,
    likely_natures: ['ねぼすけ', 'おくびょう'],
    element: '土', tribes: ['洞くつ'], cost: 2, ratio: 0.55, keywords: ['潜伏'], skill: '穴掘り',
    ability: { trigger: 'kill', effect: { type: 'draw', amount: 1 } }
  },
  {
    id: 'chr_022', name: '座ブラーズ', category: 'ネタ・シュール',
    story: true, art: { base: 1, r4: 0, r5: 0 }, hue: 5, shape: 0,
    base_weight: 4.5, base_height: 75,
    speed_bias: 300, wisdom_bias: 350, luck_bias: 600, appetite_bias: 200,
    likely_natures: ['おしゃべり', 'きまぐれ', 'いじっぱり'],
    element: '土', tribes: ['ネットミーム', 'ミーム生命'], cost: 4, ratio: 0.45, keywords: ['復活'], skill: '総崩れプレス',
    ability: { trigger: 'death', effect: { type: 'damage', target: 'allEnemies', amount: 1 } }
  },
  {
    id: 'chr_023', name: 'イワオ', category: '岩山のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 40, shape: 0,
    base_weight: 140, base_height: 180,
    speed_bias: 300, wisdom_bias: 500, luck_bias: 450, appetite_bias: 650,
    likely_natures: ['まじめ', 'しんちょう'],
    element: '土', tribes: ['岩山'], cost: 5, ratio: 0.35, keywords: ['盾'], skill: '岩壁',
    ability: { trigger: 'play', cond: { type: 'tribeCount', tribe: '岩山', n: 2 }, effect: { type: 'shield', target: 'allAllies' } }
  },
  {
    id: 'chr_024', name: 'ヒカリ', category: '空のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 48, shape: 1,
    base_weight: 35, base_height: 140,
    speed_bias: 600, wisdom_bias: 750, luck_bias: 650, appetite_bias: 400,
    likely_natures: ['すなお', 'しっかりもの'],
    element: '光', tribes: ['空'], cost: 8, ratio: 0.5, keywords: ['復活'], skill: '後光',
    ability: { trigger: 'play', effect: { type: 'heal', target: 'leader', amount: 5 } }
  },
  {
    id: 'chr_025', name: 'ホタル', category: '森のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 75, shape: 0,
    base_weight: 0.5, base_height: 12,
    speed_bias: 550, wisdom_bias: 500, luck_bias: 600, appetite_bias: 250,
    likely_natures: ['てれや', 'ひかえめ'],
    element: '光', tribes: ['森', '夜'], cost: 2, ratio: 0.35, keywords: ['射程'], skill: 'ともしび',
    ability: { trigger: 'turnEnd', cond: { type: 'tribeCount', tribe: '夜', n: 2 }, effect: { type: 'buff', target: 'tribeAllies', tribe: '夜', atk: 1 } }
  },
  {
    id: 'chr_026', name: 'ユキミ', category: '雨のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 210, shape: 1,
    base_weight: 22, base_height: 100,
    speed_bias: 450, wisdom_bias: 650, luck_bias: 550, appetite_bias: 350,
    likely_natures: ['おっとり', 'ロマンチスト'],
    element: '光', tribes: ['雨'], cost: 4, ratio: 0.45, keywords: ['盾', '再生'], skill: '雪見の庭',
    ability: null
  },
  {
    id: 'chr_027', name: 'コダマ', category: '森のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 150, shape: 0,
    base_weight: 4, base_height: 30,
    speed_bias: 500, wisdom_bias: 600, luck_bias: 500, appetite_bias: 300,
    likely_natures: ['おくびょう', 'おしゃべり'],
    element: '闇', tribes: ['森', '霧'], cost: 2, ratio: 0.45, keywords: [], skill: '呼び声',
    ability: { trigger: 'play', effect: { type: 'summon', token: { name: 'こだまの影', atk: 1, hp: 1, keywords: [] } } }
  },
  {
    id: 'chr_028', name: 'ノワール', category: '夜空のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 265, shape: 1,
    base_weight: 55, base_height: 165,
    speed_bias: 700, wisdom_bias: 650, luck_bias: 400, appetite_bias: 500,
    likely_natures: ['れいせい', 'いじっぱり'],
    element: '闇', tribes: ['夜'], cost: 6, ratio: 0.65, keywords: ['潜伏', '貫通'], skill: '夜喰い',
    ability: { trigger: 'kill', effect: { type: 'buff', target: 'self', atk: 1, hp: 1 } }
  },
  {
    id: 'chr_029', name: 'サギリ', category: '霧のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 300, shape: 2,
    base_weight: 16, base_height: 85,
    speed_bias: 600, wisdom_bias: 650, luck_bias: 450, appetite_bias: 350,
    likely_natures: ['きまぐれ', 'しんちょう'],
    element: '闇', tribes: ['霧'], cost: 3, ratio: 0.5, keywords: [], skill: '毒霧',
    ability: { trigger: 'attack', effect: { type: 'status', status: 'poison', target: 'attackTarget', amount: 2 } }
  },
  {
    id: 'chr_030', name: 'トロロ', category: '台所のいきもの',
    story: false, art: { base: 0, r4: 0, r5: 0 }, hue: 45, shape: 0,
    base_weight: 60, base_height: 90,
    speed_bias: 250, wisdom_bias: 400, luck_bias: 500, appetite_bias: 950,
    likely_natures: ['のんき', 'くいしんぼう'],
    element: '闇', tribes: ['台所'], cost: 5, ratio: 0.4, keywords: [], skill: 'ねばり',
    ability: { trigger: 'turnEnd', cond: { type: 'outnumbered' }, effect: { type: 'summon', token: { name: 'とろろ玉', atk: 2, hp: 2, keywords: ['守護'] } } }
  },
  {
    id: 'chr_031', name: 'マッチ＝ヴァルガルド', category: '戦争の化身（マッチ神）',
    story: true, art: { base: 1, r4: 0, r5: 0 }, hue: 20, shape: 2,
    base_weight: 900, base_height: 360,
    speed_bias: 200, wisdom_bias: 600, luck_bias: 400, appetite_bias: 800,
    likely_natures: ['負けず嫌い', 'ゆうかん', 'いじっぱり'],
    element: '土', tribes: ['マッチ神', '戦争'], cost: 9, ratio: 0.55,
    keywords: ['貫通', '反撃'], skill: '神装戦域',
    ability: { trigger: 'anyDeath', effect: { type: 'buff', target: 'self', atk: 1, hp: 1 } },
    costRule: { type: 'perDeath', amount: 1, min: 5 },
    ultimate: { name: '神装戦域・開帝', effects: [
      { type: 'damage', target: 'allEnemies', amount: 2 },
      { type: 'buff', target: 'self', atk: 3, hp: 3 }
    ] }
  }
];

// 縁：2体とも場にそろうと、2体とも攻撃+1・体力+1
const BONDS = [
  { a: 'chr_001', b: 'chr_005', name: '雨の日の友だち' },
  { a: 'chr_009', b: 'chr_014', name: '台所コンビ' },
  { a: 'chr_004', b: 'chr_023', name: '岩山の兄弟' },
  { a: 'chr_003', b: 'chr_025', name: '夜空の灯り' },
  { a: 'chr_010', b: 'chr_029', name: '霧の双子' },
  { a: 'chr_008', b: 'chr_018', name: '風の道' }
];
