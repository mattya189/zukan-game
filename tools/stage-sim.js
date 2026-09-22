// =====================================================================
// クエストの難しさ確認（Node.js）
//   node tools/stage-sim.js              … 33ステージの勝率・挑戦目標の達成率・得意なキャラ
//   node tools/stage-sim.js q001_1       … ステージを指定
//   node tools/stage-sim.js --calibrate  … 目標の勝率（段階1=75%、2=50%、3=25%）に合わせた STAGE_POWER を表示
//                                          （結果は data/stages.js の STAGE_POWER に手で貼り付ける）
//   挑戦者は10体すべて、個体値はランダム（ガチャと同じ出にくさ）で測る
// =====================================================================
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const run = eval;
run(['data/characters.js', 'js/battle.js', 'data/stages.js'].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n') +
  '\n;globalThis.__Q = { runBattle, CHARACTERS, STAGES, FARM_STAGES, ENEMY_IND, STAGE_POWER };');
const { runBattle, CHARACTERS, STAGES, FARM_STAGES, ENEMY_IND, STAGE_POWER } = globalThis.__Q;

const by = Object.fromEntries(CHARACTERS.map(c => [c.id, c]));
let seed = 99;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const roll = () => { const y = -Math.log10(1 - rnd()); const d = (-1.4 + Math.sqrt(1.96 + 1.2 * y)) / 0.6; return Math.floor(100 * Math.pow(10, d)); };
const TARGET = { 1: 75, 2: 50, 3: 25 };
const args = process.argv.slice(2);
const only = args.filter(a => /^q\d{3}_\d$|^farm_\d$/.test(a));
const short = id => by[id].name.replace(/.*＝/, '').slice(0, 5);

const stageObj = (st, power) => ({ name: st.name, features: [...st.features], events: st.events, enemyState: st.enemyState, enemyPower: power });
function measure(st, power, n) {
  const per = {}; let w = 0, g = 0, goal = 0, rounds = 0;
  for (const ch of CHARACTERS) {
    let cw = 0;
    for (let i = 0; i < n; i++) {
      const r = runBattle({ a: { ch, ind: { power: roll(), speed: roll(), wisdom: roll() } }, b: { ch: by[st.boss], ind: ENEMY_IND[st.level] }, stage: stageObj(st, power), seed: Math.floor(rnd() * 1e9) });
      const win = r.winner === 0; cw += win; w += win; g++; rounds += r.rounds;
      if (win && st.goal && st.goal.check(r)) goal++;
    }
    per[ch.id] = cw / n;
  }
  return { win: w / g * 100, per, goal: w ? goal / w * 100 : 0, rounds: rounds / g };
}

const calibrate = args.includes('--calibrate');
const P = { ...STAGE_POWER };
for (const st of STAGES) {
  if (only.length && !only.includes(st.id)) continue;
  let p = P[st.id] || 1;
  if (calibrate) {
    for (let it = 0; it < 7; it++) { const m = measure(st, p, it < 5 ? 12 : 24); p = Math.max(0.4, Math.min(2.5, p * Math.exp(-0.9 * (TARGET[st.level] - m.win) / 100))); }
    P[st.id] = +p.toFixed(3);
  }
  const m = measure(st, p, 30);
  const best = Object.entries(m.per).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, v]) => short(id) + Math.round(v * 100)).join(' ');
  console.log(`${st.id} 段階${st.level} ${(st.name + '　　　　　　　').slice(0, 9)} 勝率${m.win.toFixed(0).padStart(3)}%（目標${TARGET[st.level]}）　目標達成${m.goal.toFixed(0).padStart(3)}%　平均${m.rounds.toFixed(0)}R　得意：${best}`);
}
if (!only.length || only.some(x => x.startsWith('farm'))) {
  for (const st of FARM_STAGES) {
    if (only.length && !only.includes(st.id)) continue;
    const pool = CHARACTERS.filter(c => st.grades.includes(c.grade));
    let w = 0, g = 0;
    for (const ch of CHARACTERS) for (let i = 0; i < 30; i++) {
      const foe = pool[Math.floor(rnd() * pool.length)];
      const r = runBattle({ a: { ch, ind: { power: roll(), speed: roll(), wisdom: roll() } }, b: { ch: foe, ind: st.enemyInd }, stage: stageObj(st, st.enemyPower || 1), seed: Math.floor(rnd() * 1e9) });
      w += r.winner === 0; g++;
    }
    console.log(`${st.id} 周回${st.difficulty} ${st.name}　勝率${Math.round(w / g * 100)}%`);
  }
}
if (calibrate) console.log('\n次の値を data/stages.js の STAGE_POWER に貼り付けてください:\nconst STAGE_POWER = ' + JSON.stringify(P, null, 1).replace(/"/g, '') + ';');
