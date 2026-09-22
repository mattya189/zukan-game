// =====================================================================
// 集団戦のクエスト（10個）　data/team-stages.js
//   各キャラの試練の段階3をクリアすると開く。「そのキャラ＋仲間」のチームと戦う
//   size … 2 なら 2対2、3 なら 3対3。自分のチームも同じ人数（同じキャラは入れられない）
//   enemies … 相手チーム（キャラid と並び）。個体値は TEAM_ENEMY_IND
//   events と enemyState は、チーム全員に効く形で書いてある
// =====================================================================

const allFighters = ctx => [...ctx.teams[0], ...ctx.teams[1]].filter(f => f.hp > 0);
const teamRatio = (res, side) => { const t = res.state.filter(s => s.side === side); return t.reduce((a, s) => a + Math.max(0, s.hp), 0) / t.reduce((a, s) => a + s.maxHp, 0); };
const teamWon = res => res.winner === 0;
const noneDown = res => res.state.filter(s => s.side === 0).every(s => s.hp > 0);
const downOrder = res => res.log.filter(e => e.kind === 'big' && e.text.endsWith('が倒れた')).map(e => e.side);

const TEAM_REWARDS = { first: 3000, repeat: 150, goal: 1000 };
const TEAM_ENEMY_IND = { power: 1200, speed: 1200, wisdom: 1200 };

const TEAM_STAGES = [
  { id: 't001', boss: 'chr_001', size: 2, name: '終戦の大戦場', features: ['戦場', '開けた場所'],
    enemies: [{ id: 'chr_001', row: 'front' }, { id: 'chr_009', row: 'front' }],
    story: '戦争の化身と、鍛罰の化身。「最後まで勝敗を決める」者と「限界まで追い込む」者が、並んで立ちはだかる。',
    enemyText: 'ヴァルガルドの神装戦域が第二段階から始まる',
    eventText: '6ラウンドごとに軍勢の鬨の声が上がり、長期戦型のキャラが強くなる',
    events: [{ every: 6, run(ctx) { allFighters(ctx).filter(f => f.tags.has('長期戦')).forEach(f => addMod(f, { key: 'tev_war' + ctx.round, stat: 'atk', mul: 1.04, turns: 99 })); ctx.say('event', '遠くで軍勢の鬨の声が上がった'); } }],
    enemyState(ctx, enemies) { enemies.forEach(f => { if (f.ch.id === 'chr_001') { f.meters.stage = 2; f.meters.fury = 150; } }); },
    goal: { text: '味方が誰も倒れずに勝つ', check: res => teamWon(res) && noneDown(res) } },

  { id: 't002', boss: 'chr_002', size: 2, name: '産声の聖堂', features: ['反響', '生命の気配'],
    enemies: [{ id: 'chr_002', row: 'front' }, { id: 'chr_006', row: 'back' }],
    story: '現実を突きつける産声と、それでも動けるよう支える歌。二つの声が、聖堂に重なって響く。',
    enemyText: '挑戦者は全員、最初から現実直視を受けている',
    eventText: '8ラウンドごとに産声と歌が重なり、音で戦うキャラが強くなる',
    events: [{ every: 8, run(ctx) { allFighters(ctx).filter(f => f.uses.has('sound')).forEach(f => addMod(f, { key: 'tev_voice', stat: 'atk', mul: 1.12, turns: 3 })); ctx.say('event', '産声と歌が重なり、聖堂が震えた'); } }],
    enemyState(ctx, enemies, allies) { allies.forEach(f => { f.flags.reality = RESOLVE_INFO[f.resolve].mental; }); },
    goal: { text: '48ラウンド以内に勝つ', check: res => teamWon(res) && res.rounds <= 48 } },

  { id: 't003', boss: 'chr_003', size: 2, name: '星と夢岩の庭', features: ['岩場', '夜空'],
    enemies: [{ id: 'chr_003', row: 'front' }, { id: 'chr_007', row: 'back' }],
    story: '「まだ存在しない未来」を信じる守護者と、「実現する可能性のある未来」を探す神。観察と計算が、戦場を支配していく。',
    enemyText: 'マデランデスの分析と、アストラ＝プレアの観測が、少したまった状態で始まる',
    eventText: '10ラウンドごとに星が流れ、分析型のキャラの分析・観測が進む',
    events: [{ every: 10, run(ctx) { allFighters(ctx).filter(f => f.tags.has('分析')).forEach(f => { if (f.meters.analysis != null) f.meters.analysis = Math.min(100, f.meters.analysis + 10); if (f.meters.obs != null) f.meters.obs = Math.min(100, f.meters.obs + 10); }); ctx.say('event', '夜空を星が流れた。計算が一段進む'); } }],
    enemyState(ctx, enemies) { enemies.forEach(f => { if (f.meters.analysis != null) f.meters.analysis = 25; if (f.meters.obs != null) f.meters.obs = 25; }); },
    goal: { text: '相手の後衛（アストラ＝プレア）を先に倒して勝つ', check: res => teamWon(res) && res.log.findIndex(e => e.text === 'アストラ＝プレアが倒れた') < res.log.findIndex(e => e.text === 'マデランデスが倒れた') && res.log.some(e => e.text === 'アストラ＝プレアが倒れた') } },

  { id: 't004', boss: 'chr_004', size: 3, name: 'かわいい王国の親衛隊', features: ['安らぎ', '小動物'],
    enemies: [{ id: 'chr_004', row: 'front' }, { id: 'chr_005', row: 'front' }, { id: 'chr_006', row: 'back' }],
    story: 'かわいいを守るためなら戦う、と決めたタルンルソルク。のんきな巨体と、誰の声も消させない歌い手が、その隣に並ぶ。',
    enemyText: 'タルンルソルクは最初から「かわいい認定」済みで、気が散らない',
    eventText: '5ラウンドごとに小動物が駆け回り、かわいいもの好きのキャラが見とれ、興奮で強くなるキャラが落ち着く',
    events: [{ every: 5, run(ctx) { allFighters(ctx).forEach(f => { if (f.tags.has('かわいい好き') && f.side === 0 && ctx.r.chance(0.35)) f.stun = Math.max(f.stun, 1); if (f.tags.has('高揚')) addMod(f, { key: 'tev_calm', stat: 'atk', mul: 0.93, turns: 2 }); }); ctx.say('event', '小動物たちが戦場を駆け回った'); } }],
    enemyState(ctx, enemies) { enemies.forEach(f => { if (f.ch.id === 'chr_004') { f.flags.certified = true; addMod(f, { key: 'cert', stat: 'atk', mul: 1.25, turns: 999, permanent: true }); } }); },
    goal: { text: '42ラウンド以内に勝つ', check: res => teamWon(res) && res.rounds <= 42 } },

  { id: 't005', boss: 'chr_005', size: 2, name: '堕落と傲慢の大宴会', features: ['狭所', '祭壇'],
    enemies: [{ id: 'chr_005', row: 'front' }, { id: 'chr_010', row: 'front' }],
    story: '「どうでもよくなるほど強くなる」巨体と、「自信がある間だけ強い」巨体。よく似た二つの身体が、宴の中心で暴れ出す。',
    enemyText: 'デウマグナの自信が減りにくい',
    eventText: '7ラウンドごとに宴が盛り上がり、自信のキャラは自信を取り戻し、興奮で強くなるキャラがさらに強くなる',
    events: [{ every: 7, run(ctx) { allFighters(ctx).forEach(f => { if (f.meters.conf != null) f.meters.conf = Math.min(100, f.meters.conf + 8); if (f.tags.has('高揚')) addMod(f, { key: 'tev_feast', stat: 'atk', mul: 1.06, turns: 3 }); }); ctx.say('event', '宴がいっそう盛り上がった'); } }],
    enemyState(ctx, enemies) { enemies.forEach(f => { if (f.ch.id === 'chr_010') f.flags.hall = true; }); },
    goal: { text: 'デウマグナの偽神魔界を崩してから勝つ', check: res => teamWon(res) && res.log.some(e => e.text.includes('偽神魔界が崩れた') && e.side === 1) } },

  { id: 't006', boss: 'chr_006', size: 3, name: '世界よ、この歌を聞け', features: ['反響', '歓声'],
    enemies: [{ id: 'chr_002', row: 'front' }, { id: 'chr_006', row: 'back' }, { id: 'chr_007', row: 'back' }],
    story: '誰にも届かなかった想いを抱える歌い手のもとに、産声と星の願いが集まった。仲間が多いほど、あの歌は強くなる。',
    enemyText: 'カンタレイアの歌の領域が、最初から広がっている',
    eventText: '12ラウンドごとにアンコールが起き、音で戦うキャラが強くなる',
    events: [{ every: 12, run(ctx) { allFighters(ctx).filter(f => f.uses.has('sound')).forEach(f => addMod(f, { key: 'tev_encore', stat: 'atk', mul: 1.15, turns: 3 })); ctx.say('event', '観客のアンコールが響いた'); } }],
    enemyState(ctx, enemies) { enemies.forEach(f => { if (f.ch.id === 'chr_006') f.meters.song = 60; }); },
    goal: { text: '味方が誰も倒れずに勝つ', check: res => teamWon(res) && noneDown(res) } },

  { id: 't007', boss: 'chr_007', size: 3, name: '宇宙の最後の観測所', features: ['夜空', '開けた場所'],
    enemies: [{ id: 'chr_001', row: 'front' }, { id: 'chr_003', row: 'back' }, { id: 'chr_007', row: 'back' }],
    story: '「この宇宙の最後を、一緒に見てほしい」――その願いを探し続ける神の前に、戦争の化身と夢岩の守護者が立つ。',
    enemyText: 'アストラ＝プレアの観測が、ある程度たまった状態で始まる',
    eventText: '10ラウンドごとに流れ星が降り、追い詰められているチームの全員が少し回復する',
    events: [{ every: 10, run(ctx) { const ratio = side => ctx.teams[side].reduce((a, f) => a + Math.max(0, f.hp), 0) / ctx.teams[side].reduce((a, f) => a + f.maxHp, 0); const side = ratio(0) <= ratio(1) ? 0 : 1; ctx.teams[side].filter(f => f.hp > 0).forEach(f => { f.hp = Math.min(f.maxHp, f.hp + f.maxHp * 0.05); }); ctx.say('event', `流れ星が降り、${side === 0 ? '挑戦者' : '相手'}のチームの傷が少し癒えた`); } }],
    enemyState(ctx, enemies) { enemies.forEach(f => { if (f.ch.id === 'chr_007') f.meters.obs = 40; }); },
    goal: { text: '52ラウンド以内に勝つ', check: res => teamWon(res) && res.rounds <= 52 } },

  { id: 't008', boss: 'chr_008', size: 3, name: '最悪の体調の訓練場', features: ['寒冷', '強風'],
    enemies: [{ id: 'chr_005', row: 'front' }, { id: 'chr_009', row: 'front' }, { id: 'chr_008', row: 'back' }],
    story: '風邪気味で機嫌の悪いバサラが、なぜか訓練に参加している。怠け者の巨体と、うるさい教官も一緒だ。',
    enemyText: 'バサラは最初から体調が悪く、機嫌も悪い。挑戦者は全員、少し風邪気味で始まる',
    eventText: '5ラウンドごとにくしゃみが連鎖し、暴風が全員を巻き込む',
    events: [{ every: 5, run(ctx) { if (!ctx.r.chance(0.6)) return; allFighters(ctx).forEach(f => { f.shield = 0; ctx.damage(null, f, f.maxHp * 0.02, { event: true }); }); ctx.say('event', 'くしゃみが連鎖し、暴風が全員を巻き込んだ'); } }],
    enemyState(ctx, enemies, allies) { enemies.forEach(f => { if (f.ch.id === 'chr_008') f.meters.ill = 60; }); allies.forEach(f => { f.meters.cold = 2; addMod(f, { key: 'cold', stat: 'atk', mul: 0.96, turns: 99 }); }); },
    goal: { text: '32ラウンド以内に勝つ（体調が崩れる前に）', check: res => teamWon(res) && res.rounds <= 32 } },

  { id: 't009', boss: 'chr_009', size: 3, name: '地獄の合同訓練', features: ['強風', '狭所'],
    enemies: [{ id: 'chr_009', row: 'front' }, { id: 'chr_001', row: 'front' }, { id: 'chr_010', row: 'front' }],
    story: '「お前は、それでも進むか？」――教官と、戦争の化身と、自称・神魔王。三人並んだ前衛の圧に、逃げ場はない。',
    enemyText: 'トツカイザーのワイヤーが、最初から張られている',
    eventText: '15ラウンド目に「それでも進むか？」と問われ、覚悟の高いキャラが強くなる',
    events: [{ at: 15, run(ctx) { allFighters(ctx).filter(f => f.resolve === 'high').forEach(f => addMod(f, { key: 'tev_ask', stat: 'atk', mul: 1.12, turns: 999, permanent: true })); ctx.say('event', '「お前は、それでも進むか？」――問いが響いた'); } }],
    enemyState(ctx, enemies) { enemies.forEach(f => { if (f.ch.id === 'chr_009') f.meters.wire = 30; }); },
    goal: { text: '最初の10ラウンドを、味方全員が体力半分以上で耐えて勝つ', check: res => teamWon(res) && res.state.filter(s => s.side === 0).every(s => s.rec.minHpAtR10 == null || s.rec.minHpAtR10 >= 0.5) } },

  { id: 't010', boss: 'chr_010', size: 2, name: '偽神魔界の玉座の間', features: ['祭壇', '歓声'],
    enemies: [{ id: 'chr_010', row: 'front' }, { id: 'chr_008', row: 'back' }],
    story: '「我こそ神！」と叫ぶ神魔王と、「うるせぇ！！」と叫ぶ風邪の化身。どちらも声が大きい。',
    enemyText: 'デウマグナの自信が減りにくい',
    eventText: '4ラウンドごとに玉座が軋み、押されているチームの自信のキャラが揺らぐ',
    events: [{ every: 4, run(ctx) { allFighters(ctx).filter(f => f.tags.has('自信')).forEach(f => { const mine = ctx.teams[f.side], theirs = ctx.teams[1 - f.side]; const r = t => t.reduce((a, x) => a + Math.max(0, x.hp), 0) / t.reduce((a, x) => a + x.maxHp, 0); if (r(mine) < r(theirs)) { if (f.meters.conf != null) f.meters.conf = Math.max(0, f.meters.conf - 12); addMod(f, { key: 'tev_throne', stat: 'atk', mul: 0.94, turns: 2 }); } }); } }],
    enemyState(ctx, enemies) { enemies.forEach(f => { if (f.ch.id === 'chr_010') f.flags.steady = true; }); },
    goal: { text: 'デウマグナの偽神魔界を崩してから勝つ', check: res => teamWon(res) && res.log.some(e => e.text.includes('偽神魔界が崩れた') && e.side === 1) } }
];

// 集団戦のクエストごとの敵の強さ。tools/team-sim.js --calibrate で合わせる
const TEAM_STAGE_POWER = { t001: 1.163, t002: 0.924, t003: 0.84, t004: 1.096, t005: 1.182, t006: 0.937, t007: 0.794, t008: 0.972, t009: 1.08, t010: 1.029 };
