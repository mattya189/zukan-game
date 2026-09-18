// =====================================================================
// バランス確認スクリプト（Node.js で動かす）
//   使い方：
//     node tools/sim.js            … ひととおり確認
//     node tools/sim.js battles 5000   … ランダム対戦だけ
//     node tools/sim.js quests 200     … クエストの勝率だけ
//     node tools/sim.js stats 300000   … 個体値と称号の出やすさだけ
//   ブラウザを使わずに、数値だけを確かめるための道具です。
// =====================================================================
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = ['data/characters.js', 'data/artifacts.js', 'data/quests.js', 'data/rules.js', 'js/game.js'];
const src = files.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');

// ブラウザの代わりになる最低限の部品
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
const runInGlobal = eval;   // グローバルで読み込む（変数名の衝突を避ける）
const api = runInGlobal(src + '\n;({ GameServer, Battle, CARDS, CARD_MAP, ARTIFACT_MAP, QUESTS, TITLES, titlesOf, randomDeck, Rng, RULES, CHARACTERS, generateIndividual, isArtifact, powerChance, ratioChance })');
const { GameServer, Battle, CARD_MAP, QUESTS, TITLES, titlesOf, randomDeck, Rng, RULES, CHARACTERS, generateIndividual, isArtifact } = api;

const pct = (a, b) => `${(a / b * 100).toFixed(1)}%`;
const line = s => console.log(s);

function battles(n = 4000) {
  line(`\n■ ランダムなデッキ同士の対戦（${n}戦）`);
  const rng = new Rng(12345);
  const card = {}, kw = {}, el = {}, art = {};
  let turns = 0, first = 0, draws = 0;
  const add = (m, k, w) => { const v = m[k] || (m[k] = { g: 0, w: 0 }); v.g++; if (w) v.w++; };
  for (let i = 0; i < n; i++) {
    const A = randomDeck(rng), B = randomDeck(rng);
    const b = new Battle({ seed: rng.int(1e9), record: false, players: [{ name: 'A', ...A }, { name: 'B', ...B }] });
    const w = b.runToEnd();
    turns += b.turn;
    if (w === null) draws++; else if (w === 0) first++;
    [[A, 0], [B, 1]].forEach(([d, side]) => {
      const won = w === side;
      d.deck.forEach(id => {
        if (isArtifact(id)) { add(art, id, won); return; }
        add(card, id, won);
        CARD_MAP[id].keywords.forEach(k => add(kw, k, won));
      });
      add(el, CARD_MAP[d.leader].element, won);
    });
  }
  line(`平均ターン ${(turns / n).toFixed(1)}／先攻の勝率 ${pct(first, n - draws)}／引き分け ${pct(draws, n)}`);
  const show = (title, m, name) => {
    const rows = Object.entries(m).map(([k, v]) => ({ k, r: v.w / v.g * 100 })).sort((a, b) => b.r - a.r);
    line(`\n[${title}] 勝率が50%から離れているものほど要調整`);
    rows.forEach(x => { const mark = x.r >= 56 ? ' ←強すぎ?' : x.r <= 44 ? ' ←弱すぎ?' : ''; line(`  ${name(x.k).padEnd(12, '　')} ${x.r.toFixed(1)}%${mark}`); });
  };
  show('リーダーの属性', el, k => k);
  show('キーワード', kw, k => k);
  show('アーティファクト', art, k => api.ARTIFACT_MAP[k].name);
  show('カード', card, k => CARD_MAP[k].name);
}

function quests(n = 150) {
  line(`\n■ クエストの勝率（おまかせデッキ、各${n}戦×10人分の手持ち）`);
  const tot = {};
  for (let seed = 0; seed < 10; seed++) {
    const g = new GameServer();
    g.init();
    g.debugAddCoins(200000);
    for (let i = 0; i < 8; i++) { g.s.mine = g.s.mine.slice(-120); g.pull(10); }
    for (const q of QUESTS) {
      g.autoDeck(q.rules);
      if (g.deckErrors(q.rules).length) continue;
      for (let i = 0; i < n / 10; i++) {
        const b = g.createQuestBattle(q.id);
        b.start();
        while (!b.over) b.nextTurn();
        const t = tot[q.name] = tot[q.name] || { w: 0, n: 0, turns: 0 };
        t.n++; t.turns += b.turn;
        if (b.winner === 0) t.w++;
      }
    }
  }
  Object.entries(tot).forEach(([k, v]) => line(`  ${k.padEnd(14, '　')} 勝率 ${pct(v.w, v.n)}／平均 ${(v.turns / v.n).toFixed(1)}ターン`));
  line('  目安：Lv1は8〜9割、Lv2は5〜6割、Lv3は4〜5割、ボスは1〜2割');
}

function stats(n = 200000) {
  line(`\n■ 個体値と称号の出やすさ（${n}体を生成）`);
  const cnt = {};
  const q = { power: [], total: [] };
  for (let i = 0; i < n; i++) {
    const c = CHARACTERS[i % CHARACTERS.length];
    const ind = generateIndividual(Math.random, c, 1, i + 1);
    titlesOf(ind, c).forEach(t => { cnt[t] = (cnt[t] || 0) + 1; });
    if (i < 50000) { q.power.push(ind.power); q.total.push(ind.total_score); }
  }
  const med = a => { a.sort((x, y) => x - y); return `中央 ${a[a.length >> 1]}／上位5% ${a[Math.floor(a.length * 0.95)]}／上位0.1% ${a[Math.floor(a.length * 0.999)]}`; };
  line(`  パワー   ${med(q.power)}`);
  line(`  総合値   ${med(q.total)}`);
  line('  称号');
  TITLES.forEach(t => line(`    ${t.name.padEnd(6, '　')} ${cnt[t.id] ? `約1/${Math.round(n / cnt[t.id])}` : '出なかった'}`));
}

function overview() {
  line('■ いまの内容');
  line(`  キャラ ${CHARACTERS.length}体／アーティファクト ${Object.keys(api.ARTIFACT_MAP).length}種／クエスト ${QUESTS.length}件`);
  line(`  デッキ ${RULES.DECK_MIN}〜${RULES.DECK_SIZE}枚（属性${RULES.MAX_ELEMENTS}種まで、道具${RULES.MAX_ARTIFACTS}枚まで）`);
  line(`  リーダー体力 ${RULES.LEADER_HP}／初期手札 ${RULES.START_HAND}／ターン上限 ${RULES.TURN_LIMIT}`);
  const bad = CHARACTERS.filter(c => !c.element || !CARD_MAP[c.id]);
  if (bad.length) line(`  !! データが足りないキャラ: ${bad.map(c => c.id).join(', ')}`);
}

const [cmd, arg] = process.argv.slice(2);
overview();
if (!cmd || cmd === 'battles') battles(Number(arg) || 4000);
if (!cmd || cmd === 'quests') quests(Number(arg) || 150);
if (!cmd || cmd === 'stats') stats(Number(arg) || 200000);
