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
  { id: 'detail',     label: '個体票を3回見る',       target: 3,  reward: 50 },
  { id: 'battle',     label: 'クエストに1回勝つ',     target: 1,  reward: 200 }
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

// =====================================================================
// 図鑑デッキバトル
//   カードは「属性・種族・キーワード・固有能力（きっかけ×条件×効果）・縁」の部品で作る。
//   攻撃と体力は、コストと能力の点数から自動で計算する。
// =====================================================================

const RULES = {
  DECK_MIN: 8,          // デッキの最小枚数（序盤のプレイヤー向け）
  DECK_SIZE: 20,        // デッキの最大枚数
  MAX_ELEMENTS: 3,      // キャラカードの属性は3種類まで
  START_HAND: 4,
  MAX_ENERGY: 10,
  HAND_MAX: 7,
  TURN_LIMIT: 20,       // これを超えたらガーディアンの残りHPで判定
  FATIGUE_DAMAGE: 2,    // 山札が切れたあと、引くたびにガーディアンが受けるダメージ
  LANES: 3
};

// ---------------------------------------------------------------------
// 属性
// ---------------------------------------------------------------------
const ELEMENTS = {
  '火': { color: '#E4572E', speed: 3 },
  '水': { color: '#2E86DE', speed: 2 },
  '風': { color: '#1FA38A', speed: 3 },
  '土': { color: '#9A6B3F', speed: 1 },
  '光': { color: '#D9A300', speed: 3 },
  '闇': { color: '#7050A8', speed: 2 }
};

// ---------------------------------------------------------------------
// キーワード（共通能力）
// ---------------------------------------------------------------------
const KEYWORDS = {
  '守護': { pts: 0.5, desc: '近くの列の敵は、このカードを優先して攻撃する' },
  '先制': { pts: 1.0, desc: '速さに関係なく、ターンの最初に行動する' },
  '連撃': { pts: 2.5, desc: '1ターンに2回攻撃する' },
  '飛行': { pts: 2.6, desc: '前列と守護を飛び越えて、後列かガーディアンを攻撃する' },
  '貫通': { pts: 1.0, desc: '倒して余ったダメージを、後ろのカードかガーディアンに与える' },
  '反撃': { pts: 0.8, desc: '攻撃を受けて生き残ったら、相手にやり返す' },
  '射程': { pts: 1.0, desc: '後列からでも攻撃できる' },
  '潜伏': { pts: 1.0, desc: '自分が攻撃するまで、狙われない' },
  '盾':   { pts: 1.0, desc: '最初に受けるダメージを1回だけ防ぐ' },
  '再生': { pts: 1.0, desc: 'ターン終了時、体力を1回復する' },
  '毒':   { pts: 1.0, desc: '攻撃した相手に毒1を与える（毎ターン毒の数だけダメージ、1ずつ減る）' },
  '凍結': { pts: 1.8, desc: '攻撃した相手は、次の行動を1回休む' },
  '復活': { pts: 2.0, desc: '一度だけ、倒れても体力1で戻ってくる' },
  '鼓舞': { pts: 1.5, desc: '隣と前後にいる味方の攻撃+1' }
};

// ---------------------------------------------------------------------
// 固有能力の文法
// ---------------------------------------------------------------------
const TRIGGERS = {
  play:      { text: '登場時',           w: 1.0 },
  attack:    { text: '攻撃する時',       w: 1.6 },
  hurt:      { text: '攻撃を受けた時',   w: 1.2 },
  kill:      { text: '敵を倒した時',     w: 0.9 },
  death:     { text: '倒れた時',         w: 0.9 },
  anyDeath:  { text: '敵味方のカードが倒れた時', w: 1.6 },
  turnStart: { text: 'ターン開始時',     w: 2.0 },
  turnEnd:   { text: 'ターン終了時',     w: 2.0 },
  allyPlay:  { text: '味方が登場した時', w: 1.3 }
};

const TARGET_WORDS = {
  randomEnemy: 'ランダムな敵', allEnemies: '敵全体', enemyLeader: '敵ガーディアン', attackTarget: '攻撃した相手', laneEnemy: '正面の敵',
  lowestAlly: '一番弱っている味方', allAllies: '味方全体', leader: '自分のガーディアン', self: '自分', playedAlly: 'その味方', randomAlly: 'ランダムな味方', tribeAllies: '味方の{tribe}'
};

function conditionText(c) {
  if (!c) return '';
  switch (c.type) {
    case 'tribeCount': return `味方の${c.tribe}が${c.n}体以上なら`;
    case 'hpHalf': return '体力が半分以下なら';
    case 'outnumbered': return '敵の場のほうが多いなら';
    case 'playedTribe': return '';
    default: return '';
  }
}

// 能力値の増減を「+1」「-1」の形で表示する
function statChangeText(label, value) {
  if (!value) return '';
  return `${label}${value > 0 ? '+' : ''}${value}`;
}

function effectText(e) {
  const t = (TARGET_WORDS[e.target] || '').replace('{tribe}', e.tribe || '');
  switch (e.type) {
    case 'damage': return `${t}に${e.amount}ダメージ`;
    case 'heal': return `${t}を${e.amount}回復`;
    case 'buff': return `${t}の${[statChangeText('攻撃', e.atk), statChangeText('体力', e.hp)].filter(Boolean).join('、')}`;
    case 'status': return e.status === 'poison' ? `${t}に毒${e.amount}` : `${t}を凍結`;
    case 'shield': return `${t}に盾`;
    case 'summon': return `「${e.token.name}」（${e.token.atk}/${e.token.hp}）を呼ぶ`;
    case 'draw': return `カードを${e.amount}枚引く`;
    case 'energy': return `エナジー+${e.amount}`;
    default: return '';
  }
}

function ultimateEffectText(ultimate) {
  return (ultimate.effects || [ultimate.effect]).filter(Boolean).map(effectText).join('、さらに');
}

function abilityText(ab) {
  if (!ab) return '';
  let trig = TRIGGERS[ab.trigger].text;
  if (ab.cond && ab.cond.type === 'playedTribe') trig = `味方の${ab.cond.tribe}が登場した時`;
  const cond = conditionText(ab.cond);
  return `${trig}${cond ? '、' + cond : ''}：${effectText(ab.effect)}`;
}

function abilityPoints(ab) {
  if (!ab) return 0;
  const e = ab.effect;
  const n = e.amount || 1;
  let v = 0;
  switch (e.type) {
    case 'damage': v = n * ({ randomEnemy: 1, laneEnemy: 1, attackTarget: 0.8, allEnemies: 2.2, enemyLeader: 0.7 }[e.target] || 1); break;
    case 'heal': v = n * ({ lowestAlly: 0.6, allAllies: 1.2, leader: 0.35, self: 0.4, playedAlly: 0.5 }[e.target] || 0.5); break;
    case 'buff': v = (Math.abs(e.atk || 0) + Math.abs(e.hp || 0) * 0.6) * ({ self: 1, allAllies: 2.2, tribeAllies: 1.4, randomAlly: 0.9, playedAlly: 0.9, allEnemies: 2.2, randomEnemy: 1, laneEnemy: 1 }[e.target] || 1); break;
    case 'status': v = e.status === 'poison'
      ? n * ({ randomEnemy: 0.9, attackTarget: 0.8, laneEnemy: 0.9, allEnemies: 2 }[e.target] || 1)
      : ({ randomEnemy: 1.2, attackTarget: 1, laneEnemy: 1.2, allEnemies: 3 }[e.target] || 1.2); break;
    case 'shield': v = { self: 0.8, randomAlly: 0.9, allAllies: 2.4 }[e.target] || 1; break;
    case 'summon': v = (e.token.atk + e.token.hp) * 0.5 + (e.token.keywords || []).length * 0.5; break;
    case 'draw': v = n * 1.5; break;
    case 'energy': v = n * 1.8; break;
  }
  return v * TRIGGERS[ab.trigger].w * (ab.cond ? 0.65 : 1);
}

// コスト・攻撃の比率・キーワード・能力から、攻撃と体力を計算する
function compileCard(def) {
  const kwPts = def.keywords.reduce((s, k) => s + KEYWORDS[k].pts, 0);
  const budget = def.cost * 2 + 3;
  const rest = Math.max(2, Math.round(budget - kwPts - abilityPoints(def.ability)));
  const atk = Math.max(0, Math.round(rest * def.ratio));
  const hp = Math.max(1, rest - atk);
  return {
    ...def,
    atk, hp,
    speed: ELEMENTS[def.element].speed,
    text: abilityText(def.ability),
    points: { budget, keywords: kwPts, ability: Math.round(abilityPoints(def.ability) * 10) / 10 }
  };
}



const CARDS = CHARACTERS.map(compileCard);
const CARD_MAP = Object.fromEntries(CARDS.map(c => [c.id, c]));
const bondsOf = id => BONDS.filter(b => b.a === id || b.b === id).map(b => ({ ...b, partner: b.a === id ? b.b : b.a }));

// ---------------------------------------------------------------------
// 作戦
// ---------------------------------------------------------------------
const POLICIES = {
  attack: { name: '攻め', desc: '安いカードから次々に出し、空いている列からガーディアンを狙う' },
  defend: { name: '守り', desc: '守護や体力の高いカードを優先し、敵の強い列をふさぐ' },
  big:    { name: 'じっくり', desc: 'コストの高いカードを優先して出す' }
};

function ruleText(r) {
  switch (r.type) {
    case 'laneNoFlying': return `深い霧：${['左', '中央', '右'][r.lane]}の列では、飛行で攻撃できない`;
    case 'turnEndPoisonAll': return `霧の毒：${r.from}ターン目から、毎ターン終了時に全カードへ毒1`;
    case 'tribeBuff': return `宴：${r.tribe}のカードは攻撃+${r.atk}、体力+${r.hp}（敵味方とも）`;
    case 'nonFlyingAtkHalf': return '強風：飛行を持たないカードは攻撃が半分';
    case 'costLimit': return `編成制限：コスト${r.max}以下のカードのみ`;
    case 'bossPulse': return `ボスの力：${r.every}ターンごとに、あなたの全カードへ${r.amount}ダメージ`;
    case 'enemyPulse': return `守護の波動：${r.every}ターンごとに、あなたの全カードへ${r.amount}ダメージ`;
    default: return '';
  }
}

// ★5で使える奥義（属性ごとに共通。登場したとき1回だけ発動）
const ULTIMATES = {
  '火': { name: '紅蓮の奥義', effect: { type: 'damage', target: 'allEnemies', amount: 2 } },
  '水': { name: '清流の奥義', effect: { type: 'heal', target: 'allAllies', amount: 3 } },
  '風': { name: '疾風の奥義', effect: { type: 'buff', target: 'allAllies', atk: 1 } },
  '土': { name: '大地の奥義', effect: { type: 'shield', target: 'allAllies' } },
  '光': { name: '天光の奥義', effect: { type: 'heal', target: 'leader', amount: 6 } },
  '闇': { name: '深淵の奥義', effect: { type: 'status', status: 'poison', target: 'allEnemies', amount: 2 } }
};

// ★3で選べる型
const STANCES = {
  normal: { name: '標準', atk: 0, hp: 0 },
  attack: { name: '攻め型', atk: 1, hp: -1 },
  guard:  { name: '守り型', atk: -1, hp: 1 }
};

// 代表個体の称号から付くオマケ
const TITLE_BONUS = {
  big: 'hp', tall: 'hp', devoted: 'hp', glutton: 'hp',
  mighty: 'atk', colossal: 'atk', mythic: 'atk', shiny: 'atk', round: 'atk',
  swift: 'speed', lucky: 'speed', sage: 'speed', tiny: 'speed', short: 'speed', light: 'speed'
};
const BONUS_WORDS = { atk: '攻撃+1', hp: '体力+1', speed: '速さ+1' };
const QUEST_DAILY_REWARDS = 5;

RULES.MAX_ARTIFACTS = 5;   // デッキに入れられるアーティファクトの数（上限）
RULES.MIN_UNITS = 5;       // デッキに必要なキャラカードの数
RULES.RELIC_SLOTS = 2;     // 設置できるアーティファクトの数

TRIGGERS.allyDeath = { text: '味方が倒れた時', w: 1.0 };
TRIGGERS.enemyDeath = { text: '敵が倒れた時', w: 1.0 };

const ARTIFACTS = ARTIFACT_LIST.map(a => ({
  ...a, type: 'artifact', art: a.art || { base: 0 },
  text: a.mode === 'instant' ? `使うと：${effectText(a.effect)}` : `設置中、${abilityText(a.ability)}`
}));
const ARTIFACT_MAP = Object.fromEntries(ARTIFACTS.map(a => [a.id, a]));
const STARTER_ARTIFACTS = ARTIFACTS.filter(a => a.price === 0).map(a => a.id);
const isArtifact = id => !!ARTIFACT_MAP[id];
const getCard = id => CARD_MAP[id] || ARTIFACT_MAP[id];
const ARTIFACT_MODES = {
  instant: { name: '発動', desc: '使うとすぐに効果が出て、なくなる' },
  relic: { name: '設置', desc: '場の外に置かれ、条件を満たすたびに効果が出る（同時に2つまで）' }
};
