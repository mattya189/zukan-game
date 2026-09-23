// =====================================================================
// クエストのステージ（33個）　data/stages.js
//   キャラ別の試練 30（10体 × 3段階）＋ 周回 3
//   ・features  … 舞台の特徴（js/battle.js の STAGE_FEATURES。両者に効く）
//   ・events    … ステージイベント（every: 何ラウンドごと / at: 何ラウンド目）。性質タグを見て、だれにでも効く
//   ・enemyState … 敵の状態（戦いの前に、敵を強い状態・弱い状態にする）
//   ・goal      … 挑戦目標（勝ったうえで満たすとボーナス）。check(res) で判定する
//   ・enemyPower … 敵の強さ（与えるダメージの倍率）。tools/stage-sim.js で難しさに合わせて調整したもの
//   ・enemyInd  … 敵の個体値（power, speed, wisdom）
// =====================================================================

// ---- 出来事の部品（性質タグを見て、両者に効く） ----
const both = ctx => [ctx.A, ctx.B];
const withTag = (ctx, tag) => both(ctx).filter(f => f.tags.has(tag));
const tempMod = (f, stat, mul, turns, key) => addMod(f, { key: key || ('ev_' + stat + mul), stat, mul, turns });
const hpRatio = f => Math.max(0, f.hp) / f.maxHp;
const skillUsed = (res, side, name) => res.log.some(e => e.side === side && (e.kind === 'skill' || e.kind === 'big' || e.kind === 'hit') && e.text.includes(name));
const logHas = (res, text) => res.log.some(e => e.text.includes(text));
const won = res => res.winner === 0;
const me = res => res.state[0];
const foeState = res => res.state[1];

// ---- 報酬（コイン） ----
const QUEST_REWARDS = {
  1: { first: 300, repeat: 30, goal: 100 },
  2: { first: 800, repeat: 60, goal: 300 },
  3: { first: 2000, repeat: 100, goal: 800 }
};

// ---- 敵の個体値（段階ごと） ----
const ENEMY_IND = {
  1: { power: 140, speed: 140, wisdom: 140 },
  2: { power: 320, speed: 320, wisdom: 320 },
  3: { power: 1500, speed: 1500, wisdom: 1500 }
};

// ---- キャラごとの攻略のヒント（挑戦前に表示） ----
const STAGE_HINTS = {
  chr_001: '長引くほど神装戦域で強くなる。短期決戦で押し切るか、遠くから速く攻め続けるのが有効。',
  chr_002: '覚悟の低い個体は精神干渉で崩される。覚悟の高い個体なら、真正面の殴り合いに持ち込める。',
  chr_003: '分析がたまるほど強くなる。準備の時間を与えない、速い近接型の短期決戦が天敵。',
  chr_004: '脚を使う近接型や重い相手ほど短足化が効く。飛ぶ相手や遠距離型には、ほとんど効かない。',
  chr_005: '頑丈で、追い詰めるほど雑に強くなる。距離を保って削り、理性脱衣の反動を待つのが有効。',
  chr_006: '精神攻撃がほとんど効かない。近づいて歌を乱すか、風邪などで呼吸を乱すのが有効。',
  chr_007: '観測がたまるほど当たるようになる。短期決戦の速い近接型や、動きの読めない相手が苦手。',
  chr_008: '具合が悪いほど強くなる。落ち着かせる、休ませると弱る。放っておくと限界で寝込むこともある。',
  chr_009: '最初の数ラウンドが最も強い。猛攻を耐えきれば、あとは下り坂。頑丈な個体や長期戦型が有効。',
  chr_010: '自信がある間だけ強い。精神干渉や、格上の相手と長く戦うほど偽神魔界が崩れる。',
  chr_011: '音でフェイントをかけて殴る。大型や、怒りで戦うキャラには撹乱がほとんど効かない。',
  chr_012: '戦うほど解析が進み、相手専用の攻略法を作る。覚悟の高い個体、動きの読めない相手、短期決戦が有効。',
  chr_013: '備蓄がある限り回復し続ける。短期決戦で押し切るか、長引かせて備蓄を使い切らせる。'
};

const STAGES = [
  // ================================================================ No.001 ヴァルガルド
  { id: 'q001_1', boss: 'chr_001', level: 1, name: '古戦場', features: ['戦場', '開けた場所'],
    enemyText: '神装戦域の段階が上がりにくい',
    eventText: '5ラウンドごとに地面の武具が浮かび、そのとき体力の多い方の攻撃が上がる',
    events: [{ every: 5, run(ctx) { const f = hpRatio(ctx.A) >= hpRatio(ctx.B) ? ctx.A : ctx.B; tempMod(f, 'atk', 1.08, 5, 'ev_arms'); ctx.say('event', `地面に埋もれた武具が浮かび上がり、${f.name}に力を貸した`); } }],
    enemyState(ctx, B) { B.flags.slowWar = true; },
    goal: { text: '50ラウンド以内に勝つ', check: res => won(res) && res.rounds <= 50 } },
  { id: 'q001_2', boss: 'chr_001', level: 2, name: '包囲された城塞', features: ['戦場', '狭所'],
    enemyText: '征服鎖が最初から伸びていて、距離を取りにくい',
    eventText: '8ラウンド目に城壁が崩れ、狭所が消える',
    events: [{ at: 8, run(ctx) { ctx.stage.features = ctx.stage.features.filter(x => x !== '狭所'); ctx.say('event', '城壁が崩れ、戦場が一気に開けた'); } }],
    enemyState(ctx, B, A) { A.bind = 2; },
    goal: { text: '最初の鎖のあと、拘束された時間を合計2ラウンド以内に抑えて勝つ', check: res => won(res) && me(res).rec.boundRounds <= 4 } },
  { id: 'q001_3', boss: 'chr_001', level: 3, name: '大戦の荒野', features: ['戦場', '強風'],
    enemyText: '神装戦域が第二段階から始まる',
    eventText: '遠くの軍勢の鬨の声で、ラウンドが進むほど戦場が激しくなる（長期戦型が強くなる）',
    events: [{ every: 5, run(ctx) { withTag(ctx, '長期戦').forEach(f => tempMod(f, 'atk', 1.05, 99, 'ev_warcry' + ctx.round)); if (ctx.B.meters.fury != null) ctx.B.meters.fury += 20; ctx.say('event', '遠くで軍勢の鬨の声が上がった'); } }],
    enemyState(ctx, B) { B.meters.stage = 2; B.meters.fury = 150; },
    goal: { text: '大戦神装を耐え抜き、体力15%以上残して勝つ', check: res => won(res) && me(res).hp / me(res).maxHp >= 0.15 } },

  // ================================================================ No.002 バースクライ
  { id: 'q002_1', boss: 'chr_002', level: 1, name: '夜明けの産院', features: ['静寂', '安らぎ'],
    enemyText: '第一声を使わずに始まる',
    eventText: '6ラウンドごとに産声が上がり、覚悟の低いキャラが少し弱る',
    events: [{ every: 6, run(ctx) { both(ctx).filter(f => f.resolve === 'low').forEach(f => tempMod(f, 'atk', 0.9, 3, 'ev_cry')); ctx.say('event', 'どこかの部屋で、小さな産声が上がった'); } }],
    enemyState(ctx, B) { B.flags.noFirstCry = true; },
    goal: { text: '一度も行動不能にならずに勝つ', check: res => won(res) && me(res).rec.stunned === 0 } },
  { id: 'q002_2', boss: 'chr_002', level: 2, name: '泣き声の響く廃病棟', features: ['反響', '狭所'],
    enemyText: '初泣領域が最初から広がっている',
    eventText: '5ラウンドごとに照明が明滅し、そのラウンドは全員の回避が無効になる',
    events: [{ every: 5, run(ctx) { both(ctx).forEach(f => addMod(f, { key: 'ev_flicker', negateEvasion: true, turns: 1 })); ctx.say('event', '照明が激しく明滅した'); } }],
    enemyState(ctx, B) { B.flags.cry = true; },
    goal: { text: '体力が15%を切ってから逆転勝ち', check: res => won(res) && me(res).rec.minHp < 0.15 } },
  { id: 'q002_3', boss: 'chr_002', level: 3, name: '万生の産声', features: ['反響', '生命の気配', '開けた場所'],
    enemyText: '挑戦者は最初から現実直視を受けている（覚悟の低い挑戦者ほど効く）',
    eventText: '10ラウンドごとに無数の産声が重なり、精神干渉と音の攻撃が強まる',
    events: [{ every: 10, run(ctx) { both(ctx).filter(f => f.tags.has('精神干渉') || f.uses.has('sound')).forEach(f => tempMod(f, 'atk', 1.12, 3, 'ev_allcry')); ctx.say('event', '無数の産声が重なり、空気が震えた'); } }],
    enemyState(ctx, B, A) { A.flags.reality = RESOLVE_INFO[A.resolve].mental; if (A.resolve === 'low') A.mentalRes *= 1.5; },
    goal: { text: '覚悟の高い個体で勝つ', check: res => won(res) && me(res).resolve === 'high' } },

  // ================================================================ No.003 マデランデス
  { id: 'q003_1', boss: 'chr_003', level: 1, name: '岩場の谷', features: ['岩場', '狭所'],
    enemyText: '夢岩がまだ定着していない（序盤がとくに弱い）',
    eventText: '7ラウンドごとに落石があり、大型のキャラほど当たりやすい',
    events: [{ every: 7, run(ctx) { both(ctx).forEach(f => { const d = f.maxHp * (f.tags.has('大型') ? 0.05 : 0.025); ctx.damage(null, f, d, { event: true }); }); ctx.say('event', '崖の上から岩が落ちてきた'); } }],
    enemyState(ctx, B) { addMod(B, { key: 'unset', stat: 'atk', mul: 0.85, turns: 6, permanent: true }); },
    goal: { text: '40ラウンド以内に勝つ（夢詰みが完成する前に）', check: res => won(res) && res.rounds <= 40 } },
  { id: 'q003_2', boss: 'chr_003', level: 2, name: '浮遊岩の廃墟', features: ['岩場', '開けた場所'],
    enemyText: '空歩で空中から始まり、動きが速い',
    eventText: '6ラウンドごとに浮かぶ岩が足場になり、飛んでいるキャラが地面に引き寄せられる',
    events: [{ every: 6, run(ctx) { withTag(ctx, '飛行').forEach(f => { f.bind = Math.max(f.bind, 1); }); ctx.say('event', '浮かぶ岩が足場になり、空中にも手が届くようになった'); } }],
    enemyState(ctx, B) { addMod(B, { key: 'skywalk', stat: 'spd', mul: 1.15, turns: 999, permanent: true }); },
    goal: { text: '相手の「傲岩」に一度でも大技を受け止めさせる', check: res => won(res) && skillUsed(res, 1, '傲岩') } },
  { id: 'q003_3', boss: 'chr_003', level: 3, name: '夢岩の庭', features: ['岩場', '開けた場所', '異界'],
    enemyText: '分析が半分たまった状態で始まる',
    eventText: '9ラウンドごとに夢が暴走し、舞台の特徴が入れ替わる（岩場は残る）',
    events: [{ every: 9, run(ctx) { const pool = ['開けた場所', '狭所', '夜空', '反響', '強風', '異界']; const pick = ctx.r.pick(pool); ctx.stage.features = ['岩場', pick]; ctx.say('event', `夢が暴走し、舞台が「${pick}」に変わった`); } }],
    enemyState(ctx, B) { B.meters.analysis = 50; },
    goal: { text: '夢界天星を受けても、体力2割以上残して勝つ', check: res => won(res) && me(res).hp / me(res).maxHp >= 0.2 } },

  // ================================================================ No.004 タルンルソルク
  { id: 'q004_1', boss: 'chr_004', level: 1, name: '小動物の森', features: ['小動物', '狭所'],
    enemyText: 'なし',
    eventText: '4ラウンドごとに小動物が横切り、かわいいもの好きのキャラが見とれる',
    events: [{ every: 4, run(ctx) { withTag(ctx, 'かわいい好き').forEach(f => { if (ctx.r.chance(0.35)) { f.stun = Math.max(f.stun, 1); ctx.say('info', `${f.name}は横切った小動物に見とれている`, { side: f.side }); } }); } }],
    goal: { text: '33ラウンド以内に勝つ（脚を短くされきる前に）', check: res => won(res) && res.rounds <= 33 } },
  { id: 'q004_2', boss: 'chr_004', level: 2, name: 'ちょこちょこ公園', features: ['小動物', '開けた場所'],
    enemyText: '縮脚愛化の効果が長く続く',
    eventText: '6ラウンドごとに短足の犬が散歩に来て、全員の素早さが少し下がる',
    events: [{ every: 6, run(ctx) { both(ctx).forEach(f => addMod(f, { key: 'ev_dog' + ctx.round, stat: 'spd', mul: 0.97, turns: 999, permanent: true })); ctx.say('event', '短足の犬が散歩にやってきた。みんな思わず歩幅が小さくなる'); } }],
    enemyState(ctx, B) { B.flags.longShrink = true; },
    goal: { text: '短足化されても、相手の攻撃を5回以上かわして勝つ', check: res => won(res) && me(res).rec.evaded >= 5 } },
  { id: 'q004_3', boss: 'chr_004', level: 3, name: 'かわいい王国', features: ['安らぎ', '狭所'],
    enemyText: 'かわいい認定済みで、気が散らない',
    eventText: '5ラウンドごとに住民の「かわいい！」の声援で、かわいいもの好きと自信のキャラが強くなる',
    events: [{ every: 5, run(ctx) { both(ctx).filter(f => f.tags.has('かわいい好き') || f.tags.has('自信')).forEach(f => tempMod(f, 'atk', 1.08, 3, 'ev_cute')); ctx.say('event', '住民たちの「かわいい！」の声援が響いた'); } }],
    enemyState(ctx, B) { B.flags.certified = true; addMod(B, { key: 'cert', stat: 'atk', mul: 1.25, turns: 999, permanent: true }); },
    goal: { text: '「全生物かわいい化・試作型」を受けても、体力15%以上残して勝つ', check: res => won(res) && skillUsed(res, 1, '全生物かわいい化') && me(res).hp / me(res).maxHp >= 0.15 } },

  // ================================================================ No.005 ダラガルド
  { id: 'q005_1', boss: 'chr_005', level: 1, name: '昼寝の河原', features: ['安らぎ', '開けた場所'],
    enemyText: '最初の数ラウンドは眠そうで本気を出さない',
    eventText: '7ラウンドごとに気持ちのいい日差しで、興奮で強くなるキャラがときどき気が抜けて休む',
    events: [{ every: 7, run(ctx) { withTag(ctx, '高揚').forEach(f => { if (ctx.r.chance(0.3)) { f.stun = Math.max(f.stun, 1); ctx.say('info', `${f.name}は日差しが気持ちよくて、ひと休みした`, { side: f.side }); } }); } }],
    enemyState(ctx, B) { B.flags.sleepy = true; },
    goal: { text: '45ラウンド以内に勝つ（本気を出される前に）', check: res => won(res) && res.rounds <= 45 } },
  { id: 'q005_2', boss: 'chr_005', level: 2, name: '野生の山', features: ['岩場', '狭所'],
    enemyText: '野生の勘が鋭く、大技をかわしやすい',
    eventText: '6ラウンドごとに山の獣が乱入し、ランダムに襲いかかる',
    events: [{ every: 6, run(ctx) { const f = ctx.r.pick(both(ctx)); ctx.damage(null, f, f.maxHp * 0.035, { event: true }); ctx.say('event', `山の獣が乱入し、${f.name}に襲いかかった`); } }],
    enemyState(ctx, B) { B.flags.keen = true; },
    goal: { text: '体力2割以上残して勝つ', check: res => won(res) && me(res).hp / me(res).maxHp >= 0.2 } },
  { id: 'q005_3', boss: 'chr_005', level: 3, name: '原野', features: ['戦場', '狭所'],
    enemyText: '堕落蓄積が倍の速さでたまる',
    eventText: '25ラウンド目に夕日が沈み、興奮で強くなるキャラが一段強くなる',
    events: [{ at: 25, run(ctx) { withTag(ctx, '高揚').forEach(f => addMod(f, { key: 'ev_dusk', stat: 'atk', mul: 1.15, turns: 999, permanent: true })); ctx.say('event', '夕日が沈み、原野に獣の気配が満ちた'); } }],
    enemyState(ctx, B) { B.flags.fastDecay = true; },
    goal: { text: '理性脱衣の猛攻を耐え抜き、体力15%以上残して勝つ', check: res => won(res) && me(res).hp / me(res).maxHp >= 0.15 } },

  // ================================================================ No.006 カンタレイア
  { id: 'q006_1', boss: 'chr_006', level: 1, name: '路上の広場', features: ['騒音', '開けた場所'],
    enemyText: 'なし',
    eventText: '通行人が少しずつ集まり、音で戦うキャラと領域を作るキャラが強まっていく（50ラウンドで観客10人）',
    events: [{ every: 5, run(ctx) { const n = Math.floor(ctx.round / 5); both(ctx).filter(f => f.uses.has('sound') || f.tags.has('領域')).forEach(f => addMod(f, { key: 'ev_crowd', stat: 'atk', mul: 1 + Math.min(0.15, n * 0.012), turns: 999, permanent: true })); ctx.say('event', `足を止める通行人が増えてきた（観客${n}人）`); } }],
    goal: { text: '観客が10人集まる前（50ラウンド以内）に勝つ', check: res => won(res) && res.rounds <= 50 } },
  { id: 'q006_2', boss: 'chr_006', level: 2, name: '野外ライブ会場', features: ['歓声', '開けた場所'],
    enemyText: '抱響壁が最初から張られている',
    eventText: '15ラウンドごとにアンコールが起き、音で戦うキャラが強くなる',
    events: [{ every: 15, run(ctx) { both(ctx).filter(f => f.uses.has('sound')).forEach(f => tempMod(f, 'atk', 1.15, 3, 'ev_encore')); ctx.say('event', '会場からアンコールの声が上がった'); } }],
    enemyState(ctx, B) { B.shield = B.maxHp * 0.06; },
    goal: { text: '相手の抱響壁を8回以上破って勝つ', check: res => won(res) && foeState(res).rec.shieldBroken >= 8 } },
  { id: 'q006_3', boss: 'chr_006', level: 3, name: '伝歌の大劇場', features: ['反響', '歓声'],
    enemyText: '歌の領域が最初から広がっている',
    eventText: '20ラウンド目に名無しの歌が流れ、全員の行動が1回止まる',
    events: [{ at: 20, run(ctx) { both(ctx).forEach(f => { f.stun = Math.max(f.stun, 1); }); ctx.say('event', 'どこからか、名無しの歌が流れてきた。誰もが一瞬、動きを止める'); } }],
    enemyState(ctx, B) { B.meters.song = 60; },
    goal: { text: '「万声伝歌」を受けても、体力15%以上残して勝つ', check: res => won(res) && me(res).hp / me(res).maxHp >= 0.15 } },

  // ================================================================ No.007 アストラ＝プレア
  { id: 'q007_1', boss: 'chr_007', level: 1, name: '星見の丘（夜明け前）', features: ['開けた場所', '強風'],
    enemyText: '星が少なく、観測がたまりにくい',
    eventText: '20ラウンド目に夜が明け、観測や分析のたまり方がさらに遅くなる',
    events: [{ at: 20, run(ctx) { withTag(ctx, '分析').forEach(f => { f.flags.dawn = true; }); ctx.say('event', '夜が明け、最後の星が消えた'); } }],
    enemyState(ctx, B) { B.flags.dawn = true; },
    goal: { text: '相手の観測が半分たまる前に勝つ', check: res => won(res) && (foeState(res).meters.obs ?? 0) < 50 } },
  { id: 'q007_2', boss: 'chr_007', level: 2, name: '古い天文台', features: ['夜空', '狭所'],
    enemyText: '観測がある程度たまった状態で始まる',
    eventText: '7ラウンドごとに望遠鏡が回り、全員の位置が暴かれる（2ラウンドの間、回避が無効）',
    events: [{ every: 7, run(ctx) { both(ctx).forEach(f => addMod(f, { key: 'ev_scope', negateEvasion: true, turns: 2 })); ctx.say('event', '古い望遠鏡がきしみながら回り、全員の位置が暴かれた'); } }],
    enemyState(ctx, B) { B.meters.obs = 35; },
    goal: { text: '38ラウンド以内に勝つ（観測が仕上がる前に）', check: res => won(res) && res.rounds <= 38 } },
  { id: 'q007_3', boss: 'chr_007', level: 3, name: '天球儀の内部', features: ['夜空', '開けた場所'],
    enemyText: '観測がほぼたまった状態で始まる',
    eventText: '10ラウンドごとに流れ星が降り、追い詰められている側が回復する',
    events: [{ every: 10, run(ctx) { const f = hpRatio(ctx.A) <= hpRatio(ctx.B) ? ctx.A : ctx.B; f.hp = Math.min(f.maxHp, f.hp + f.maxHp * 0.06); ctx.say('event', `流れ星が降り、${f.name}の傷が少し癒えた`); } }],
    enemyState(ctx, B) { B.meters.obs = 80; },
    goal: { text: '「終天観測」を受けても、体力12%以上残して勝つ', check: res => won(res) && me(res).hp / me(res).maxHp >= 0.12 } },

  // ================================================================ No.008 バサラ
  { id: 'q008_1', boss: 'chr_008', level: 1, name: '冬の山寺', features: ['寒冷', '安らぎ'],
    enemyText: 'なし',
    eventText: '8ラウンドごとにお粥が運ばれ、興奮で強くなるキャラが落ち着いて弱くなる',
    events: [{ every: 8, run(ctx) { withTag(ctx, '高揚').forEach(f => tempMod(f, 'atk', 0.9, 4, 'ev_porridge')); ctx.say('event', '住職が温かいお粥を運んできた'); } }],
    goal: { text: '相手に発熱暴走をさせず、40ラウンド以内に勝つ', check: res => won(res) && !skillUsed(res, 1, '発熱暴走') && res.rounds <= 40 } },
  { id: 'q008_2', boss: 'chr_008', level: 2, name: '吹雪の峠', features: ['寒冷', '強風'],
    enemyText: '風邪胞子を最初からまとっている（挑戦者は最初から少し風邪気味）',
    eventText: '6ラウンドごとに吹雪が強まり、全員の素早さが下がっていく',
    events: [{ every: 6, run(ctx) { both(ctx).forEach(f => addMod(f, { key: 'ev_snow' + ctx.round, stat: 'spd', mul: 0.97, turns: 999, permanent: true })); ctx.say('event', '吹雪がいっそう強くなった'); } }],
    enemyState(ctx, B, A) { A.meters.cold = 3; addMod(A, { key: 'cold', stat: 'atk', mul: 0.94, turns: 99 }); addMod(A, { key: 'cold2', stat: 'spd', mul: 0.925, turns: 99 }); },
    goal: { text: '35ラウンド以内に勝つ（風邪が悪化する前に）', check: res => won(res) && res.rounds <= 35 } },
  { id: 'q008_3', boss: 'chr_008', level: 3, name: '風邪の嵐', features: ['寒冷', '強風', '狭所'],
    enemyText: '最初から体調が悪く、機嫌も悪い',
    eventText: '5ラウンドごとにくしゃみが連鎖し、暴風が全員を巻き込む（盾も吹き飛ぶ）',
    events: [{ every: 5, run(ctx) { if (!ctx.r.chance(0.6)) return; both(ctx).forEach(f => { f.shield = 0; ctx.damage(null, f, f.maxHp * 0.025, { event: true }); }); ctx.say('event', 'くしゃみが連鎖し、暴風が全員を巻き込んだ'); } }],
    enemyState(ctx, B) { B.meters.ill = 70; },
    goal: { text: '相手に戦いをやめさせて勝つ', check: res => won(res) && foeState(res).forfeit } },

  // ================================================================ No.009 トツカイザー
  { id: 'q009_1', boss: 'chr_009', level: 1, name: '訓練場', features: ['無風', '狭所'],
    enemyText: 'なし（無風で帆走加速が弱い）',
    eventText: '6ラウンドごとに「立て！」の掛け声で、体力が減っている側が強くなる',
    events: [{ every: 6, run(ctx) { const f = hpRatio(ctx.A) <= hpRatio(ctx.B) ? ctx.A : ctx.B; tempMod(f, 'atk', 1.1, 3, 'ev_stand'); ctx.say('event', `「立て！」――掛け声に、${f.name}が奮い立った`); } }],
    goal: { text: '最初の5ラウンドを、体力9割以上残して耐えて勝つ', check: res => won(res) && me(res).rec.hpAtR5 >= 0.9 } },
  { id: 'q009_2', boss: 'chr_009', level: 2, name: '逆風の海峡', features: ['強風', '開けた場所'],
    enemyText: '帆が完全に張られた状態で始まる',
    eventText: '5ラウンドごとに高波が来て、ランダムに体勢が崩れる',
    events: [{ every: 5, run(ctx) { both(ctx).forEach(f => { if (ctx.r.chance(0.25)) { f.stun = Math.max(f.stun, 1); ctx.say('info', `高波で${f.name}の体勢が崩れた`, { side: f.side }); } }); } }],
    enemyState(ctx, B) { B.flags.strongWind = true; },
    goal: { text: '最初の8ラウンドで、相手の体力を3割以上削って勝つ（帆を破る）', check: res => won(res) && foeState(res).rec.takenByR8 >= 0.3 } },
  { id: 'q009_3', boss: 'chr_009', level: 3, name: '荒海の卒業航路', features: ['強風', '狭所'],
    enemyText: 'ワイヤーが張られた状態で始まる',
    eventText: '20ラウンド目に「お前は、それでも進むか？」と問われ、覚悟の高いキャラが強くなる',
    events: [{ at: 20, run(ctx) { both(ctx).filter(f => f.resolve === 'high').forEach(f => addMod(f, { key: 'ev_ask', stat: 'atk', mul: 1.12, turns: 999, permanent: true })); ctx.say('event', '「お前は、それでも進むか？」――荒海に問いが響いた'); } }],
    enemyState(ctx, B) { B.meters.wire = 30; },
    goal: { text: '「荒海卒業式」を受けても、体力12%以上残して勝つ', check: res => won(res) && skillUsed(res, 1, '荒海卒業式') && me(res).hp / me(res).maxHp >= 0.12 } },

  // ================================================================ No.010 デウマグナ
  { id: 'q010_1', boss: 'chr_010', level: 1, name: '小さな祭壇', features: ['静寂', '狭所'],
    enemyText: '祭壇が小さく、偽神魔界がすぐ不安定になる',
    eventText: '5ラウンドごとに祭壇の灯が消えかけ、領域と自信のキャラが不安定になる',
    events: [{ every: 5, run(ctx) { both(ctx).filter(f => f.tags.has('領域') || f.tags.has('自信')).forEach(f => { tempMod(f, 'def', 0.94, 2, 'ev_altar'); if (f.meters.conf != null) f.meters.conf = Math.max(0, f.meters.conf - 8); }); ctx.say('event', '祭壇の灯が、ふっと消えかけた'); } }],
    enemyState(ctx, B) { B.flags.smallAltar = true; },
    goal: { text: '偽神魔界を崩し、28ラウンド以内に勝つ', check: res => won(res) && logHas(res, '偽神魔界が崩れた') && res.rounds <= 28 } },
  { id: 'q010_2', boss: 'chr_010', level: 2, name: '偽神魔界の広間', features: ['祭壇', '狭所'],
    enemyText: '偽神魔界が最初から展開され、自信が減りにくい',
    eventText: '5ラウンドごとに信者像が拝み、自信のキャラが自信を取り戻す',
    events: [{ every: 5, run(ctx) { withTag(ctx, '自信').forEach(f => { tempMod(f, 'atk', 1.05, 2, 'ev_idol'); if (f.meters.conf != null) f.meters.conf = Math.min(100, f.meters.conf + 8); }); ctx.say('event', '広間の信者像が、一斉に頭を垂れた'); } }],
    enemyState(ctx, B) { B.flags.hall = true; },
    goal: { text: '「神魔王モード」を発動させずに勝つ', check: res => won(res) && !skillUsed(res, 1, '神魔王モード') } },
  { id: 'q010_3', boss: 'chr_010', level: 3, name: '神魔の玉座', features: ['祭壇', '歓声'],
    enemyText: '自信が減りにくい',
    eventText: '4ラウンドごとに玉座が軋み、押されている自信のキャラが大きく揺らぐ',
    events: [{ every: 4, run(ctx) { withTag(ctx, '自信').forEach(f => { if (hpRatio(f) < hpRatio(ctx.foe(f))) { tempMod(f, 'atk', 0.94, 2, 'ev_throne'); if (f.meters.conf != null) f.meters.conf = Math.max(0, f.meters.conf - 12); ctx.say('info', `玉座が軋み、${f.name}の自信が揺らいだ`, { side: f.side }); } }); } }],
    enemyState(ctx, B) { B.flags.steady = true; },
    goal: { text: '「偽・天地魔界崩壊」を受けても勝つ', check: res => won(res) && skillUsed(res, 1, '偽・天地魔界崩壊') } },

  // ================================================================ No.011 カンカラッチ
  { id: 'q011_1', boss: 'chr_011', level: 1, name: '深夜の踏切', features: ['静寂', '狭所'],
    enemyText: '蓄えた警報音が少なく、撹乱が弱い',
    eventText: '6ラウンドごとに終電が通過し、そのラウンドは全員の回避が無効になる',
    events: [{ every: 6, run(ctx) { both(ctx).forEach(f => addMod(f, { key: 'ev_train', negateEvasion: true, turns: 1 })); ctx.say('event', '踏切を電車が通過し、轟音がすべてをかき消した'); } }],
    enemyState(ctx, B) { B.meters.echo = 45; },
    goal: { text: '一度も行動不能にならずに勝つ', check: res => won(res) && me(res).rec.stunned === 0 } },
  { id: 'q011_2', boss: 'chr_011', level: 2, name: '高架下の反響', features: ['反響', '狭所'],
    enemyText: '警界が最初から展開されている',
    eventText: '5ラウンドごとに警報音が跳ね返り、音で戦うキャラが強くなる',
    events: [{ every: 5, run(ctx) { both(ctx).filter(f => f.uses.has('sound')).forEach(f => tempMod(f, 'atk', 1.12, 3, 'ev_echo')); ctx.say('event', 'コンクリートの壁に警報音が跳ね返り、何重にも重なった'); } }],
    enemyState(ctx, B, A) { B.flags.barrier = true; addMod(A, { key: 'kankai', stat: 'wis', mul: 0.85, turns: 5 }); },
    goal: { text: '25ラウンド以内に勝つ', check: res => won(res) && res.rounds <= 25 } },
  { id: 'q011_3', boss: 'chr_011', level: 3, name: '開かずの踏切', features: ['反響', '騒音', '狭所'],
    enemyText: '警報音を満タンに蓄えていて、撹乱が最も強い',
    eventText: '4ラウンドごとに遮断機が降り、その間は距離を取れなくなる（遠距離型が不利）',
    events: [{ every: 4, run(ctx) { both(ctx).filter(f => f.tags.has('遠距離')).forEach(f => tempMod(f, 'atk', 0.9, 2, 'ev_gate')); ctx.say('event', '遮断機が降り、逃げ場がなくなった'); } }],
    enemyState(ctx, B) { B.meters.echo = 130; },
    goal: { text: '終電警鐘を受けても、体力15%以上残して勝つ', check: res => won(res) && skillUsed(res, 1, '終電警鐘') && me(res).hp / me(res).maxHp >= 0.15 } },

  // ================================================================ No.012 ネガヴォイド
  { id: 'q012_1', boss: 'chr_012', level: 1, name: '心の入口', features: ['静寂', '開けた場所'],
    enemyText: '解析がほとんど進んでいない状態で始まる',
    eventText: '7ラウンドごとに心淵界の風が吹き、精神干渉が少し強まる',
    events: [{ every: 7, run(ctx) { both(ctx).filter(f => f.tags.has('精神干渉')).forEach(f => tempMod(f, 'atk', 1.08, 3, 'ev_void')); ctx.say('event', '心淵界から、冷たい風が吹き抜けた'); } }],
    enemyState(ctx, B) { B.meters.read = 0; addMod(B, { key: 'slowread', stat: 'atk', mul: 0.85, turns: 8 }); },
    goal: { text: '52ラウンド以内に勝つ（解析が仕上がる前に）', check: res => won(res) && res.rounds <= 52 } },
  { id: 'q012_2', boss: 'chr_012', level: 2, name: '隠された部屋', features: ['生命の気配', '狭所'],
    enemyText: '精神座標が完成した状態で始まる',
    eventText: '6ラウンドごとに幻影が現れ、覚悟の低いキャラの命中が下がる',
    events: [{ every: 6, run(ctx) { both(ctx).filter(f => f.resolve === 'low').forEach(f => tempMod(f, 'wis', 0.88, 3, 'ev_mirror')); ctx.say('event', '認めたくなかったものが、幻影となって現れた'); } }],
    enemyState(ctx, B) { B.meters.read = 55; B.flags.coord = true; },
    goal: { text: '覚悟の高い個体で勝つ', check: res => won(res) && me(res).resolve === 'high' } },
  { id: 'q012_3', boss: 'chr_012', level: 3, name: '心淵界の深層', features: ['生命の気配', '異界', '開けた場所'],
    enemyText: '解析がほぼ仕上がった状態で始まる',
    eventText: '8ラウンドごとに心淵界が広がり、精神干渉がさらに強まる',
    events: [{ every: 8, run(ctx) { both(ctx).filter(f => f.tags.has('精神干渉')).forEach(f => tempMod(f, 'atk', 1.12, 4, 'ev_deep')); ctx.say('event', '心淵界がまた一つ、新しい部屋を作った'); } }],
    enemyState(ctx, B) { B.meters.read = 78; B.flags.coord = true; },
    goal: { text: '無明牢を受けても、体力12%以上残して勝つ', check: res => won(res) && skillUsed(res, 1, '無明牢') && me(res).hp / me(res).maxHp >= 0.12 } },

  // ================================================================ No.013 タメリス
  { id: 'q013_1', boss: 'chr_013', level: 1, name: '空っぽの隠し蔵', features: ['開けた場所', '安らぎ'],
    enemyText: '備蓄が半分しかない',
    eventText: '6ラウンドごとにどんぐりが転がってきて、拾った側が少し回復する',
    events: [{ every: 6, run(ctx) { const f = ctx.r.pick(both(ctx)); f.hp = Math.min(f.maxHp, f.hp + f.maxHp * 0.03); ctx.say('event', `どんぐりが転がってきて、${f.name}が拾った`); } }],
    enemyState(ctx, B) { B.meters.stock = 50; },
    goal: { text: '体力を5割以上残して勝つ', check: res => won(res) && me(res).hp / me(res).maxHp >= 0.5 } },
  { id: 'q013_2', boss: 'chr_013', level: 2, name: '備蓄庫の奥', features: ['狭所', '安らぎ'],
    enemyText: '先払い治療を厚めに張った状態で始まる',
    eventText: '5ラウンドごとに棚から物資が落ち、体力の少ない側が回復する',
    events: [{ every: 5, run(ctx) { const f = hpRatio(ctx.A) <= hpRatio(ctx.B) ? ctx.A : ctx.B; f.hp = Math.min(f.maxHp, f.hp + f.maxHp * 0.04); ctx.say('event', `棚から物資が落ちてきて、${f.name}が使った`); } }],
    enemyState(ctx, B) { B.shield = B.maxHp * 0.16; },
    goal: { text: '体力を45%以上残して勝つ', check: res => won(res) && me(res).hp / me(res).maxHp >= 0.45 } },
  { id: 'q013_3', boss: 'chr_013', level: 3, name: '終末蔵の前', features: ['開けた場所', '祭壇'],
    enemyText: '備蓄が満タンで、回復を惜しまない',
    eventText: '10ラウンドごとに「まだ使う時じゃない」と備蓄を出し渋り、そのラウンドは回復が弱まる',
    events: [{ every: 10, run(ctx) { ctx.B.flags.hesitate = true; ctx.say('event', '「……まだ使う時じゃない」――タメリスが備蓄を出し渋った'); } }],
    enemyState(ctx, B) { B.meters.stock = 120; },
    goal: { text: '体力を25%以上残して勝つ', check: res => won(res) && me(res).hp / me(res).maxHp >= 0.25 } },
];

// ---- 周回ステージ（敵は等級の範囲からランダム） ----
const FARM_STAGES = [
  { id: 'farm_1', name: 'はじまりの草原', difficulty: '初級', grades: ['F', 'E', 'D'], reward: 60, cooldown: 30,
    features: ['開けた場所'], enemyInd: { power: 160, speed: 160, wisdom: 160 }, enemyPower: 0.8,
    eventText: '5ラウンドごとにそよ風が吹き、全員が少し回復する',
    events: [{ every: 5, run(ctx) { both(ctx).forEach(f => { f.hp = Math.min(f.maxHp, f.hp + f.maxHp * 0.02); }); ctx.say('event', 'そよ風が吹き、少しだけ疲れが取れた'); } }],
    goal: null },
  { id: 'farm_2', name: '黄昏の闘技場', difficulty: '中級', grades: ['C', 'B'], reward: 150, cooldown: 120,
    features: ['狭所', '歓声'], enemyInd: { power: 300, speed: 300, wisdom: 300 }, enemyPower: 0.9,
    eventText: '6ラウンドごとに観客が物を投げ込み、ランダムに小さなダメージ。自信のキャラは歓声で少し強くなる',
    events: [{ every: 6, run(ctx) { const f = ctx.r.pick(both(ctx)); ctx.damage(null, f, f.maxHp * 0.02, { event: true }); withTag(ctx, '自信').forEach(x => tempMod(x, 'atk', 1.04, 3, 'ev_arena')); ctx.say('event', `観客が物を投げ込み、${f.name}に当たった`); } }],
    goal: { text: '連勝するほど報酬が増える（最大5連勝で1.5倍）', streak: true } },
  { id: 'farm_3', name: '神々の遺跡', difficulty: '上級', grades: ['A', 'S'], reward: 400, cooldown: 300,
    features: ['岩場', '夜空', '異界'], enemyInd: { power: 800, speed: 800, wisdom: 800 }, enemyPower: 0.95,
    eventText: '6ラウンドごとに遺跡の像が目覚め、ランダムな加護を片方に与える',
    events: [{ every: 6, run(ctx) { const f = ctx.r.pick(both(ctx)); tempMod(f, ctx.r.pick(['atk', 'def', 'spd']), 1.12, 3, 'ev_ruin'); ctx.say('event', `遺跡の像が目覚め、${f.name}に加護を与えた`); } }],
    goal: { text: '40ラウンド以内に勝つと報酬1.5倍', check: res => won(res) && res.rounds <= 40, multiplier: 1.5 } }
];

// 敵の強さ（与えるダメージの倍率）。tools/stage-sim.js --calibrate で難しさに合わせて調整する
const STAGE_POWER = {
  q001_1: 0.904,
  q001_2: 0.885,
  q001_3: 0.957,
  q002_1: 0.95,
  q002_2: 0.937,
  q002_3: 0.899,
  q003_1: 0.766,
  q003_2: 0.701,
  q003_3: 0.882,
  q004_1: 0.985,
  q004_2: 1.219,
  q004_3: 1.015,
  q005_1: 1.035,
  q005_2: 0.914,
  q005_3: 0.959,
  q006_1: 0.892,
  q006_2: 0.853,
  q006_3: 0.84,
  q007_1: 0.804,
  q007_2: 0.832,
  q007_3: 0.837,
  q008_1: 0.867,
  q008_2: 0.882,
  q008_3: 1.019,
  q009_1: 0.942,
  q009_2: 0.968,
  q009_3: 0.94,
  q010_1: 0.989,
  q010_2: 0.953,
  q010_3: 1.358,
  q011_1: 1.044,
  q011_2: 0.876,
  q011_3: 1.009,
  q012_1: 0.619,
  q012_2: 0.863,
  q012_3: 0.917,
  q013_1: 0.853,
  q013_2: 1.199,
  q013_3: 1.053
};
