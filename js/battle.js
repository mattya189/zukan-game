// =====================================================================
// 対戦の仕組み（1対1）　js/battle.js
//   使い方：
//     const res = runBattle({
//       a: { ch: キャラ（data/characters.js の1体）, ind: 個体（power, speed, wisdom を使う。省略可） },
//       b: { ch: ..., ind: ... },
//       stage: { name: '古戦場', features: ['戦場', '開けた場所'], events: [], enemyState(ctx, enemy) {} },  // 省略可
//       seed: 12345   // 省略するとランダム
//     });
//     res.winner … 0（a の勝ち）/ 1（b の勝ち）/ null（引き分け）
//     res.log    … 実況（{ round, kind, text, side, dmg, hpA, hpB, note }）。kind は stage/round/talk/info/skill/big/hit/miss/event
//     res.A, res.B … { name, hp, maxHp }　　res.rounds, res.reason
//   キャラに必要な項目：id, name, grade, resolve, tags, stats{atk,def,wis,spd,sta,amb}
//   クエスト用：stage.enemyPower（敵の強さ）、stage.enemyState(ctx, 敵, 自分)、res.state（挑戦目標の判定用の記録）
//   集団戦は js/team.js（このファイルの部品を使う）
//   新しいキャラを追加するときは、FIGHTER_KITS に部品を足し、KIT_TUNE に補正値（最初は1）を足す
// =====================================================================

const BATTLE_RULES = {
  MAX_ROUNDS: 60,
  BASE_HP: 560,          // 体力 ＝ (BASE_HP + 持久力 × HP_PER_STA) × 等級の倍率
  HP_PER_STA: 6,
  BASE_DMG: 18.6,          // 1回の攻撃の基本ダメージ
  STAT_FLOOR: 35,        // 能力値の差を縮めるための下駄（実効値 ＝ 35 ＋ 0.65 × 能力値）
  STAT_SLOPE: 0.65
};

const GRADE_INFO = {
  F: { name: '微神級', mult: 0.84 }, E: { name: '小神級', mult: 0.88 }, D: { name: '常神級', mult: 0.92 },
  C: { name: '強神級', mult: 0.96 }, B: { name: '大神級', mult: 1.0 }, A: { name: '超神級', mult: 1.05 },
  S: { name: '神話級', mult: 1.1 }, ORIGIN: { name: '特殊等級', mult: 1.0 }
};
const GRADE_ORDER = ['F', 'E', 'D', 'C', 'B', 'A', 'S'];
const RESOLVE_INFO = { low: { name: '低い', mental: 1.0 }, mid: { name: 'ふつう', mental: 0.6 }, high: { name: '高い', mental: 0.3 } };

// ---------------------------------------------------------------------
// 舞台の特徴（両者に効く。性質タグや部品の uses を見て効果が変わる）
// ---------------------------------------------------------------------
const STAGE_FEATURES = {
  岩場:     { text: '岩を使う能力が強くなる' },
  夜空:     { text: '観測がたまりやすい' },
  反響:     { text: '音の攻撃が強くなる' },
  静寂:     { text: '音の攻撃が弱くなる' },
  騒音:     { text: '音の攻撃が乱れやすい' },
  寒冷:     { text: '風邪の効きが強くなり、素早さが少し下がる' },
  強風:     { text: '飛び道具が逸れやすく、帆走や飛行が強くなる' },
  無風:     { text: '帆走や風を使う能力が弱くなる' },
  狭所:     { text: '距離を取りにくく、近接型が有利' },
  開けた場所: { text: '距離を取りやすく、遠距離型が有利' },
  戦場:     { text: '戦いが激しくなりやすい' },
  安らぎ:   { text: '怒りや興奮による強化が弱まる' },
  小動物:   { text: 'かわいいものに弱いキャラが気を取られる' },
  生命の気配: { text: '精神に作用する能力が強くなる' },
  祭壇:     { text: '領域を作る能力が安定しやすい' },
  歓声:     { text: '先に攻撃を当てた方が少し強くなる。自信で強くなる能力も安定する' },
  異界:     { text: '3ラウンドごとに、両者の強化と弱体化が一度消える' }
};

// ---------------------------------------------------------------------
// 乱数
// ---------------------------------------------------------------------
function battleRng(seed) {
  let a = seed >>> 0;
  const r = () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  r.pick = arr => arr[Math.floor(r() * arr.length)];
  r.chance = p => r() < p;
  r.range = (lo, hi) => lo + r() * (hi - lo);
  return r;
}

// 個体値は「桁」で少しだけ効く（中央値160で1.0、10倍で約1.08、1000倍で約1.24、上限1.4）
const individualFactor = v => Math.max(0.9, Math.min(1.4, 1 + 0.08 * Math.log10(Math.max(1, v || 160) / 160)));
const effStat = v => BATTLE_RULES.STAT_FLOOR + BATTLE_RULES.STAT_SLOPE * v;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------
// 戦う者の状態
// ---------------------------------------------------------------------
function makeFighter(ch, ind, side, stage) {
  const kit = FIGHTER_KITS[ch.id];
  if (!kit) throw new Error(`${ch.id} の部品がありません`);
  const g = GRADE_INFO[ch.grade] || GRADE_INFO.B;
  const i = ind || {};
  const maxHp = Math.round((BATTLE_RULES.BASE_HP + ch.stats.sta * BATTLE_RULES.HP_PER_STA) * g.mult);
  const f = {
    side, ch, kit, name: kit.short || ch.name, grade: ch.grade, gradeMult: g.mult,
    tags: new Set(ch.tags || []), uses: new Set(kit.uses || []),
    resolve: ch.resolve || 'mid',
    base: {
      atk: effStat(ch.stats.atk) * g.mult * individualFactor(i.power),
      def: effStat(ch.stats.def) * g.mult,
      wis: effStat(ch.stats.wis) * individualFactor(i.wisdom),
      spd: effStat(ch.stats.spd) * individualFactor(i.speed),
      amb: ch.stats.amb
    },
    maxHp, hp: maxHp,
    mods: [],            // 一時的な強化・弱体化 { key, stat, mul, add, turns, tag, name }
    stun: 0, bind: 0, shield: 0, stored: 0,
    mentalRes: 1,        // 精神攻撃の受けやすさ（覚悟とキャラの特性で決まる）
    meters: {},          // キャラごとのゲージ（激しさ、分析、自信など）
    flags: {},           // 1回だけの技の使用済みなど
    dmgDealt: 0, dmgTaken: 0, hitsLanded: 0, forfeit: false, ambUsed: false,
    rec: { stunned: 0, bound: false, boundRounds: 0, debuffs: 0, spdDown: 0, evaded: 0, shieldBroken: 0, minHp: 1, hpAtR5: 1, takenByR8: 0 }   // 挑戦目標の判定用の記録
  };
  f.mentalRes = RESOLVE_INFO[f.resolve].mental * (kit.mentalRes ?? 1);
  kit.init?.(f);        // ゲージの準備（舞台の「敵の状態」より前に行う）
  return f;
}

// 舞台の特徴のうち、戦いの最初に決まるもの（性質タグを見て、両者に効く）
function applyStageFeatures(stage, fighters) {
  const has = n => stage.features.includes(n);
  for (const f of fighters) {
    const add = (stat, mul, key) => addMod(f, { key: 'stage_' + key, stat, mul, turns: 999, permanent: true });
    if (has('寒冷')) add('spd', 0.95, 'cold');
    if (has('強風')) { if (f.uses.has('wind')) f.flags.strongWind = true; if (f.tags.has('飛行')) add('spd', 1.05, 'wind'); }
    if (has('無風') && f.uses.has('wind')) f.flags.noWind = true;
    if (has('安らぎ') && f.tags.has('高揚')) add('atk', 0.9, 'calm');
    if (has('騒音') && f.uses.has('sound')) add('atk', 0.92, 'noise');
    if (has('祭壇') && f.tags.has('領域')) add('def', 1.05, 'altar');
    if (has('歓声') && f.tags.has('自信')) add('atk', 1.04, 'cheer');
  }
}

function statOf(f, stat) {
  let v = f.base[stat];
  let mul = 1;
  for (const m of f.mods) if (m.stat === stat) mul *= m.mul ?? 1;
  if (f.kit.statMul) mul *= f.kit.statMul(f, stat) ?? 1;
  return v * mul;
}
function addMod(f, m) {
  if (m.key) f.mods = f.mods.filter(x => x.key !== m.key);
  if (f.rec && m.mul < 1 && !m.permanent && !String(m.key || '').startsWith('stage_')) { f.rec.debuffs++; if (m.stat === 'spd') f.rec.spdDown++; }
  f.mods.push({ turns: 99, ...m });
}
function hasFeature(ctx, name) { return ctx.stage.features.includes(name); }

// ---------------------------------------------------------------------
// 1戦
// ---------------------------------------------------------------------
function runBattle(opts) {
  const r = battleRng(opts.seed ?? Math.floor(Math.random() * 1e9));
  const stage = { name: '無名の荒野', features: [], events: [], ...opts.stage };
  const A = makeFighter(opts.a.ch, opts.a.ind, 0, stage);
  const B = makeFighter(opts.b.ch, opts.b.ind, 1, stage);
  applyStageFeatures(stage, [A, B]);
  // その日の調子：戦うたびに攻撃と防御が少し上下する（番狂わせの源）
  for (const f of [A, B]) {
    f.form = r.range(0.82, 1.18);   // 与えるダメージに直接掛かる
  }
  const log = [];
  const ctx = {
    r, stage, A, B, round: 0, log, firstHit: null,
    foe: f => (f === A ? B : A),
    say(kind, text, extra = {}) { log.push({ round: ctx.round, kind, text, hpA: Math.max(0, Math.round(A.hp)), hpB: Math.max(0, Math.round(B.hp)), ...extra }); },
    line(f, key) { const arr = f.kit.lines[key]; return arr ? r.pick(arr) : ''; },
    feat: name => hasFeature(ctx, name),
    // 精神攻撃：受ける側の精神耐性・舞台で強さが変わる
    mental(src, tgt, power) {
      let p = power * tgt.mentalRes;
      if (ctx.feat('生命の気配')) p *= 1.35;
      if (tgt.kit.onMental) p = tgt.kit.onMental(ctx, tgt, src, p) ?? p;
      return p;
    },
    // 回避を打ち消す効果が、相手に掛かっているか
    evasionNegated: f => f.mods.some(m => m.negateEvasion) || f.bind > 0,
    damage(src, tgt, amount, info = {}) { return applyDamage(ctx, src, tgt, amount, info); },
    attack(src, tgt, opt) { return doAttack(ctx, src, tgt, opt); }
  };
  stage.setup?.(ctx);

  ctx.say('stage', `舞台：${stage.name}${stage.features.length ? `（${stage.features.join('・')}）` : ''}`);
  for (const f of [A, B]) {
    if (f.form >= 1.1) ctx.say('info', `${f.name}は絶好調だ`, { side: f.side });
    else if (f.form <= 0.9) ctx.say('info', `${f.name}は少し調子が悪そうだ`, { side: f.side });
    ctx.say('talk', `${f.name}「${ctx.line(f, 'intro')}」`, { side: f.side });
    if (f.resolve === 'high' && ctx.foe(f).tags.has('精神干渉')) ctx.say('info', `${f.name}は、死も敗北も理解したうえで戦いに臨んでいる`, { side: f.side });
  }
  stage.enemyState?.(ctx, B, A);
  for (const f of [A, B]) f.kit.onStart?.(ctx, f, ctx.foe(f));

  while (A.hp > 0 && B.hp > 0 && ctx.round < BATTLE_RULES.MAX_ROUNDS && !A.forfeit && !B.forfeit) {
    ctx.round++;
    ctx.say('round', `ラウンド ${ctx.round}`);
    roundStart(ctx);
    // 行動順：素早さ＋ゆらぎ
    const order = [A, B].sort((x, y) => (statOf(y, 'spd') * r.range(0.85, 1.15) + (y.kit.initiative?.(ctx, y) || 0)) - (statOf(x, 'spd') * r.range(0.85, 1.15) + (x.kit.initiative?.(ctx, x) || 0)));
    for (const f of order) {
      if (A.hp <= 0 || B.hp <= 0 || A.forfeit || B.forfeit) break;
      act(ctx, f);
      // 素早さの差が大きいと、たまにもう一度動く
      const foe = ctx.foe(f);
      const extra = clamp((statOf(f, 'spd') - statOf(foe, 'spd')) / 220, 0, 0.3);
      if (extra > 0 && r.chance(extra) && f.hp > 0 && foe.hp > 0 && !f.forfeit && !foe.forfeit) act(ctx, f, true);
    }
    roundEnd(ctx);
  }
  return finish(ctx);
}

function roundStart(ctx) {
  const { A, B } = ctx;
  if (ctx.feat('異界') && ctx.round % 3 === 0) {
    for (const f of [A, B]) f.mods = f.mods.filter(m => m.permanent);
    ctx.say('event', '異界の揺らぎで、両者の強化と弱体化が消えた');
  }
  for (const ev of ctx.stage.events || []) {
    if ((ev.at && ev.at === ctx.round) || (ev.every && ctx.round % ev.every === 0)) ev.run(ctx);
  }
  for (const f of [A, B]) f.kit.onRound?.(ctx, f, ctx.foe(f));
}

function roundEnd(ctx) {
  for (const f of [ctx.A, ctx.B]) {
    f.kit.onRoundEnd?.(ctx, f, ctx.foe(f));
    for (const m of f.mods) m.turns--;
    const expired = f.mods.filter(m => m.turns <= 0 && m.onExpire);
    f.mods = f.mods.filter(m => m.turns > 0);
    expired.forEach(m => m.onExpire(ctx, f));
    if (f.bind > 0) { f.rec.bound = true; f.rec.boundRounds++; f.bind--; }
    f.rec.minHp = Math.min(f.rec.minHp, Math.max(0, f.hp) / f.maxHp);
    if (ctx.round === 5) f.rec.hpAtR5 = Math.max(0, f.hp) / f.maxHp;
    if (ctx.round === 8) f.rec.takenByR8 = f.dmgTaken / f.maxHp;
  }
}

function act(ctx, f, extra = false) {
  const foe = ctx.foe(f);
  if (f.stun > 0) {
    f.stun--; f.rec.stunned++;
    if (f.kit.onStunned?.(ctx, f, foe)) return;
    ctx.say('info', `${f.name}は動けない`, { side: f.side });
    return;
  }
  // 野望力の底力（体力3割以下で一度だけ）
  if (!f.ambUsed && f.hp <= f.maxHp * 0.3) {
    f.ambUsed = true;
    addMod(f, { key: 'amb', stat: 'atk', mul: 1 + f.base.amb / 600, turns: 99, permanent: true });
    ctx.say('talk', `${f.name}「${ctx.line(f, 'low')}」`, { side: f.side, note: '野望力で攻撃が上がった' });
  }
  const action = f.kit.chooseAction?.(ctx, f, foe, extra) || { name: ctx.line(f, 'attack') };
  if (action.skip) { if (action.text) ctx.say('info', action.text, { side: f.side }); return; }
  if (action.special) { action.special(ctx, f, foe); return; }
  doAttack(ctx, f, foe, action);
}

// 攻撃：{ name, mult, hits, sure, pierce, big, label, after }
function doAttack(ctx, f, foe, opt = {}) {
  const { r } = ctx;
  const hits = opt.hits || 1;
  let total = 0, landed = 0;
  for (let h = 0; h < hits; h++) {
    if (foe.hp <= 0) break;
    // 命中
    let acc = 0.9 + (statOf(f, 'wis') - statOf(foe, 'spd')) * 0.0015;
    let eva = clamp(0.05 + (statOf(foe, 'spd') - statOf(f, 'spd')) * 0.0025, 0, 0.3);
    if (f.kit.accuracy) acc += f.kit.accuracy(ctx, f, foe) || 0;
    if (foe.kit.evasion) eva += foe.kit.evasion(ctx, foe, f, opt) || 0;
    if (ctx.feat('強風') && f.tags.has('遠距離')) acc -= 0.06;
    if (ctx.evasionNegated(foe) || opt.sure) eva = 0;
    const hitChance = opt.sure ? 1 : clamp(acc - eva, 0.4, 0.98);
    if (!r.chance(hitChance)) {
      foe.rec.evaded++;
      if (h === 0) ctx.say('miss', `${f.name}の${opt.name || '攻撃'}――${foe.name}はかわした`, { side: f.side });
      continue;
    }
    // ダメージ
    let dmg = BATTLE_RULES.BASE_DMG * (opt.mult ?? 1) / (hits > 1 ? Math.sqrt(hits) * 0.9 : 1);
    const atk = statOf(f, 'atk');
    let def = statOf(foe, 'def') * (1 - (opt.pierce || 0));
    dmg *= Math.pow(atk / def, 0.42);
    dmg *= r.range(0.7, 1.3);
    const critRate = 0.05 + statOf(f, 'wis') * 0.0008 + (f.kit.critBonus?.(ctx, f, foe) || 0);
    const crit = r.chance(critRate);
    if (crit) dmg *= 1.8;
    // 舞台
    if (ctx.feat('狭所')) { if (f.tags.has('近接')) dmg *= 1.08; if (f.tags.has('遠距離')) dmg *= 0.93; }
    if (ctx.feat('開けた場所')) { if (f.tags.has('遠距離')) dmg *= 1.08; if (f.tags.has('近接')) dmg *= 0.95; }
    if (f.uses.has('sound')) { if (ctx.feat('反響')) dmg *= 1.15; if (ctx.feat('静寂')) dmg *= 0.85; }
    if (f.uses.has('rock') && ctx.feat('岩場')) dmg *= 1.15;
    if (ctx.feat('歓声') && ctx.firstHit === f) dmg *= 1.05;
    if (ctx.rowMul) dmg *= ctx.rowMul(f, foe, opt);   // 集団戦：並び（前衛・後衛）の効果
    if (f.kit.damageOut) dmg = f.kit.damageOut(ctx, f, foe, dmg, opt) ?? dmg;
    dmg *= ((typeof KIT_TUNE !== 'undefined' && KIT_TUNE[f.ch.id]) || 1) * (f.form || 1);
    if (f.side === 1 && ctx.stage.enemyPower) dmg *= ctx.stage.enemyPower;   // ステージごとの敵の強さ
    const res = applyDamage(ctx, f, foe, dmg, { crit, big: opt.big, name: opt.name });
    total += res; landed++;
    if (!ctx.firstHit) ctx.firstHit = f;
  }
  if (landed > 0) {
    f.hitsLanded++;
    const hitsText = hits > 1 ? `（${landed}回命中）` : '';
    ctx.say(opt.big ? 'big' : 'hit', `${opt.label ? opt.label + ' ' : ''}${f.name}は${opt.name || ctx.line(f, 'attack')}。${foe.name}に${Math.round(total)}ダメージ${hitsText}`, { side: f.side, dmg: Math.round(total) });
    opt.after?.(ctx, f, foe, total);
    f.kit.onHit?.(ctx, f, foe, total, opt);
  }
  return total;
}

function applyDamage(ctx, src, tgt, amount, info = {}) {
  let dmg = amount;
  if (ctx.beforeDamage) dmg = ctx.beforeDamage(src, tgt, dmg, info);   // 集団戦：味方をかばう効果など
  if (tgt.kit.damageIn) dmg = tgt.kit.damageIn(ctx, tgt, src, dmg, info) ?? dmg;
  if (tgt.shield > 0 && !info.ignoreShield) {
    const absorbed = Math.min(tgt.shield, dmg);
    tgt.shield -= absorbed; dmg -= absorbed;
    if (tgt.shield <= 0 && dmg > 0) tgt.rec.shieldBroken++;
  }
  dmg = Math.max(0, dmg);
  tgt.hp -= dmg; tgt.dmgTaken += dmg;
  if (src) src.dmgDealt += dmg;
  tgt.kit.onDamaged?.(ctx, tgt, src, dmg, info);
  if (tgt.hp <= 0) tgt.kit.onFall?.(ctx, tgt, src);
  return dmg;
}

function finish(ctx) {
  const { A, B } = ctx;
  let winner = null, reason = '';
  if (A.forfeit || B.forfeit) { winner = A.forfeit ? B : A; reason = `${(A.forfeit ? A : B).name}が戦いをやめた`; }
  else if (A.hp > 0 && B.hp <= 0) { winner = A; reason = `${B.name}が倒れた`; }
  else if (B.hp > 0 && A.hp <= 0) { winner = B; reason = `${A.name}が倒れた`; }
  else if (A.hp <= 0 && B.hp <= 0) { reason = '相打ち'; }
  else {
    const ra = A.hp / A.maxHp, rb = B.hp / B.maxHp;
    winner = ra === rb ? null : (ra > rb ? A : B);
    reason = `${BATTLE_RULES.MAX_ROUNDS}ラウンドを戦い抜き、残り体力で判定`;
    ctx.say('info', reason);
  }
  if (winner) {
    const loser = ctx.foe(winner);
    ctx.say('talk', `${winner.name}「${ctx.line(winner, 'win')}」`, { side: winner.side });
    ctx.say('talk', `${loser.name}「${ctx.line(loser, 'lose')}」`, { side: loser.side });
  }
  const key = [...ctx.log].reverse().find(e => e.kind === 'skill' || e.kind === 'big');
  return {
    winner: winner ? winner.side : null, reason, rounds: ctx.round, log: ctx.log, stage: ctx.stage,
    A: { name: A.name, hp: Math.max(0, Math.round(A.hp)), maxHp: A.maxHp },
    B: { name: B.name, hp: Math.max(0, Math.round(B.hp)), maxHp: B.maxHp },
    key: key ? key.skill || key.text.slice(0, 24) : '地力の差',
    state: [A, B].map(f => ({ rec: f.rec, flags: f.flags, meters: f.meters, resolve: f.resolve, forfeit: f.forfeit, hp: f.hp, maxHp: f.maxHp }))
  };
}

// =====================================================================
// キャラごとの部品（技・弱点・台詞）
//   文章の技を、戦いの中の動きに置き換えたもの。
//   uses … 舞台の特徴が参照する性質（rock=岩を使う, sound=音で戦う, wind=風・帆を使う, irregular=動きが読めない）
// =====================================================================
const skill = (ctx, f, name, text, extra = {}) => ctx.say('skill', `${f.name}の「${name}」！ ${text}`, { side: f.side, skill: name, ...extra });
const gradeGap = (a, b) => GRADE_ORDER.indexOf(b.grade) - GRADE_ORDER.indexOf(a.grade);   // 相手が何段上か

const FIGHTER_KITS = {

  // ------------------------------------------------------------------ 001
  chr_001: {
    short: 'ヴァルガルド',
    uses: [],
    lines: {
      intro: ['勝負だと？　ならば戦争だ', '始めるぞ。最後まで勝敗を決める'],
      attack: ['巨大な腕で殴りつけた', '全身の装甲ごと体当たりした', '翼の刃で薙ぎ払った'],
      low: ['……面白い。ここからが戦争だ'],
      win: ['勝敗は決した。よい戦争だった'],
      lose: ['……次だ。次は勝つ']
    },
    init(f) { f.meters.fury = 0; f.meters.stage = 1; },
    // 神装戦域：激しさ（両者が与えたダメージ）で段階が上がる
    onRound(ctx, f, foe) {
      let gain = 6;
      if (ctx.feat('戦場')) gain *= 1.4;
      if (f.flags.slowWar) gain *= 0.6;
      f.meters.fury += gain;
      const intensity = f.meters.fury + (f.dmgDealt + f.dmgTaken) * 0.35;
      if (f.meters.stage === 1 && intensity >= 150) {
        f.meters.stage = 2;
        skill(ctx, f, '神装戦域・第二段階', '鎧がさらに厚くなり、翼の刃が大型化した。征服鎖の本数も増えていく');
      } else if (f.meters.stage === 2 && intensity >= 330) {
        f.meters.stage = 3;
        skill(ctx, f, '大戦神装', '全武装が最大規模まで発達した。翼は巨大化し、無数の刃と鎖が展開される');
      }
    },
    statMul(f, stat) {
      const s = f.meters.stage || 1;
      if (stat === 'atk') return [1, 1, 1.18, 1.36][s];
      if (stat === 'def') return [1, 1, 1.14, 1.3][s];
      return 1;
    },
    chooseAction(ctx, f, foe) {
      const { r } = ctx;
      // 終戦宣告：この一撃で終わらせられる、または追い詰められたとき
      if (!f.flags.endWar && f.meters.stage >= 2 && (foe.hp < foe.maxHp * 0.3 || f.hp < f.maxHp * 0.2)) {
        f.flags.endWar = true;
        return {
          name: '終戦宣告', mult: 4.2, big: true, sure: true, label: '「この一撃で戦争を終わらせる」――',
          after(ctx, f) { f.meters.stage = 1; f.meters.fury = 0; f.dmgDealt *= 0.2; f.dmgTaken *= 0.2; ctx.say('info', `${f.name}は神装戦域の強化の大部分を失った`, { side: f.side }); }
        };
      }
      // 征服鎖：速い相手・遠距離の相手を捕まえる
      if (!foe.bind && r.chance(foe.tags.has('遠距離') || statOf(foe, 'spd') > statOf(f, 'spd') ? 0.2 : 0.08)) {
        return { special(ctx, f, foe) {
          foe.bind = 2;
          skill(ctx, f, '征服鎖', `鎖が${foe.name}に巻き付き、強引に引き寄せた`);
          doAttack(ctx, f, foe, { name: '引き寄せて殴りつけた', mult: 0.8 });
        } };
      }
      // 戦神圧砕：捕まえた相手へ
      if (foe.bind > 0 && r.chance(0.45)) {
        return { name: '戦神圧砕', mult: 2.0, big: true, label: '鎖で引き寄せ――', after(ctx, f, foe) { if (r.chance(0.4)) { foe.stun = 1; } } };
      }
      return { name: ctx.line(f, 'attack') };
    },
    damageIn(ctx, f, src, dmg) { return dmg * 0.94; }   // 受けながら前進する
  },

  // ------------------------------------------------------------------ 002
  chr_002: {
    short: 'バースクライ',
    uses: ['sound'],
    mentalRes: 0.4,     // 防御能力：精神攻撃への耐性が非常に高い
    lines: {
      intro: ['生まれてしまった以上、ここから先は現実だ', '戦うなら戦え。その結果まで受け入れろ'],
      attack: ['産声衝撃を放った', '巨大な肉体で殴りつけた', '掴んで叩きつけた'],
      low: ['痛いから何だ。生きているなら痛むこともある'],
      win: ['聞こえた。お前は確かに生まれた'],
      lose: ['これも現実だ']
    },
    onStart(ctx, f, foe) {
      if (f.flags.noFirstCry) return;
      // 第一声：現実直視を付ける
      const p = ctx.mental(f, foe, 1);
      foe.flags.reality = p;
      skill(ctx, f, '第一声', `短い産声が響いた。${foe.name}は、自分の鼓動と呼吸と痛みを異常なほど鮮明に感じ始める`);
      if (foe.resolve === 'high') {
        f.flags.headOn = true;
        ctx.say('talk', `${f.name}「そうか。なら、その選択の結果を見せてみろ」`, { side: f.side, note: '覚悟の高い相手には、精神干渉をやめて真正面から戦う' });
      }
    },
    onRound(ctx, f, foe) {
      const rp = foe.flags.reality || 0;
      // 人生荷重：長期戦ほど相手の限界を自覚させる
      if (ctx.round >= 8 && ctx.round % 4 === 0) {
        const p = ctx.mental(f, foe, 1) * Math.min(1, ctx.round / 30);
        const down = clamp(0.06 * p, 0, 0.2);
        const prev = foe.mods.find(m => m.key === 'burden');
        const total = Math.min(0.35, (prev ? 1 - prev.mul : 0) + down);
        addMod(foe, { key: 'burden', stat: 'atk', mul: 1 - total, turns: 99 });
        addMod(foe, { key: 'burden2', stat: 'spd', mul: 1 - total * 0.6, turns: 99 });
        foe.flags.fatigueExposed = true;
        if (down > 0.02) skill(ctx, f, '人生荷重', `${foe.name}は、ごまかしていた疲労と痛みを一気に自覚した`);
      }
      // 初泣領域：回避と奇襲を封じる
      if (!f.flags.cry && ctx.round >= 3) { f.flags.cry = true; skill(ctx, f, '初泣領域', '呼吸音と心音が異常に強調され、隠れることも奇襲することもできなくなった'); }
      // 死への距離：瀕死の相手へ
      if (foe.hp < foe.maxHp * 0.25 && !foe.flags.deathDistance) {
        foe.flags.deathDistance = true;
        skill(ctx, f, '死への距離', `${foe.name}は、自分の肉体がどれほど死に近づいているかを理解させられた`);
        if (foe.resolve === 'low' && ctx.r.chance(0.35 * ctx.mental(f, foe, 1))) {
          foe.forfeit = true;
          ctx.say('big', `${foe.name}は戦意を失った`, { side: foe.side });
        } else {
          addMod(foe, { key: 'stand', stat: 'atk', mul: 1.08, turns: 99 });
          ctx.say('info', `${foe.name}は、それでも踏みとどまった`, { side: foe.side });
        }
      }
    },
    evasion(ctx, f) { return 0; },
    accuracy(ctx, f) { return f.flags.cry ? 0.06 : 0; },
    chooseAction(ctx, f, foe) {
      const { r } = ctx;
      // 万生大哭：中盤以降に一度
      if (!f.flags.bigCry && ctx.round >= 18 && r.chance(0.25)) {
        f.flags.bigCry = true;
        return { name: '万生大哭', mult: 3.0, big: true, sure: true, label: '無数の産声が重なり――', after(ctx, f, foe) {
          const p = ctx.mental(f, foe, 1);
          if (r.chance(0.3 + 0.5 * p)) { foe.stun = 1 + (p > 0.8 ? 1 : 0); ctx.say('info', `${foe.name}は、生まれ落ちた瞬間の感覚に呑まれ、動きを止めた`, { side: foe.side }); }
        } };
      }
      // 産声宣告：定期的に相手の攻撃を下げ、動きを止める
      if (!f.flags.headOn && ctx.round % 6 === 2) {
        return { special(ctx, f, foe) {
          const p = ctx.mental(f, foe, 1);
          addMod(foe, { key: 'decl', stat: 'atk', mul: 1 - clamp(0.28 * p, 0.04, 0.3), turns: 3 });
          skill(ctx, f, '産声宣告', `${foe.name}に「避けられない現実」を見せた。老い、別れ、失敗、そして死――`);
          if (r.chance(0.4 * p)) { foe.stun = 1; ctx.say('info', `${foe.name}は動きを止めた`, { side: foe.side }); }
        } };
      }
      // 生誕震界：精神が効きにくい相手にも振動で
      if (ctx.round % 7 === 0) return { name: '生誕震界', mult: 1.5, sure: true, label: '空間そのものが震えた――' };
      return { name: ctx.line(f, 'attack'), mult: f.flags.headOn ? 1.2 : 1.1 };
    }
  },

  // ------------------------------------------------------------------ 003
  chr_003: {
    short: 'マデランデス',
    uses: ['rock'],
    lines: {
      intro: ['命令するな。俺は面白いから戦うだけだ', '世界を作れる奴より上がいるなら、ぜひ教えてくれ'],
      attack: ['小型の夢岩を撃ち出した', '墜星を落とした', '杖と夢岩で打ち据えた'],
      low: ['まだ何か方法があるはずだ'],
      win: ['次に何が生まれるのか、見てみたいんでね'],
      lose: ['……なるほど。なら前提から変えればいい']
    },
    init(f) { f.meters.analysis = 0; f.meters.conviction = 100; },   // 分析、確信（夢が実現すると信じる力）
    onStart(ctx, f) { if (!ctx.feat('岩場')) f.flags.fewRocks = true; },
    onRound(ctx, f, foe) {
      let gain = 3 + statOf(f, 'wis') / 60;
      if (foe.uses.has('irregular')) gain *= 0.7;
      if (foe.tags.has('短期決戦') && ctx.round <= 12) gain *= 0.35;   // 準備の時間を与えない相手
      f.meters.analysis = Math.min(100, f.meters.analysis + gain);
      // 現実直視で確信が揺らぐ
      if (foe.flags && f.flags.reality) f.meters.conviction = Math.max(0, f.meters.conviction - 4 * f.flags.reality);
      if (f.meters.analysis >= 60 && !f.flags.checkmate) { f.flags.checkmate = true; skill(ctx, f, '夢詰み', `${foe.name}がどこへ逃げても、次の夢岩が待っている`); }
      // 不落城
      if (ctx.round % 5 === 0) { f.flags.fort = true; skill(ctx, f, '夢岩・不落城', '崩れなかった城壁の夢を見た岩が、周りに集まった'); } else f.flags.fort = false;
      // 創世夢岩：岩の少ない舞台で一度だけ
      if (f.flags.fewRocks && !f.flags.genesis && ctx.round >= 12 && f.meters.conviction >= 50) {
        f.flags.genesis = true;
        ctx.stage.features.push('岩場');
        skill(ctx, f, '創世夢岩（未完成）', '「ここは巨大な岩山である」――戦場が一時的に岩石地帯へ変わった');
        f.hp -= f.maxHp * 0.06;
      }
      // 夢界天星
      if (!f.flags.heaven && f.meters.analysis >= 90) {
        if (f.meters.conviction >= 50) {
          f.flags.heaven = true;
          addMod(f, { key: 'heaven', stat: 'atk', mul: 1.35, turns: 6 });
          addMod(f, { key: 'heaven2', stat: 'def', mul: 1.25, turns: 6 });
          skill(ctx, f, '夢界天星', '数百の夢岩が浮かび、戦場そのものがマデランデスの術式になった');
        } else if (!f.flags.heavenFail) {
          f.flags.heavenFail = true;
          ctx.say('info', `${f.name}の確信が揺らぎ、夢界天星の夢が岩に定着しない`, { side: f.side });
        }
      }
    },
    // 戦闘開始直後の至近距離が苦手
    damageIn(ctx, f, src, dmg, info) {
      let d = dmg;
      if (src && src.tags.has('近接') && ctx.round <= (src.tags.has('短期決戦') ? 10 : 3)) d *= src.tags.has('短期決戦') ? 1.3 : 1.15;
      if (f.flags.fort) d *= 0.5;
      // 傲岩：大技を一度だけ受け止める
      if (info.big && !f.flags.pride && ctx.r.chance(0.7)) { f.flags.pride = true; d *= 0.3; ctx.say('skill', `${f.name}の「傲岩」！ 自分こそ世界で最も硬いと信じる岩が、一撃を受け止めた`, { side: f.side, skill: '傲岩' }); }
      return d;
    },
    evasion(ctx, f) { return f.flags.mirage ? 0.08 : 0; },
    accuracy(ctx, f) { return f.meters.analysis * 0.0015; },
    critBonus(ctx, f) { return f.meters.analysis * 0.0012; },
    statMul(f, stat) { if (stat === 'atk' && f.meters.analysis < 20) return 0.85; return 1; },
    chooseAction(ctx, f, foe) {
      const { r } = ctx;
      if (ctx.round % 9 === 4 && r.chance(0.7)) {
        return { special(ctx, f, foe) {
          f.flags.mirage = true;
          skill(ctx, f, '夢岩・偽界', `景色が別の場所のように変わり、${foe.name}は距離感を狂わされた`);
          addMod(foe, { key: 'mirage', stat: 'wis', mul: 0.85, turns: 3, onExpire: () => { f.flags.mirage = false; } });
        } };
      }
      if (ctx.round % 8 === 0 && r.chance(0.55 + (statOf(f, 'wis') - statOf(foe, 'atk')) * 0.004)) {
        return { special(ctx, f, foe) { foe.stun = 1; skill(ctx, f, '夢岩・千年牢', `「千年間動かなかった夢」を見た岩が、${foe.name}を閉じ込めた`); } };
      }
      if (f.flags.checkmate && r.chance(0.35)) return { name: '夢岩・墜星（単星）', mult: 1.7, sure: true };
      if (r.chance(0.4)) return { name: '夢岩・墜星（群星）', hits: 3, sure: statOf(foe, 'spd') > statOf(f, 'spd') };
      return { name: ctx.line(f, 'attack') };
    },
    onMental(ctx, f, src, p) { return p * 0.8; }
  },

  // ------------------------------------------------------------------ 004
  chr_004: {
    short: 'タルンルソルク',
    uses: [],
    lines: {
      intro: ['大丈夫だよ。絶対かわいくなるから', 'その足、ちょっと長すぎない？'],
      attack: ['ぽかぽか叩いた', '体当たりした', 'ちょこちょこ近づいて殴った'],
      low: ['かわいいものは、ぼくが守る！'],
      win: ['ほら、かわいくなった！'],
      lose: ['……でも、かわいかったなあ']
    },
    init(f) { f.meters.cute = 0; f.meters.shrink = 0; },
    shrinkPower(foe) {
      if (foe.tags.has('飛行')) return 0.15;
      if (foe.tags.has('遠距離')) return 0.5;
      return 1;
    },
    onHit(ctx, f, foe) {
      // 縮脚愛化：当てるたびに脚を短くする
      const p = this.shrinkPower(foe) * (f.flags.longShrink ? 1.3 : 1);
      if (p <= 0.2 && !f.flags.flyNote) { f.flags.flyNote = true; ctx.say('info', `${foe.name}は脚を使わずに戦っている。縮脚愛化がほとんど効かない`, { side: f.side }); }
      if (f.meters.shrink < 10) {
        f.meters.shrink++;
        addMod(foe, { key: 'shrink', stat: 'spd', mul: 1 - clamp(0.045 * f.meters.shrink * p, 0, 0.45), turns: 99 });
        if (f.meters.shrink % 3 === 1) skill(ctx, f, '縮脚愛化', `${foe.name}の脚が短くなった`);
        if (p > 0.4) f.meters.cute += 6;
      }
    },
    // 踏込封じ：近接の相手の攻撃がときどき届かない
    evasion(ctx, f, attacker) { return attacker.tags.has('近接') ? (0.08 + (f.meters.shrink || 0) * 0.012) * this.shrinkPower(attacker) : 0; },
    chooseAction(ctx, f, foe) {
      const { r } = ctx;
      // かわいいが限界：攻撃する気がなくなる
      let cuteSkip = f.meters.cute / 420;
      if (ctx.feat('小動物')) cuteSkip += 0.1;
      if (f.flags.certified) cuteSkip *= 0.3;
      if (r.chance(clamp(cuteSkip, 0, 0.45))) return { skip: true, text: `${f.name}「……かわいい」（攻撃する気がなくなった）` };
      // 奥義
      if (!f.flags.ult && ctx.round >= 14 && r.chance(0.3)) {
        f.flags.ult = true;
        return { special(ctx, f, foe) {
          const p = this.shrinkPower ? 1 : FIGHTER_KITS.chr_004.shrinkPower(foe);
          addMod(foe, { key: 'ult', stat: 'spd', mul: 1 - 0.3 * FIGHTER_KITS.chr_004.shrinkPower(foe), turns: 99 });
          addMod(foe, { key: 'ult2', stat: 'atk', mul: 1 - 0.2 * FIGHTER_KITS.chr_004.shrinkPower(foe), turns: 4 });
          f.meters.cute += 35;
          skill(ctx, f, '全生物かわいい化・試作型', `${foe.name}をまとめて短足化した……そして「……かわいい」`);
        } };
      }
      // 超短足化：大きく重い相手ほど倒れやすい
      if (ctx.round % 7 === 0) {
        return { special(ctx, f, foe) {
          const p = FIGHTER_KITS.chr_004.shrinkPower(foe);
          const heavy = foe.tags.has('大型') ? 0.35 : 0;
          skill(ctx, f, '超短足化', `${foe.name}の脚に能力を集中させた`);
          if (r.chance((0.2 + heavy) * p)) { foe.stun = 1 + (heavy ? 1 : 0); ctx.say('info', `重心が崩れ、${foe.name}は立っていられなくなった`, { side: foe.side }); }
          f.meters.cute += 8;
        } };
      }
      return { name: ctx.line(f, 'attack') };
    },
    onDamaged(ctx, f, src, dmg) {
      if (!f.flags.certified && f.hp < f.maxHp * 0.5) { f.flags.certified = true; addMod(f, { key: 'cert', stat: 'atk', mul: 1.25, turns: 99 }); ctx.say('skill', `${f.name}の「かわいい認定」！ かわいいを傷つける奴は許さない――性格が一変した`, { side: f.side, skill: 'かわいい認定' }); }
    }
  },

  // ------------------------------------------------------------------ 005
  chr_005: {
    short: 'ダラガルド',
    uses: ['irregular'],
    lines: {
      intro: ['難しいこと考えてねえで、かかってこい', 'まあ、やるか'],
      attack: ['殴った', '掴んで地面へ叩きつけた', '野良突進でぶつかった', 'ダラ投げで放り投げた'],
      low: ['痛いけど別にいい'],
      win: ['肉食って寝るか'],
      lose: ['まあ、今日はダメな日だったんだろ']
    },
    init(f) { f.meters.decay = 0; },
    onRound(ctx, f, foe) {
      // 堕落蓄積
      let gain = 2 + (f.hp < f.maxHp * 0.5 ? 2 : 0);
      if (ctx.feat('安らぎ')) gain *= 0.6;
      if (f.flags.fastDecay) gain *= 2;
      f.meters.decay = Math.min(100, f.meters.decay + gain);
      if (!f.flags.wild && f.hp < f.maxHp * 0.5) { f.flags.wild = true; skill(ctx, f, 'ワイルド状態', '姿勢が低くなり、戦い方が巨大な野獣に近づいていく'); }
      // 理性脱衣
      if (!f.flags.strip && (f.hp < f.maxHp * 0.4 || ctx.round >= 26)) {
        f.flags.strip = true;
        const turns = foe.flags && f.flags.fatigueExposed ? 3 : 5;
        addMod(f, { key: 'strip', stat: 'atk', mul: 1.45, turns, onExpire(ctx, f) {
          const crash = f.flags.fatigueExposed ? 0.18 : 0.1;
          f.hp -= f.maxHp * crash;
          addMod(f, { key: 'crash', stat: 'atk', mul: 0.85, turns: 99 });
          ctx.say('info', `理性脱衣が解け、無視していた疲労とダメージが一気に戻ってきた`, { side: f.side });
        } });
        skill(ctx, f, '理性脱衣', '理性という服を脱いだ。恐怖も痛みも、いまは関係ない');
      }
    },
    statMul(f, stat) {
      if (stat === 'atk') return (1 + f.meters.decay * 0.004) * (f.flags.wild ? 1.15 : 1);
      if (stat === 'wis') return 1 - f.meters.decay * 0.003;
      return 1;
    },
    evasion(ctx, f, attacker, opt) {
      // 肉体防御：ほとんど避けない。ただし致命傷になる大技は野生の勘でかわすことがある
      if (opt && opt.big && !attacker.flags.mirage) return f.flags.keen ? 0.5 : 0.3;
      return -0.05;
    },
    damageIn(ctx, f, src, dmg) { return dmg * 0.9; },
    onStunned(ctx, f, foe) {
      // ダラ寝返し：倒されても転がって反撃
      if (ctx.r.chance(0.5)) { f.stun = 0; ctx.say('skill', `${f.name}の「ダラ寝返し」！ 起き上がるのが面倒なので、そのまま転がって押し潰した`, { side: f.side, skill: 'ダラ寝返し' }); doAttack(ctx, f, foe, { name: '転がり押し潰し', mult: 0.9 }); return true; }
      return false;
    },
    chooseAction(ctx, f, foe) {
      const { r } = ctx;
      if (f.bind > 0) { f.bind = 0; skill(ctx, f, '荒腹震', '腹を激しく震わせ、拘束を振りほどいた'); }
      if (ctx.round <= 4 && f.flags.sleepy && r.chance(0.5)) return { skip: true, text: `${f.name}は眠そうにあくびをした` };
      // 原野回帰・獣王崩し：追い詰められて一度
      if (!f.flags.feral && f.hp < f.maxHp * 0.25) {
        f.flags.feral = true;
        const n = 3 + Math.floor(r() * 4);
        return { name: '原野回帰・獣王崩し', hits: n, mult: r.range(1.4, 2.6), big: true, label: '四肢で地面を蹴り――次に何をするか、本人にも分からない！' };
      }
      if (f.flags.wild && r.chance(0.3)) return { name: '頭突きと噛みつきの連続攻撃', hits: 2, mult: 1.3 };
      return { name: ctx.line(f, 'attack'), mult: 1.05 };
    }
  },

  // ------------------------------------------------------------------ 006
  chr_006: {
    short: 'カンタレイア',
    uses: ['sound'],
    mentalRes: 0.35,   // 抱歌領域：精神攻撃に非常に強い
    lines: {
      intro: ['じゃあ、まず私に聞かせて', '届かせようとした時点で、それは立派な歌だ'],
      attack: ['響弾を撃った', '伝響刃を飛ばした', '歌に乗せて響弾を連続で放った'],
      low: ['誰一人の声も、消させない'],
      win: ['届いた？'],
      lose: ['……歌、止まっちゃった']
    },
    init(f) { f.meters.song = 0; },
    onRound(ctx, f, foe) {
      let gain = 4;
      if (ctx.feat('騒音')) gain *= 0.5;
      if (ctx.feat('反響')) gain *= 1.5;
      if (f.flags.coughing) gain *= 0.4;
      f.meters.song = Math.min(100, f.meters.song + gain);
      // 名無しの歌：現実直視を受けていると、ときどき声が止まる
      if (f.flags.reality && ctx.r.chance(0.12)) { f.stun = 1; ctx.say('info', `心の奥の名無しの歌に触れ、${f.name}の声が止まった`, { side: f.side }); }
      // 抱響壁
      if (ctx.round % 8 === 0) { f.shield = Math.max(f.shield, f.maxHp * 0.04); skill(ctx, f, '抱響壁', '赤い伝響が帯のように広がり、攻撃を受け止める壁になった'); }
    },
    accuracy(ctx, f) { return f.meters.song * 0.0008; },
    damageOut(ctx, f, foe, dmg) { const d = dmg + f.stored; if (f.stored > 0) { ctx.say('skill', `${f.name}の「反響返歌」！ 受け止めた攻撃の勢いを歌に乗せて撃ち返した`, { side: f.side, skill: '反響返歌' }); f.stored = 0; } return d; },
    damageIn(ctx, f, src, dmg, info) {
      let d = dmg;
      if (src && src.tags.has('近接') && (f.bind > 0 || ctx.feat('狭所'))) d *= 1.15;
      if (dmg > 30) f.stored = Math.min(35, f.stored + dmg * 0.15);
      if (info.big) f.meters.song *= 0.7;   // 強い衝撃で歌が乱れる
      return d;
    },
    evasion(ctx, f, attacker) {
      // 響輪：近づかれたら一度だけ吹き飛ばして距離を取る
      if (attacker.tags.has('近接') && !f.flags.ring && (f.bind > 0 || ctx.round < 6)) { f.flags.ring = true; f.bind = 0; ctx.say('skill', `${f.name}の「響輪」！ 伝響を高速回転させ、${attacker.name}を吹き飛ばした`, { side: f.side, skill: '響輪' }); return 0.5; }
      return 0;
    },
    chooseAction(ctx, f, foe) {
      const { r } = ctx;
      if (!f.flags.wave && ctx.round >= 18 && r.chance(0.3)) {
        f.flags.wave = true;
        return { name: '万声伝歌', hits: 3, mult: 3.3, big: true, sure: true, label: '無数の「誰かへ届けたかった歌」が重なり――' };
      }
      const multi = r.chance(0.08 + f.meters.song * 0.0025);
      if (multi) return { name: '歌連弾', hits: 2 + Math.floor(f.meters.song / 50), mult: 1.1 + f.meters.song * 0.003, pierce: 0.15 };
      return { name: ctx.line(f, 'attack'), pierce: 0.15, mult: 0.85 + f.meters.song * 0.002 };
    }
  },

  // ------------------------------------------------------------------ 007
  chr_007: {
    short: 'アストラ＝プレア',
    uses: [],
    lines: {
      intro: ['私は星を調べているのではありません。星を見ている人を見ているのです', '観測を始めます'],
      attack: ['星光弾を撃った', '星座砲列で囲むように撃った', '指先から星の光を放った'],
      low: ['自分だけではどうにもならない。それでも、手を伸ばします'],
      win: ['星はあなたを追いません。あなたが星の計算した場所へ来るだけです'],
      lose: ['……観測が、足りませんでした']
    },
    init(f) { f.meters.obs = 0; },
    onRound(ctx, f, foe) {
      let gain = 3.2;
      if (ctx.feat('夜空')) gain *= 1.5;
      if (f.flags.dawn) gain *= 0.5;
      if (foe.uses.has('irregular')) gain *= 0.6;
      if (foe.flags.mirage) gain *= 0.5;
      if (foe.tags.has('短期決戦') && ctx.round <= 12) gain *= 0.4;
      f.meters.obs = Math.min(100, f.meters.obs + gain);
      if (f.meters.obs >= 50 && !f.flags.deflection) { f.flags.deflection = true; skill(ctx, f, '天体偏差射撃', `${foe.name}の現在位置ではなく、攻撃が届く瞬間にいる座標へ撃ち始めた`); }
      if (ctx.round % 6 === 3) { addMod(foe, { key: 'grav', stat: 'spd', mul: 0.75, turns: 2 }); skill(ctx, f, '重星圏', `局所的な重力異常で、${foe.name}の動きが遅くなった`); }
    },
    accuracy(ctx, f) { return f.meters.obs * 0.002; },
    critBonus(ctx, f) { return f.meters.obs * 0.0015; },
    statMul(f, stat) { if (stat === 'atk') return 0.8 + f.meters.obs * 0.004; return 1; },
    damageIn(ctx, f, src, dmg) {
      let d = dmg;
      if (src && src.tags.has('遠距離')) d *= 0.85;   // 星幕
      // 接近戦に弱い：捕まった、または相手の方が速い近接型
      if (src && src.tags.has('近接') && (f.bind > 0 || statOf(src, 'spd') > statOf(f, 'spd'))) d *= 1.25;
      return d;
    },
    evasion(ctx, f, attacker) {
      if (attacker.tags.has('近接') && !f.flags.moon && ctx.r.chance(0.5)) { f.flags.moon = ctx.round; ctx.say('skill', `${f.name}の「月弧」！ 三日月の光刃で${attacker.name}を追い払った`, { side: f.side, skill: '月弧' }); return 0.6; }
      if (f.flags.moon && ctx.round - f.flags.moon >= 8) f.flags.moon = false;
      return 0.04;
    },
    chooseAction(ctx, f, foe) {
      const { r } = ctx;
      if (!f.flags.final && f.meters.obs >= 100) {
        f.flags.final = true;
        return { name: '天願星図・終天観測', mult: 3.4, big: true, sure: true, label: '戦場が巨大な天球儀の内部になった。どの未来を選んでも、そこには砲撃が用意されている――' };
      }
      if (ctx.round % 12 === 0) return { name: '七星天砲', mult: 2.1, pierce: 0.4, big: true, label: '七つの巨大な星が一点に光を集め――' };
      return { name: ctx.line(f, 'attack'), sure: f.flags.deflection, mult: f.meters.obs < 25 ? 0.8 : 1 };
    }
  },

  // ------------------------------------------------------------------ 008
  chr_008: {
    short: 'バサラ',
    uses: ['wind', 'irregular'],
    lines: {
      intro: ['うるせぇ！！', 'ハァ……ハァ……ハァックショォォォイ！！'],
      attack: ['乱暴に殴った', '黒羽ぶん殴りを叩きつけた', '爪で引っかいた', '鼻息砲を放った'],
      low: ['俺も限界だコラァ……！'],
      win: ['……帰って寝る'],
      lose: ['うるせぇ！！　大丈夫に決まってんだろ！！']
    },
    init(f) { f.meters.ill = 10; },
    onRound(ctx, f, foe) {
      let gain = 3;
      if (ctx.feat('寒冷')) gain *= 1.3;
      if (ctx.feat('安らぎ') || foe.ch.id === 'chr_006') gain *= 0.5;   // 落ち着かされると弱まる
      f.meters.ill += gain;
      // 限界を超えると寝込む
      if (f.meters.ill >= 110) {
        f.meters.ill = 55; f.stun = 2;
        ctx.say('big', `${f.name}「……ちょっと待て、マジでしんどい」――寝込んだ`, { side: f.side });
      }
      // 風邪胞子
      if (ctx.round % 3 === 0) {
        foe.meters.cold = Math.min(10, (foe.meters.cold || 0) + (ctx.feat('寒冷') ? 2 : 1));
        const c = foe.meters.cold;
        addMod(foe, { key: 'cold', stat: 'atk', mul: 1 - c * 0.02, turns: 99 });
        addMod(foe, { key: 'cold2', stat: 'spd', mul: 1 - c * 0.025, turns: 99 });
        if (foe.uses.has('sound')) foe.flags.coughing = true;
        if (c % 3 === 1) skill(ctx, f, '風邪胞子', `${foe.name}に咳・鼻詰まり・悪寒が出始めた`);
      }
      // お粥や安らぎで機嫌が良くなる
      if (ctx.feat('安らぎ') && ctx.round % 8 === 0) { f.meters.ill = Math.max(0, f.meters.ill - 25); ctx.say('info', `${f.name}は少し機嫌が良くなった……弱くなった`, { side: f.side }); }
    },
    statMul(f, stat) {
      const ill = Math.min(90, f.meters.ill || 0);
      if (stat === 'atk') return 0.85 + ill * 0.005;
      if (stat === 'spd') return 1 + (ctx_wind(f) ? 0.1 : 0);
      return 1;
    },
    onDamaged(ctx, f) { f.meters.ill += 1.5; },
    chooseAction(ctx, f, foe) {
      const { r } = ctx;
      if (!f.flags.ult && f.meters.ill >= 85) {
        f.flags.ult = true;
        return { name: '大荒風邪・八苦邪嵐', mult: 2.4, big: true, label: '上空で黒翼を全開にし、風邪の嵐を解き放った――', after(ctx, f, foe) {
          foe.meters.cold = Math.min(10, (foe.meters.cold || 0) + 5);
          addMod(foe, { key: 'cold', stat: 'atk', mul: 1 - foe.meters.cold * 0.02, turns: 99 });
          f.meters.ill = 100;
          if (r.chance(0.4)) {
            if (f.hp / f.maxHp < foe.hp / foe.maxHp) { f.forfeit = true; ctx.say('big', `${f.name}「……もう無理。帰って寝る」`, { side: f.side }); }
            else { f.stun = 2; ctx.say('info', `${f.name}「……もう無理」――その場で寝込んだ`, { side: f.side }); }
          }
        } };
      }
      if (!f.flags.fever && f.meters.ill >= 60) {
        f.flags.fever = true;
        addMod(f, { key: 'fever', stat: 'atk', mul: 1.35, turns: 4, onExpire(ctx, f) { addMod(f, { key: 'tired', stat: 'spd', mul: 0.6, turns: 2 }); ctx.say('info', `${f.name}「……ちょっと待て、マジでしんどい」`, { side: f.side }); } });
        skill(ctx, f, '発熱暴走', '体温が異常に上がり、攻撃がさらに荒々しくなった');
      }
      if (r.chance(0.1)) return { name: '爆嚏暴風', mult: 1.8, big: true, label: '「ハ……ハァ……ハックショォォォォォイ！！」――', after(ctx, f, foe) { foe.shield = 0; if (r.chance(0.3)) { f.hp -= f.maxHp * 0.03; ctx.say('info', 'くしゃみの勢いで、自分も少し吹き飛んだ', { side: f.side }); } } };
      if (r.chance(0.22)) return { name: '荒咳連弾', hits: 3 + Math.floor(r() * 3), mult: 1.4 };
      if (ctx.round % 5 === 0) return { name: '悪寒羽', after(ctx, f, foe) { addMod(foe, { key: 'chill', stat: 'spd', mul: 0.85, turns: 3 }); } };
      return { name: ctx.line(f, 'attack') };
    }
  },

  // ------------------------------------------------------------------ 009
  chr_009: {
    short: 'トツカイザー',
    uses: ['wind'],
    lines: {
      intro: ['立て！　訓練を始める！', 'お前は、それでも進むか？'],
      attack: ['鉄拳指導を叩き込んだ', '鉤爪で捕まえて殴った', '膝蹴りを入れた'],
      low: ['限界を勝手に決めるな！'],
      win: ['訓練終了！'],
      lose: ['……今日の訓練は、ここまでだ']
    },
    init(f) { f.meters.energy = 100; f.meters.wire = 0; },
    initiative(ctx, f) { return ctx.round <= 5 ? 200 : 0; },   // 帆走加速：最初の数ラウンドはほぼ必ず先に動く
    onRound(ctx, f, foe) {
      let drain = 2.4;
      if (f.flags.fatigueExposed) drain *= 1.8;
      f.meters.energy = Math.max(0, f.meters.energy - drain);
      f.flags.early = ctx.round <= 6;   // 帆走加速：序盤は非常に強い
      // 懲練ワイヤー：時間とともに逃げ道が減る
      f.meters.wire = Math.min(30, f.meters.wire + 3);
      if (ctx.round === 4) skill(ctx, f, '懲練ワイヤー', '戦場に蜘蛛の巣のようなワイヤーが張り巡らされた');
      if (!f.flags.tired && f.meters.energy < 35) { f.flags.tired = true; ctx.say('info', `${f.name}の動きが目に見えて鈍くなってきた`, { side: f.side }); }
    },
    statMul(f, stat) {
      const e = f.meters.energy ?? 100;
      const sail = f.flags.noWind ? 0.85 : f.flags.strongWind ? 1.1 : 1;
      if (stat === 'atk') return (0.55 + 0.6 * e / 100) * sail * (f.flags.early ? 1.2 : 1);
      if (stat === 'spd') return (0.5 + 0.7 * e / 100) * sail;
      return 1;
    },
    accuracy(ctx, f) { return 0.05; },
    chooseAction(ctx, f, foe) {
      const { r } = ctx;
      addMod(foe, { key: 'wire', stat: 'spd', mul: 1 - f.meters.wire / 100, turns: 99 });
      // 必殺技：体力の残りがあるうちに
      if (!f.flags.grad && f.meters.energy >= 35 && (ctx.round >= 7 || foe.hp < foe.maxHp * 0.6)) {
        f.flags.grad = true;
        f.meters.energy -= 20;
        return { name: '極限航路・荒海卒業式', hits: 4, mult: 5.2, big: true, sure: true, label: 'ワイヤー網の中を超高速で帆走し、全方向から連続攻撃――最後に巨大な右腕の一撃！' };
      }
      // 荒療過給
      if (!f.flags.over && ctx.round >= 3 && ctx.round <= 8) {
        f.flags.over = true;
        addMod(f, { key: 'over', stat: 'atk', mul: 1.5, turns: 4, onExpire(ctx, f) { f.meters.energy -= 25; ctx.say('info', `荒療過給が切れ、${f.name}の動きが急激に鈍った`, { side: f.side }); } });
        return { special(ctx, f) { skill(ctx, f, '荒療過給', '全身の機械器官が高速回転し、帆が完全展開した'); } };
      }
      // 荒波引き：遠距離の相手を引き寄せる
      if (foe.tags.has('遠距離') && !foe.bind && ctx.round % 5 === 1) {
        return { special(ctx, f, foe) { foe.bind = 2; skill(ctx, f, '荒波引き', `フックを撃ち込み、${foe.name}を目の前まで引き寄せた`); } };
      }
      // 荒療成長（自分に）
      if (!f.flags.growth && f.hp < f.maxHp * 0.5 && f.meters.energy > 15) {
        f.flags.growth = true;
        addMod(f, { key: 'growth', stat: 'atk', mul: 1.3, turns: 3 });
        skill(ctx, f, '荒療成長', '「まだ戦える！」――負傷が一時的な力に変わった');
      }
      return { name: ctx.line(f, 'attack'), hits: r.chance(0.5) ? 2 : 1, mult: 1.25 };
    }
  },

  // ------------------------------------------------------------------ 010
  chr_010: {
    short: 'デウマグナ',
    uses: [],
    lines: {
      intro: ['我こそ神！　我こそ大悪魔！', '微神級など仮の姿だ！'],
      attack: ['神魔拳を叩き込んだ', '魔王掌握で掴んで叩きつけた', '黒炎息を吐いた'],
      low: ['我は神！　我は大悪魔！　我は最強！'],
      win: ['見たか！　これが神魔王の力よ！'],
      lose: ['……いや……もしかして我より強い？']
    },
    init(f) { f.meters.conf = 100; },
    onStart(ctx, f, foe) {
      skill(ctx, f, '偽神魔界', '「我が魔界」が展開された。ここではデウマグナが神であり、大悪魔である');
    },
    onRound(ctx, f, foe) {
      let loss = 1.4 + Math.max(0, gradeGap(f, foe)) * 0.45;
      if (foe.resolve === 'low') loss *= 0.5;       // 相手が恐れるほど自信が安定する
      if (ctx.feat('祭壇')) loss *= 0.6;
      if (ctx.feat('歓声')) loss *= 0.8;
      if (f.flags.steady) loss *= 0.5;
      if (f.flags.smallAltar) loss *= 1.5;
      if (f.flags.hall) loss *= 0.8;
      f.meters.conf = Math.max(0, f.meters.conf - loss);
      if (ctx.round % 5 === 0 && f.meters.conf > 0) {
        f.meters.conf = Math.min(100, f.meters.conf + 6);
        ctx.say('talk', `${f.name}「${ctx.r.pick(['我こそ最強！', '我こそ神！', '我こそ大悪魔！'])}」`, { side: f.side, note: '自信が少し戻った' });
      }
      if (f.meters.conf <= 0 && !f.flags.broken) { f.flags.broken = true; ctx.say('big', `偽神魔界が崩れた。${f.name}はただの微神級に戻った`, { side: f.side }); }
      // 領域の力で傷を修復
      if (f.meters.conf > 50) f.hp = Math.min(f.maxHp, f.hp + f.maxHp * 0.012);
      // 神魔王モード
      if (!f.flags.king && f.meters.conf >= 85 && ctx.round >= 3) {
        f.flags.king = true;
        addMod(f, { key: 'king', stat: 'atk', mul: 1.5, turns: 3 });
        addMod(f, { key: 'king2', stat: 'def', mul: 1.3, turns: 3 });
        skill(ctx, f, '神魔王モード', '神でもあり、大悪魔でもある――と完全に信じ切った');
      }
    },
    statMul(f, stat) {
      const c = (f.meters.conf ?? 100) / 100;
      const godMode = f.hp < f.maxHp * 0.5;
      if (stat === 'atk') return (1 + 0.75 * c) * (godMode ? 1 : 1.1);
      if (stat === 'def') return (1 + 0.5 * c) * (godMode ? 1.12 : 1);
      return 1;
    },
    onMental(ctx, f, src, p) { f.meters.conf = Math.max(0, f.meters.conf - 30 * p); return p; },
    onHit(ctx, f) { f.meters.conf = Math.min(100, f.meters.conf + 2.5); },
    onDamaged(ctx, f, src, dmg, info) { if (info.big) f.meters.conf = Math.max(0, f.meters.conf - 12); },
    chooseAction(ctx, f, foe) {
      const { r } = ctx;
      // 切り札
      if (!f.flags.trump && (f.meters.conf < 30 || foe.hp < foe.maxHp * 0.35) && f.meters.conf > 5) {
        f.flags.trump = true;
        return { name: '偽・天地魔界崩壊', mult: 3.2, big: true, label: '神格と悪魔の力を拳に流し込み、全体重を乗せて――', after(ctx, f) { f.meters.conf = 0; } };
      }
      if (ctx.round % 6 === 1) return { special(ctx, f, foe) { addMod(foe, { key: 'quake', stat: 'spd', mul: 0.8, turns: 2 }); skill(ctx, f, '神魔震脚', `足場を揺らし、${foe.name}の動きを一瞬止めた`); } };
      if (ctx.round % 9 === 0) return { name: '神罰雷', mult: 1.4, sure: true, label: '「神罰である！」――' };
      return { name: ctx.line(f, 'attack') };
    }
  },

  // ------------------------------------------------------------------ 011
  chr_011: {
    short: 'カンカラッチ',
    uses: ['sound'],
    lines: {
      intro: ['カン。', '渡るの？　渡らないの？'],
      attack: ['警音拳を叩き込んだ', '長い腕で殴りつけた', '踏響掌を押し当てた'],
      low: ['カンカンカンカン！'],
      win: ['もう渡っていいって！'],
      lose: ['……カン。']
    },
    init(f) { f.meters.dizzy = 0; f.meters.echo = 100; },
    // 警音反響：音を無視して突っ込んでくる相手（大型・高揚）には効きが半分
    noiseRate(f, foe) {
      let r = f.meters.echo / 100;
      if (foe.tags.has('大型') || foe.tags.has('高揚')) r *= 0.5;
      if (foe.tags.has('分析')) r *= 0.75;
      return r;
    },
    onRound(ctx, f, foe) {
      if (!f.flags.barrier && ctx.round >= 6 && ctx.r.chance(0.3)) {
        f.flags.barrier = true;
        addMod(foe, { key: 'kankai', stat: 'wis', mul: 1 - 0.2 * this.noiseRate(f, foe), turns: 4 });
        skill(ctx, f, '警界', `「カン、カン、カン、カン」――四方から警報音が反響し、${foe.name}は${f.name}の位置を音で判断できなくなった`);
      }
      // 遮断打：離れようとする相手を止める
      if (foe.tags.has('遠距離') && ctx.round % 6 === 3) {
        addMod(foe, { key: 'shadan', stat: 'spd', mul: 0.88, turns: 2 });
        skill(ctx, f, '遮断打', `長い腕を遮断機のように振り抜き、${foe.name}の進路を塞いだ`);
      }
    },
    accuracy(ctx, f, foe) { return f.flags.fake ? 0.2 : 0; },
    evasion(ctx, f, attacker) { return 0.06 * FIGHTER_KITS.chr_011.noiseRate(f, attacker); },
    damageOut(ctx, f, foe, dmg) { return foe.tags.has('遠距離') && !foe.bind ? dmg * 0.92 : dmg; },
    onHit(ctx, f, foe) {
      // 警音拳：当てるほど相手の平衡感覚が乱れる
      if (f.meters.dizzy < 5) {
        f.meters.dizzy++;
        addMod(foe, { key: 'dizzy', stat: 'spd', mul: 1 - 0.03 * f.meters.dizzy * FIGHTER_KITS.chr_011.noiseRate(f, foe), turns: 99 });
      }
    },
    chooseAction(ctx, f, foe) {
      const { r } = ctx;
      f.flags.fake = false;
      if (!f.flags.last && (foe.hp < foe.maxHp * 0.5 || ctx.round >= 20)) {
        f.flags.last = true;
        return { name: '終電警鐘', mult: 2.6, big: true, label: '警報音がぴたりと止み、あたりが無音になった――',
          after(ctx, f, foe) {
            if (r.chance(0.6 * FIGHTER_KITS.chr_011.noiseRate(f, foe))) { foe.stun = 1; ctx.say('info', `至近距離の「カァァァン！！」で、${foe.name}は大きく怯んだ`, { side: foe.side }); }
            f.meters.echo = 25;
            ctx.say('info', `${f.name}は蓄えていた警報音を使い切った`, { side: f.side });
          } };
      }
      if (ctx.round % 5 === 2) {
        return { name: '踏響掌', mult: 0.9, sure: true, label: '掌を押し当て、身体に直接振動を送り込む――',
          after(ctx, f, foe) { if (r.chance(0.5 * FIGHTER_KITS.chr_011.noiseRate(f, foe))) foe.stun = 1; } };
      }
      if (ctx.round % 4 === 1) { f.flags.fake = true; return { name: '偽踏音からの一撃', mult: 1.3, label: `${foe.name}の背後から「カン」――振り向いた正面から、` }; }
      if (r.chance(0.25)) return { name: 'カンカン連打', hits: 3 + Math.floor(r() * 3), mult: 1.15 };
      return { name: ctx.line(f, 'attack') };
    }
  },

  // ------------------------------------------------------------------ 012
  chr_012: {
    short: 'ネガヴォイド',
    uses: [],
    mentalRes: 0.5,   // 自分の感情を理解している
    lines: {
      intro: ['そこ、まだ部屋があるよ', '心が暗くなることは、そんなに珍しいことじゃない'],
      attack: ['蜘蛛脚で刺突した', '紫の次元糸を放った', '心淵界から黒い手を伸ばした'],
      low: ['……まだ、見ていない部屋がある'],
      win: ['でも、それをどうするかは君が決めることだ'],
      lose: ['……預かっておくよ']
    },
    init(f) { f.meters.read = 0; },
    onRound(ctx, f, foe) {
      // 深層解析：戦うほど相手専用の攻略法ができていく
      let gain = 3.4 + statOf(f, 'wis') / 90;
      if (foe.uses.has('irregular')) gain *= 0.55;                 // 思考が読めない相手
      if (foe.tags.has('短期決戦') && ctx.round <= 10) gain *= 0.5;  // 仕上がる前に決められる
      if (foe.resolve === 'high') gain *= 0.8;                      // 自分の感情を理解している相手
      f.meters.read = Math.min(100, f.meters.read + gain);
      if (f.meters.read >= 50 && !f.flags.coord) { f.flags.coord = true; skill(ctx, f, '精神座標', `${foe.name}の恐怖・後悔・執着が座標として記録された。ここからが本番だ`); }
      // 心淵共鳴
      if (ctx.round % 5 === 3 && f.flags.coord) {
        const p = ctx.mental(f, foe, 1);
        addMod(foe, { key: 'resonance', stat: 'atk', mul: 1 - clamp(0.25 * p, 0.03, 0.28), turns: 3 });
        skill(ctx, f, '心淵共鳴', `${foe.name}の中にあった感情が、心淵界の同じ感情と響き合い、異常に鮮明になった`);
      }
      // 黒心反射
      if (ctx.round % 7 === 5) {
        const p = ctx.mental(f, foe, 1);
        addMod(foe, { key: 'mirror', stat: 'wis', mul: 1 - clamp(0.2 * p, 0.03, 0.22), turns: 3 });
        skill(ctx, f, '黒心反射', `${foe.name}が認めたくなかったものが、幻影として目の前に現れた`);
      }
    },
    accuracy(ctx, f) { return f.meters.read * 0.0018; },
    evasion(ctx, f, attacker, opt) { return opt && opt.big ? 0.35 : 0.05; },   // 心淵潜航
    statMul(f, stat) { if (stat === 'atk') return 0.75 + f.meters.read * 0.004; return 1; },
    chooseAction(ctx, f, foe) {
      const { r } = ctx;
      if (!f.flags.prison && f.meters.read >= 85) {
        f.flags.prison = true;
        const p = ctx.mental(f, foe, 1);
        return { name: '深層心界・無明牢', mult: 2.2, big: true, sure: true, label: '精神だけが、心淵界の深層へ引きずり込まれた――',
          after(ctx, f, foe) {
            const turns = p >= 0.9 ? 3 : p >= 0.55 ? 2 : 1;
            foe.stun = turns;
            ctx.say('info', `${foe.name}は、自分自身が作った世界に閉じ込められた（${turns}ラウンド行動不能）`, { side: foe.side });
          } };
      }
      if (ctx.round % 9 === 6) {
        return { special(ctx, f, foe) {
          const p = ctx.mental(f, foe, 1);
          skill(ctx, f, '心界糸', `紫の次元糸が${foe.name}の精神と心淵界を繋いだ。距離も時間も、あいまいになっていく`);
          if (r.chance(0.5 * p)) { foe.stun = 1; ctx.say('info', `${foe.name}は、数秒のつもりで数分を失った`, { side: foe.side }); }
          else addMod(foe, { key: 'thread', stat: 'spd', mul: 0.85, turns: 3 });
        } };
      }
      return { name: ctx.line(f, 'attack') };
    }
  },

  // ------------------------------------------------------------------ 013
  chr_013: {
    short: 'タメリス',
    uses: [],
    lines: {
      intro: ['使うべき時に使わない貯蓄は、ただの荷物', 'ちゃんと備えてある'],
      attack: ['爪で薙ぎ払った', '尾で打ち払った', '翼で殴りつけた'],
      low: ['……ここで使わないと、もっと大きなものを失う'],
      win: ['備えておいてよかった'],
      lose: ['……まだ使う時じゃなかったか']
    },
    init(f) { f.meters.stock = 100; },
    heal(ctx, f, pct, cost, name, text) {
      if (f.meters.stock <= 0) return false;
      const rate = Math.max(0.3, f.meters.stock / 100);
      const amount = Math.round(f.maxHp * pct * rate);
      f.hp = Math.min(f.maxHp, f.hp + amount);
      f.meters.stock = Math.max(0, f.meters.stock - cost);
      skill(ctx, f, name, `${text}（体力+${amount}／備蓄 残り${Math.round(f.meters.stock)}）`);
      return true;
    },
    onStart(ctx, f) {
      f.shield = f.maxHp * 0.08;
      f.meters.stock -= 8;
      skill(ctx, f, '先払い治療', '戦う前に、自分へ生命力を預けておいた。傷つけば自動で癒える');
    },
    onRound(ctx, f, foe) {
      const K = FIGHTER_KITS.chr_013;
      f.meters.stock -= 1.6;   // 備蓄は、維持しているだけでも少しずつ目減りする
      if (f.meters.stock <= 0) { if (!f.flags.empty) { f.flags.empty = true; ctx.say('info', `${f.name}の備蓄が尽きた`, { side: f.side }); } return; }
      if (f.hp < f.maxHp * 0.25 && !f.flags.emergency) { f.flags.emergency = true; K.heal(ctx, f, 0.22, 40, '緊急備蓄解放', '溜め込んでいた生命力を一気に流し込んだ'); return; }
      if (f.hp < f.maxHp * 0.4 && !f.flags.century && f.meters.stock >= 45) { f.flags.century = true; K.heal(ctx, f, 0.18, 50, '百年備蓄・大放出', '「今ここで使わなければ、もっと大きなものを失う」――何十年ぶんもの備蓄が解放された'); return; }
      if (f.hp < f.maxHp * 0.6 && !f.flags.ration) { f.flags.ration = true; K.heal(ctx, f, 0.13, 18, '非常食', '巨大などんぐりのような実を噛み砕いた'); return; }
      if (ctx.round % 5 === 0 && f.hp < f.maxHp * 0.85) K.heal(ctx, f, 0.04, 13, 'リザーブ・ヒール', '蓄えていた生命力を引き出した');
    },
    // 幸運の備蓄：一度だけ、致命的な一撃を耐える
    damageIn(ctx, f, src, dmg) {
      if (!f.flags.luck && dmg >= f.hp && f.hp > 1) {
        f.flags.luck = true;
        ctx.say('big', `${f.name}の「幸運の備蓄」！ 何年もかけて貯めた運が、あり得ない偶然を連れてきた（体力1で踏みとどまる）`, { side: f.side, skill: '幸運の備蓄' });
        return f.hp - 1;
      }
      return dmg;
    },
    chooseAction(ctx, f, foe) { return { name: ctx.line(f, 'attack'), mult: 0.9 }; }
  }

};

// バサラの飛行（強風で速くなる）
function ctx_wind(f) { return f.flags.strongWind; }

// キャラごとの強さの補正値（与えるダメージに掛ける）。等級ごとの目標勝率に合わせて自動調整したもの
const KIT_TUNE = {
 'chr_001': 0.805,
 'chr_002': 1.027,
 'chr_003': 0.672,
 'chr_004': 2.255,
 'chr_005': 1.096,
 'chr_006': 0.647,
 'chr_007': 0.767,
 'chr_008': 0.818,
 'chr_009': 1.053,
 'chr_010': 1.881,
 'chr_011': 1.285,
 'chr_012': 0.996,
 'chr_013': 0.917
};
