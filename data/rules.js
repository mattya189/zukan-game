// =====================================================================
// ゲームのルールと数値（個体値の出にくさ、報酬、称号、バトルの部品など）
//   読み込み順：characters.js → artifacts.js → quests.js → rules.js → js/game.js
// =====================================================================
// ---------------------------------------------------------------------
// 性格と、性格ごとのひとこと（{name} はキャラ名に置き換わる）
// ---------------------------------------------------------------------
const NATURES = ['さみしがり','のんき','負けず嫌い','おっとり','せっかち','きまぐれ','まじめ','ひかえめ','ようき','ゆうかん','しんちょう','れいせい','てれや','がんこ','すなお','いじっぱり','おくびょう','むじゃき','やんちゃ','くいしんぼう','ねぼすけ','おしゃべり','ロマンチスト','しっかりもの','マイペース'];
const NATURE_LINES = {
  'さみしがり':'……どこにも行かない？　そばにいてくれる？',
  'のんき':'まあまあ、あわてなくても大丈夫だよ。',
  '負けず嫌い':'ランキング、次はもっと上に行くからね！',
  'おっとり':'ふわぁ……今日はいいお天気ですねぇ。',
  'せっかち':'はやく！　はやく次のところへ行こう！',
  'きまぐれ':'気が向いたら、手伝ってあげてもいいよ。',
  'まじめ':'本日もよろしくお願いいたします。',
  'ひかえめ':'あの……わたしなんかで、いいのかな。',
  'ようき':'やっほー！　会えてうれしい！',
  'ゆうかん':'どんな場所でも、先頭はまかせて。',
  'しんちょう':'足もとに気をつけて、ゆっくり進もう。',
  'れいせい':'状況を整理しよう。まずはそこからだ。',
  'てれや':'そ、そんなにじっと見ないで……。',
  'がんこ':'一度決めたことは、ぜったい曲げない。',
  'すなお':'教えてくれてありがとう。やってみるね！',
  'いじっぱり':'べつに、うれしくなんかないんだから。',
  'おくびょう':'ひっ……い、今の音、なに……？',
  'むじゃき':'ねえねえ、あれなに？　さわってもいい？',
  'やんちゃ':'じっとしてるの、たいくつ〜！',
  'くいしんぼう':'おなかすいた……おやつの時間まだ？',
  'ねぼすけ':'むにゃ……あと五分だけ……。',
  'おしゃべり':'聞いて聞いて！　今日ね、すごいことがあったの！',
  'ロマンチスト':'星がきれいな夜は、なにか起きそうな気がする。',
  'しっかりもの':'忘れ物はない？　ハンカチは持った？',
  'マイペース':'{name}は、{name}のペースでいくよ。'
};

// ---------------------------------------------------------------------
// ガチャ
// ---------------------------------------------------------------------
const RATES = [[5, 1.5], [4, 5.5], [3, 15], [2, 28], [1, 50]];
// パワー：レアリティに関係なくランダム。大きい値ほど急激に出にくくなる
//   ある値「以上」が出る確率 ＝ 10 の −(a×d + b×d²) 乗（d は最小値から何桁上か）
//   1,000以上：約1/50　1万以上：約1/1万　10万以上：約1/800万　100万以上：約1/250億　上限付近：天文学的
const POWER_RULE = { min: 100, max: 9999999, a: 1.4, b: 0.3 };
const powerChance = p => {
  const d = Math.max(0, Math.log10(p / POWER_RULE.min));
  return Math.pow(10, -(POWER_RULE.a * d + POWER_RULE.b * d * d));
};
const POWER_MILESTONES = [1000, 10000, 100000, 1000000, 9999999];

// ほかの個体値も同じ出にくさ。キャラごとに「出発点」だけが違う（上限は共通）
//   すばやさ・かしこさ・うんのよさ … キャラの傾向（speed_bias など）÷5 が出発点
//   かがやき・性格の強さ … 出発点30
const STAT_MAX = 9999999;
const statStart = (c, key) => ({
  power: POWER_RULE.min,
  speed: Math.round(c.speed_bias / 5),
  wisdom: Math.round(c.wisdom_bias / 5),
  luck: Math.round(c.luck_bias / 5),
  shine: 30,
  nature_strength: 30
}[key]);
const statChance = (v, start) => powerChance(v * POWER_RULE.min / start);

// 体重・身長・食欲は、多い方にも少ない方にも伸びる（基準からの倍率で決まる）
//   片側ごとの確率 ＝ 1/2 × 10 の −(a×e + b×e²) 乗（e は倍率の桁。10倍なら1）
//   1.5倍：約1/36　3倍：約1/7千　10倍：約1/2億　100倍（上限）：天文学的
const RATIO_RULE = { a: 7, b: 1, maxDigits: 2 };
const ratioChance = r => {
  const e = Math.abs(Math.log10(r));
  return 0.5 * Math.pow(10, -(RATIO_RULE.a * e + RATIO_RULE.b * e * e));
};
const RATIO_MILESTONES = [1.5, 3, 10, 100];

// 総合値：項目ごとの「桁」を足す（どれか1つが桁違いでも、ほかの項目の差が効く）
const totalScoreOf = i => Math.round(100 * ['power', 'speed', 'wisdom', 'luck', 'shine']
  .reduce((s, k) => s + Math.log10(Math.max(1, Number(i[k]) || 1)), 0));
const PULL_COST = { 1: 100, 10: 1000 };
const SPECIAL_RATE = 0.005;
const RELEASE_COINS = { 1: 10, 2: 20, 3: 50, 4: 150, 5: 500 };
const START_COINS = 3000;
const VAULT_CAP = 200;

// ---------------------------------------------------------------------
// 報酬
// ---------------------------------------------------------------------
const LOGIN_TABLE = [300, 300, 300, 300, 300, 300, 1000];      // 7日で一周
const STAMP_REWARD = { 1: 50, 2: 100, 3: 200, 4: 500, 5: 1000 }; // 初めてのスタンプ
const COMPLETE_REWARD = 1500;                                    // 1キャラの★1〜★5がそろった

const MISSIONS = [
  { id: 'pull',       label: 'ガチャを10回引く',     target: 10, reward: 200 },
  { id: 'release',    label: '個体を5体送り出す',     target: 5,  reward: 150 },
  { id: 'expedition', label: '探索を2回完了する',     target: 2,  reward: 200 },
  { id: 'detail',     label: '個体票を3回見る',       target: 3,  reward: 50 }
];
const MISSION_ALL_BONUS = 300;

// 探索：パワーの合計で報酬が増え、すばやさで早く帰り、うんのよさで大成功しやすい
const DESTINATIONS = [
  { id: 'field',    name: '近くの原っぱ', minutes: 5,   base: 40 },
  { id: 'forest',   name: '霧の森',       minutes: 60,  base: 320 },
  { id: 'mountain', name: '星降る山',     minutes: 480, base: 1800 }
];
const EXP_SLOTS = 2;
const PARTY_MAX = 3;

// ---------------------------------------------------------------------
// 称号：個体値が極端な個体に付く
// ---------------------------------------------------------------------
const TITLES = [
  { id: 'big',     name: '特大',     desc: '体重が基準の1.5倍以上',       test: (i, c) => i.weight >= c.base_weight * 1.5 },
  { id: 'tiny',    name: 'ちび',     desc: '体重が基準の3分の2以下',      test: (i, c) => i.weight <= c.base_weight / 1.5 },
  { id: 'tall',    name: 'のっぽ',   desc: '身長が基準の1.5倍以上',       test: (i, c) => i.height >= c.base_height * 1.5 },
  { id: 'short',   name: '豆つぶ',   desc: '身長が基準の3分の2以下',      test: (i, c) => i.height <= c.base_height / 1.5 },
  { id: 'mighty',  name: '怪力',     desc: 'パワーが1,000以上',           test: (i) => i.power >= 1000 },
  { id: 'colossal', name: '剛力無双', desc: 'パワーが1万以上',             test: (i) => i.power >= 10000 },
  { id: 'mythic',  name: '神話の力', desc: 'パワーが10万以上',            test: (i) => i.power >= 100000 },
  { id: 'swift',   name: '韋駄天',   desc: 'すばやさが出発点の10倍以上',  test: (i, c) => i.speed >= statStart(c, 'speed') * 10 },
  { id: 'sage',    name: '賢者',     desc: 'かしこさが出発点の10倍以上',  test: (i, c) => i.wisdom >= statStart(c, 'wisdom') * 10 },
  { id: 'lucky',   name: '強運',     desc: 'うんのよさが出発点の10倍以上', test: (i, c) => i.luck >= statStart(c, 'luck') * 10 },
  { id: 'shiny',   name: 'まぶしい', desc: 'かがやきが300以上',           test: (i) => i.shine >= 300 },
  { id: 'glutton', name: '大食い',   desc: '食欲がキャラ基準の1.5倍以上', test: (i, c) => i.appetite >= c.appetite_bias * 1.5 },
  { id: 'light',   name: '小食',     desc: '食欲がキャラ基準の3分の2以下', test: (i, c) => i.appetite <= c.appetite_bias / 1.5 },
  { id: 'devoted', name: '筋金入り', desc: '性格の強さが1,000以上',       test: (i) => i.nature_strength >= 1000 },
  { id: 'round',   name: 'キリ番',   desc: '出会い番号が100の倍数',        test: (i) => i.serial % 100 === 0 }
];

// ---------------------------------------------------------------------
// ランキング・表示
// ---------------------------------------------------------------------
const RANK_SPECS = [
  ['weight','desc','char'], ['weight','asc','char'], ['weight_dev','desc','all'], ['weight_dev','asc','all'],
  ['height','desc','char'], ['height','asc','char'], ['height_dev','desc','all'], ['height_dev','asc','all'],
  ['power','desc','char'], ['power','desc','all'],
  ['speed','desc','char'], ['speed','desc','all'],
  ['wisdom','desc','char'], ['wisdom','desc','all'],
  ['luck','desc','char'], ['luck','desc','all'],
  ['nature_strength','desc','char_nature'], ['nature_strength','desc','nature'],
  ['shine','desc','char'], ['shine','desc','all'],
  ['appetite','desc','char'], ['appetite','asc','char'],
  ['serial','asc','char'],
  ['total_score','desc','char'], ['total_score','desc','all']
];
const RECORD_SPECS = [
  ['weight','desc'], ['weight','asc'], ['height','desc'], ['height','asc'],
  ['power','desc'], ['speed','desc'], ['wisdom','desc'], ['luck','desc'],
  ['shine','desc'], ['appetite','desc'], ['appetite','asc'], ['total_score','desc']
];
const STAT_LABEL = { weight:'体重', height:'身長', power:'パワー', speed:'すばやさ', wisdom:'かしこさ', luck:'うんのよさ', nature_strength:'性格', shine:'かがやき', appetite:'食欲', serial:'出会い番号', total_score:'総合', weight_dev:'体重のズレ率', height_dev:'身長のズレ率' };
const DIR_WORDS = {
  weight: { desc:'重い順', asc:'軽い順' }, height: { desc:'高い順', asc:'低い順' },
  appetite: { desc:'大食い順', asc:'小食順' }, serial: { asc:'番号が若い順' },
  weight_dev: { desc:'規格外に重い順', asc:'規格外に軽い順' }, height_dev: { desc:'規格外に高い順', asc:'規格外に低い順' },
  nature_strength: { desc:'性格が強い順' }
};
const dirLabel = (stat, dir) => (DIR_WORDS[stat] && DIR_WORDS[stat][dir]) || (dir === 'desc' ? '高い順' : '低い順');
const SCOPE_WORDS = { char:'このキャラで', all:'全キャラで', char_nature:'同じ性格のこのキャラで', nature:'同じ性格の全キャラで' };
const DETAIL_ROWS = [
  { stat:'weight', include:['weight','weight_dev'] }, { stat:'height', include:['height','height_dev'] },
  { stat:'power' }, { stat:'speed' }, { stat:'wisdom' }, { stat:'luck' },
  { stat:'nature_strength' }, { stat:'shine' }, { stat:'appetite' }, { stat:'serial' }, { stat:'total_score' }
];
const RANKING_STATS = [
  { stat:'total_score', dirs:['desc'], global:true },
  { stat:'power', dirs:['desc'], global:true },
  { stat:'speed', dirs:['desc'], global:true },
  { stat:'wisdom', dirs:['desc'], global:true },
  { stat:'luck', dirs:['desc'], global:true },
  { stat:'shine', dirs:['desc'], global:true },
  { stat:'nature_strength', dirs:['desc'], global:true, needsNature:true },
  { stat:'weight', dirs:['desc','asc'], global:false },
  { stat:'height', dirs:['desc','asc'], global:false },
  { stat:'appetite', dirs:['desc','asc'], global:false },
  { stat:'serial', dirs:['asc'], global:false },
  { stat:'weight_dev', dirs:['desc','asc'], global:true, globalOnly:true },
  { stat:'height_dev', dirs:['desc','asc'], global:true, globalOnly:true }
];
