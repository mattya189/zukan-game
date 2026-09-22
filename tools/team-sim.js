// =====================================================================
// 集団戦の確認（Node.js）
//   node tools/team-sim.js               … 練習試合（2対2・3対3）のラウンド数と、キャラごとの活躍（入ったチームの勝率）
//                                           ＋ 集団戦クエスト10個の勝率・挑戦目標の達成率
//   node tools/team-sim.js --calibrate   … 集団戦クエストの勝率を約30%に合わせた TEAM_STAGE_POWER を表示
//   node tools/team-sim.js --tune        … 練習試合の活躍を等級の目標に合わせた TEAM_TUNE を表示
//   ※結果は、表示された値を data/team-stages.js と js/team.js に手で貼り付ける
// =====================================================================
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const run = eval;
run(['data/characters.js', 'js/battle.js', 'js/team.js', 'data/team-stages.js'].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n') +
  '\n;globalThis.__T = { runTeamBattle, CHARACTERS, TEAM_STAGES, TEAM_ENEMY_IND, TEAM_STAGE_POWER, TEAM_TUNE };');
const { runTeamBattle, CHARACTERS, TEAM_STAGES, TEAM_ENEMY_IND, TEAM_STAGE_POWER, TEAM_TUNE } = globalThis.__T;
const by = Object.fromEntries(CHARACTERS.map(c => [c.id, c]));
let seed = 23;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const roll = () => { const y = -Math.log10(1 - rnd()); const d = (-1.4 + Math.sqrt(1.96 + 1.2 * y)) / 0.6; return Math.floor(100 * Math.pow(10, d)); };
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// 並び：近接型を前衛、遠距離型を後衛（全員遠距離なら1体を前衛に）
function team(chars) {
  const s = chars.slice().sort((a, b) => (a.tags.includes('遠距離') ? 1 : 0) - (b.tags.includes('遠距離') ? 1 : 0));
  const nf = Math.max(1, Math.ceil(s.length / 2));
  return s.map((ch, i) => ({ ch, ind: { power: roll(), speed: roll(), wisdom: roll() }, row: i < nf ? 'front' : 'back' }));
}
const GRADE = { S: 66, A: 60, B: 52, C: 46, D: 36, E: 33, F: 30, ORIGIN: 50 };
const teamTarget = g => 50 + (GRADE[g] - 50) * 0.6;
const short = id => by[id].name.replace(/.*＝/, '').slice(0, 5);
const args = process.argv.slice(2);

function practice(N) {
  const w = {}, g = {}, out = {};
  for (const size of [2, 3]) {
    const rounds = [];
    for (let i = 0; i < N; i++) {
      const p = shuffle(CHARACTERS); const A = p.slice(0, size), B = p.slice(size, size * 2);
      const r = runTeamBattle({ teams: [team(A), team(B)], seed: Math.floor(rnd() * 1e9) });
      const x = r.winner === 0 ? 1 : r.winner === 1 ? 0 : 0.5; rounds.push(r.rounds);
      A.forEach(c => { w[c.id] = (w[c.id] || 0) + x; g[c.id] = (g[c.id] || 0) + 1; });
      B.forEach(c => { w[c.id] = (w[c.id] || 0) + 1 - x; g[c.id] = (g[c.id] || 0) + 1; });
    }
    rounds.sort((a, b) => a - b);
    out[size] = rounds;
  }
  return { win: Object.fromEntries(CHARACTERS.map(c => [c.id, w[c.id] / g[c.id] * 100])), rounds: out };
}
function questMeasure(st, power, N) {
  let w = 0, goal = 0, rounds = 0; const per = {}, cnt = {};
  for (let i = 0; i < N; i++) {
    const mine = shuffle(CHARACTERS).slice(0, st.size);
    const r = runTeamBattle({ teams: [team(mine), st.enemies.map(e => ({ ch: by[e.id], ind: TEAM_ENEMY_IND, row: e.row }))],
      stage: { name: st.name, features: [...st.features], events: st.events, enemyState: st.enemyState, enemyPower: power }, seed: Math.floor(rnd() * 1e9) });
    const win = r.winner === 0; w += win; rounds += r.rounds; if (win && st.goal.check(r)) goal++;
    mine.forEach(c => { per[c.id] = (per[c.id] || 0) + win; cnt[c.id] = (cnt[c.id] || 0) + 1; });
  }
  return { win: w / N * 100, goal: w ? goal / w * 100 : 0, rounds: rounds / N, per: Object.fromEntries(Object.keys(per).map(k => [k, per[k] / cnt[k]])) };
}

if (args.includes('--tune')) {
  const T = { ...TEAM_TUNE }; const hist = [];
  for (let it = 0; it < 12; it++) {
    Object.assign(TEAM_TUNE, T);
    const m = practice(it < 8 ? 500 : 900);
    console.log('調整', it + 1, CHARACTERS.map(c => `${short(c.id)} ${m.win[c.id].toFixed(0)}/${teamTarget(c.grade).toFixed(0)}`).join('  '));
    for (const c of CHARACTERS) T[c.id] = Math.max(0.4, Math.min(2.5, (T[c.id] || 1) * Math.exp(1.2 * (teamTarget(c.grade) - m.win[c.id]) / 100)));
    hist.push({ ...T });
  }
  const out = {}; for (const c of CHARACTERS) { const l = hist.slice(-4); out[c.id] = +(l.reduce((s, h) => s + h[c.id], 0) / l.length).toFixed(3); }
  console.log('\n次の値を js/team.js の TEAM_TUNE に貼り付けてください:\nconst TEAM_TUNE = ' + JSON.stringify(out).replace(/"/g, '') + ';');
} else {
  const P = { ...TEAM_STAGE_POWER };
  if (!args.includes('--calibrate')) {
    const m = practice(800);
    const q = (a, p) => a[Math.floor(a.length * p)];
    console.log(`練習試合　2対2：ラウンド数 中央${q(m.rounds[2], 0.5)}（下位10% ${q(m.rounds[2], 0.1)}、上位10% ${q(m.rounds[2], 0.9)}）　3対3：中央${q(m.rounds[3], 0.5)}`);
    console.log('キャラごとの活躍（入ったチームの勝率／目標）');
    CHARACTERS.forEach(c => console.log(`  ${(short(c.id) + '　　　').slice(0, 6)} ${c.grade}級 ${m.win[c.id].toFixed(0).padStart(3)}%（${teamTarget(c.grade).toFixed(0)}%）`));
    console.log('');
  }
  for (const st of TEAM_STAGES) {
    let p = P[st.id] || 1;
    if (args.includes('--calibrate')) { for (let it = 0; it < 5; it++) { const m = questMeasure(st, p, 300); p = Math.max(0.3, Math.min(2.5, p * Math.exp(-0.8 * (30 - m.win) / 100))); } P[st.id] = +p.toFixed(3); }
    const m = questMeasure(st, p, 300);
    const best = Object.entries(m.per).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, v]) => short(id) + Math.round(v * 100)).join(' ');
    console.log(`${st.id} ${st.size}対${st.size} ${(st.name + '　　　　　　　　').slice(0, 10)} 勝率${m.win.toFixed(0).padStart(3)}%（目標30）　目標達成${m.goal.toFixed(0).padStart(3)}%　平均${m.rounds.toFixed(0)}R　入ると強い：${best}`);
  }
  if (args.includes('--calibrate')) console.log('\n次の値を data/team-stages.js の TEAM_STAGE_POWER に貼り付けてください:\nconst TEAM_STAGE_POWER = ' + JSON.stringify(P).replace(/"/g, '') + ';');
}
