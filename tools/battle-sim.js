// =====================================================================
// 対戦のバランス確認（Node.js）
//   node tools/battle-sim.js                … 全組み合わせの勝率表とラウンド数
//   node tools/battle-sim.js 300            … 1組あたりの戦闘数を指定（既定200）
//   node tools/battle-sim.js --features 戦場,開けた場所   … 舞台の特徴を指定
//   node tools/battle-sim.js --calibrate    … 等級ごとの目標勝率に合わせて KIT_TUNE を計算して表示
//                                            （結果は js/battle.js の KIT_TUNE に手で貼り付ける）
// =====================================================================
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const run = eval;   // グローバルで読み込む（変数名の衝突を避ける）
run(fs.readFileSync(path.join(root, 'data/characters.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'js/battle.js'), 'utf8') +
  '\n;globalThis.__B = { runBattle, CHARACTERS, KIT_TUNE, FIGHTER_KITS };');
const { runBattle, CHARACTERS, KIT_TUNE, FIGHTER_KITS } = globalThis.__B;

const args = process.argv.slice(2);
const N = Number(args.find(a => /^\d+$/.test(a))) || 200;
const fi = args.indexOf('--features');
const features = fi >= 0 ? (args[fi + 1] || '').split(',').filter(Boolean) : [];
const TARGET = { S: 66, A: 60, B: 52, C: 46, D: 36, E: 33, F: 30, ORIGIN: 50 };

let seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const roll = () => { const y = -Math.log10(1 - rnd()); const d = (-1.4 + Math.sqrt(1.96 + 1.2 * y)) / 0.6; return Math.floor(100 * Math.pow(10, d)); };
const ind = () => ({ power: roll(), speed: roll(), wisdom: roll() });
const chars = CHARACTERS.filter(c => FIGHTER_KITS[c.id]);
const missing = CHARACTERS.filter(c => !FIGHTER_KITS[c.id]).map(c => c.id);
if (missing.length) console.log('!! 部品（FIGHTER_KITS）がないキャラ:', missing.join(', '));

function measure(n) {
  const pair = {}, win = {}, games = {}, rounds = [];
  for (const a of chars) for (const b of chars) {
    if (a === b) continue;
    let w = 0;
    for (let i = 0; i < n; i++) {
      const r = runBattle({ a: { ch: a, ind: ind() }, b: { ch: b, ind: ind() }, stage: { name: '確認', features: [...features] }, seed: seed++ });
      const x = r.winner === 0 ? 1 : r.winner === 1 ? 0 : 0.5;
      w += x; rounds.push(r.rounds);
    }
    pair[a.id + b.id] = w / n;
  }
  for (const a of chars) {
    let s = 0;
    for (const b of chars) if (a !== b) s += (pair[a.id + b.id] + 1 - pair[b.id + a.id]) / 2;
    win[a.id] = s / (chars.length - 1) * 100;
  }
  rounds.sort((x, y) => x - y);
  return { pair, win, rounds };
}

const short = c => (FIGHTER_KITS[c.id].short || c.name).replace('＝プレア', '').slice(0, 5);
if (args.includes('--calibrate')) {
  const T = { ...KIT_TUNE }; chars.forEach(c => { if (!T[c.id]) T[c.id] = 1; });
  const hist = [];
  for (let it = 0; it < 12; it++) {
    Object.assign(KIT_TUNE, T);
    const m = measure(it < 8 ? 40 : 80);
    console.log('調整', it + 1, chars.map(c => `${short(c)} ${m.win[c.id].toFixed(0)}/${TARGET[c.grade]}`).join('  '));
    for (const c of chars) T[c.id] = Math.max(0.3, Math.min(3, T[c.id] * Math.exp(0.7 * (TARGET[c.grade] - m.win[c.id]) / 100)));
    hist.push({ ...T });
  }
  const last = hist.slice(-4); const out = {};
  for (const c of chars) out[c.id] = +(last.reduce((s, h) => s + h[c.id], 0) / last.length).toFixed(3);
  console.log('\n次の値を js/battle.js の KIT_TUNE に貼り付けてください:\nconst KIT_TUNE = ' + JSON.stringify(out, null, 1).replace(/"/g, "'") + ';');
} else {
  const m = measure(N);
  const q = p => m.rounds[Math.floor(m.rounds.length * p)];
  console.log(`舞台の特徴: ${features.join('・') || 'なし'}　／　1組あたり ${N} 戦`);
  console.log(`ラウンド数: 下位10% ${q(0.1)}　中央 ${q(0.5)}　上位10% ${q(0.9)}（目標は中央30〜50）\n`);
  console.log('全体の勝率（目標）');
  chars.forEach(c => console.log(`  ${(short(c) + '　　　').slice(0, 6)} ${c.grade}級  ${m.win[c.id].toFixed(0).padStart(3)}%（${TARGET[c.grade]}%）${Math.abs(m.win[c.id] - TARGET[c.grade]) > 6 ? ' ←要調整' : ''}`));
  console.log('\n組み合わせの勝率（行のキャラが列のキャラに勝つ割合）');
  console.log('        ' + chars.map(c => short(c).slice(0, 3).padEnd(3, '　')).join(' '));
  for (const a of chars) console.log((short(a) + '　　　').slice(0, 5) + ' ' + chars.map(b => a === b ? ' －  ' : String(Math.round((m.pair[a.id + b.id] + 1 - m.pair[b.id + a.id]) / 2 * 100)).padStart(4) + ' ').join(''));
}
