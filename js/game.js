// =====================================================================
// ガチャ図鑑　ゲーム本体
//   データは data/ と stories/、画像は img/ に分けてある。
//   ゲームのルールはすべて GameServer クラスにまとめてある（オンライン化するときはここをサーバーへ移す）。
// =====================================================================
const HAS_WINDOW = typeof window !== 'undefined';
const ASSET_V = HAS_WINDOW && window.ASSET_VERSION ? window.ASSET_VERSION : '';

// 図鑑の文章（stories/chr_xxx.js）は、図鑑のページを開いたときに読み込む
const STORIES = {};
function registerStory(id, data) { STORIES[id] = data; }
const COMBATS = {};
function registerCombat(id, data) { COMBATS[id] = data; }
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${src} を読み込めませんでした`));
    document.head.appendChild(s);
  });
}
function loadStory(id) {
  if (STORIES[id]) return Promise.resolve();
  return loadScriptOnce(`stories/${id}.js${ASSET_V ? `?v=${ASSET_V}` : ''}`);
}
function loadCombat(id) {
  if (COMBATS[id]) return Promise.resolve();
  return loadScriptOnce(`combat/${id}.js${ASSET_V ? `?v=${ASSET_V}` : ''}`);
}

// 画像の場所：img/（id）_（枠）_（版番号）.webp、小さい画像は _s.webp
function imagePath(item, slot, small) {
  const v = item && item.art && item.art[slot];
  if (!v) return '';
  const p = `img/${item.id}_${slot}_${v}${small ? '_s' : ''}.webp`;
  return (HAS_WINDOW && window.EMBEDDED_IMAGES && window.EMBEDDED_IMAGES[p]) || p;
}

// =====================================================================
// 乱数と個体値の生成
// =====================================================================
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const randnWith = rng => () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
const clampRound = (x, lo, hi) => Math.min(hi, Math.max(lo, Math.round(x)));
const round1 = x => Math.round(x * 10) / 10;
const pickWith = (rng, arr) => arr[Math.floor(rng() * arr.length)];

function rollRarity(rng, minRarity = 1) {
  const pool = RATES.filter(([r]) => r >= minRarity);
  const sum = pool.reduce((s, [, p]) => s + p, 0);
  let x = rng() * sum;
  for (const [r, p] of pool) { if (x < p) return r; x -= p; }
  return pool[pool.length - 1][0];
}

// 0より大きく1以下の乱数を、細かい精度（53ビット）で作る
function fineRandom() {
  return (Math.floor(Math.random() * 67108864) * 134217728 + Math.floor(Math.random() * 134217728) + 1) / 9007199254740992;
}

function uniformForTail(rng) { return rng === Math.random ? fineRandom() : 1 - rng(); }

// 出発点から上に伸びる値（パワー・すばやさなど）
function rollStat(rng, start) {
  const y = -Math.log10(uniformForTail(rng));
  const { a, b } = POWER_RULE;
  const d = (-a + Math.sqrt(a * a + 4 * b * y)) / (2 * b);
  return Math.min(STAT_MAX, Math.max(1, Math.floor(start * Math.pow(10, d))));
}
const rollPower = rng => rollStat(rng, POWER_RULE.min);

// 基準から多い方・少ない方に伸びる倍率（体重・身長・食欲）
function rollRatio(rng) {
  const up = rng() < 0.5;
  const y = -Math.log10(uniformForTail(rng));
  const { a, b, maxDigits } = RATIO_RULE;
  const e = Math.min(maxDigits, (-a + Math.sqrt(a * a + 4 * b * y)) / (2 * b));
  return Math.pow(10, up ? e : -e);
}

function generateIndividual(rng, c, rarity, serial) {
  const weight = Math.max(0.1, round1(c.base_weight * rollRatio(rng)));
  const height = Math.max(0.1, round1(c.base_height * rollRatio(rng)));
  const nature = (c.likely_natures.length && rng() < 0.6) ? pickWith(rng, c.likely_natures) : pickWith(rng, NATURES);
  const ind = {
    char_id: c.id, serial, rarity, weight, height,
    power: rollPower(rng),
    speed: rollStat(rng, statStart(c, 'speed')),
    wisdom: rollStat(rng, statStart(c, 'wisdom')),
    luck: rollStat(rng, statStart(c, 'luck')),
    nature,
    nature_strength: rollStat(rng, statStart(c, 'nature_strength')),
    shine: rollStat(rng, statStart(c, 'shine')),
    appetite: Math.max(1, Math.min(STAT_MAX, Math.round(c.appetite_bias * rollRatio(rng)))),
    weight_dev: round1((weight - c.base_weight) / c.base_weight * 100),
    height_dev: round1((height - c.base_height) / c.base_height * 100),
    special: rng() < SPECIAL_RATE,
    locked: false
  };
  ind.total_score = totalScoreOf(ind);
  return ind;
}

function titlesOf(ind, c) {
  return TITLES.filter(t => t.test(ind, c)).map(t => t.id);
}

// =====================================================================
// 保存（使えない環境では保存せずに動く）
// =====================================================================
const store = {
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 保存できない環境 */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* 何もしない */ } }
};

// スマホから登録したキャラ画像（IndexedDB に保存）
const ImageStore = {
  db: null,
  cache: {},
  async open() {
    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('gachaZukanImages', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('images');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve) => {
        const tx = this.db.transaction('images', 'readonly');
        const os = tx.objectStore('images');
        const cur = os.openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) { this.cache[c.key] = c.value; c.continue(); } else resolve();
        };
        cur.onerror = () => resolve();
      });
    } catch (e) { this.db = null; }
  },
  _tx(mode, fn) {
    if (!this.db) return Promise.resolve();
    return new Promise((resolve) => {
      const tx = this.db.transaction('images', mode);
      fn(tx.objectStore('images'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  },
  async put(key, dataUrl) { this.cache[key] = dataUrl; await this._tx('readwrite', os => os.put(dataUrl, key)); },
  async del(key) { delete this.cache[key]; await this._tx('readwrite', os => os.delete(key)); }
};

// =====================================================================
// GameServer：ゲームのルール（オンライン化するときはサーバーへ移す部分）
// =====================================================================
const SAVE_KEY = 'gachaZukanDemo_v3';
const WORLD_VERSION = `${CHARACTERS.length}:stats-tail-1`;
const OLD_SAVE_KEY = 'gachaZukanDemo_v1';
const NPC_COUNT = Math.max(2400, CHARACTERS.length * 40);   // 仮プレイヤーの個体数（キャラが増えると増える）
const NPC_NAMES = ['ぽんず','ユウキ','さくら餅','Kento','みけ','タロ','はるか','Rin','こつぶ','ソラ','もなか','Aoi','しおん','ハヤテ','くるみ','Nao','いちご','ゲンタ','つばめ','Mio'];
const DAY_MS = 86400000;

class GameServer {
  constructor(now = () => Date.now()) {
    this.userId = 'me';
    this._now = now;
  }

  // ---------- 起動と保存 ----------
  init() {
    this.characters = CHARACTERS;
    this.charMap = Object.fromEntries(CHARACTERS.map(c => [c.id, c]));
    const rng = mulberry32(20260916);
    this.npcCounters = {};
    this.world = [];
    for (let i = 0; i < NPC_COUNT; i++) {
      const c = pickWith(rng, CHARACTERS);
      this.npcCounters[c.id] = (this.npcCounters[c.id] || 0) + 1;
      const ind = generateIndividual(rng, c, rollRarity(rng), this.npcCounters[c.id]);
      const k = Math.floor(rng() * NPC_NAMES.length);
      ind.uid = -(i + 1);   // 仮プレイヤーの個体はマイナスの番号（あなたの個体と重ならない）
      ind.owner_id = 'npc' + k;
      ind.owner_name = NPC_NAMES[k];
      ind.titles = titlesOf(ind, c);
      this.world.push(ind);
    }

    const saved = store.get(SAVE_KEY);
    this.s = saved || this._fresh();
    this._migrate(!!saved);
    // 世界記録は毎回、仮プレイヤーの記録から作り直し、あなたの記録だけを保存データから重ねる
    const savedHall = this.s.hall || {};
    const worldChanged = this.s.worldVer !== WORLD_VERSION;
    if (worldChanged) {
      for (const ind of this.s.mine) ind.total_score = totalScoreOf(ind);
      Object.keys(this.s.bests).filter(k => k.includes(':total_score:')).forEach(k => delete this.s.bests[k]);
      Object.keys(savedHall).filter(k => k.includes(':total_score:')).forEach(k => delete savedHall[k]);
      for (const ind of this.s.mine) {
        const npc = this.npcCounters[ind.char_id] || 0;
        const need = ind.serial - npc;
        if (need > (this.s.extraCounters[ind.char_id] || 0)) this.s.extraCounters[ind.char_id] = need;
      }
      this.s.worldVer = WORLD_VERSION;
    }
    this.s.hall = {};
    for (const ind of this.world) this._updateHall(ind, ind.owner_name);
    for (const [key, v] of Object.entries(savedHall)) {
      const isMine = v.mine || (v.mine === undefined && v.uid > 2400);
      if (!isMine || !this.charMap[key.split(':')[0]]) continue;
      const cur = this.s.hall[key];
      if (!cur || (v.dir === 'desc' ? v.value > cur.value : v.value < cur.value)) this.s.hall[key] = { ...v, mine: true };
    }
    for (const ind of this.s.mine) this._updateHall(ind, this.s.player.display_name);
    this._save();
    return this.player();
  }

  _fresh() {
    const base = {
      v: 2,
      player: { display_name: 'あなた', coins: START_COINS, vault_cap: VAULT_CAP },
      mine: [], zukan: {}, extraCounters: {}, nextUid: 1, hall: null,
      tutorial: { step: 0, done: false, rewarded: false, hidden: false }
    };
    return base;
  }

  _migrate(hadSave = true) {
    const s = this.s;
    s.bests = s.bests || {};
    s.titleBook = s.titleBook || {};
    s.claimed = s.claimed || {};
    s.login = s.login || { last: '', streak: 0 };
    s.missions = s.missions || { date: '', progress: {}, claimed: {} };
    s.expeditions = s.expeditions || [];
    s.onlineStampRewards = Array.isArray(s.onlineStampRewards) ? s.onlineStampRewards : null;
    s.settings = Object.assign({ sound: true, effects: 'full' }, s.settings || {});
    // 古い保存データを使っている人には自動表示せず、再開しても報酬を重ねて渡さない。
    const hasPlayed = !!(s.mine.length || Object.keys(s.zukan || {}).length || Number(s.nextUid) > 1);
    s.tutorial = s.tutorial || (hadSave && hasPlayed
      ? { step:TUTORIAL_STEPS.length - 1, done:true, rewarded:true, hidden:false }
      : { step:0, done:false, rewarded:false, hidden:false });
    s.tutorial.step = Math.max(0, Math.min(TUTORIAL_STEPS.length - 1, Number(s.tutorial.step) || 0));
    s.tutorial.done = !!s.tutorial.done;
    s.tutorial.rewarded = !!s.tutorial.rewarded;
    s.tutorial.hidden = !!s.tutorial.hidden;
    const qp = s.questProgress || {};
    s.questProgress = {
      cleared: qp.cleared || {}, goals: qp.goals || {}, proofs: qp.proofs || {},
      farmReadyAt: qp.farmReadyAt || {}, arenaStreak: qp.arenaStreak || 0,
      teamCleared: qp.teamCleared || {}, teamGoals: qp.teamGoals || {}
    };
    s.teamLineups = Object.assign({ 2:{ uids:[], rows:[] }, 3:{ uids:[], rows:[] } }, s.teamLineups || {});
    s.relayLineup = Array.isArray(s.relayLineup) ? s.relayLineup : [];
    s.relayClears = Number(s.relayClears || 0);
    s.dayOffset = s.dayOffset || 0;
    s.expSeq = s.expSeq || 1;
    for (const ind of s.mine) {
      ind.equipped_skills = Array.isArray(ind.equipped_skills) ? ind.equipped_skills.filter(id=>SKILL_DEFS[id]) : [];
      if (!ind.titles) ind.titles = titlesOf(ind, this.charMap[ind.char_id]);
      for (const t of ind.titles) this._addTitle(ind.char_id, t);
    }
  }

  // 保存するときは、仮プレイヤーの記録を除いて小さくする（キャラが1000体でも収まるように）
  _save() {
    const hall = {};
    for (const [k, v] of Object.entries(this.s.hall || {})) if (v.mine) hall[k] = v;
    store.set(SAVE_KEY, { ...this.s, hall });
  }
  _all() { return this.world.concat(this.s.mine); }
  _withOwner(ind) { return ind.owner_id === 'me' ? { ...ind, owner_name: this.s.player.display_name } : { ...ind }; }
  now() { return this._now() + this.s.dayOffset * DAY_MS; }
  today() {
    const d = new Date(this.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  player() { return { ...this.s.player }; }
  settings() { return { ...this.s.settings }; }
  setSetting(key, value) { this.s.settings[key] = value; this._save(); }
  tutorial() { return { ...this.s.tutorial }; }
  hideTutorial() { this.s.tutorial.hidden = true; this._save(); }
  restartTutorial() {
    this.s.tutorial = { step:0, done:false, rewarded:!!this.s.tutorial.rewarded, hidden:false };
    this._save();
    return this.tutorial();
  }
  advanceTutorial(stepId) {
    const t = this.s.tutorial, current = TUTORIAL_STEPS[t.step];
    if (t.done || !current || current.id !== stepId || current.id === 'finish') return false;
    t.step = Math.min(TUTORIAL_STEPS.length - 1, t.step + 1);
    t.hidden = false;
    this._save();
    return true;
  }
  finishTutorial(onlineReward = false) {
    const t = this.s.tutorial, current = TUTORIAL_STEPS[t.step];
    if (t.done || !current || current.id !== 'finish') return { finished:false, gained:0 };
    let gained = 0;
    if (!t.rewarded) {
      t.rewarded = true;
      if (!onlineReward) { this.s.player.coins += TUTORIAL_REWARD; gained = TUTORIAL_REWARD; }
    }
    t.done = true;
    t.hidden = false;
    this._save();
    return { finished:true, gained };
  }
  applyOnlineWallet(wallet) {
    const coins = Number(wallet && wallet.coins);
    if (!Number.isSafeInteger(coins) || coins < 0) throw new Error('オンライン残高が正しくありません');
    this.s.player.coins = coins;
    this.s.onlineWallet = true;
    if (wallet.login_last !== undefined) {
      this.s.login.last = wallet.login_last || '';
      this.s.login.streak = Number(wallet.login_streak || wallet.day || 0);
    }
    if (wallet.missions) {
      const claimed = {};
      for (const id of wallet.missions.claimed || []) claimed[id] = true;
      this.s.missions = { date:String(wallet.missions.date || this.today()), progress:{ ...(wallet.missions.progress || {}) }, claimed };
    }
    if (Array.isArray(wallet.stamp_rewards)) {
      this.s.onlineStampRewards = wallet.stamp_rewards.map(x => ({
        key:String(x.key), char_id:String(x.char_id), rarity:x.rarity == null ? null : Number(x.rarity),
        amount:Number(x.amount), kind:String(x.kind || 'stamp')
      }));
    }
    if (Array.isArray(wallet.quest_progress)) {
      const q = this.s.questProgress;
      q.cleared = {}; q.goals = {}; q.teamCleared = {}; q.teamGoals = {}; q.farmReadyAt = {}; q.arenaStreak = 0;
      for (const row of wallet.quest_progress) {
        const id = String(row.stage_id || '');
        if (id.startsWith('q')) { if (row.cleared) q.cleared[id] = true; if (row.goal) q.goals[id] = true; }
        else if (id.startsWith('t')) { if (row.cleared) q.teamCleared[id] = true; if (row.goal) q.teamGoals[id] = true; }
        else if (id.startsWith('farm_')) { q.farmReadyAt[id] = Number(row.farm_ready_at || 0); if (id === 'farm_2') q.arenaStreak = Number(row.arena_streak || 0); }
      }
      q.proofs = {};
      STAGES.filter(st => st.level === 3 && q.cleared[st.id]).forEach(st => { q.proofs[st.boss] = true; });
    }
    if (Array.isArray(wallet.expeditions)) {
      this.s.expeditions = wallet.expeditions.map(e => ({
        id:Number(e.id), dest:String(e.dest), uids:(e.uids || []).map(Number),
        start:Number(e.start), end:Number(e.end), reward:Number(e.reward), great:!!e.great
      }));
    }
    this._save();
    return this.player();
  }

  // ---------- 記録 ----------
  _updateHall(ind, ownerName) {
    const records = [];
    for (const [stat, dir] of RECORD_SPECS) {
      const key = `${ind.char_id}:${stat}:${dir}`;
      const cur = this.s.hall[key];
      const v = ind[stat];
      if (!cur || (dir === 'desc' ? v > cur.value : v < cur.value)) {
        this.s.hall[key] = { stat, dir, value: v, uid: ind.uid, owner_name: ownerName, mine: ind.owner_id === 'me' };
        records.push(`${stat}:${dir}`);
      }
    }
    return records;
  }

  _updateBests(ind) {
    const beaten = [];
    for (const [stat, dir] of RECORD_SPECS) {
      const key = `${ind.char_id}:${stat}:${dir}`;
      const cur = this.s.bests[key];
      const v = ind[stat];
      if (cur === undefined) { this.s.bests[key] = v; continue; }
      if (dir === 'desc' ? v > cur : v < cur) { this.s.bests[key] = v; beaten.push(`${stat}:${dir}`); }
    }
    return beaten;
  }

  _addTitle(charId, titleId) {
    const list = this.s.titleBook[charId] || (this.s.titleBook[charId] = []);
    if (!list.includes(titleId)) list.push(titleId);
  }

  // ---------- 毎日 ----------
  _rollDaily() {
    const today = this.today();
    if (this.s.missions.date !== today) this.s.missions = { date: today, progress: {}, claimed: {} };
  }

  _progress(id, n) {
    this._rollDaily();
    this.s.missions.progress[id] = (this.s.missions.progress[id] || 0) + n;
  }

  // ログインボーナス。今日まだ受け取っていなければ付与して内容を返す
  dailyLogin() {
    this._rollDaily();
    const today = this.today();
    const L = this.s.login;
    if (L.last === today) { this._save(); return null; }
    const yesterday = (() => { const d = new Date(this.now() - DAY_MS); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    L.streak = (L.last === yesterday) ? (L.streak % 7) + 1 : 1;
    L.last = today;
    const amount = LOGIN_TABLE[L.streak - 1];
    this.s.player.coins += amount;
    this._save();
    return { day: L.streak, amount, coins: this.s.player.coins };
  }

  loginStatus() { return { ...this.s.login, today: this.today() }; }

  missions() {
    this._rollDaily();
    const m = this.s.missions;
    const list = MISSIONS.map(def => {
      const progress = Math.min(def.target, m.progress[def.id] || 0);
      return { ...def, progress, claimed: !!m.claimed[def.id], claimable: progress >= def.target && !m.claimed[def.id] };
    });
    const allDone = list.every(x => x.claimed);
    list.push({ id: 'all', label: 'ほかのミッションをすべて受け取る', target: MISSIONS.length, progress: list.filter(x => x.claimed).length, reward: MISSION_ALL_BONUS, claimed: !!m.claimed.all, claimable: allDone && !m.claimed.all });
    return list;
  }

  claimMission(id) {
    const item = this.missions().find(x => x.id === id);
    if (!item || !item.claimable) throw new Error('まだ受け取れません');
    this.s.missions.claimed[id] = true;
    this.s.player.coins += item.reward;
    this._save();
    return { gained: item.reward, coins: this.s.player.coins };
  }

  // ---------- 図鑑報酬 ----------
  stampRewards() {
    if (this.s.onlineWallet && Array.isArray(this.s.onlineStampRewards)) {
      return this.s.onlineStampRewards.map(x => ({
        ...x,
        label:x.kind === 'complete' ? `${this.charMap[x.char_id].name} コンプリート` : `${this.charMap[x.char_id].name} ★${x.rarity}`
      }));
    }
    const list = [];
    const byChar = {};
    for (const z of Object.values(this.s.zukan)) {
      (byChar[z.char_id] = byChar[z.char_id] || new Set()).add(z.rarity);
      const key = `stamp:${z.char_id}:${z.rarity}`;
      if (!this.s.claimed[key]) list.push({ key, char_id: z.char_id, label: `${this.charMap[z.char_id].name} ★${z.rarity}`, amount: STAMP_REWARD[z.rarity] });
    }
    for (const [charId, set] of Object.entries(byChar)) {
      const key = `complete:${charId}`;
      if (set.size === 5 && !this.s.claimed[key]) list.push({ key, char_id: charId, label: `${this.charMap[charId].name} コンプリート`, amount: COMPLETE_REWARD });
    }
    return list;
  }

  claimStampRewards() {
    const list = this.stampRewards();
    const gained = list.reduce((s, x) => s + x.amount, 0);
    for (const x of list) this.s.claimed[x.key] = true;
    this.s.player.coins += gained;
    this._save();
    return { gained, count: list.length, coins: this.s.player.coins };
  }

  // ---------- ガチャ ----------
  _checkPull(n, serverChecksCoins = false, gacha = null) {
    const cost = gacha ? (n === 1 ? gacha.price : n === 10 ? gacha.price10 : 0) : PULL_COST[n];
    if (!cost) throw new Error('引ける回数は1回か10回です');
    const p = this.s.player;
    if (!serverChecksCoins && p.coins < cost) throw new Error(`コインが足りません（あと${cost - p.coins}コイン）`);
    if (this.s.mine.length + n > p.vault_cap) throw new Error('保管庫がいっぱいです。個体を送り出してから引いてください');
    return cost;
  }

  nextPullUids(n, serverChecksCoins = false, gacha = null) {
    this._checkPull(n, serverChecksCoins, gacha);
    return Array.from({ length: n }, (_, i) => this.s.nextUid + i);
  }

  // Supabase側で抽選済みの個体を、端末の保管庫と図鑑へ反映する。
  acceptOnlinePull(n, incoming, onlineCoins, gacha = null) {
    this._checkPull(n, true, gacha);
    if (!Array.isArray(incoming) || incoming.length !== n) throw new Error('オンライン抽選の結果が正しくありません');
    const p = this.s.player;
    if (!Number.isSafeInteger(Number(onlineCoins)) || Number(onlineCoins) < 0) throw new Error('オンライン残高が正しくありません');
    p.coins = Number(onlineCoins);
    this.s.onlineWallet = true;
    const results = incoming.map(raw => {
      const c = this.charMap[raw.char_id];
      const uid = Number(raw.local_uid);
      if (!c || !Number.isSafeInteger(uid) || uid < 1 || this.s.mine.some(i => i.uid === uid)) {
        throw new Error('オンライン抽選の個体を保管できませんでした');
      }
      const ind = {
        char_id: c.id, uid, owner_id: 'me', serial: Number(raw.serial), rarity: Number(raw.rarity),
        weight: Number(raw.weight), height: Number(raw.height), power: Number(raw.power),
        speed: Number(raw.speed), wisdom: Number(raw.wisdom), luck: Number(raw.luck),
        nature: String(raw.nature), nature_strength: Number(raw.nature_strength), shine: Number(raw.shine),
        appetite: Number(raw.appetite), weight_dev: Number(raw.weight_dev), height_dev: Number(raw.height_dev),
        special: !!raw.special, total_score: Number(raw.total_score), locked: false,
        obtained_at: String(raw.obtained_at || new Date(this.now()).toISOString()), online_verified: true
      };
      ind.titles = titlesOf(ind, c);
      this.s.mine.push(ind);
      this.s.nextUid = Math.max(this.s.nextUid, uid + 1);

      const zk = `${c.id}:${ind.rarity}`;
      const isNew = !this.s.zukan[zk];
      const z = this.s.zukan[zk] || { char_id: c.id, rarity: ind.rarity, count: 0, special_count: 0 };
      z.count++; if (ind.special) z.special_count++;
      this.s.zukan[zk] = z;
      const newTitles = ind.titles.filter(t => !(this.s.titleBook[c.id] || []).includes(t));
      ind.titles.forEach(t => this._addTitle(c.id, t));
      const records = this._updateHall(ind, p.display_name);
      const bests = this._updateBests(ind);
      return { ...ind, records, bests, isNew, newTitles };
    });
    this._progress('pull', n);
    this._save();
    return { coins: p.coins, results };
  }

  pull(n, gacha = GACHAS.find(x => x.open)) {
    const cost = this._checkPull(n, false, gacha);
    const p = this.s.player;
    p.coins -= cost;

    const rarities = Array.from({ length: n }, () => rollRarity(Math.random));
    const minRarity = gacha.guarantee && n === gacha.guarantee.count ? gacha.guarantee.minRarity : 1;
    if (n === 10 && Math.max(...rarities) < minRarity) rarities[9] = rollRarity(Math.random, minRarity);

    const results = rarities.map(rarity => {
      const c = this.charMap[pickWith(Math.random, gacha.chars)];
      this.s.extraCounters[c.id] = (this.s.extraCounters[c.id] || 0) + 1;
      const serial = (this.npcCounters[c.id] || 0) + this.s.extraCounters[c.id];
      const ind = generateIndividual(Math.random, c, rarity, serial);
      ind.uid = this.s.nextUid++;
      ind.owner_id = 'me';
      ind.obtained_at = new Date(this.now()).toISOString();
      ind.titles = titlesOf(ind, c);
      this.s.mine.push(ind);

      const zk = `${c.id}:${rarity}`;
      const isNew = !this.s.zukan[zk];
      const z = this.s.zukan[zk] || { char_id: c.id, rarity, count: 0, special_count: 0 };
      z.count++; if (ind.special) z.special_count++;
      this.s.zukan[zk] = z;

      const newTitles = ind.titles.filter(t => !(this.s.titleBook[c.id] || []).includes(t));
      ind.titles.forEach(t => this._addTitle(c.id, t));

      const records = this._updateHall(ind, p.display_name);
      const bests = this._updateBests(ind);
      return { ...ind, records, bests, isNew, newTitles };
    });

    this._progress('pull', n);
    this._save();
    return { coins: p.coins, results };
  }

  // ---------- 保管庫 ----------
  vault() { return this.s.mine.slice().sort((a, b) => b.uid - a.uid); }
  zukan() { return Object.values(this.s.zukan); }
  titleBook(charId) { return (this.s.titleBook[charId] || []).slice(); }
  dispatchedUids() { return new Set(this.s.expeditions.flatMap(e => e.uids)); }

  // ---------- 練習試合 ----------
  rollPracticeEnemy(enemyCharId) {
    const c = this.charMap[enemyCharId];
    if (!c) throw new Error('相手のキャラが見つかりません');
    return generateIndividual(Math.random, c, 3, 0);
  }

  practiceBattle(uid, enemyCharId, stage, enemyInd) {
    const own = this.s.mine.find(i => i.uid === Number(uid));
    const enemy = this.charMap[enemyCharId];
    if (!own) throw new Error('保管庫から戦う個体を選んでください');
    if (!enemy) throw new Error('相手のキャラが見つかりません');
    return runBattle({
      a: { ch: this.charMap[own.char_id], ind: {...own,loadout:own.equipped_skills||[]} },
      b: { ch: enemy, ind: enemyInd || this.rollPracticeEnemy(enemyCharId) },
      stage: stage || { name: '無名の荒野（特徴なし）', features: [] }
    });
  }

  teamLineup(size) {
    const x = this.s.teamLineups[size] || { uids:[], rows:[] };
    return { uids:[...x.uids], rows:[...x.rows] };
  }

  saveTeamLineup(size, uids, rows) {
    this.s.teamLineups[size] = { uids:uids.map(Number), rows:rows.map(x => x === 'back' ? 'back' : 'front') };
    this._save();
  }

  _ownTeam(size, uids, rows) {
    if (uids.length !== size) throw new Error(`${size}体の個体を選んでください`);
    const own = uids.map(uid => this._questOwn(uid));
    if (new Set(own.map(x => x.char_id)).size !== own.length) throw new Error('同じキャラを同じチームに入れることはできません');
    return own.map((ind,i) => ({ ch:this.charMap[ind.char_id], ind:{...ind,loadout:ind.equipped_skills||[]}, row:rows[i] === 'back' ? 'back' : 'front' }));
  }

  teamPracticeBattle(size, uids, rows, enemyTeam, stage) {
    const mine = this._ownTeam(size, uids, rows);
    if (!Array.isArray(enemyTeam) || enemyTeam.length !== size) throw new Error(`相手を${size}体選んでください`);
    if (new Set(enemyTeam.map(x => x.id)).size !== size) throw new Error('相手チームにも同じキャラは入れられません');
    const foes = enemyTeam.map(x => {
      const ch=this.charMap[x.id]; if(!ch) throw new Error('相手のキャラが見つかりません');
      return { ch, ind:x.ind || this.rollPracticeEnemy(x.id), row:x.row === 'back' ? 'back' : 'front' };
    });
    this.saveTeamLineup(size,uids,rows);
    return runTeamBattle({ teams:[mine,foes], stage:stage || { name:'無名の荒野（特徴なし）', features:[] } });
  }

  questProgress() {
    const q = this.s.questProgress;
    return { cleared:{...q.cleared}, goals:{...q.goals}, proofs:{...q.proofs}, farmReadyAt:{...q.farmReadyAt}, arenaStreak:q.arenaStreak, teamCleared:{...q.teamCleared}, teamGoals:{...q.teamGoals} };
  }

  teamQuestUnlocked(stageId) {
    const st=TEAM_STAGES.find(x=>x.id===stageId);
    return !!(st && this.s.questProgress.cleared[`q${st.boss.slice(-3)}_3`]);
  }

  teamQuestBattle(stageId,uids,rows) {
    const st=TEAM_STAGES.find(x=>x.id===stageId);
    if(!st) throw new Error('集団戦クエストが見つかりません');
    if(!this.teamQuestUnlocked(stageId)) throw new Error('このキャラの段階3をクリアすると挑戦できます');
    const mine=this._ownTeam(st.size,uids,rows);
    const foes=st.enemies.map(x=>({ch:this.charMap[x.id],ind:{...TEAM_ENEMY_IND},row:x.row}));
    const res=runTeamBattle({teams:[mine,foes],stage:{name:st.name,features:[...st.features],events:st.events,enemyState:st.enemyState,enemyPower:TEAM_STAGE_POWER[st.id]}});
    const q=this.s.questProgress,cleared=res.winner===0,first=cleared&&!q.teamCleared[st.id];
    const goalDone=cleared&&!!st.goal?.check(res),goalFirst=goalDone&&!q.teamGoals[st.id];
    let reward=0;
    if(cleared){reward=first?TEAM_REWARDS.first:TEAM_REWARDS.repeat;if(goalFirst)reward+=TEAM_REWARDS.goal;q.teamCleared[st.id]=true;if(goalDone)q.teamGoals[st.id]=true;this.s.player.coins+=reward;this._progress('quest',1);}
    this.saveTeamLineup(st.size,uids,rows);this._save();
    return {...res,quest:{stageId,cleared,first,goalDone,goalFirst,reward}};
  }

  questUnlocked(stageId) {
    const st = STAGES.find(x => x.id === stageId);
    if (!st) return false;
    if (st.level === 1) return true;
    return !!this.s.questProgress.cleared[`${stageId.slice(0, -1)}${st.level - 1}`];
  }

  _questOwn(uid) {
    const own = this.s.mine.find(i => i.uid === Number(uid));
    if (!own) throw new Error('保管庫から戦う個体を選んでください');
    return own;
  }

  questBattle(stageId, uid) {
    const st = STAGES.find(x => x.id === stageId);
    if (!st) throw new Error('ステージが見つかりません');
    if (!this.questUnlocked(stageId)) throw new Error('前の段階をクリアすると挑戦できます');
    const own = this._questOwn(uid), foe = this.charMap[st.boss];
    const res = runBattle({
      a:{ ch:this.charMap[own.char_id], ind:{...own,loadout:own.equipped_skills||[]} }, b:{ ch:foe, ind:{...ENEMY_IND[st.level]} },
      stage:{ name:st.name, features:[...st.features], events:st.events, enemyState:st.enemyState, enemyPower:STAGE_POWER[st.id] }
    });
    const q = this.s.questProgress, cleared = res.winner === 0;
    const first = cleared && !q.cleared[st.id];
    const goalDone = cleared && !!(st.goal && st.goal.check(res));
    const goalFirst = goalDone && !q.goals[st.id];
    let reward = 0;
    if (cleared) {
      const rw = QUEST_REWARDS[st.level];
      reward = first ? rw.first : rw.repeat;
      if (goalFirst) reward += rw.goal;
      q.cleared[st.id] = true;
      if (goalDone) q.goals[st.id] = true;
      if (st.level === 3 && first) q.proofs[st.boss] = true;
      this.s.player.coins += reward;
      this._progress('quest', 1);
    }
    this._save();
    return { ...res, quest:{ stageId, cleared, first, goalDone, goalFirst, reward, proof:first && st.level === 3, enemyId:st.boss } };
  }

  farmBattle(stageId, uid) {
    const st = FARM_STAGES.find(x => x.id === stageId);
    if (!st) throw new Error('周回ステージが見つかりません');
    const own = this._questOwn(uid), q = this.s.questProgress, now = this.now();
    const readyAt = Number(q.farmReadyAt[st.id] || 0);
    if (readyAt > now) throw new Error(`あと${fmtTime(readyAt - now)}で挑戦できます`);
    const pool = this.characters.filter(c => st.grades.includes(c.grade));
    const foe = pickWith(Math.random, pool);
    q.farmReadyAt[st.id] = now + st.cooldown * 1000;
    const res = runBattle({
      a:{ ch:this.charMap[own.char_id], ind:{...own,loadout:own.equipped_skills||[]} }, b:{ ch:foe, ind:{...st.enemyInd} },
      stage:{ name:st.name, features:[...st.features], events:st.events, enemyState:st.enemyState, enemyPower:st.enemyPower }
    });
    const cleared = res.winner === 0;
    let reward = 0, multiplier = 1, goalDone = false;
    if (st.id === 'farm_2') {
      q.arenaStreak = cleared ? q.arenaStreak + 1 : 0;
      if (cleared) multiplier = 1 + Math.min(5, q.arenaStreak) * 0.1;
      goalDone = cleared;
    } else if (st.goal && st.goal.check) {
      goalDone = cleared && st.goal.check(res);
      if (goalDone) multiplier = st.goal.multiplier || 1;
    }
    if (cleared) {
      reward = Math.round(st.reward * multiplier);
      this.s.player.coins += reward;
      this._progress('quest', 1);
    }
    this._save();
    return { ...res, quest:{ stageId, cleared, reward, goalDone, multiplier, streak:q.arenaStreak, enemyId:foe.id, readyAt:q.farmReadyAt[st.id] } };
  }

  _holdsWorldRecord(uid) { return Object.values(this.s.hall).some(h => h.uid === uid); }
  recordHolderUids() { return new Set(Object.values(this.s.hall).map(h => h.uid)); }

  // 送り出す前の注意点
  releaseWarnings(uids) {
    const set = new Set(uids);
    const picked = this.s.mine.filter(i => set.has(i.uid));
    return {
      special: picked.filter(i => i.special).length,
      titled: picked.filter(i => i.titles && i.titles.length).length,
      record: picked.filter(i => this._holdsWorldRecord(i.uid)).length,
      high: picked.filter(i => i.rarity >= 4).length
    };
  }

  release(uids, onlineResult = null) {
    const set = new Set(uids);
    const away = this.dispatchedUids();
    let gained = 0, count = 0;
    this.s.mine = this.s.mine.filter(ind => {
      if (set.has(ind.uid) && !ind.locked && !away.has(ind.uid)) {
        gained += RELEASE_COINS[ind.rarity] * (ind.special ? 5 : 1);
        count++;
        return false;
      }
      return true;
    });
    if (onlineResult && Number.isSafeInteger(Number(onlineResult.coins))) {
      this.s.player.coins = Number(onlineResult.coins);
      gained = Number(onlineResult.gained || 0);
      this.s.onlineWallet = true;
    } else {
      this.s.player.coins += gained;
    }
    this._progress('release', count);
    this._save();
    return { gained, count, coins: this.s.player.coins };
  }

  toggleLock(uid) {
    const ind = this.s.mine.find(i => i.uid === uid);
    if (!ind) throw new Error('個体が見つかりません');
    ind.locked = !ind.locked;
    this._save();
    return ind.locked;
  }

  equipSkills(uid,ids){
    const ind=this.s.mine.find(x=>x.uid===Number(uid)),ch=ind&&this.charMap[ind.char_id];
    if(!ind)throw new Error('個体が見つかりません');
    const unique=[...new Set(ids||[])];
    if(unique.some(id=>!SKILL_DEFS[id]||!SKILL_DEFS[id].condition(ind,ch)))throw new Error('条件を満たしていないスキルが含まれています');
    if(skillCost(unique)>SKILL_MAX_COST)throw new Error('スキルコストは合計8までです');
    ind.equipped_skills=unique;this._save();return unique;
  }

  relayLineup(){return this.s.relayLineup.slice();}
  relayBattle(uids){
    const ids=uids.map(Number);
    if(ids.length!==3||new Set(ids).size!==3)throw new Error('異なる3体の個体を選んでください');
    const mine=ids.map(id=>this._questOwn(id)).map(ind=>({ch:this.charMap[ind.char_id],ind}));
    const foes=RELAY_ENEMIES.map(x=>({ch:x.ch||this.charMap[x.id],ind:{...x.ind}}));
    const res=runRelayBattle({a:mine,b:foes});this.s.relayLineup=ids;
    if(res.winner===0){this.s.player.coins+=1000;this.s.relayClears++;this._progress('quest',1);}
    this._save();return{...res,reward:res.winner===0?1000:0};
  }

  individual(uid, countView = false) {
    const ind = this._all().find(i => i.uid === uid);
    if (!ind) throw new Error('この個体はもう送り出されています');
    if (countView) { this._progress('detail', 1); this._save(); }
    const out = this._withOwner(ind);
    out.dispatched = this.dispatchedUids().has(uid);
    out.holdsRecord = this._holdsWorldRecord(uid);
    return out;
  }

  // ---------- ランキング ----------
  ranks(uid) {
    const t = this._all().find(i => i.uid === uid);
    if (!t) return null;
    const all = this._all();
    const inScope = (i, scope) =>
      scope === 'all' ? true :
      scope === 'char' ? i.char_id === t.char_id :
      scope === 'nature' ? i.nature === t.nature :
      i.char_id === t.char_id && i.nature === t.nature;
    const out = {};
    for (const [stat, dir, scope] of RANK_SPECS) {
      let better = 0, total = 0;
      for (const i of all) {
        if (!inScope(i, scope)) continue;
        total++;
        const a = i[stat], b = t[stat];
        if ((dir === 'desc' ? a > b : a < b) || (a === b && i.uid < t.uid)) better++;
      }
      out[`${stat}:${dir}:${scope}`] = { rank: better + 1, total };
    }
    return out;
  }

  ranking({ stat, dir, charId, nature }) {
    return this._all()
      .filter(i => (!charId || i.char_id === charId) && (!nature || i.nature === nature))
      .sort((a, b) => (dir === 'desc' ? b[stat] - a[stat] : a[stat] - b[stat]) || a.uid - b.uid)
      .slice(0, 100)
      .map((i, idx) => ({
        rank: idx + 1, uid: i.uid, char_id: i.char_id, rarity: i.rarity, value: i[stat],
        owner_name: i.owner_id === 'me' ? this.s.player.display_name : i.owner_name,
        is_mine: i.owner_id === 'me', special: i.special
      }));
  }

  hall(charId) {
    return Object.entries(this.s.hall).filter(([k]) => k.startsWith(charId + ':')).map(([, v]) => v);
  }

  // ---------- 探索 ----------
  estimateExpedition(destId, uids) {
    const dest = DESTINATIONS.find(d => d.id === destId);
    const party = this.s.mine.filter(i => uids.includes(i.uid));
    if (!dest || !party.length) return null;
    const sumPower = party.reduce((s, i) => s + i.power, 0);
    // 桁違いの個体でも壊れないよう、平均は「桁」で取る
    const level = k => party.reduce((s, i) => s + Math.log10(Math.max(1, i[k]) / 100), 0) / party.length;
    const reward = Math.round(dest.base * (1 + 0.8 * Math.log10(1 + sumPower / 150) + Math.max(0, 0.25 * (level('wisdom') + 1))));
    const minutes = dest.minutes * (1 - Math.min(0.5, Math.max(0, 0.1 + 0.15 * level('speed'))));
    const greatChance = Math.min(0.5, Math.max(0.03, 0.1 + 0.12 * level('luck')));
    return { reward, ms: Math.round(minutes * 60000), greatChance };
  }

  expeditions() {
    const now = this.now();
    return this.s.expeditions.map(e => ({ ...e, done: now >= e.end, remaining: Math.max(0, e.end - now) }));
  }

  startExpedition(destId, uids) {
    if (this.s.expeditions.length >= EXP_SLOTS) throw new Error('探索に出せるのは同時に2組までです');
    if (!uids.length || uids.length > PARTY_MAX) throw new Error(`1〜${PARTY_MAX}体を選んでください`);
    const away = this.dispatchedUids();
    for (const uid of uids) {
      if (!this.s.mine.find(i => i.uid === uid)) throw new Error('保管庫にいない個体が含まれています');
      if (away.has(uid)) throw new Error('すでに探索中の個体が含まれています');
    }
    const est = this.estimateExpedition(destId, uids);
    if (!est) throw new Error('行き先を選んでください');
    const great = Math.random() < est.greatChance;
    const start = this.now();
    const exp = { id: this.s.expSeq++, dest: destId, uids: uids.slice(), start, end: start + est.ms, reward: est.reward * (great ? 2 : 1), great };
    this.s.expeditions.push(exp);
    this._save();
    return exp;
  }

  claimExpedition(id) {
    const e = this.expeditions().find(x => x.id === id);
    if (!e) throw new Error('探索が見つかりません');
    if (!e.done) throw new Error('まだ帰ってきていません');
    this.s.expeditions = this.s.expeditions.filter(x => x.id !== id);
    this.s.player.coins += e.reward;
    this._progress('expedition', 1);
    this._save();
    return { gained: e.reward, great: e.great, coins: this.s.player.coins };
  }

  // ---------- お知らせの数 ----------
  badges() {
    const missions = this.missions().filter(m => m.claimable).length;
    const exps = this.expeditions().filter(e => e.done).length;
    return { zukan: this.stampRewards().length, adventure: missions + exps };
  }

  // ---------- その他 ----------
  setName(name) {
    const v = String(name || '').trim();
    if (v.length < 1 || v.length > 12) throw new Error('名前は1〜12文字にしてください');
    this.s.player.display_name = v;
    this._save();
    return v;
  }

  reset() { store.del(SAVE_KEY); store.del(OLD_SAVE_KEY); }
}


const app = {
  server: null, chars: [], charMap: {}, tab: 'gacha', lastResults: [], gachaId: '',
  selectMode: false, selected: new Set(),
  vf: { charId: '', rarity: '', sort: 'new', dir: 'desc', combat: null },
  rk: { charId: '', stat: 'total_score', dir: 'desc', nature: NATURES[0] },
  busy: false,
  renderedDone: 0
};

const PRACTICE_FEATURES = ['岩場','夜空','反響','静寂','騒音','寒冷','強風','無風','狭所','開けた場所','戦場','安らぎ','小動物','生命の気配','祭壇','歓声','異界'];
const PRACTICE_STAGES = [
  { name:'無名の荒野（特徴なし）', features:[] },
  { name:'古戦場', features:['戦場','開けた場所'] },
  { name:'岩場の谷', features:['岩場','狭所'] },
  { name:'冬の山寺', features:['寒冷','安らぎ'] },
  { name:'伝歌の大劇場', features:['反響','歓声'] },
  { name:'天球儀の内部', features:['夜空','開けた場所'] },
  { name:'荒海の卒業航路', features:['強風','狭所'] },
  { name:'万生の産声', features:['反響','生命の気配','開けた場所'] },
  { name:'神魔の玉座', features:['祭壇','歓声'] },
  { name:'神々の遺跡', features:['岩場','夜空','異界'] }
];
const practice = { open:false, mode:1, ownUid:null, enemyId:'chr_002', enemyInd:null, stageIndex:0, features:[], token:0, fast:false, skip:false, running:false, expanded:false };
const questView = { stageId:null, ownUid:null, enemyId:null, result:null, token:0, fast:false, skip:false, running:false, expanded:false };
const teamView = { quest:false, stageId:null, size:2, uids:[], rows:[], enemies:[], token:0, fast:false, skip:false, running:false, expanded:false, result:null };
const relayView = { uids:[], result:null, token:0, fast:false, skip:false, running:false, expanded:false };
let adventureView = 'home';
const tutorialLosses = { quest:0, farm:0 };

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
const num = n => Number(n).toLocaleString('ja-JP');
const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const starsHtml = r => `<span class="stars s${r}" aria-label="★${r}">${'★'.repeat(r)}</span>`;
const pad6 = n => String(n).padStart(6, '0');
const titleName = id => (TITLES.find(t => t.id === id) || {}).name || '';
const vibrate = p => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) { /* 非対応 */ } };

function fmtValue(stat, v, ind) {
  const n = Number(v);
  switch (stat) {
    case 'weight': return `${n.toFixed(1)}kg`;
    case 'height': return `${n.toFixed(1)}cm`;
    case 'weight_dev':
    case 'height_dev': return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
    case 'serial': return `#${pad6(n)}`;
    case 'nature_strength': return ind ? `${ind.nature} ${n}` : `強さ ${n}`;
    default: return num(n);
  }
}

function oddsText(n) {
  const units = [[1e20, '垓'], [1e16, '京'], [1e12, '兆'], [1e8, '億'], [1e4, '万']];
  for (const [v, name] of units) {
    if (n >= v) { const x = n / v; return `${x >= 10 ? Math.round(x) : String(Number(x.toFixed(1)))}${name}`; }
  }
  return num(Math.round(n));
}

function fmtTime(ms) {
  const t = Math.ceil(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------
// 効果音（ファイル不要。その場で音を作る）
// ---------------------------------------------------------------------
const Sound = {
  ctx: null,
  enabled() { return app.server && app.server.settings().sound; },
  _ctx() {
    if (!this.enabled()) return null;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    } catch (e) { return null; }
  },
  tone(freq, dur = 0.12, type = 'sine', vol = 0.15, when = 0, slideTo = null) {
    const c = this._ctx(); if (!c) return;
    const t = c.currentTime + when;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur + 0.03);
  },
  click() { this.tone(880, 0.05, 'square', 0.04); },
  turn() { [0, 0.11, 0.22].forEach(w => this.tone(320, 0.06, 'square', 0.05, w)); },
  drop() { this.tone(260, 0.2, 'triangle', 0.22, 0, 90); },
  up() { [523, 659, 784].forEach((f, i) => this.tone(f, 0.14, 'triangle', 0.13, i * 0.07)); },
  up5() { [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.14, i * 0.07)); },
  pop() { this.tone(500, 0.14, 'sine', 0.22, 0, 1300); },
  flip(r) { this.tone(650 + r * 70, 0.06, 'sine', 0.07); },
  rare(r) { (r === 5 ? [784, 988, 1175, 1568] : [659, 784, 988]).forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.13, i * 0.09)); },
  coin() { this.tone(988, 0.08, 'square', 0.05); this.tone(1319, 0.16, 'square', 0.05, 0.08); }
};

// ---------------------------------------------------------------------
// キャラ絵
// ---------------------------------------------------------------------
function artSrc(c, rarity, small = false) {
  const order = rarity >= 5 ? ['r5', 'r4', 'base'] : rarity >= 4 ? ['r4', 'base'] : ['base'];
  for (const slot of order) {
    const src = ImageStore.cache[`${c.id}:${slot}`] || imagePath(c, slot, small);
    if (src) return src;
  }
  return '';
}
function slotSrc(c, slot) { return ImageStore.cache[`${c.id}:${slot}`] || imagePath(c, slot, false) || ''; }

function art(c, { ind = null, rarity = 1, size = 64, hidden = false } = {}) {
  const r = ind ? ind.rarity : rarity;
  const sp = !!(ind && ind.special && !hidden);
  const lim = (x, a) => Math.max(-a, Math.min(a, x));
  const sx = ind ? 1 + lim(Number(ind.weight_dev) / 120, 0.15) : 1;
  const sy = ind ? 1 + lim(Number(ind.height_dev) / 80, 0.12) : 1;
  const src = artSrc(c, hidden ? 1 : r, size <= 72);
  // 画像は枠からはみ出さないように、大きくする方向の変化は枠の中で表現する
  const k = Math.max(1, sx, sy);
  const inner = src
    ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'" class="${hidden ? 'sil' : ''}" style="transform:scale(${(sx / k).toFixed(3)},${(sy / k).toFixed(3)})">`
    : placeholderSvg(c, ind, hidden, sx, sy);
  return `<span class="art${sp ? ' special' : ''}" style="width:${size}px;height:${size}px">${inner}</span>`;
}

function placeholderSvg(c, ind, hidden, sx, sy) {
  const hue = ((c ? c.hue : 220) + (ind && ind.special ? 160 : 0)) % 360;
  const body = hidden ? '#B9C3D3' : `hsl(${hue} 62% 64%)`;
  const deep = hidden ? '#A3AEC1' : `hsl(${hue} 50% 42%)`;
  const cheek = `hsl(${hue} 85% 82%)`;
  const shape = c ? c.shape : 0;
  const ears = shape === 1
    ? `<path d="M28 34 L22 10 L44 26Z M72 34 L78 10 L56 26Z" fill="${deep}"/>`
    : shape === 2 ? `<path d="M50 24 L44 4 L58 22Z" fill="${deep}"/>` : '';
  const face = hidden
    ? `<text x="50" y="70" text-anchor="middle" font-size="30" font-family="DotGothic16, monospace" fill="#fff">?</text>`
    : `<circle cx="40" cy="58" r="4.5" fill="#1E2A4A"/><circle cx="60" cy="58" r="4.5" fill="#1E2A4A"/>
       <circle cx="41.5" cy="56.5" r="1.4" fill="#fff"/><circle cx="61.5" cy="56.5" r="1.4" fill="#fff"/>
       <ellipse cx="31" cy="68" rx="5.5" ry="3" fill="${cheek}"/><ellipse cx="69" cy="68" rx="5.5" ry="3" fill="${cheek}"/>
       <path d="M46 67 Q50 71 54 67" stroke="#1E2A4A" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  return `<svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true">
    <ellipse cx="50" cy="93" rx="${26 * sx}" ry="4" fill="rgba(30,42,74,.15)"/>
    <g transform="translate(50 92) scale(${sx.toFixed(3)} ${sy.toFixed(3)}) translate(-50 -92)">
      ${ears}
      <path d="M50 24 C74 24 85 45 85 64 C85 83 70 92 50 92 C30 92 15 83 15 64 C15 45 26 24 50 24Z" fill="${body}"/>
      ${face}
    </g>
  </svg>`;
}

function machineSvg() {
  const caps = [
    [70, 62, 'var(--r3)'], [100, 50, 'var(--red)'], [128, 66, 'var(--r2)'], [84, 92, 'var(--yellow)'],
    [116, 96, 'var(--r4)'], [60, 100, 'var(--r2)'], [140, 100, 'var(--red)'], [100, 78, 'var(--r5)']
  ].map(([x, y, col]) => `<g><circle cx="${x}" cy="${y}" r="15" fill="#fff" stroke="#1E2A4A" stroke-width="3"/><path d="M${x - 15} ${y} a15 15 0 0 1 30 0z" fill="${col}" stroke="#1E2A4A" stroke-width="3"/></g>`).join('');
  return `<svg viewBox="0 0 200 230" role="img" aria-label="ガチャマシン">
    <rect x="34" y="120" width="132" height="100" rx="16" fill="var(--red)" stroke="#1E2A4A" stroke-width="4"/>
    <circle cx="100" cy="80" r="70" fill="#fff" stroke="#1E2A4A" stroke-width="4"/>
    <g>${caps}</g>
    <path d="M52 40 a60 60 0 0 1 30 -22" stroke="#fff" stroke-width="8" stroke-linecap="round" fill="none" opacity=".9"/>
    <circle cx="100" cy="162" r="22" fill="var(--yellow)" stroke="#1E2A4A" stroke-width="4"/><rect x="95" y="144" width="10" height="36" rx="4" fill="#1E2A4A"/>
    <rect x="76" y="194" width="48" height="18" rx="7" fill="#1E2A4A"/>
  </svg>`;
}

// ---------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  let el = $('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function renderCoins(bump = false) {
  const el = $('#coins');
  el.textContent = num(app.server.player().coins);
  if (bump) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
}

function onlineWalletEnabled() {
  return typeof OnlineRanking !== 'undefined' && OnlineRanking.configured();
}

function gained(amount, label) {
  renderCoins(true);
  Sound.coin();
  toast(`${label ? label + '：' : ''}+${num(amount)}コイン`);
  updateBadges();
}

function openDialog(html, mode = '') {
  $('#dlgBody').innerHTML = html;
  const d = $('#dlg');
  d.classList.toggle('zukan-page-dialog', mode === 'zukan');
  if (!d.open) d.showModal();
  $('.dlg-inner').scrollTop = 0;
  return $('#dlgBody');
}
// 確認画面（ブラウザの confirm() はプレビュー画面などで使えないことがあるため自前で出す）
function askConfirm(message, okLabel = 'OK') {
  return new Promise(resolve => {
    let d = $('#confirmDlg');
    if (!d) { d = document.createElement('dialog'); d.id = 'confirmDlg'; d.className = 'confirm'; document.body.appendChild(d); }
    d.innerHTML = `<div class="dlg-inner"><p class="confirm-msg">${esc(message)}</p>
      <div class="actions"><button class="btn" data-a="no">やめる</button><button class="btn danger" data-a="yes">${esc(okLabel)}</button></div></div>`;
    const finish = v => { if (d.open) d.close(); resolve(v); };
    d.querySelector('[data-a="no"]').onclick = () => finish(false);
    d.querySelector('[data-a="yes"]').onclick = () => finish(true);
    d.oncancel = e => { e.preventDefault(); finish(false); };
    d.showModal();
  });
}
function closeDialog() { const d = $('#dlg'); if (d.open) d.close(); }

function updateBadges() {
  if (!app.server) return;
  const b = app.server.badges();
  $$('nav.tabs button').forEach(btn => {
    const n = b[btn.dataset.tab] || 0;
    let el = btn.querySelector('.badge');
    if (!n) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('span'); el.className = 'badge'; btn.appendChild(el); }
    el.textContent = n > 99 ? '99+' : n;
  });
}

function show(tab) {
  practice.open = false;
  practice.token++;
  document.body.classList.remove('practice-mode');
  app.tab = tab;
  if (tab === 'vault') app.vf.combat = newCombatFilter();
  app.selectMode = false; app.selected.clear();
  $$('nav.tabs button').forEach(b => { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const r = $('.release-bar'); if (r) r.remove();
  document.body.classList.remove('selecting');
  window.scrollTo(0, 0);
  render();
}
function render() {
  ({ gacha: renderGacha, zukan: renderZukan, vault: renderVault, adventure: renderAdventure, ranking: renderRanking })[app.tab]();
  updateBadges();
  renderTutorial();
}

function tutorialTarget(step) {
  if (!step || app.tab !== step.tab) return null;
  if (step.target === 'pull1') return $('.pull[data-n="1"]');
  if (step.target === 'vaultFirstRow') return $('#main .row[data-uid]');
  if (step.target === 'zukanFirstOwned') {
    const first = app.server.zukan()[0];
    return first ? $(`.zcell[data-id="${first.char_id}"]`) : null;
  }
  if (step.target === 'questFirstStage') return adventureView === 'quests' ? $('[data-quest-stage^="q"]') : null;
  if (step.target === 'farmEasy') return adventureView === 'quests' ? $('[data-quest-stage="farm_1"]') : null;
  return null;
}

function tutorialText(step) {
  const losses = tutorialLosses[step.id] || 0;
  const retry = (step.retry || []).filter(x => losses >= x.after).sort((a,b) => b.after - a.after)[0];
  return retry || step;
}

function clearTutorialTarget() {
  $$('.tutorial-target').forEach(el => el.classList.remove('tutorial-target'));
}

function renderTutorial() {
  document.querySelector('.tutorial-band')?.remove();
  clearTutorialTarget();
  document.body.classList.remove('tutorial-active');
  if (!app.server) return;
  const state = app.server.tutorial();
  if (state.done || state.hidden) return;
  const step = TUTORIAL_STEPS[state.step];
  if (!step) return;
  const text = tutorialText(step), onScreen = app.tab === step.tab && (step.tab !== 'adventure' || adventureView === 'quests');
  const band = document.createElement('aside');
  band.className = 'tutorial-band';
  band.setAttribute('aria-live', 'polite');
  band.innerHTML = `<span class="tutorial-step">${state.step + 1} / ${TUTORIAL_STEPS.length}</span><strong>${esc(text.title)}</strong><p>${esc(text.body)}</p><div class="tutorial-actions"><button class="btn" data-tutorial-later>あとで見る</button>${step.id === 'finish' ? '<button class="btn primary" data-tutorial-finish>案内を閉じる</button>' : onScreen ? '' : '<button class="btn primary" data-tutorial-go>この画面へ</button>'}</div>`;
  document.body.appendChild(band);
  document.body.classList.add('tutorial-active');
  band.querySelector('[data-tutorial-later]').onclick = () => { app.server.hideTutorial(); renderTutorial(); };
  const go = band.querySelector('[data-tutorial-go]');
  if (go) go.onclick = () => {
    closeDialog();
    if (step.tab === 'adventure') adventureView = 'quests';
    show(step.tab);
  };
  const finish = band.querySelector('[data-tutorial-finish]');
  if (finish) finish.onclick = finishTutorial;
  requestAnimationFrame(() => tutorialTarget(step)?.classList.add('tutorial-target'));
}

function tutorialEvent(stepId, won = null) {
  if (won === true && tutorialLosses[stepId] !== undefined) tutorialLosses[stepId] = 0;
  if (won === false && tutorialLosses[stepId] !== undefined) tutorialLosses[stepId]++;
  if (app.server.advanceTutorial(stepId)) renderTutorial();
}

async function finishTutorial() {
  const state = app.server.tutorial();
  if (state.done) return;
  try {
    let gained = 0;
    if (onlineWalletEnabled() && !state.rewarded) {
      const wallet = await OnlineRanking.claimTutorial();
      gained = Number(wallet.gained || 0);
      app.server.applyOnlineWallet(wallet);
      app.server.finishTutorial(true);
    } else gained = app.server.finishTutorial(false).gained;
    renderCoins(true);
    renderTutorial();
    toast(gained ? `案内おつかれさま。${TUTORIAL_REWARD}コイン（ガチャ1回分）を受け取りました` : '案内を最後まで確認しました。報酬は受け取り済みです');
  } catch (e) {
    toast(e.message || '案内の報酬を受け取れませんでした');
  }
}

function cardTags(ind, max = 3) {
  const tags = [];
  if (ind.special) tags.push('<em class="tag sp">特異個体</em>');
  if (ind.records && ind.records.length) tags.push('<em class="tag rec">世界記録</em>');
  const t = (ind.newTitles && ind.newTitles[0]) || (ind.titles && ind.titles[0]);
  if (t) tags.push(`<em class="tag title">${esc(titleName(t))}</em>`);
  if (ind.isNew) tags.push('<em class="tag new">図鑑に登録</em>');
  if (ind.bests && ind.bests.length) tags.push('<em class="tag best">自己ベスト</em>');
  return tags.slice(0, max).join('');
}
function cardInner(ind) {
  const c = app.charMap[ind.char_id];
  return `${art(c, { ind, size: 64 })}${starsHtml(ind.rarity)}
    <span class="cname">${esc(c.name)}</span>
    <span class="cmeta">パワー ${num(ind.power)}</span>
    <span class="tags">${cardTags(ind)}</span>`;
}

// ---------------------------------------------------------------------
// ガチャ
// ---------------------------------------------------------------------
function renderGacha() {
  const openGachas = GACHAS.filter(g => g.open);
  const gacha = openGachas.find(g => g.id === app.gachaId) || openGachas[0];
  if (!gacha) { $('#main').innerHTML = '<p class="error">開催中のガチャがありません。</p>'; return; }
  app.gachaId = gacha.id;
  const rateRows = GACHA_RATES.slice().reverse().map(([r, p]) => `<tr><td>${starsHtml(r)}</td><td class="num">${p}%</td><td class="num">${RELEASE_COINS[r]}</td></tr>`).join('');
  const ratioRows = RATIO_MILESTONES.map(r => `<tr><td>${r}倍 ／ ${r === 1.5 ? '3分の2' : `${r}分の1`}${r === 100 ? '（上限）' : ''}</td><td class="num">約 1 / ${oddsText(1 / ratioChance(r))}</td></tr>`).join('');
  const powerRows = POWER_MILESTONES.map(v => `<tr><td>${v === POWER_RULE.max ? `上限 ${num(v)}` : `${num(v)} 以上`}</td><td class="num">約 1 / ${oddsText(1 / powerChance(v))}</td></tr>`).join('');
  const last = app.lastResults;
  $('#main').innerHTML = `
    <div class="gacha-pickers" aria-label="ガチャを選ぶ">${openGachas.map(item => `<button class="gacha-picker ${item.id === gacha.id ? 'selected' : ''}" data-gacha-id="${esc(item.id)}" aria-pressed="${item.id === gacha.id}"><img src="${esc(item.banner)}" alt="${esc(item.name)}">${item.limited ? '<span class="limited-mark">限定</span>' : ''}</button>`).join('')}</div>
    <h2 class="gacha-title">${esc(gacha.name)}${gacha.limited ? ' <span class="tag rec">限定</span>' : ''}</h2>
    ${gacha.subtitle ? `<p class="gacha-subtitle">${esc(gacha.subtitle)}</p>` : ''}
    <div class="pull-row">
      <button class="pull" data-n="1">1回引く<span>${num(gacha.price)}コイン</span></button>
      <button class="pull pull-10" data-n="10">10回引く<span>${num(gacha.price10)}コイン</span></button>
    </div>
    <p class="guarantee">${esc(gacha.guaranteeText)}</p>
    ${gacha.note ? `<p class="gacha-note">${esc(gacha.note)}</p>` : ''}
    <h2 class="sec">出るキャラ</h2>
    <div class="gacha-lineup">${gacha.chars.map(id => { const c = app.charMap[id]; return c ? `<div class="gacha-lineup-item">${art(c,{size:62})}<span>${esc(c.name)}</span></div>` : ''; }).join('')}</div>
    ${last.length ? `<h2 class="sec">さっき出た個体</h2><div class="cards">${last.map(ind => `<button class="card r${ind.rarity}" data-uid="${ind.uid}">${cardInner(ind)}</button>`).join('')}</div>` : ''}
    <details class="rates">
      <summary>排出率とパワーの出やすさ</summary>
      <table class="simple"><thead><tr><th>レア</th><th>確率</th><th>送り出し</th></tr></thead><tbody>${rateRows}</tbody></table>
      <p class="muted small">特異個体はレアリティとは別に0.5%で出て、送り出すと5倍のコインになります。</p>
      <h3 style="font-size:13px;margin:12px 0 0">パワー（レアリティに関係なく決まる）</h3>
      <table class="simple"><thead><tr><th>パワー</th><th>出る確率</th></tr></thead><tbody>${powerRows}</tbody></table>
      <p class="muted small">ほとんどの個体は100〜500ほど。大きな値ほど急激に出にくくなり、上限に近い値は天文学的な確率です。</p>
      <h3 style="font-size:13px;margin:12px 0 0">すばやさ・かしこさ・うんのよさ・かがやき・性格の強さ</h3>
      <p class="muted small" style="margin:2px 0 0">パワーと同じ出にくさで、上限も${num(STAT_MAX)}。キャラごとに出発点が違い、出発点の10倍以上で約1/50、100倍以上で約1/1万です。</p>
      <h3 style="font-size:13px;margin:12px 0 0">体重・身長・食欲（多い方にも少ない方にも伸びる）</h3>
      <table class="simple"><thead><tr><th>基準からの倍率</th><th>出る確率（片側ごと）</th></tr></thead><tbody>${ratioRows}</tbody></table>
    </details>`;
  $$('[data-gacha-id]').forEach(b => { b.onclick = () => { app.gachaId = b.dataset.gachaId; app.lastResults = []; renderGacha(); }; });
  $$('.pull').forEach(b => { b.onclick = () => doPull(Number(b.dataset.n), gacha.id); });
  $$('#main .card').forEach(el => { el.onclick = () => openDetail(Number(el.dataset.uid)); });
}

async function doPull(n, gachaId = app.gachaId) {
  if (app.busy) return;
  Sound.click();
  let data;
  app.busy = true;
  try {
    const gacha = GACHAS.find(g => g.open && g.id === gachaId);
    if (!gacha) throw new Error('このガチャは現在開催されていません');
    if (onlineWalletEnabled()) {
      const localUids = app.server.nextPullUids(n, true, gacha);
      const pulled = await OnlineRanking.pull(gacha.id, n, app.server.player().display_name, localUids);
      data = app.server.acceptOnlinePull(n, pulled.results, pulled.coins, gacha);
      app.server.applyOnlineWallet(await OnlineRanking.wallet());
    } else {
      data = app.server.pull(n, gacha);
    }
  } catch (e) {
    app.busy = false;
    toast(e.message || 'ガチャを引けませんでした');
    return;
  }
  renderCoins();
  app.lastResults = data.results;
  updateBadges();
  tutorialEvent('gacha');
  try { await runShow(data.results, n); } finally { app.busy = false; }
  if (app.tab === 'gacha') renderGacha();
}

function runShow(results, n) {
  return new Promise((done) => {
    const full = app.server.settings().effects === 'full' && !reducedMotion();
    const ov = document.createElement('div');
    ov.className = 'show';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'ガチャの結果');
    ov.innerHTML = `
      <button class="skip">スキップ</button>
      <div class="flash"></div>
      <div class="show-stage"><div class="rays"></div><div class="big-capsule"><span class="top"></span><span class="bottom"></span></div><p class="tap-hint" hidden>タップして開ける</p></div>
      <div class="show-results" hidden><div class="inner"></div></div>`;
    document.body.appendChild(ov);
    document.body.classList.add('noscroll');

    let skipped = false;
    const pending = new Set();
    const pause = ms => skipped || ms <= 0 ? Promise.resolve() : new Promise(res => {
      const f = () => { clearTimeout(t); pending.delete(f); res(); };
      const t = setTimeout(f, ms);
      pending.add(f);
    });
    const skipBtn = ov.querySelector('.skip');
    skipBtn.onclick = () => { skipped = true; [...pending].forEach(f => f()); };

    const maxR = Math.max(...results.map(r => r.rarity));
    const cap = ov.querySelector('.big-capsule');
    const stage = ov.querySelector('.show-stage');
    const setCap = r => cap.style.setProperty('--cap', `var(--r${r})`);
    const shake = () => { cap.classList.remove('shake'); void cap.offsetWidth; cap.classList.add('shake'); };

    const close = () => { ov.remove(); document.body.classList.remove('noscroll'); done(); };

    (async () => {
      if (full) {
        setCap(maxR >= 3 ? 3 : 2);
        Sound.turn();
        await pause(300);
        cap.classList.add('drop'); Sound.drop();
        await pause(750);
        cap.classList.remove('drop'); cap.classList.add('ready');
        if (maxR >= 4 && !skipped) {
          shake(); await pause(380);
          setCap(4); ov.classList.add('purple'); Sound.up();
          await pause(650);
        }
        if (maxR === 5 && !skipped) {
          shake(); await pause(380);
          setCap(5); ov.classList.remove('purple'); ov.classList.add('gold'); Sound.up5(); vibrate([60, 40, 120]);
          await pause(750);
        }
        if (!skipped) {
          const hint = ov.querySelector('.tap-hint');
          hint.hidden = false;
          await new Promise(res => {
            const f = () => { clearTimeout(t); pending.delete(f); stage.removeEventListener('click', f); res(); };
            const t = setTimeout(f, 4000);
            pending.add(f);
            stage.addEventListener('click', f);
          });
          hint.hidden = true;
        }
        cap.classList.add('open'); Sound.pop();
        ov.querySelector('.flash').classList.add('go');
        await pause(420);
      }

      stage.hidden = true;
      const box = ov.querySelector('.show-results');
      box.hidden = false;
      const inner = box.querySelector('.inner');
      inner.innerHTML = `
        <div class="cards">${results.map((ind, i) => `<button class="fcard r${ind.rarity}" data-i="${i}" aria-label="キャラを確認する"><span class="flipper"><span class="face back"></span><span class="face front card r${ind.rarity}">${cardInner(ind)}</span></span></button>`).join('')}</div>
        <div class="show-actions"><button class="btn" data-act="close">閉じる</button><button class="btn danger" data-act="again">もう一度${n}回引く</button></div>`;
      const cards = [...inner.querySelectorAll('.fcard')];
      const flip = (el, quiet) => {
        if (el.classList.contains('flipped')) return;
        el.classList.add('flipped');
        el.setAttribute('aria-label', '個体票を見る');
        const ind = results[el.dataset.i];
        if (quiet) return;
        if (ind.rarity >= 4) { Sound.rare(ind.rarity); if (ind.rarity === 5) vibrate(80); } else Sound.flip(ind.rarity);
      };
      cards.forEach(el => {
        el.onclick = () => { if (el.classList.contains('flipped')) openDetail(results[el.dataset.i].uid); else flip(el); };
      });
      inner.querySelector('[data-act="close"]').onclick = close;
      inner.querySelector('[data-act="again"]').onclick = () => { close(); setTimeout(() => doPull(n, app.gachaId), 30); };

      const wasSkipped = skipped;
      skipped = false;
      skipBtn.textContent = 'すべてめくる';
      skipBtn.onclick = () => { skipped = true; [...pending].forEach(f => f()); };
      if (wasSkipped || !full) {
        cards.forEach(el => flip(el, true));
        if (maxR >= 4) Sound.rare(maxR); else Sound.flip(maxR);
      } else {
        await pause(200);
        for (const el of cards) {
          const r = results[el.dataset.i].rarity;
          await pause(r >= 4 ? 600 : 130);
          flip(el, skipped && r < 4);
        }
      }
      skipBtn.hidden = true;
    })();
  });
}

// ---------------------------------------------------------------------
// 図鑑
// ---------------------------------------------------------------------
function zukanSummary() {
  const byChar = {};
  for (const z of app.server.zukan()) {
    const g = byChar[z.char_id] || (byChar[z.char_id] = { rarities: new Set(), counts: {}, max: 0 });
    g.rarities.add(z.rarity);
    g.counts[z.rarity] = z.count;
    g.max = Math.max(g.max, z.rarity);
  }
  return byChar;
}

function renderZukan() {
  const main = $('#main');
  const byChar = zukanSummary();
  const seenCount = Object.keys(byChar).length;
  const total = app.chars.length * 5;
  const stamps = app.server.zukan().length;
  const titleTotal = app.chars.length * TITLES.length;
  const titleFound = app.chars.reduce((s, c) => s + app.server.titleBook(c.id).length, 0);
  const rewards = app.server.stampRewards();
  const rewardChars = new Set(rewards.map(r => r.char_id));
  const rewardSum = rewards.reduce((s, r) => s + r.amount, 0);

  main.innerHTML = `
    <div class="progress">
      <div class="nums">
        <div><b>${seenCount}</b><span> / ${app.chars.length} キャラ</span></div>
        <div><b>${stamps}</b><span> / ${total} スタンプ</span></div>
      </div>
      <div class="meter"><i style="width:${(stamps / total * 100).toFixed(1)}%"></i></div>
      <div class="small" style="margin-top:6px;color:#B9C3DA">見つけた称号 ${titleFound} / ${titleTotal}</div>
    </div>
    ${rewards.length ? `<div class="claim-banner"><span>図鑑報酬が${rewards.length}件あります<br><span class="small">合計 +${num(rewardSum)}コイン</span></span><button class="btn gold" id="claimStamps">受け取る</button></div>` : ''}
    <div class="zgrid">${app.chars.map((c, idx) => {
      const g = byChar[c.id];
      const slots = [1, 2, 3, 4, 5].map(r => `<i class="${g && g.rarities.has(r) ? 'on' + r : ''}" title="★${r}"></i>`).join('');
      return `<button class="zcell" data-id="${c.id}" aria-label="${g ? esc(c.name) : '未発見'}">
        ${rewardChars.has(c.id) ? '<span class="dotmark" aria-label="報酬あり"></span>' : ''}
        <span class="no">No.${String(idx + 1).padStart(3, '0')}</span>
        ${art(c, { rarity: g ? g.max : 1, size: 64, hidden: !g })}
        <span class="zname">${g ? esc(c.name) : '？？？'}</span>
        <span class="slots">${slots}</span>
      </button>`;
    }).join('')}</div>`;

  const claim = $('#claimStamps');
  if (claim) claim.onclick = async () => {
    claim.disabled = true;
    try {
      const r = onlineWalletEnabled() ? await OnlineRanking.claimStamps() : app.server.claimStampRewards();
      if (onlineWalletEnabled()) app.server.applyOnlineWallet(r);
      gained(Number(r.gained || 0), '図鑑報酬');
      renderZukan();
    } catch (e) { claim.disabled = false; toast(e.message); }
  };
  main.querySelectorAll('.zcell').forEach(el => { el.onclick = () => openZukanPage(el.dataset.id); });
}

// 図鑑の文章を、従来と同じ「続きを読む」形式で組み立てる
function zukanStoryTextHtml(text) {
  return String(text).split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const quote = /^「[^」]*」[。、]?$/.test(line);
    const flow = line === '↓';
    const beat = line.length <= 12 && !quote && !flow;
    return `<p class="${quote ? 'q' : flow ? 'flow' : beat ? 'beat' : ''}">${esc(line)}</p>`;
  }).join('');
}

function isLongZukanStory(value) {
  return String(value).length > 60 || String(value).includes('\n');
}

function zukanStoryPairsHtml(pairs) {
  const titlePair = pairs.find(([key]) => key === '題');
  const shortPairs = pairs.filter(([key, value]) => key !== '題' && !isLongZukanStory(value));
  const longPairs = pairs.filter(([key, value]) => key !== '題' && isLongZukanStory(value));
  return `${titlePair ? `<h4 class="ztitle">「${esc(titlePair[1])}」</h4>` : ''}
    ${shortPairs.length ? `<dl class="zfacts">${shortPairs.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>` : ''}
    ${longPairs.map(([key, value]) => {
      const first = String(value).split('\n').map(line => line.trim()).filter(Boolean)[0] || '';
      return `<details class="story">
        <summary><span class="story-label">${esc(key)}</span><span class="story-preview">${esc(first)}</span><span class="story-more">続きを読む（約${String(value).replace(/\s/g, '').length}文字）</span><span class="story-less">たたむ</span></summary>
        <div class="story-body">${zukanStoryTextHtml(value)}</div>
      </details>`;
    }).join('')}`;
}

function zukanStorySectionHtml(c, g, rarity) {
  const raw = (STORIES[c.id] || {})[String(rarity)] || [];
  const pairs = rarity === 1 ? [['分類', c.category], ['種類', c.kind || '—'], ['等級', c.grade], ...raw] : raw;
  const count = g.counts[rarity] ? `<span class="zcount">×${g.counts[rarity]}</span>` : '<span class="zcount none">スタンプなし</span>';
  const unlocked = g.max >= rarity;
  let content;
  if (!unlocked) content = `<p class="locked">★${rarity}を引くと開放されます</p>`;
  else if (!pairs.length) content = '<p class="muted small">この段階の文章はまだ用意されていません。</p>';
  else content = zukanStoryPairsHtml(pairs);
  return `<section class="zsec ${unlocked ? '' : 'is-locked'}"><h3>${starsHtml(rarity)}${count}</h3>${content}</section>`;
}

function zukanTrend(c, stat) {
  const start = statStart(c, stat);
  const average = app.chars.reduce((sum, char) => sum + statStart(char, stat), 0) / app.chars.length;
  const word = start < average * 0.7 ? '低い' : start > average * 1.3 ? '高い' : 'ふつう';
  return `${word}（出発点${num(start)}）`;
}

function zukanMeasure(value, unit) {
  const n = Number(value);
  return `${Number.isFinite(n) ? n.toLocaleString('ja-JP', { maximumFractionDigits: 1 }) : value}${unit}`;
}

function zukanHeroMediaHtml(c, slot, label) {
  const src = slotSrc(c, slot);
  if (src) return `<img src="${esc(src)}" alt="${esc(c.name)} ${esc(label)}" loading="eager" decoding="async">`;
  return `<span class="zukan-placeholder" aria-label="${esc(c.name)}の仮の絵">${placeholderSvg(c, null, false, 1, 1)}</span>`;
}

const ZUKAN_GRADE_INFO = {
  F:['微神級','#8E99A8'], E:['小神級','#2FA36B'], D:['常神級','#3B7DDD'], C:['強神級','#D6A600'],
  B:['大神級','#E67E22'], A:['超神級','#E6394A'], S:['神話級','#8E44AD'], ORIGIN:['特殊等級','#159A9C']
};
const RESOLVE_LABEL = { low:'低い', mid:'ふつう', high:'高い' };

// 個体を選ぶ画面で共通して使う「戦い方」の絞り込み。
// 同じ分類ではどれか1つ、別の分類どうしではすべてに合う個体を残す。
const COMBAT_FILTER_GROUPS = [
  { key:'distance', label:'距離', source:'tags', items:[['近接','近接'],['遠距離','遠距離'],['飛行','飛行']] },
  { key:'style', label:'型', source:'tags', items:[['長期戦','長期戦'],['短期決戦','短期決戦'],['分析','分析'],['高揚','高揚'],['自信','自信']] },
  { key:'role', label:'役割', source:'tags', items:[['拘束','拘束'],['精神干渉','精神干渉'],['領域','領域'],['音','音'],['大型','大型'],['かわいい好き','かわいい好き']] },
  { key:'resolve', label:'覚悟', source:'resolve', items:[['low','低い'],['mid','ふつう'],['high','高い']] },
  { key:'grade', label:'等級', source:'grade', items:['F','E','D','C','B','A','S'].map(x=>[x,x]) }
];

const STAGE_RECOMMEND = {
  chr_001:['短期決戦','遠距離'], chr_002:['high'], chr_003:['短期決戦','近接'],
  chr_004:['飛行','遠距離'], chr_005:['遠距離','分析'], chr_006:['近接','高揚'],
  chr_007:['短期決戦','近接'], chr_008:['短期決戦','音'], chr_009:['長期戦','大型'],
  chr_010:['精神干渉','分析'], chr_011:['大型','高揚'],
  chr_012:['high','短期決戦'], chr_013:['短期決戦','長期戦']
};

const RELAY_RECOMMEND_TAGS = ['短期決戦','飛行','遠距離','分析'];
const RELAY_RECOMMEND_SLOTS = [
  ['短期決戦','遠距離'],
  ['飛行','短期決戦','遠距離'],
  ['遠距離','分析','長期戦']
];

function newCombatFilter(values = []) {
  const state = { open:false, selected:{}, titled:false, special:false, thresholds:new Set() };
  COMBAT_FILTER_GROUPS.forEach(g => { state.selected[g.key] = new Set(); });
  values.forEach(value => {
    const group = COMBAT_FILTER_GROUPS.find(g => g.items.some(([v]) => v === value));
    if (group) state.selected[group.key].add(value);
  });
  return state;
}

function combatFilterValues(state) {
  const values = COMBAT_FILTER_GROUPS.flatMap(g => [...state.selected[g.key]].map(value => {
    const item = g.items.find(([v]) => v === value);
    return { group:g, value, label:item ? item[1] : value };
  }));
  if (state.titled) values.push({ value:'titled', label:'称号つき' });
  if (state.special) values.push({ value:'special', label:'特異個体' });
  [...(state.thresholds || [])].forEach(value => values.push({ value, label:`${STAT_LABEL[value]}1,000以上` }));
  return values;
}

function combatFilterMatch(ind, state) {
  const c = app.charMap[ind.char_id];
  if (!c) return false;
  if (state.titled && !(ind.titles && ind.titles.length)) return false;
  if (state.special && !ind.special) return false;
  if ([...(state.thresholds || [])].some(key => Number(ind[key]) < 1000)) return false;
  return COMBAT_FILTER_GROUPS.every(g => {
    const selected = [...state.selected[g.key]];
    if (!selected.length) return true;
    if (g.source === 'tags') return selected.some(value => (c.tags || []).includes(value));
    return selected.includes(c[g.source]);
  });
}

function filterIndividuals(all, state, charId = '') {
  return all.filter(ind => (!charId || ind.char_id === charId) && combatFilterMatch(ind, state));
}

function combatFilterHtml(state, shown, total) {
  const values = combatFilterValues(state);
  const summary = values.length ? values.map(x => x.label).join('・') : '条件なし';
  return `<div class="combat-filter-bar"><button class="btn" data-combat-filter-open aria-expanded="${state.open}">絞り込み</button><span class="combat-filter-summary" title="${esc(summary)}">${esc(summary)}</span><span class="combat-filter-count">${shown}体／${total}体</span></div>
    <div class="combat-filter-pop" ${state.open ? '' : 'hidden'}>${COMBAT_FILTER_GROUPS.map(g => `<div class="combat-filter-group"><strong>${g.label}</strong><div class="combat-filter-chips">${g.items.map(([value,label]) => `<button class="combat-filter-chip" data-combat-filter-group="${g.key}" data-combat-filter-value="${esc(value)}" aria-pressed="${state.selected[g.key].has(value)}">${esc(label)}</button>`).join('')}</div></div>`).join('')}
      <div class="combat-filter-group"><strong>個体</strong><div class="combat-filter-chips"><button class="combat-filter-chip" data-ind-filter="titled" aria-pressed="${state.titled}">称号つきだけ</button><button class="combat-filter-chip" data-ind-filter="special" aria-pressed="${state.special}">特異個体だけ</button></div></div>
      <div class="combat-filter-group"><strong>数値（選んだ条件すべて）</strong><div class="combat-filter-chips">${[['power','パワー'],['speed','すばやさ'],['wisdom','かしこさ']].map(([value,label]) => `<button class="combat-filter-chip" data-ind-threshold="${value}" aria-pressed="${state.thresholds.has(value)}">${label}1,000以上</button>`).join('')}</div></div>
      <button class="btn combat-filter-clear" data-combat-filter-clear ${values.length ? '' : 'disabled'}>すべて解除</button></div>`;
}

function bindCombatFilter(root, state, redraw) {
  const open = root.querySelector('[data-combat-filter-open]');
  if (open) open.onclick = () => { state.open = !state.open; redraw(); };
  root.querySelectorAll('[data-combat-filter-value]').forEach(button => button.onclick = () => {
    const selected = state.selected[button.dataset.combatFilterGroup], value = button.dataset.combatFilterValue;
    if (selected.has(value)) selected.delete(value); else selected.add(value);
    redraw();
  });
  root.querySelectorAll('[data-ind-filter]').forEach(button => button.onclick = () => {
    const key = button.dataset.indFilter;
    state[key] = !state[key];
    redraw();
  });
  root.querySelectorAll('[data-ind-threshold]').forEach(button => button.onclick = () => {
    const value = button.dataset.indThreshold;
    if (state.thresholds.has(value)) state.thresholds.delete(value); else state.thresholds.add(value);
    redraw();
  });
  const clear = root.querySelector('[data-combat-filter-clear]');
  if (clear) clear.onclick = () => {
    COMBAT_FILTER_GROUPS.forEach(g => state.selected[g.key].clear());
    state.titled = false; state.special = false; state.thresholds.clear();
    redraw();
  };
}
const COMBAT_STAT_LABEL = { atk:'攻撃', def:'防御', wis:'賢さ', spd:'素早さ', sta:'持久力', amb:'野望力' };

function combatEffectRowsHtml(rows) {
  return `<dl class="combat-effect-list">${rows.map(([name, text]) => `<div class="combat-effect-row ${name === '弱点' ? 'weak' : ''}"><dt>${esc(name)}</dt><dd>${esc(text)}</dd></div>`).join('')}</dl>`;
}

function combatEffectsHtml(charId) {
  const effect = BATTLE_EFFECTS[charId];
  if (!effect) return '';
  const team = TEAM_EFFECTS[charId] || [];
  return `<details class="combat-effects" open><summary>ゲームでの動き</summary><div class="combat-effects-body">
    <p class="combat-role">${esc(effect.role)}</p>
    ${combatEffectRowsHtml(effect.effects || [])}
    ${team.length ? `<h4 class="combat-team-title">集団戦での効果</h4>${combatEffectRowsHtml(team)}` : ''}
  </div></details>`;
}

function combatPanelHtml(c) {
  const data = COMBATS[c.id] || { type:'読み込み中', sections:[] };
  const bars = Object.entries(c.stats).map(([key,value]) => `<div class="combat-stat"><span>${COMBAT_STAT_LABEL[key]}</span><div><i style="width:${value}%"></i></div><b>${value}</b></div>`).join('');
  const sections = data.sections.map(([heading,text], index) => `<details class="story" ${index === 0 ? 'open' : ''}><summary><span class="story-label">${esc(heading)}</span><span class="story-preview">${esc(String(text).split('\n')[0])}</span><span class="story-more">続きを読む</span><span class="story-less">たたむ</span></summary><div class="story-body">${zukanStoryTextHtml(text)}</div></details>`).join('');
  return `<span class="combat-type">${esc(data.type)}</span><div class="combat-stats">${bars}</div><div class="combat-labels"><b>覚悟：${RESOLVE_LABEL[c.resolve]}</b>${c.tags.map(tag => `<em>${esc(tag)}</em>`).join('')}</div>${combatEffectsHtml(c.id)}${sections}<button class="btn primary wide" data-practice-char="${c.id}" style="margin-top:12px">このキャラと練習試合をする</button>`;
}

function openZukanPage(charId) {
  const g = zukanSummary()[charId];
  if (!g) { toast('ガチャで出会うと、図鑑のページが開きます'); return; }
  const c = app.charMap[charId];
  const pending = [];
  if (c.story && !STORIES[charId]) pending.push(loadStory(charId));
  if (c.combat && !COMBATS[charId]) pending.push(loadCombat(charId));
  if (pending.length) {
    openDialog('<p class="loading">図鑑の文章を読み込み中…</p>');
    Promise.all(pending).catch(() => toast('文章を読み込めませんでした')).then(() => openZukanPage(charId));
    return;
  }
  const idx = app.chars.indexOf(c) + 1, story = STORIES[c.id] || {}, one = story['1'] || [];
  const ability = one.find(([key]) => key === 'マッチアビリティ');
  const basicFacts = [['分類',c.category],['種類',c.kind || '—'],['等級',`${c.grade}級（${ZUKAN_GRADE_INFO[c.grade][0]}）`],['体重の基準',zukanMeasure(c.base_weight,'kg')],['身長の基準',zukanMeasure(c.base_height,'cm')],['出やすい性格',c.likely_natures.join('・')]];
  const found = app.server.titleBook(charId), mineCount = app.server.vault().filter(i => i.char_id === charId).length;
  const titleTags = TITLES.map(t => found.includes(t.id) ? `<em class="tag title">${esc(t.name)}</em>` : '<em class="tag off">？？？</em>').join('');
  const hallMap = Object.fromEntries(app.server.hall(charId).map(r => [`${r.stat}:${r.dir}`,r]));
  const hasProof = !!app.server.questProgress().proofs[charId];
  const records = RECORD_SPECS.map(([stat,dir]) => { const r=hallMap[`${stat}:${dir}`]; return `<div class="zukan-fact"><dt>${STAT_LABEL[stat]}（${dirLabel(stat,dir)}）</dt><dd>${r ? `<b>${fmtValue(stat,r.value)}</b><small>${esc(r.owner_name)}</small>` : '—'}</dd></div>`; }).join('');
  const grade = ZUKAN_GRADE_INFO[c.grade];
  const body = openDialog(`<div class="zukan-page" style="--zukan-el:${grade[1]}">
    <header class="zukan-hero"><div class="zukan-art-stage"><span class="zukan-no">No.${String(idx).padStart(3,'0')}</span><div class="zukan-hero-media">${zukanHeroMediaHtml(c,'base','通常')}</div></div>
    <div class="zukan-identity"><h2>${esc(c.name)}</h2><p>${esc(c.title)}</p><div><strong class="grade" style="--grade:${grade[1]}">${c.grade}級・${grade[0]}${c.category === 'マッチ守護者' ? '（守護者）' : ''}</strong><em>${esc(c.category)}</em>${c.kind ? `<em>${esc(c.kind)}</em>` : ''}</div></div></header>
    <div class="zukan-page-tabs" role="tablist">${[['basic','基本'],['story','物語'],['combat','戦闘能力'],['records','記録']].map(([k,l],i)=>`<button data-zukan-tab="${k}" aria-selected="${i===0}">${l}</button>`).join('')}</div>
    <div class="zukan-panels"><section class="zukan-panel" data-zukan-panel="basic"><dl class="zukan-facts">${basicFacts.map(([l,v])=>`<div class="zukan-fact"><dt>${l}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>${ability ? `<h3 class="zukan-panel-title">マッチアビリティ</h3>${zukanStoryPairsHtml([ability])}` : ''}</section>
    <section class="zukan-panel" data-zukan-panel="story" hidden><div class="story-tools"><button class="btn" id="openAllStories">すべて開く</button><button class="btn" id="closeAllStories">すべてたたむ</button></div>${[1,2,3,4,5].map(r=>zukanStorySectionHtml(c,g,r)).join('')}</section>
    <section class="zukan-panel" data-zukan-panel="combat" hidden>${combatPanelHtml(c)}</section>
    <section class="zukan-panel" data-zukan-panel="records" hidden>${hasProof ? '<div class="proof-banner">🏆 撃破の証　段階3クリア</div>' : ''}<h3 class="zukan-panel-title">見つけた称号 ${found.length} / ${TITLES.length}</h3><div class="title-list">${titleTags}</div><h3 class="zukan-panel-title">世界記録</h3><dl class="zukan-facts zukan-records">${records}</dl><button class="btn primary wide" id="seeMine" ${mineCount?'':'disabled'}>保管庫のこのキャラを見る（${mineCount}体）</button></section></div></div>`, 'zukan');
  tutorialEvent('zukan');
  const page = body.querySelector('.zukan-page');
  const panels = [...body.querySelectorAll('[data-zukan-panel]')];
  const updateCompact = panel => page.classList.toggle('is-compact', panel.scrollTop > 12);
  panels.forEach(panel => panel.addEventListener('scroll', () => updateCompact(panel), { passive:true }));
  body.querySelectorAll('[data-zukan-tab]').forEach(b => b.onclick=()=>{ body.querySelectorAll('[data-zukan-tab]').forEach(x=>x.setAttribute('aria-selected',String(x===b))); panels.forEach(x=>x.hidden=x.dataset.zukanPanel!==b.dataset.zukanTab); updateCompact(panels.find(x=>!x.hidden)); });
  const storyPanel=body.querySelector('[data-zukan-panel="story"]');
  body.querySelector('#openAllStories').onclick=()=>storyPanel.querySelectorAll('details.story').forEach(x=>{x.open=true;});
  body.querySelector('#closeAllStories').onclick=()=>storyPanel.querySelectorAll('details.story').forEach(x=>{x.open=false;});
  const mine=body.querySelector('#seeMine'); if(mine) mine.onclick=()=>{ app.vf={...app.vf,charId,rarity:''}; closeDialog(); show('vault'); };
  const fight=body.querySelector('[data-practice-char]'); if(fight) fight.onclick=()=>{ closeDialog(); openPracticeBattle(fight.dataset.practiceChar); };
}

// ---------------------------------------------------------------------
// 保管庫
// ---------------------------------------------------------------------
const VAULT_SORTS = {
  new: ['新しい順', (a, b) => b.uid - a.uid],
  rarity: ['レアリティ', (a, b) => b.rarity - a.rarity || b.uid - a.uid],
  power: ['個体値：パワー', (a, b) => b.power - a.power],
  speed: ['個体値：すばやさ', (a, b) => b.speed - a.speed],
  wisdom: ['個体値：かしこさ', (a, b) => b.wisdom - a.wisdom],
  base_atk: ['能力値：攻撃力', (a, b) => (app.charMap[b.char_id]?.stats.atk||0)-(app.charMap[a.char_id]?.stats.atk||0)],
  base_def: ['能力値：防御力', (a, b) => (app.charMap[b.char_id]?.stats.def||0)-(app.charMap[a.char_id]?.stats.def||0)],
  base_wis: ['能力値：賢さ', (a, b) => (app.charMap[b.char_id]?.stats.wis||0)-(app.charMap[a.char_id]?.stats.wis||0)],
  base_spd: ['能力値：素早さ', (a, b) => (app.charMap[b.char_id]?.stats.spd||0)-(app.charMap[a.char_id]?.stats.spd||0)],
  base_sta: ['能力値：持久力', (a, b) => (app.charMap[b.char_id]?.stats.sta||0)-(app.charMap[a.char_id]?.stats.sta||0)],
  base_amb: ['能力値：野望力', (a, b) => (app.charMap[b.char_id]?.stats.amb||0)-(app.charMap[a.char_id]?.stats.amb||0)],
  weight: ['体重', (a, b) => b.weight - a.weight],
  height: ['身長', (a, b) => b.height - a.height],
  luck: ['うんのよさ', (a, b) => b.luck - a.luck],
  shine: ['かがやき', (a, b) => b.shine - a.shine],
  appetite: ['食欲', (a, b) => b.appetite - a.appetite],
  nature_strength: ['性格の強さ', (a, b) => b.nature_strength - a.nature_strength],
  total_score: ['総合値', (a, b) => b.total_score - a.total_score],
  titles: ['称号の数', (a, b) => (b.titles || []).length - (a.titles || []).length || b.uid - a.uid]
};

function sortIndividuals(list, key = 'new', dir = 'desc') {
  const sorter = (VAULT_SORTS[key] || VAULT_SORTS.new)[1];
  return list.slice().sort((a, b) => dir === 'asc' ? sorter(b, a) : sorter(a, b));
}

function sortValue(ind, key) {
  if (key === 'new') return [`#${pad6(ind.serial)}`, '通し番号'];
  if (key === 'rarity') return [`★${ind.rarity}`, 'レアリティ'];
  if (key === 'titles') return [`${(ind.titles || []).length}`, '称号'];
  const battleStats={base_atk:['攻撃力','atk'],base_def:['防御力','def'],base_wis:['賢さ','wis'],base_spd:['素早さ','spd'],base_sta:['持久力','sta'],base_amb:['野望力','amb']};
  if(battleStats[key]){const [label,stat]=battleStats[key],value=app.charMap[ind.char_id]?.stats[stat]||0;return[num(value),label];}
  const labels = { power:'パワー', speed:'すばやさ', wisdom:'かしこさ', weight:'体重', height:'身長', luck:'うん', shine:'かがやき', appetite:'食欲', nature_strength:'性格', total_score:'総合値' };
  const units = { weight:'kg', height:'cm' };
  const value = key === 'weight' || key === 'height' ? Number(ind[key]).toLocaleString('ja-JP', { maximumFractionDigits:1 }) : num(ind[key]);
  return [`${value}${units[key] || ''}`, labels[key] || 'パワー'];
}

function individualSortHtml(view) {
  const options = Object.entries(VAULT_SORTS).map(([key,[label]]) => `<option value="${key}" ${view.sort === key ? 'selected' : ''}>${label}</option>`).join('');
  return `<div class="individual-sort"><label>並べ替え<select data-ind-sort>${options}</select></label><label>順序<select data-ind-dir><option value="desc" ${view.dir !== 'asc' ? 'selected' : ''}>高い順</option><option value="asc" ${view.dir === 'asc' ? 'selected' : ''}>低い順</option></select></label></div>`;
}

function bindIndividualSort(root, view, redraw) {
  const sort = root.querySelector('[data-ind-sort]'), dir = root.querySelector('[data-ind-dir]');
  if (sort) sort.onchange = () => { view.sort = sort.value; redraw(); };
  if (dir) dir.onchange = () => { view.dir = dir.value; redraw(); };
}

function releaseRisk(ind) {
  return !!(ind.special || (ind.titles || []).length >= 2 || Number(ind.power) >= 1000 || Number(ind.speed) >= 1000 || Number(ind.wisdom) >= 1000);
}

function individualRowHtml(ind, options = {}) {
  const c = app.charMap[ind.char_id], key = options.sort || 'power';
  const [value,label] = sortValue(ind,key);
  const titles = (ind.titles || []).map(titleName).filter(Boolean);
  const tags = [ind.special ? '<em class="tag sp">特異個体</em>' : '', ...titles.slice(0,3).map(t => `<em class="tag title">${esc(t)}</em>`)].join('');
  const stat = (name, short) => `<span class="${key === name ? 'active' : ''}">${short} ${num(ind[name])}</span>`;
  const classes = ['row','individual-row',options.selected ? 'selected' : '',options.dim ? 'dim' : '',options.warning ? 'release-warning' : ''].filter(Boolean).join(' ');
  return `<button class="${classes}" ${options.attr || ''}>${art(c,{ind,size:48})}<span class="individual-main"><span class="individual-top"><span class="rt">${esc(c.name)} ${starsHtml(ind.rarity)}</span><span class="individual-sort-value">${value}<small>${esc(label)}</small></span></span><span class="rs individual-meta">#${pad6(ind.serial)}　${esc(ind.nature)}　${Number(ind.weight).toLocaleString('ja-JP',{maximumFractionDigits:1})}kg</span><span class="individual-stats">${stat('power','P')}<i>／</i>${stat('speed','速')}<i>／</i>${stat('wisdom','賢')}</span>${tags ? `<span class="tags individual-tags">${tags}</span>` : ''}</span></button>`;
}

function pickerView(view) { return view || { sort:'power', dir:'desc' }; }

function protectedReason(ind, away, holders) {
  if (ind.locked) return 'ロック中';
  if (away.has(ind.uid)) return '探索中';
  if (ind.special) return '特異個体';
  if (holders.has(ind.uid)) return '世界記録';
  if ((ind.titles || []).length >= 2) return '称号が2つ以上';
  if (Number(ind.power) >= 1000 || Number(ind.speed) >= 1000 || Number(ind.wisdom) >= 1000) return '能力値1,000以上';
  return '';
}

function renderVault() {
  const main = $('#main');
  const all = app.server.vault();
  const away = app.server.dispatchedUids();
  const holders = app.server.recordHolderUids();
  const vf = app.vf;
  vf.combat = vf.combat || newCombatFilter();
  const list = sortIndividuals(all
    .filter(i => (!vf.charId || i.char_id === vf.charId) && (!vf.rarity || i.rarity === Number(vf.rarity)) && combatFilterMatch(i, vf.combat)), vf.sort, vf.dir);
  const seen = zukanSummary();

  const charOpts = `<option value="">全キャラ</option>` + app.chars.filter(c => seen[c.id]).map(c => `<option value="${c.id}" ${c.id === vf.charId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const rarOpts = `<option value="">全レア</option>` + [5, 4, 3, 2, 1].map(r => `<option value="${r}" ${String(r) === String(vf.rarity) ? 'selected' : ''}>★${r}</option>`).join('');

  main.innerHTML = `
    <div class="toolbar">
      <span class="count">${all.length} / ${app.server.player().vault_cap}</span>
      <button class="btn ${app.selectMode ? 'primary' : ''}" id="vselect" ${all.length ? '' : 'disabled'}>${app.selectMode ? '選ぶのをやめる' : '選んで送り出す'}</button>
    </div>
    <div class="filter-row">
      <select id="fChar" aria-label="キャラ">${charOpts}</select>
      <select id="fRar" aria-label="レアリティ">${rarOpts}</select>
      <span></span>
    </div>
    ${individualSortHtml(vf)}
    ${combatFilterHtml(vf.combat, list.length, all.length)}
    ${app.selectMode ? `<div class="bulk">
      <button class="btn" data-bulk="1">★1をまとめて選ぶ</button>
      <button class="btn" data-bulk="2">★2以下をまとめて選ぶ</button>
      <button class="btn" data-bulk="0">選択を解除</button>
    </div><p class="muted small" style="margin:-4px 0 10px">まとめて選ぶときは、ロック中・探索中・特異個体・世界記録・称号2つ以上・能力値1,000以上の個体を除きます。</p>` : ''}
    ${list.length ? `<ul class="rows">${list.map(ind => {
      const c = app.charMap[ind.char_id];
      const sel = app.selected.has(ind.uid);
      const blocked = ind.locked || away.has(ind.uid);
      const statusTags = [away.has(ind.uid) ? '<em class="tag exp">探索中</em>' : '', ind.locked ? '<em class="tag">ロック</em>' : '', holders.has(ind.uid) ? '<em class="tag rec">世界記録</em>' : ''].join('');
      return `<li>${individualRowHtml(ind,{sort:vf.sort,selected:sel,dim:app.selectMode&&blocked,warning:app.selectMode&&sel&&releaseRisk(ind),attr:`data-uid="${ind.uid}" ${app.selectMode ? `aria-pressed="${sel}"` : ''}`})}${statusTags ? `<span class="individual-status">${statusTags}</span>` : ''}</li>`;
    }).join('')}</ul>` : `<p class="muted combat-filter-empty">${all.length ? '条件に合う個体がいません。<br>条件を外してみてください。' : '保管庫は空です。ガチャを引くと、ここに個体が入ります。'}</p>`}`;

  $('#fChar').onchange = e => { vf.charId = e.target.value; renderVault(); };
  $('#fRar').onchange = e => { vf.rarity = e.target.value; renderVault(); };
  bindIndividualSort(main, vf, renderVault);
  bindCombatFilter(main, vf.combat, renderVault);
  $('#vselect').onclick = () => { app.selectMode = !app.selectMode; app.selected.clear(); renderVault(); };
  $$('[data-bulk]').forEach(b => {
    b.onclick = () => {
      const max = Number(b.dataset.bulk);
      if (!max) { app.selected.clear(); renderVault(); return; }
      let skippedCount = 0;
      list.forEach(i => {
        if (i.rarity > max) return;
        if (protectedReason(i, away, holders)) { skippedCount++; return; }
        app.selected.add(i.uid);
      });
      if (skippedCount) toast(`守られている個体${skippedCount}体を除きました`);
      renderVault();
    };
  });
  main.querySelectorAll('.row').forEach(el => {
    el.onclick = () => {
      const uid = Number(el.dataset.uid);
      if (!app.selectMode) { openDetail(uid); return; }
      const ind = all.find(i => i.uid === uid);
      if (ind.locked) { toast('ロック中の個体は送り出せません'); return; }
      if (away.has(uid)) { toast('探索中の個体は送り出せません'); return; }
      if (app.selected.has(uid)) app.selected.delete(uid); else app.selected.add(uid);
      renderVault();
    };
  });
  renderReleaseBar(all);
}

function releaseConfirmText(uids) {
  const w = app.server.releaseWarnings(uids);
  const selected = new Set(uids.map(Number));
  const risky = app.server.vault().filter(ind => selected.has(ind.uid) && releaseRisk(ind));
  const notes = [];
  if (w.special) notes.push(`特異個体 ${w.special}体`);
  if (w.record) notes.push(`世界記録を持つ個体 ${w.record}体`);
  if (w.titled) notes.push(`称号つき ${w.titled}体`);
  if (w.high) notes.push(`★4以上 ${w.high}体`);
  const detail = notes.length ? `\n\n次の個体が含まれています：\n・${notes.join('\n・')}` : '';
  return risky.length ? `${detail}\n\n⚠ 強い個体が${risky.length}体含まれています（称号2つ以上・能力値1,000以上・特異個体）。\nこの個体を送り出しますか？` : detail;
}

async function releaseOnlineIndividuals(individuals) {
  const uids = individuals.filter(i => i.online_verified).map(i => i.uid);
  if (!onlineWalletEnabled()) {
    if (!uids.length) return null;
    throw new Error('オンライン個体を送り出すには通信が必要です');
  }
  const released = uids.length ? await OnlineRanking.release(uids) : { gained:0, released:[] };
  const status = await OnlineRanking.wallet();
  return { ...status, gained:Number(released.gained || 0), released:released.released || [] };
}

function renderReleaseBar(all) {
  let bar = $('.release-bar');
  document.body.classList.toggle('selecting', app.selectMode);
  if (!app.selectMode) { if (bar) bar.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.className = 'release-bar'; document.body.appendChild(bar); }
  const picked = all.filter(i => app.selected.has(i.uid));
  const rewardable = onlineWalletEnabled() ? picked.filter(i => i.online_verified) : picked;
  const gain = rewardable.reduce((s, i) => s + RELEASE_COINS[i.rarity] * (i.special ? 5 : 1), 0);
  bar.innerHTML = `<div class="inner"><span><b>${picked.length}体選択中</b><small>合計 +${num(gain)}コイン</small></span><button class="btn danger" ${picked.length ? '' : 'disabled'}>送り出す</button></div>`;
  bar.querySelector('button').onclick = async () => {
    const uids = picked.map(i => i.uid);
    if (!await askConfirm(`${picked.length}体を送り出して、${num(gain)}コインを受け取ります。送り出した個体は戻せません。${releaseConfirmText(uids)}`, '送り出す')) return;
    try {
      const onlineResult = await releaseOnlineIndividuals(picked);
      const r = app.server.release(uids, onlineResult);
      if (onlineResult) app.server.applyOnlineWallet(onlineResult);
      app.selectMode = false; app.selected.clear();
      gained(r.gained, `${r.count}体を送り出しました`);
      renderVault();
    } catch (e) { toast(e.message); }
  };
}

// ---------------------------------------------------------------------
// 冒険（ログインボーナス・ミッション・探索）
// ---------------------------------------------------------------------
function streakHtml() {
  const L = app.server.loginStatus();
  const doneToday = L.last === L.today;
  return `<div class="streak">${LOGIN_TABLE.map((amt, i) => {
    const day = i + 1;
    const done = doneToday ? day <= L.streak : day < L.streak;
    const today = doneToday && day === L.streak;
    return `<div class="${done ? 'done' : ''} ${today ? 'today' : ''}">${day}日目<b>${amt}</b></div>`;
  }).join('')}</div>`;
}

function renderDaily(main) {
  const missions = app.server.missions();
  const exps = app.server.expeditions();
  app.renderedDone = exps.filter(e => e.done).length;

  const missionHtml = missions.map(m => `
    <div class="mission">
      <div><div class="mt">${esc(m.label)}</div><div class="mr">${m.progress} / ${m.target}　+${num(m.reward)}コイン</div></div>
      ${m.claimed ? '<span class="muted small">受け取り済み</span>' : `<button class="btn ${m.claimable ? 'gold' : ''}" data-mission="${m.id}" ${m.claimable ? '' : 'disabled'}>受け取る</button>`}
      <div class="bar"><i class="${m.progress >= m.target ? 'ok' : ''}" style="width:${(m.progress / m.target * 100).toFixed(0)}%"></i></div>
    </div>`).join('');

  const slots = Array.from({ length: EXP_SLOTS }, (_, i) => {
    const e = exps[i];
    if (!e) return `<div class="exp-slot"><div class="exp-head"><b>あき</b><button class="btn primary" data-plan style="margin-left:auto">探索に出す</button></div></div>`;
    const dest = DESTINATIONS.find(d => d.id === e.dest);
    const party = e.uids.map(uid => { const ind = app.server.vault().find(x => x.uid === uid); return ind ? art(app.charMap[ind.char_id], { ind, size: 40 }) : ''; }).join('');
    if (e.done) {
      return `<div class="exp-slot done"><div class="exp-head"><b>${esc(dest.name)}から帰ってきました</b></div>
        <div class="party">${party}</div>
        <button class="btn gold wide" data-claim="${e.id}">報酬を受け取る</button></div>`;
    }
    return `<div class="exp-slot running"><div class="exp-head"><b>${esc(dest.name)}を探索中</b><span class="time" data-end="${e.end}">${fmtTime(e.remaining)}</span></div>
      <div class="party">${party}</div>
      <div class="muted small">帰ってくると ${num(e.great ? e.reward / 2 : e.reward)}コイン以上</div></div>`;
  }).join('');

  main.innerHTML = `
    <section class="panel"><h2 class="sec">ログインボーナス</h2>${streakHtml()}<p class="muted small" style="margin:6px 0 0">毎日ひらくともらえます。7日目は1000コイン。</p></section>
    <section class="panel"><h2 class="sec">今日のミッション</h2>${missionHtml}</section>
    <section class="panel"><h2 class="sec">探索</h2>
      <p class="muted small" style="margin:0">保管庫の個体を探索に出すと、時間がたってからコインを持ち帰ります。探索中の個体は送り出せません。</p>
      ${slots}
    </section>`;

  $$('[data-mission]').forEach(b => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = onlineWalletEnabled() ? await OnlineRanking.claimMission(b.dataset.mission) : app.server.claimMission(b.dataset.mission);
        if (onlineWalletEnabled()) app.server.applyOnlineWallet(r);
        gained(Number(r.gained || 0), 'ミッション'); renderAdventure();
      } catch (e) { b.disabled = false; toast(e.message); }
    };
  });
  $$('[data-claim]').forEach(b => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = onlineWalletEnabled() ? await OnlineRanking.claimExpedition(Number(b.dataset.claim)) : app.server.claimExpedition(Number(b.dataset.claim));
        if (onlineWalletEnabled()) app.server.applyOnlineWallet(r);
        gained(r.gained, r.great ? '大成功！' : '探索');
        if (r.great) vibrate(60);
        renderAdventure();
      } catch (e) { b.disabled = false; toast(e.message); }
    };
  });
  $$('[data-plan]').forEach(b => { b.onclick = () => openExpeditionPlanner(); });
}

function openExpeditionPlanner(state = { dest: 'field', picked: [] }) {
  const away = app.server.dispatchedUids();
  const cands = app.server.vault().filter(i => !away.has(i.uid)).sort((a, b) => b.power - a.power);
  if (!cands.length) { toast('探索に出せる個体がいません。ガチャで仲間を増やしましょう'); return; }
  const prevScroll = $('.pick-list') ? $('.pick-list').scrollTop : 0;
  const est = state.picked.length ? app.server.estimateExpedition(state.dest, state.picked) : null;

  const body = openDialog(`
    <h2 style="margin:0 0 10px">探索に出す</h2>
    <div class="dest-list">${DESTINATIONS.map(d => `<button class="dest" data-dest="${d.id}" aria-pressed="${d.id === state.dest}"><b>${esc(d.name)}</b><span class="muted small">およそ${d.minutes >= 60 ? d.minutes / 60 + '時間' : d.minutes + '分'}　基本 ${num(d.base)}コイン</span></button>`).join('')}</div>
    <h3 style="margin:14px 0 2px;font-size:14px">メンバー（${state.picked.length} / ${PARTY_MAX}）</h3>
    <p class="muted small" style="margin:0">パワーの合計とかしこさで報酬が増え、すばやさが高いと早く帰り、うんのよさが高いと大成功（報酬2倍）しやすくなります。</p>
    <div class="pick-list"><ul class="rows">${cands.map(ind => {
      const c = app.charMap[ind.char_id];
      const sel = state.picked.includes(ind.uid);
      return `<li><button class="row ${sel ? 'selected' : ''}" data-pick="${ind.uid}" aria-pressed="${sel}">
        ${art(c, { ind, size: 44 })}
        <span><span class="rt">${esc(c.name)} ${starsHtml(ind.rarity)}</span><br><span class="rs">すばやさ ${ind.speed}　かしこさ ${ind.wisdom}　うん ${ind.luck}</span></span>
        <span class="rv">${num(ind.power)}<small>パワー</small></span></button></li>`;
    }).join('')}</ul></div>
    <div class="estimate">${est
      ? `予定 <b>${num(est.reward)}</b> コイン　帰還まで ${fmtTime(est.ms)}<br><span class="small">大成功の確率 ${(est.greatChance * 100).toFixed(0)}%</span>`
      : 'メンバーを選ぶと、報酬と時間の見込みが出ます'}</div>
    <button class="btn primary wide" id="goExp" ${state.picked.length ? '' : 'disabled'}>出発する</button>`);

  body.querySelector('.pick-list').scrollTop = prevScroll;
  body.querySelectorAll('[data-dest]').forEach(b => { b.onclick = () => openExpeditionPlanner({ ...state, dest: b.dataset.dest }); });
  body.querySelectorAll('[data-pick]').forEach(b => {
    b.onclick = () => {
      const uid = Number(b.dataset.pick);
      let picked = state.picked.slice();
      if (picked.includes(uid)) picked = picked.filter(x => x !== uid);
      else if (picked.length >= PARTY_MAX) { toast(`選べるのは${PARTY_MAX}体までです`); return; }
      else picked.push(uid);
      openExpeditionPlanner({ ...state, picked });
    };
  });
  body.querySelector('#goExp').onclick = async () => {
    const go = body.querySelector('#goExp'); go.disabled = true;
    try {
      if (onlineWalletEnabled()) app.server.applyOnlineWallet(await OnlineRanking.startExpedition(state.dest, state.picked));
      else app.server.startExpedition(state.dest, state.picked);
      closeDialog();
      toast('探索に出発しました');
      if (app.tab === 'adventure') renderAdventure();
    } catch (e) { go.disabled = false; toast(e.message); }
  };
}

function tick() {
  if (!app.server) return;
  if (app.tab === 'adventure' && !practice.open) {
    const now = app.server.now();
    $$('[data-farm-ready]').forEach(el => {
      const rest = Math.max(0, Number(app.server.questProgress().farmReadyAt[el.dataset.farmReady] || 0) - now);
      el.textContent = rest ? fmtTime(rest) : '挑戦可';
    });
    const doneNow = app.server.expeditions().filter(e => e.done).length;
    $$('[data-end]').forEach(el => { el.textContent = fmtTime(Math.max(0, Number(el.dataset.end) - now)); });
    if (doneNow !== app.renderedDone && !$('#dlg').open) renderAdventure();
  }
  if (Math.floor(Date.now() / 1000) % 15 === 0) updateBadges();
}

// ---------------------------------------------------------------------
// ランキング
// ---------------------------------------------------------------------
let rankingRenderId = 0;
let rankingSyncSignature = '';
let rankingSyncPromise = null;

function rankingRowsHtml(rows, stat, online) {
  if (!rows.length) return '<p class="muted">まだこの条件の個体がいません。</p>';
  return `<ul class="rows">${rows.map(r => {
    const c = app.charMap[r.char_id];
    if (!c) return '';
    const inner = `
      <span class="rank-no">${r.rank}</span>
      ${art(c, { rarity: r.rarity, size: 40 })}
      <span><span class="rt">${esc(c.name)} ${starsHtml(r.rarity)}${r.special ? ' ✦' : ''}</span><br><span class="rs">${esc(r.owner_name)}${r.is_mine ? '（あなた）' : ''}</span></span>
      <span class="rv">${fmtValue(stat, r.value)}</span>`;
    if (r.is_mine) return `<li><button class="row rank-row mine" data-rank-uid="${r.uid}">${inner}</button></li>`;
    return `<li><div class="row rank-row static${online ? '' : ' local'}">${inner}</div></li>`;
  }).join('')}</ul>`;
}

async function syncOnlineRanking() {
  const name = app.server.player().display_name;
  const signature = name;
  if (signature === rankingSyncSignature) return;
  if (rankingSyncPromise) await rankingSyncPromise;
  if (signature === rankingSyncSignature) return;
  rankingSyncPromise = OnlineRanking.sync(name);
  try {
    await rankingSyncPromise;
    rankingSyncSignature = signature;
  } finally {
    rankingSyncPromise = null;
  }
}

function stageRecommendHtml(boss) {
  const values = STAGE_RECOMMEND[boss] || [];
  if (!values.length) return '';
  const labels = values.map(value => value === 'high' ? '覚悟：高い' : value);
  return `<div class="quest-recommend"><button data-quest-recommend="${values.join('|')}">おすすめで絞り込む：${esc(labels.join('・'))}</button></div>`;
}

async function renderRanking() {
  const renderId = ++rankingRenderId;
  const main = $('#main');
  const rk = app.rk;
  const valid = RANKING_STATS.filter(s => rk.charId ? !s.globalOnly : s.global);
  if (!valid.find(s => s.stat === rk.stat)) rk.stat = valid[0].stat;
  const def = RANKING_STATS.find(s => s.stat === rk.stat);
  if (!def.dirs.includes(rk.dir)) rk.dir = def.dirs[0];

  const charOpts = `<option value="">全キャラ</option>` + app.chars.map(c => `<option value="${c.id}" ${c.id === rk.charId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const statOpts = valid.map(s => `<option value="${s.stat}" ${s.stat === rk.stat ? 'selected' : ''}>${s.stat === 'nature_strength' ? '性格の強さ' : STAT_LABEL[s.stat]}</option>`).join('');
  const dirOpts = def.dirs.map(d => `<option value="${d}" ${d === rk.dir ? 'selected' : ''}>${dirLabel(rk.stat, d)}</option>`).join('');
  const natureOpts = NATURES.map(n => `<option ${n === rk.nature ? 'selected' : ''}>${esc(n)}</option>`).join('');

  main.innerHTML = `
    <div class="filters">
      <label>キャラ<select id="rkChar">${charOpts}</select></label>
      <label>項目<select id="rkStat">${statOpts}</select></label>
      <label>並び<select id="rkDir" ${def.dirs.length < 2 ? 'disabled' : ''}>${dirOpts}</select></label>
      ${def.needsNature ? `<label>性格<select id="rkNature">${natureOpts}</select></label>` : ''}
    </div>
    <p class="ranking-status" id="rkStatus">${typeof OnlineRanking !== 'undefined' && OnlineRanking.configured() ? 'オンラインランキングを更新中…' : 'オンラインランキングはまだ接続されていません。端末内の参考順位です。'}</p>
    <div id="rkRows"><p class="loading">順位を読み込み中…</p></div>`;

  $('#rkChar').onchange = e => { rk.charId = e.target.value; renderRanking(); };
  $('#rkStat').onchange = e => { rk.stat = e.target.value; renderRanking(); };
  $('#rkDir').onchange = e => { rk.dir = e.target.value; renderRanking(); };
  if ($('#rkNature')) $('#rkNature').onchange = e => { rk.nature = e.target.value; renderRanking(); };

  const query = { stat: rk.stat, dir: rk.dir, charId: rk.charId, nature: def.needsNature ? rk.nature : null };
  let rows;
  let online = false;
  let error = '';
  if (typeof OnlineRanking !== 'undefined' && OnlineRanking.configured()) {
    try {
      await syncOnlineRanking();
      rows = await OnlineRanking.ranking(query);
      online = true;
    } catch (e) {
      error = e.message || '通信できませんでした';
    }
  }
  if (!rows) rows = app.server.ranking(query);
  if (renderId !== rankingRenderId || app.tab !== 'ranking') return;

  const status = $('#rkStatus');
  if (online) {
    status.className = 'ranking-status online';
    status.textContent = `オンラインランキング（上位${rows.length}体）`;
  } else if (error) {
    status.className = 'ranking-status error';
    status.textContent = `オンラインに接続できません。端末内の参考順位を表示しています。（${error}）`;
  }
  $('#rkRows').innerHTML = rankingRowsHtml(rows, rk.stat, online);
  $$('#rkRows [data-rank-uid]').forEach(el => { el.onclick = () => openDetail(Number(el.dataset.rankUid)); });
}

// ---------------------------------------------------------------------
// 個体票
// ---------------------------------------------------------------------
function openDetail(uid) {
  let ind;
  try { ind = app.server.individual(uid, true); } catch (e) { toast(e.message); return; }
  tutorialEvent('individual');
  if (onlineWalletEnabled() && ind.owner_id === 'me' && ind.online_verified) {
    OnlineRanking.recordDetail().then(status => { app.server.applyOnlineWallet(status); updateBadges(); }).catch(() => {});
  }
  const ranks = app.server.ranks(uid);
  const c = app.charMap[ind.char_id];
  const mine = ind.owner_id === app.server.userId;
  const line = (NATURE_LINES[ind.nature] || '……。').replaceAll('{name}', c.name);

  const statItems = DETAIL_ROWS.map(row => {
    const stats = row.include || [row.stat];
    const best = {};
    for (const [stat, dir, scope] of RANK_SPECS) {
      if (!stats.includes(stat)) continue;
      const r = ranks && ranks[`${stat}:${dir}:${scope}`];
      if (!r) continue;
      const key = `${stat}:${scope}`;
      const pct = r.rank / r.total * 100;
      if (!best[key] || pct < best[key].pct) best[key] = { stat, dir, scope, pct, ...r };
    }
    let bestPct = 100;
    const lines = Object.values(best).map(b => {
      bestPct = Math.min(bestPct, b.pct);
      const extra = b.stat.endsWith('_dev') ? `（ズレ ${fmtValue(b.stat, ind[b.stat])}）` : '';
      return `<li class="${b.rank <= 10 ? 'top10' : ''}">${SCOPE_WORDS[b.scope]}${dirLabel(b.stat, b.dir)}${extra} <b>${num(b.rank)}位</b> / ${num(b.total)}体</li>`;
    }).join('');
    const hot = bestPct <= 5;
    return `<li class="stat">
      <div class="stat-top"><span class="lbl">${STAT_LABEL[row.stat]}</span><span class="val">${fmtValue(row.stat, ind[row.stat], ind)}</span>
        <span class="pct ${hot ? 'hot' : ''}">上位 ${bestPct < 1 ? bestPct.toFixed(2) : bestPct.toFixed(1)}%</span></div>
      <div class="bar"><i class="${hot ? 'hot' : ''}" style="width:${Math.max(2, 100 - bestPct).toFixed(1)}%"></i></div>
      <ul class="ranks">${lines}</ul>
    </li>`;
  }).join('');

  const titles = (ind.titles || []).map(id => TITLES.find(t => t.id === id)).filter(Boolean);
  const status = [
    ind.special ? '<em class="tag sp">特異個体</em>' : '',
    ind.holdsRecord ? '<em class="tag rec">世界記録を保持</em>' : '',
    ind.dispatched ? '<em class="tag exp">探索中</em>' : '',
    ind.locked ? '<em class="tag">ロック中</em>' : ''
  ].join('');
  const releaseCoins = onlineWalletEnabled() && !ind.online_verified ? 0 : RELEASE_COINS[ind.rarity] * (ind.special ? 5 : 1);

  const body = openDialog(`
    <div class="specimen-head">
      ${art(c, { ind, size: 104 })}
      <div>
        <span class="serial">#${pad6(ind.serial)}</span>
        <h2>${esc(c.name)}</h2>
        ${starsHtml(ind.rarity)}
        <div class="muted small">${mine ? 'あなたの個体' : `持ち主：${esc(ind.owner_name)}`}</div>
        ${status ? `<div class="tags" style="justify-content:flex-start">${status}</div>` : ''}
      </div>
    </div>
    <div class="speech">${esc(line)}</div>
    <p class="muted small" style="margin:0 0 6px">性格「${esc(ind.nature)}」のひとこと</p>
    ${titles.length ? `<div class="title-list" style="margin:8px 0">${titles.map(t => `<em class="tag title">${esc(t.name)}</em><span class="muted small">${esc(t.desc)}</span>`).join('')}</div>` : ''}
    <ul class="stats">${statItems}</ul>
    ${mine ? `<div class="actions">
      <button class="btn primary" id="dSkills">スキル装備（${skillCost(ind.equipped_skills)}/8）</button>
      <button class="btn" id="dLock">${ind.locked ? 'ロックを外す' : 'ロックする'}</button>
      <button class="btn danger" id="dRelease" ${ind.locked || ind.dispatched ? 'disabled' : ''}>送り出す（+${num(releaseCoins)}）</button>
    </div>` : ''}`);

  if (mine) {
    body.querySelector('#dSkills').onclick=()=>openSkillEquip(uid);
    body.querySelector('#dLock').onclick = () => {
      try { app.server.toggleLock(uid); openDetail(uid); if (app.tab === 'vault') renderVault(); } catch (e) { toast(e.message); }
    };
    body.querySelector('#dRelease').onclick = async () => {
      if (!await askConfirm(`${c.name} #${pad6(ind.serial)} を送り出して、${num(releaseCoins)}コインを受け取ります。送り出した個体は戻せません。${releaseConfirmText([uid])}`, '送り出す')) return;
      try {
        const onlineResult = await releaseOnlineIndividuals([ind]);
        const r = app.server.release([uid], onlineResult);
        if (onlineResult) app.server.applyOnlineWallet(onlineResult);
        closeDialog();
        app.lastResults = app.lastResults.filter(x => x.uid !== uid);
        gained(r.gained, '送り出しました');
        if (app.tab !== 'gacha' || !$('.show')) render();
      } catch (e) { toast(e.message); }
    };
  }
  updateBadges();
}

function equipmentSummary(ind){
 const defs=(ind.equipped_skills||[]).map(id=>SKILL_DEFS[id]).filter(Boolean),skills=defs.filter(x=>x.kind!=='passive').length,passives=defs.filter(x=>x.kind==='passive').length;
 return defs.length?`発動スキル${skills}・パッシブ${passives}（${skillCost(ind.equipped_skills)}/${SKILL_MAX_COST}）`:`装備なし（0/${SKILL_MAX_COST}）`;
}

function equipmentGuideHtml(){
 return `<details class="relay-equip-guide"><summary>装備（発動スキル・パッシブ）について</summary><p>装備は合計コスト${SKILL_MAX_COST}まで。発動スキルは条件を満たしたとき、パッシブは常時または攻撃を受けたときなどに自動で働きます。個体選択画面の「装備を変更」から選べます。</p></details>`;
}

function openSkillEquip(uid,options={}){
 const ind=app.server.vault().find(x=>x.uid===Number(uid));if(!ind)return;
 const ch=app.charMap[ind.char_id],selected=new Set(ind.equipped_skills||[]);
 const draw=()=>{const used=skillCost([...selected]);const body=openDialog(`<h2 style="margin:0">装備を選ぶ</h2><p class="equip-guide-mini">発動スキルもパッシブも戦闘中に自動で働きます。解放条件を満たした装備を、合計コスト${SKILL_MAX_COST}まで選べます。</p><p class="skill-cost">コスト <b>${used}</b> / ${SKILL_MAX_COST}</p><div class="skill-list">${Object.entries(SKILL_DEFS).map(([id,s])=>{const req=s.requirement(ind,ch),on=selected.has(id),over=!on&&used+s.cost>SKILL_MAX_COST,passive=s.kind==='passive';return`<button class="skill-row ${on?'on':''} ${req.ok?'':'locked'}" data-skill="${id}" ${!req.ok||over?'disabled':''}><span><strong><i class="equip-kind ${passive?'passive':''}">${passive?'パッシブ':'発動スキル'}</i>${esc(s.name)}</strong><small>コスト ${s.cost}</small></span><em>${req.ok?(on?'装備中':'装備可能'):esc(req.text)}</em><p>${esc(s.desc)}</p></button>`;}).join('')}</div>${options.back?'<button class="btn wide" id="skillBack" style="margin-bottom:7px">個体選択へ戻る</button>':''}<button class="btn primary wide" id="skillSave">この装備で確定</button>`);body.querySelectorAll('[data-skill]').forEach(b=>b.onclick=()=>{const id=b.dataset.skill;selected.has(id)?selected.delete(id):selected.add(id);draw();});const back=body.querySelector('#skillBack');if(back)back.onclick=options.back;body.querySelector('#skillSave').onclick=()=>{try{app.server.equipSkills(uid,[...selected]);toast('装備を保存しました');if(options.done)options.done();else closeDialog();}catch(e){toast(e.message);}};};draw();
}

// ---------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------
function openSettings() {
  const st = app.server.settings();
  const body = openDialog(`
    <h2 style="margin:0 0 10px">設定</h2>
    <label style="display:block;font-weight:700;font-size:13px">ランキングに出る名前（1〜12文字）
      <div style="display:flex;gap:8px;margin-top:4px"><input type="text" id="nameInput" maxlength="12" value="${esc(app.server.player().display_name)}" style="flex:1"><button class="btn primary" id="nameSave">変更する</button></div>
    </label>
    <div class="setting-row"><span>効果音</span><label class="check"><input type="checkbox" id="sSound" ${st.sound ? 'checked' : ''}>鳴らす</label></div>
    <div class="setting-row"><span>ガチャ演出</span><select id="sFx"><option value="full" ${st.effects === 'full' ? 'selected' : ''}>フル</option><option value="short" ${st.effects === 'short' ? 'selected' : ''}>短め</option></select></div>
    <button class="btn wide" id="openBattleHelp" style="margin-top:12px">戦闘について</button>
    <button class="btn wide" id="restartTutorial" style="margin-top:7px">はじめての案内をもう一度見る</button>
    <button class="btn wide" id="openSiteInfo" style="margin-top:7px">このゲームについて・利用規約</button>
    <p class="muted small" style="margin:7px 0 0;text-align:center">個人制作・開発中／無料・課金なし</p>
    <h3 style="font-size:14px;margin:16px 0 4px">データ管理</h3>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      <button class="btn danger" id="dbgReset">データを消す</button>
    </div>`);
  body.querySelector('#nameSave').onclick = () => {
    try { app.server.setName(body.querySelector('#nameInput').value); toast('名前を変更しました'); } catch (e) { toast(e.message); }
  };
  body.querySelector('#sSound').onchange = e => { app.server.setSetting('sound', e.target.checked); if (e.target.checked) Sound.coin(); };
  body.querySelector('#sFx').onchange = e => app.server.setSetting('effects', e.target.value);
  body.querySelector('#openBattleHelp').onclick = openBattleHelp;
  body.querySelector('#restartTutorial').onclick = () => { app.server.restartTutorial(); closeDialog(); show('gacha'); };
  body.querySelector('#openSiteInfo').onclick = () => openSiteInfo();
  body.querySelector('#dbgReset').onclick = async () => {
    if (!await askConfirm('デモのデータをすべて消します。オンラインの匿名プレイヤーも新しくなり、以前のランキングや残高には戻れません。登録した画像は残ります。', '消す')) return;
    if (typeof OnlineRanking !== 'undefined') OnlineRanking.resetSession();
    app.server.reset();
    location.reload();
  };
}

function openBattleHelp() {
  const body = openDialog(`<h2 style="margin:0 0 10px">戦闘について</h2><div class="battle-help-list">${HELP_BATTLE.map((item, index) => `<details ${index === 0 ? 'open' : ''}><summary>${esc(item.title)}</summary><p class="battle-help-body">${esc(item.body)}</p></details>`).join('')}</div>`);
  return body;
}

function siteInfoPage(id) {
  return SITE_INFO_PAGES.find(page => page.id === id);
}

function openSiteInfo(id = '') {
  if (!id) {
    const body = openDialog(`<span class="site-info-badge">個人制作・開発中</span><h2 style="margin:0 0 5px">ガチャ図鑑</h2><p class="site-info-lead">趣味で制作・公開している無料ゲームです。遊ぶ前に、以下の内容をご確認ください。</p><div class="site-info-menu">${SITE_INFO_PAGES.map(page => `<button class="btn wide" data-site-info="${page.id}">${esc(page.title)}</button>`).join('')}</div><p class="site-info-updated">最終更新：${esc(SITE_INFO_UPDATED)}</p>`);
    body.querySelectorAll('[data-site-info]').forEach(button => { button.onclick = () => openSiteInfo(button.dataset.siteInfo); });
    return;
  }
  const page = siteInfoPage(id);
  if (!page) return openSiteInfo();
  const body = openDialog(`<button class="btn site-info-back" id="siteInfoBack">← 一覧へ戻る</button><h2 style="margin:0 38px 5px 0">${esc(page.title)}</h2><p class="site-info-lead">${esc(page.lead)}</p>${page.sections.map(([heading, text]) => `<section class="site-info-section"><h3>${esc(heading)}</h3><p>${esc(text)}</p></section>`).join('')}${page.link ? `<a class="btn primary wide" href="${esc(page.link.url)}" target="_blank" rel="noopener noreferrer" style="display:block;text-align:center;margin-top:12px">${esc(page.link.label)}</a>` : ''}<p class="site-info-updated">最終更新：${esc(SITE_INFO_UPDATED)}</p>`);
  body.querySelector('#siteInfoBack').onclick = () => openSiteInfo();
}

function showLoginBonus(info) {
  if (!info) return;
  renderCoins(true);
  openDialog(`
    <h2 style="margin:0 0 4px">ログインボーナス</h2>
    <p style="margin:0 0 6px">${info.day}日目：<b style="font-family:var(--dot);font-size:22px">+${num(info.amount)}</b> コイン</p>
    ${streakHtml()}
    <button class="btn primary wide" style="margin-top:14px" id="lbOk">受け取る</button>`);
  $('#lbOk').onclick = () => { Sound.coin(); closeDialog(); };
  updateBadges();
}

function questStageById(id) { return STAGES.find(s => s.id === id) || FARM_STAGES.find(s => s.id === id); }
function isFarmStage(id) { return id && id.startsWith('farm_'); }
function farmRemaining(id) { return Math.max(0, Number(app.server.questProgress().farmReadyAt[id] || 0) - app.server.now()); }

function questSectionsHtml() {
  const progress = app.server.questProgress();
  const clearedCount = Object.keys(progress.cleared).length;
  const trials = app.chars.map((c, index) => {
    const stages = STAGES.filter(s => s.boss === c.id).sort((a,b) => a.level - b.level);
    const levels = stages.map(st => {
      const unlocked = app.server.questUnlocked(st.id), cleared = !!progress.cleared[st.id], goal = !!progress.goals[st.id];
      const cls = goal ? 'goal' : cleared ? 'cleared' : unlocked ? '' : 'locked';
      const label = goal ? `段階${st.level} ★` : cleared ? `段階${st.level} ✓` : unlocked ? `段階${st.level}` : `段階${st.level} 🔒`;
      return `<button class="quest-level ${cls}" data-quest-stage="${st.id}" ${unlocked ? '' : 'disabled'}>${label}</button>`;
    }).join('');
    const team=TEAM_STAGES.find(x=>x.boss===c.id),teamUnlocked=team&&app.server.teamQuestUnlocked(team.id),teamClear=team&&progress.teamCleared[team.id],teamGoal=team&&progress.teamGoals[team.id];
    const teamCls=teamGoal?'goal':teamClear?'cleared':teamUnlocked?'':'locked';
    const teamLabel=teamGoal?'集団 ★':teamClear?'集団 ✓':teamUnlocked?'集団戦':'集団 🔒';
    const teamMark=team?`<button class="quest-level team-mark ${teamCls}" data-team-stage="${team.id}" ${teamUnlocked?'':'disabled'}>${teamLabel}</button>`:'';
    return `<article class="quest-card ${progress.proofs[c.id] ? 'proof' : ''}">${progress.proofs[c.id] ? '<span class="quest-proof">撃破の証</span>' : ''}<div class="quest-card-head">${art(c,{size:48})}<span><strong>No.${String(index+1).padStart(3,'0')} ${esc(c.name)}</strong><small>${c.grade}級・${esc(ZUKAN_GRADE_INFO[c.grade][0])}</small></span></div><div class="quest-levels">${levels}${teamMark}</div></article>`;
  }).join('');
  const farms = FARM_STAGES.map(st => {
    const rest = farmRemaining(st.id), streak = st.id === 'farm_2' ? `　${progress.arenaStreak}連勝中` : '';
    return `<button class="farm-card" data-quest-stage="${st.id}"><span><strong>${esc(st.difficulty)}　${esc(st.name)}</strong><small>${st.reward}コイン${streak}</small></span><span class="farm-time" data-farm-ready="${st.id}">${rest ? fmtTime(rest) : '挑戦可'}</span></button>`;
  }).join('');
  return `<div class="quest-heading"><h2>特別試験</h2></div><button class="relay-entry" id="openRelay"><strong>逆獣三段撃破</strong><small>3体を順番に出す勝ち抜き戦・固定報酬 1,000コイン</small><span>${app.server.s.relayClears?'クリア済み':'挑戦する'} →</span></button><div class="quest-heading"><h2>キャラ別の試練</h2><span class="quest-count">${clearedCount} / ${STAGES.length}</span></div><div class="quest-grid">${trials}</div><div class="quest-heading"><h2>周回</h2></div><div class="farm-grid">${farms}</div>`;
}

function bindQuestSections(root = document) {
  const relay=root.querySelector('#openRelay');if(relay)relay.onclick=openRelayQuest;
  root.querySelectorAll('[data-quest-stage]').forEach(b => b.onclick = () => openQuestDetail(b.dataset.questStage));
  root.querySelectorAll('[data-team-stage]').forEach(b => b.onclick = () => openTeamQuestDetail(b.dataset.teamStage));
}

function relayAutoScore(ind,tags){
 const c=app.charMap[ind.char_id],grade={F:0,E:1,D:2,C:3,B:4,A:5,S:6}[c.grade]||0;
 const tagScore=tags.reduce((score,tag,index)=>score+((c.tags||[]).includes(tag)?70-index*10:0),0);
 const valueScore=['power','speed','wisdom'].reduce((score,key)=>score+Math.log10(Math.max(1,Number(ind[key])||1)),0);
 return tagScore+grade*5+valueScore;
}

function relayAutoLineup(){
 const pool=app.server.vault(),picked=[],usedChars=new Set();
 for(const tags of RELAY_RECOMMEND_SLOTS){
  const available=pool.filter(ind=>!picked.some(x=>x.uid===ind.uid));
  const diverse=available.filter(ind=>!usedChars.has(ind.char_id)),candidates=diverse.length?diverse:available;
  const best=candidates.sort((a,b)=>relayAutoScore(b,tags)-relayAutoScore(a,tags))[0];
  if(!best)return null;
  picked.push(best);usedChars.add(best.char_id);
 }
 return picked.map(ind=>ind.uid);
}

function openRelayQuest(){
 relayView.uids=app.server.relayLineup().filter(uid=>app.server.vault().some(x=>x.uid===uid)).slice(0,3);
 const draw=()=>{
  const slots=Array.from({length:3},(_,i)=>{const ind=app.server.vault().find(x=>x.uid===relayView.uids[i]),c=ind&&app.charMap[ind.char_id];return`<button class="relay-slot" data-relay-slot="${i}">${c?art(c,{ind,size:52}):'<span class="relay-empty">＋</span>'}<span><b>${i+1}番手　${c?esc(c.name):'個体を選ぶ'}</b><small>${ind?`${equipmentSummary(ind)}　★${ind.rarity}`:'勝った個体は残りHPを引き継ぎます'}</small></span></button>`;}).join('');
  const enemies=RELAY_ENEMIES.map((x,i)=>{const c=x.ch||app.charMap[x.id];return`<button type="button" class="relay-enemy boss-ability-trigger" data-boss-ability="${c.id}" aria-label="${esc(c.name)}の能力と攻略ヒントを表示">${art(c,{size:82})}<b>${i+1}戦目</b><small>${esc(c.name)}</small><span class="boss-list-hint">能力・攻略を見る</span></button>`;}).join('');
  $('#main').innerHTML=`<section class="quest-detail"><button class="btn" id="relayBack">← クエスト一覧</button><div class="quest-detail-hero"><span><h2>逆獣三段撃破</h2><p>3対3・勝ち抜き戦</p></span></div><h3 class="sec">敵の順番</h3><div class="relay-enemies">${enemies}</div><div class="quest-info"><dl><dt>ルール</dt><dd>勝者は残りHPを引き継ぎ、敗者側だけが次の個体へ交代します。</dd><dt>報酬</dt><dd>クリアごとに1,000コイン</dd></dl></div><div class="relay-recommend"><div class="relay-recommend-head"><strong>連戦におすすめ</strong><button class="btn primary" id="relayAuto">おすすめで自動編成</button></div><div class="relay-recommend-tags">${RELAY_RECOMMEND_TAGS.map(tag=>`<em>${tag}</em>`).join('')}</div></div><h3 class="sec">出撃順</h3><div class="relay-slots">${slots}</div>${equipmentGuideHtml()}<button class="btn danger wide" id="relayStart" ${relayView.uids.length===3?'':'disabled'}>この順番で挑戦</button></section>`;
  $('#relayBack').onclick=renderAdventure;$('#relayAuto').onclick=()=>{const ids=relayAutoLineup();if(!ids){toast('自動編成には異なる個体が3体必要です');return;}relayView.uids=ids;draw();toast('おすすめタグに合わせて編成しました');};$$('[data-relay-slot]').forEach(b=>b.onclick=()=>openRelayPicker(Number(b.dataset.relaySlot),draw));$$('[data-boss-ability]').forEach(b=>b.onclick=()=>openBossAbility(b.dataset.bossAbility));$('#relayStart').onclick=()=>{renderRelayBattle();startRelayFight();};
 };draw();
}
function openRelayPicker(slot,done,filter='',combat=newCombatFilter(),view=null){view=pickerView(view);const used=new Set(relayView.uids.filter((x,i)=>i!==slot)),all=app.server.vault().filter(x=>!used.has(x.uid)),list=sortIndividuals(filterIndividuals(all,combat,filter),view.sort,view.dir),redraw=()=>openRelayPicker(slot,done,filter,combat,view);const body=openDialog(`<h2 style="margin:0 0 8px">${slot+1}番手を選ぶ</h2><label class="small">キャラで絞り込み <select id="relayOwnFilter"><option value="">すべて</option>${app.chars.map(c=>`<option value="${c.id}" ${c.id===filter?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label>${individualSortHtml(view)}${combatFilterHtml(combat,list.length,all.length)}<p class="muted small" style="margin:5px 0 9px">個体を選ぶ前に、相手に合わせて装備も変更できます。</p><div class="practice-pick-list"><ul class="rows">${list.map(ind=>`<li class="relay-pick-card">${individualRowHtml(ind,{sort:view.sort,attr:`data-relay-pick="${ind.uid}"`})}<div class="relay-pick-equip"><span>${esc(equipmentSummary(ind))}</span><button type="button" class="btn" data-relay-equip="${ind.uid}">装備を変更</button></div></li>`).join('')||'<li class="muted small combat-filter-empty">条件に合う個体がいません。<br>条件を外してみてください。</li>'}</ul></div>`);body.querySelector('#relayOwnFilter').onchange=e=>openRelayPicker(slot,done,e.target.value,combat,view);bindIndividualSort(body,view,redraw);bindCombatFilter(body,combat,redraw);body.querySelectorAll('[data-relay-pick]').forEach(b=>b.onclick=()=>{relayView.uids[slot]=Number(b.dataset.relayPick);closeDialog();done();});body.querySelectorAll('[data-relay-equip]').forEach(b=>b.onclick=()=>openSkillEquip(Number(b.dataset.relayEquip),{back:redraw,done:redraw}));}

function relayMember(side,index){
 if(side===0){const ind=app.server.vault().find(x=>x.uid===relayView.uids[index]);return ind&&{ind,c:app.charMap[ind.char_id]};}
 const x=RELAY_ENEMIES[index],c=x&&(x.ch||app.charMap[x.id]);return c&&{ind:x.ind,c};
}
function relayCorner(side,index,hp=null,maxHp=null){
 const el=$(`#relayCorner${side}`),member=relayMember(side,index);if(!el||!member)return;
 const {ind,c}=member,grade=ZUKAN_GRADE_INFO[c.grade]||[c.grade,'#8E99A8'],pct=hp==null||!maxHp?100:Math.max(0,hp)/maxHp*100,src=slotSrc(c,'base');
 el.style.setProperty('--c',grade[1]);el.innerHTML=`<div class="relay-order">${side===0?'味方':'敵'} ${index+1}/3</div><div class="practice-art">${src?`<img src="${esc(src)}" alt="${esc(c.name)}">`:placeholderSvg(c,ind,false,1,1)}</div><div class="practice-name">${esc(c.name)}</div><div class="practice-grade"><b>${c.grade}</b>${esc(grade[0])}・覚悟${esc(RESOLVE_LABEL[c.resolve])}</div><div class="practice-ind"><span>パ<b>${num(ind.power)}</b></span><span>速<b>${num(ind.speed)}</b></span><span>賢<b>${num(ind.wisdom)}</b></span></div><div class="practice-hpbar"><i class="${pct<=30?'low':''}" style="width:${pct}%"></i></div><div class="practice-hpnum">${hp==null?'待機中':`HP ${Math.max(0,Math.round(hp))} / ${Math.round(maxHp)}`}</div>`;
}
function openBossAbility(id){
 const data=typeof BOSS_ABILITIES!=='undefined'&&BOSS_ABILITIES[id];if(!data)return;
 const body=openDialog(`<div class="boss-help-head"><span class="boss-help-badge">敵の仕様</span><h2>${esc(data.displayName)}</h2><p>${esc(data.subtitle)}</p></div><section class="boss-help-section"><h3>持っている効果</h3><ul class="boss-ability-list">${data.abilities.map(x=>`<li><strong>${esc(x.name)}</strong><span>${esc(x.desc)}</span></li>`).join('')}</ul></section><section class="boss-help-section hint"><h3>攻略のヒント</h3><ul>${data.hints.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></section><button class="btn primary wide" id="bossHelpClose">出撃画面に戻る</button>`);
 body.querySelector('#bossHelpClose').onclick=closeDialog;
}
function renderRelayBattle(){
 if(relayView.running){relayView.token++;relayView.running=false;}practice.open=true;document.body.classList.add('practice-mode');
 $('#main').innerHTML=`<section class="practice-battle ${relayView.expanded?'log-wide':''}" id="relayBattle"><div class="practice-top"><button class="practice-mini practice-back" id="relayBattleBack">← 編成</button><h1>逆獣三段撃破</h1><button class="practice-mini battle-view-toggle" id="relayViewToggle">${relayView.expanded?'絵を大きく':'実況を広く'}</button></div><div class="practice-versus"><div class="practice-corner" id="relayCorner0"></div><div class="practice-vs">VS</div><div class="practice-corner" id="relayCorner1"></div></div><div class="practice-stage"><b id="relayBoutLabel">第1戦</b><p class="practice-feature-line">勝者は残りHPを引き継いで次の相手と戦います</p></div><div class="practice-feed" id="relayFeed" aria-live="polite"></div><div class="practice-actions"><button id="relayEdit">編成へ</button><button id="relaySpeed">実況：<br>${relayView.fast?'はやい':'ふつう'}</button><button id="relaySkip">結果まで<br>飛ばす</button><button class="go" id="relayGo">戦わせる</button></div></section>`;
 relayCorner(0,0);relayCorner(1,0);
 const back=()=>{practice.open=false;relayView.token++;relayView.running=false;document.body.classList.remove('practice-mode');openRelayQuest();};
 $('#relayBattleBack').onclick=back;$('#relayEdit').onclick=back;$('#relaySpeed').onclick=e=>{relayView.fast=!relayView.fast;e.currentTarget.innerHTML=`実況：<br>${relayView.fast?'はやい':'ふつう'}`;};$('#relaySkip').onclick=()=>relayView.skip=true;$('#relayViewToggle').onclick=e=>{relayView.expanded=!relayView.expanded;$('#relayBattle').classList.toggle('log-wide',relayView.expanded);e.currentTarget.textContent=relayView.expanded?'絵を大きく':'実況を広く';};$('#relayGo').onclick=startRelayFight;
}
async function startRelayFight(){
 const token=++relayView.token,feed=$('#relayFeed'),button=$('#relayGo');relayView.skip=false;relayView.running=true;relayView.expanded=true;$('#relayBattle').classList.add('log-wide');$('#relayViewToggle').textContent='絵を大きく';feed.innerHTML='';button.textContent='やり直す';button.classList.add('running');
 let res;try{res=app.server.relayBattle(relayView.uids);}catch(e){relayView.running=false;button.classList.remove('running');button.textContent='戦わせる';toast(e.message);return;}
 relayView.result=res;renderCoins(true);let ai=0,bi=0,carryA=null,carryB=null;const wait=ms=>new Promise(r=>setTimeout(r,relayView.skip?0:relayView.fast?ms/4:ms));
 for(let n=0;n<res.bouts.length;n++){
  const bout=res.bouts[n],names=[bout.A.name,bout.B.name];if(token!==relayView.token||!practice.open)return;
  $('#relayBoutLabel').textContent=`第${n+1}戦　味方${ai+1}番手 vs 敵${bi+1}番手`;
  relayCorner(0,ai,carryA??bout.A.maxHp,bout.A.maxHp);relayCorner(1,bi,carryB??bout.B.maxHp,bout.B.maxHp);
  feed.insertAdjacentHTML('beforeend',`<p class="ev relay-change"><b>第${n+1}戦</b>　${esc(names[0])} VS ${esc(names[1])}</p>`);feed.scrollTop=feed.scrollHeight;await wait(800);
  for(const event of compressPracticeLog(bout.log,names)){if(token!==relayView.token||!practice.open)return;feed.insertAdjacentHTML('beforeend',practiceEventHtml(event,names));if(event.hpA!=null){relayCorner(0,ai,event.hpA,bout.A.maxHp);relayCorner(1,bi,event.hpB,bout.B.maxHp);}if(!relayView.skip){feed.scrollTop=feed.scrollHeight;await wait(event.kind==='skill'||event.kind==='big'?900:event.kind==='sum'?700:500);}}
  relayCorner(0,ai,bout.A.hp,bout.A.maxHp);relayCorner(1,bi,bout.B.hp,bout.B.maxHp);
  if(bout.winner===0){carryA=bout.A.hp;carryB=null;bi++;feed.insertAdjacentHTML('beforeend',`<p class="ev relay-change">${esc(names[1])}が倒れ、次の敵が出現する！</p>`);}else{carryB=bout.B.hp;carryA=null;ai++;feed.insertAdjacentHTML('beforeend',`<p class="ev relay-change">${esc(names[0])}が倒れ、次の味方が出撃する！</p>`);}feed.scrollTop=feed.scrollHeight;await wait(1100);
 }
 if(token!==relayView.token||!practice.open)return;
 feed.insertAdjacentHTML('beforeend',`<div class="practice-result"><h2>${res.winner===0?'クリア！':'敗北…'}</h2><p>${res.winner===0?'敵の3体をすべて撃破しました。':'自分の3体が先に倒れました。'}</p><p><b>${res.reward?`+${num(res.reward)}コイン`:'報酬なし'}</b></p><div class="quest-result-actions"><button id="relayRetry">もう一度挑戦</button><button id="relayResultEdit">編成へ戻る</button></div></div>`);feed.scrollTop=feed.scrollHeight;relayView.running=false;button.textContent='もう一度';button.classList.remove('running');$('#relayRetry').onclick=startRelayFight;$('#relayResultEdit').onclick=()=>{practice.open=false;document.body.classList.remove('practice-mode');openRelayQuest();};
}

function questRewardText(st) {
  if (isFarmStage(st.id)) {
    if (st.id === 'farm_2') return `${st.reward}コイン（連勝ごとに+10%、最大1.5倍）`;
    if (st.id === 'farm_3') return `${st.reward}コイン（目標達成で1.5倍）`;
    return `${st.reward}コイン`;
  }
  const rw = QUEST_REWARDS[st.level];
  return `初回 ${num(rw.first)}／2回目以降 ${num(rw.repeat)}／目標初達成 +${num(rw.goal)}コイン${st.level === 3 ? ' ＋ 撃破の証' : ''}`;
}

function preferredRow(c) { return (c.tags || []).some(x => x === '遠距離' || x === '飛行') ? 'back' : 'front'; }

function prepareTeam(size, quest = false) {
  teamView.size=size; teamView.quest=quest;
  const vault=app.server.vault(), saved=app.server.teamLineup(size), used=new Set(), uids=[], rows=[];
  for(let i=0;i<size;i++){
    let ind=vault.find(x=>x.uid===saved.uids[i]&&!used.has(x.char_id));
    if(!ind) ind=vault.find(x=>!used.has(x.char_id));
    if(ind){uids.push(ind.uid);used.add(ind.char_id);rows.push(saved.rows[i]||preferredRow(app.charMap[ind.char_id]));}
  }
  teamView.uids=uids;teamView.rows=rows;
  if(!quest){
    const ids=app.chars.slice(0,size).map(x=>x.id);
    teamView.enemies=ids.map((id,i)=>({id,row:preferredRow(app.charMap[id]),ind:app.server.rollPracticeEnemy(id)}));
  }
}

function teamSelectedHtml() {
  return Array.from({length:teamView.size},(_,i)=>{
    const ind=app.server.vault().find(x=>x.uid===teamView.uids[i]),c=ind&&app.charMap[ind.char_id];
    return `<div class="team-compose-slot">${c?art(c,{ind,size:44}):'<div class="art" style="width:44px;height:44px"></div>'}<span><strong>${c?esc(c.name):'個体未選択'}</strong>${ind?`<small>パ ${num(ind.power)}　速 ${num(ind.speed)}　賢 ${num(ind.wisdom)}</small><small>${esc(equipmentSummary(ind))}</small>`:''}</span><button class="team-row-toggle" data-team-row="${i}">${teamView.rows[i]==='back'?'後衛':'前衛'}</button><button class="btn" data-team-pick="${i}" style="grid-column:2/4;padding:3px">個体・装備を選ぶ</button></div>`;
  }).join('');
}

function bindTeamComposer(root,onChange) {
  root.querySelectorAll('[data-team-row]').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.teamRow);teamView.rows[i]=teamView.rows[i]==='back'?'front':'back';onChange();});
  root.querySelectorAll('[data-team-pick]').forEach(b=>b.onclick=()=>openTeamOwnPicker(Number(b.dataset.teamPick),onChange));
}

function openTeamOwnPicker(slot,onChange,filter='',combat=newCombatFilter(),view=null) {
  view=pickerView(view);
  const all=app.server.vault(),list=sortIndividuals(filterIndividuals(all,combat,filter),view.sort,view.dir);
  const redraw=()=>openTeamOwnPicker(slot,onChange,filter,combat,view);
  const body=openDialog(`<h2 style="margin:0 0 8px">${slot+1}体目を選ぶ</h2><label class="small">キャラで絞り込み <select id="teamOwnFilter"><option value="">すべて</option>${app.chars.map(c=>`<option value="${c.id}" ${c.id===filter?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label>${individualSortHtml(view)}${combatFilterHtml(combat,list.length,all.length)}<div class="practice-pick-list"><ul class="rows">${list.map(ind=>`<li class="relay-pick-card">${individualRowHtml(ind,{sort:view.sort,selected:teamView.uids[slot]===ind.uid,attr:`data-team-own="${ind.uid}"`})}<div class="relay-pick-equip"><span>${esc(equipmentSummary(ind))}</span><button type="button" class="btn" data-team-equip="${ind.uid}">装備を変更</button></div></li>`).join('')||'<li class="muted small combat-filter-empty">条件に合う個体がいません。<br>条件を外してみてください。</li>'}</ul></div>`);
  body.querySelector('#teamOwnFilter').onchange=e=>openTeamOwnPicker(slot,onChange,e.target.value,combat,view);
  bindIndividualSort(body,view,redraw);
  bindCombatFilter(body,combat,redraw);
  body.querySelectorAll('[data-team-equip]').forEach(b=>b.onclick=()=>openSkillEquip(Number(b.dataset.teamEquip),{back:redraw,done:redraw}));
  body.querySelectorAll('[data-team-own]').forEach(b=>b.onclick=()=>{const uid=Number(b.dataset.teamOwn),ind=app.server.vault().find(x=>x.uid===uid),other=teamView.uids.some((x,i)=>i!==slot&&app.server.vault().find(v=>v.uid===x)?.char_id===ind.char_id);if(other){toast('同じキャラを同じチームに入れることはできません');return;}teamView.uids[slot]=uid;teamView.rows[slot]=teamView.rows[slot]||preferredRow(app.charMap[ind.char_id]);closeDialog();if($('#teamOwnCompose')||$('#battleTeamCompose'))onChange();else renderTeamBattle(teamView.quest);});
}

function teamEnemyCards(st) {
  const enemies=st?st.enemies:teamView.enemies;
  return `<div class="team-enemies" style="--n:${enemies.length}">${enemies.map(x=>{const c=app.charMap[x.id],src=artSrc(c,1,true);return `<div class="team-enemy">${src?`<img src="${esc(src)}" alt="${esc(c.name)}">`:placeholderSvg(c,null,false,1,1)}<strong>${esc(c.name)}</strong><small>${x.row==='back'?'後衛':'前衛'}</small></div>`;}).join('')}</div>`;
}

function openTeamQuestDetail(stageId) {
  const st=TEAM_STAGES.find(x=>x.id===stageId);if(!st)return;
  teamView.stageId=stageId;prepareTeam(st.size,true);practice.open=false;document.body.classList.remove('practice-mode');
  const draw=()=>{$('#teamOwnCompose').innerHTML=teamSelectedHtml();bindTeamComposer($('#teamOwnCompose'),draw);$('#startTeamQuest').disabled=teamView.uids.length!==st.size;};
  const featureText=st.features.map(f=>`<b>${esc(f)}</b>：${esc(STAGE_FEATURES[f].text)}`).join('<br>')||'なし';
  $('#main').innerHTML=`<section class="quest-detail"><button class="btn" id="teamQuestBack">← クエスト一覧</button><div class="quest-detail-hero"><span><h2>${esc(st.name)}</h2><p>${st.size}対${st.size}・集団戦</p></span></div><div class="quest-info"><dl><dt>物語</dt><dd>${esc(st.story)}</dd><dt>相手チーム</dt><dd>${teamEnemyCards(st)}</dd><dt>舞台の特徴</dt><dd>${featureText}</dd><dt>敵の状態</dt><dd>${esc(st.enemyText||'なし')}</dd><dt>出来事</dt><dd>${esc(st.eventText||'なし')}</dd><dt>挑戦目標</dt><dd>${esc(st.goal?.text||'なし')}</dd><dt>報酬</dt><dd>初回 ${num(TEAM_REWARDS.first)}／2回目以降 ${num(TEAM_REWARDS.repeat)}／目標初達成 +${num(TEAM_REWARDS.goal)}コイン</dd></dl></div><h3 class="sec">挑戦するチーム</h3><div class="team-compose" id="teamOwnCompose"></div>${equipmentGuideHtml()}<button class="btn danger wide" id="startTeamQuest">挑戦する</button></section>`;
  $('#teamQuestBack').onclick=renderAdventure;$('#startTeamQuest').onclick=()=>renderTeamBattle(true);draw();
}

function openTeamEnemyEditor() {
  const draw=()=>{
    const body=openDialog(`<h2 style="margin:0 0 5px">相手チーム</h2><p class="muted small" style="margin:0">同じキャラは選べません。</p><div class="team-compose">${teamView.enemies.map((x,i)=>`<div class="team-compose-slot">${art(app.charMap[x.id],{size:44})}<span><select data-enemy-char="${i}" style="max-width:100%">${app.chars.map(c=>`<option value="${c.id}" ${c.id===x.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select><small>パ ${num(x.ind.power)}　速 ${num(x.ind.speed)}　賢 ${num(x.ind.wisdom)}</small></span><button class="team-row-toggle" data-enemy-row="${i}">${x.row==='back'?'後衛':'前衛'}</button></div>`).join('')}</div><button class="btn wide" id="enemyReroll">相手を引き直す</button><button class="btn primary wide" id="enemyDone" style="margin-top:6px">決定</button>`);
    body.querySelectorAll('[data-enemy-char]').forEach(s=>s.onchange=()=>{const id=s.value,i=Number(s.dataset.enemyChar);if(teamView.enemies.some((x,j)=>j!==i&&x.id===id)){toast('相手チームにも同じキャラは入れられません');s.value=teamView.enemies[i].id;return;}teamView.enemies[i]={id,row:preferredRow(app.charMap[id]),ind:app.server.rollPracticeEnemy(id)};draw();});
    body.querySelectorAll('[data-enemy-row]').forEach(b=>b.onclick=()=>{const x=teamView.enemies[Number(b.dataset.enemyRow)];x.row=x.row==='back'?'front':'back';draw();});
    body.querySelector('#enemyReroll').onclick=()=>{teamView.enemies.forEach(x=>x.ind=app.server.rollPracticeEnemy(x.id));draw();};
    body.querySelector('#enemyDone').onclick=()=>{closeDialog();renderTeamBattle(false);};
  };draw();
}

function openTeamStagePicker() {
  const body=openDialog(`<h2 style="margin:0 0 8px">舞台を選ぶ</h2><select id="teamStagePick" style="width:100%">${PRACTICE_STAGES.map((s,i)=>`<option value="${i}" ${i===practice.stageIndex?'selected':''}>${esc(s.name)}</option>`).join('')}<option value="custom" ${practice.stageIndex<0?'selected':''}>オリジナルの舞台</option></select><button class="btn wide" id="teamCustomFeatures" style="margin-top:8px">特徴を選ぶ</button><button class="btn primary wide" id="teamStageDone" style="margin-top:8px">決定</button>`);
  body.querySelector('#teamStagePick').onchange=e=>{if(e.target.value==='custom'){practice.stageIndex=-1;}else{practice.stageIndex=Number(e.target.value);practice.features=PRACTICE_STAGES[practice.stageIndex].features.slice();}};
  body.querySelector('#teamCustomFeatures').onclick=()=>openPracticeFeatures(()=>renderTeamBattle(false));
  body.querySelector('#teamStageDone').onclick=()=>{closeDialog();teamView.expanded=false;renderTeamBattle(false);};
}

function teamColumnWeight(n){return n===0?.5:n===1?1:n===2?1.1:1.8;}
function renderTeamField(fighters) {
  const field=$('#teamField');if(!field)return;
  const defs=[[0,'back','後衛'],[0,'front','前衛'],[1,'front','前衛'],[1,'back','後衛']];
  const groups=defs.map(([side,row])=>fighters.filter(f=>f.side===side&&f.row===row)),weights=groups.map(g=>teamColumnWeight(g.length)),total=weights.reduce((a,b)=>a+b,0),mid=(weights[0]+weights[1])/total*100;
  field.style.setProperty('--team-cols',weights.map(x=>`${x}fr`).join(' '));field.style.setProperty('--mid',`${mid}%`);
  field.innerHTML=groups.map((g,i)=>`<div class="team-col ${i<2?'me':'foe'}"><div class="team-col-label">${defs[i][2]}</div><div class="team-cells n${g.length}">${g.length?g.map(f=>{const c=app.charMap[f.id],src=artSrc(c,1,true),pct=f.maxHp?Math.max(0,f.hp)/f.maxHp*100:100;return `<div class="team-cell ${f.hp<=0?'down':''}">${src?`<img src="${esc(src)}" alt="${esc(c.name)}">`:placeholderSvg(c,null,false,1,1)}<div class="team-cell-cap"><div class="team-cell-name">${esc(c.name)}</div><div class="practice-hpbar"><i class="${pct<=30?'low':''}" style="width:${pct}%"></i></div></div></div>`;}).join(''):'<div class="team-cell empty"></div>'}</div></div>`).join('');
}

function initialTeamFighters() {
  const own=teamView.uids.map((uid,i)=>{const ind=app.server.vault().find(x=>x.uid===uid),c=ind&&app.charMap[ind.char_id];return c&&{side:0,id:c.id,name:c.name,row:teamView.rows[i],hp:1,maxHp:1};}).filter(Boolean);
  const st=teamView.quest&&TEAM_STAGES.find(x=>x.id===teamView.stageId),foes=(st?st.enemies:teamView.enemies).map(x=>({side:1,id:x.id,name:app.charMap[x.id].name,row:x.row,hp:1,maxHp:1}));
  return own.concat(foes);
}

function compressTeamLog(log) {
  const out=[];let buf=[];const flush=()=>{if(!buf.length)return;const rounds=[...new Set(buf.map(e=>e.round))],last=buf.at(-1);if(rounds.length<=1)out.push(...buf);else{const d=[0,0];buf.forEach(e=>{if(e.dmg&&e.side!=null)d[e.side]+=e.dmg;});out.push({kind:'sum',round:last.round,text:`ラウンド${rounds[0]}〜${rounds.at(-1)}：乱戦が続く（自分のチームが${d[0]}、相手のチームが${d[1]}ダメージ）`,hp:last.hp});}buf=[];};
  log.forEach(e=>{if(e.kind==='round')return;if(e.kind==='hit'||e.kind==='miss')buf.push(e);else{flush();out.push(e);}});flush();return out;
}

function renderTeamBattle(quest=teamView.quest) {
  if(teamView.running){teamView.token++;teamView.running=false;}teamView.quest=quest;practice.open=true;document.body.classList.add('practice-mode');
  const st=quest?TEAM_STAGES.find(x=>x.id===teamView.stageId):null,title=st?st.name:`${teamView.size}対${teamView.size} 練習試合`;
  $('#main').innerHTML=`<section class="team-battle ${teamView.expanded?'log-wide':''}" id="teamBattle"><div class="practice-top"><button class="practice-mini practice-back" id="teamBack">← ${quest?'一覧':'冒険'}</button><h1>${esc(title)}</h1><button class="practice-mini battle-view-toggle" id="teamViewToggle">${teamView.expanded?'絵を大きく':'実況を広く'}</button></div>${quest?'':`<div class="battle-mode-switch">${[1,2,3].map(n=>`<button data-battle-mode="${n}" class="${n===teamView.size?'active':''}">${n}対${n}</button>`).join('')}</div>`}<div class="team-field" id="teamField"></div><div class="practice-stage"><div class="practice-stage-row"><b>${st?'集団戦クエスト':'舞台：'+esc(practiceStage().name)}</b><button class="practice-mini" id="editOwnTeam">味方編成</button>${st?'':'<button class="practice-mini" id="editTeamStage">舞台</button><button class="practice-mini" id="editEnemyTeam">相手編成</button>'}</div><p class="practice-feature-line">特徴：${(st?st.features:practiceStage().features).map(esc).join('・')||'なし'}${st?`　／　目標：${esc(st.goal.text)}`:''}</p></div><div class="practice-feed" id="teamFeed" aria-live="polite"></div><div class="practice-actions"><button id="teamReroll">編成を<br>選び直す</button><button id="teamSpeed">実況：<br>${teamView.fast?'はやい':'ふつう'}</button><button id="teamSkip">結果まで<br>飛ばす</button><button class="go" id="teamGo">戦わせる</button></div></section>`;
  renderTeamField(initialTeamFighters());
  const back=()=>{practice.open=false;teamView.token++;document.body.classList.remove('practice-mode');quest?renderAdventure():show('adventure');};$('#teamBack').onclick=back;
  $('#teamViewToggle').onclick=e=>{teamView.expanded=!teamView.expanded;$('#teamBattle').classList.toggle('log-wide',teamView.expanded);e.currentTarget.textContent=teamView.expanded?'絵を大きく':'実況を広く';};
  $('#editOwnTeam').onclick=()=>{const body=openDialog(`<h2 style="margin:0 0 5px">味方チーム編成</h2><p class="muted small" style="margin:0">同じキャラは入れられません。近接型は前衛、遠距離・飛行型は後衛向きです。</p><div class="team-compose" id="battleTeamCompose"></div><button class="btn primary wide" id="battleTeamDone">決定</button>`);const draw=()=>{$('#battleTeamCompose').innerHTML=teamSelectedHtml();bindTeamComposer($('#battleTeamCompose'),draw);};draw();$('#battleTeamDone').onclick=()=>{closeDialog();renderTeamBattle(quest);};};
  if(!quest){$('#editEnemyTeam').onclick=openTeamEnemyEditor;$('#editTeamStage').onclick=openTeamStagePicker;$$('[data-battle-mode]').forEach(b=>b.onclick=()=>{const n=Number(b.dataset.battleMode);if(n===1){practice.mode=1;renderPracticeBattle();return;}prepareTeam(n,false);teamView.expanded=false;renderTeamBattle(false);});}
  $('#teamReroll').onclick=()=>$('#editOwnTeam').click();
  $('#teamSpeed').onclick=e=>{teamView.fast=!teamView.fast;e.currentTarget.innerHTML=`実況：<br>${teamView.fast?'はやい':'ふつう'}`;};$('#teamSkip').onclick=()=>teamView.skip=true;$('#teamGo').onclick=startTeamFight;
}

async function startTeamFight() {
  const st=teamView.quest&&TEAM_STAGES.find(x=>x.id===teamView.stageId),token=++teamView.token,feed=$('#teamFeed'),button=$('#teamGo');teamView.skip=false;teamView.running=true;teamView.expanded=true;$('#teamBattle').classList.add('log-wide');$('#teamViewToggle').textContent='絵を大きく';feed.innerHTML='';button.textContent='やり直す';button.classList.add('running');
  let res,ticket=null;
  try{
    if(st&&onlineWalletEnabled())ticket=await OnlineRanking.beginBattle(st.id,teamView.uids);
    res=st?app.server.teamQuestBattle(st.id,teamView.uids,teamView.rows):app.server.teamPracticeBattle(teamView.size,teamView.uids,teamView.rows,teamView.enemies,practiceStage());
    if(ticket){
      const settled=await OnlineRanking.finishBattle(ticket,res.quest.cleared,res.quest.goalDone);
      app.server.applyOnlineWallet(settled);
      res.quest={...res.quest,reward:Number(settled.reward||0),first:!!settled.first,goalFirst:!!settled.goal_first};
    }
  }catch(e){
    if(st&&onlineWalletEnabled()){try{app.server.applyOnlineWallet(await OnlineRanking.wallet());}catch(ignore){}}
    teamView.running=false;button.classList.remove('running');button.textContent='戦わせる';toast(e.message);return;
  }
  renderCoins(true);const names=res.fighters.map(x=>x.name),wait=ms=>new Promise(r=>setTimeout(r,teamView.skip?0:teamView.fast?ms/4:ms));let current=res.fighters.map(x=>({...x,hp:x.maxHp}));renderTeamField(current);
  for(const event of compressTeamLog(res.log)){if(token!==teamView.token||!practice.open)return;feed.insertAdjacentHTML('beforeend',practiceEventHtml(event,names));if(event.hp){current=current.map((f,i)=>({...f,hp:event.hp[i]}));renderTeamField(current);}if(!teamView.skip){feed.scrollTop=feed.scrollHeight;await wait(event.kind==='skill'||event.kind==='big'?900:event.kind==='sum'?700:500);}}
  if(token!==teamView.token||!practice.open)return;renderTeamField(res.fighters);const q=res.quest,won=res.winner===0;let extra='';if(q){extra=`<p><b>${q.reward?num(q.reward)+'コイン獲得':'報酬なし'}</b></p><div class="quest-result-goal">挑戦目標：${esc(st.goal.text)}<br><b class="${q.goalDone?'ok':'ng'}">${q.goalDone?'達成！':'未達成'}</b></div>`;}
  feed.insertAdjacentHTML('beforeend',`<div class="practice-result"><h2>${won?'勝利！':res.winner===1?'敗北…':'引き分け'}</h2><p>${esc(res.reason)}／${res.rounds}ラウンド</p>${extra}</div>`);feed.scrollTop=feed.scrollHeight;teamView.running=false;button.textContent='もう一度';button.classList.remove('running');
}

function selectedQuestIndividualHtml() {
  const ind = app.server.vault().find(i => i.uid === questView.ownUid);
  if (!ind) return '<span class="muted">個体が選ばれていません</span>';
  const c = app.charMap[ind.char_id];
  return `${art(c,{ind,size:48})}<span><strong>${esc(c.name)} ${starsHtml(ind.rarity)}</strong><small>パ ${num(ind.power)}　速 ${num(ind.speed)}　賢 ${num(ind.wisdom)}</small><small>${esc(equipmentSummary(ind))}</small></span>`;
}

function openQuestDetail(stageId) {
  const st = questStageById(stageId);
  if (!st) return;
  practice.open = false;
  document.body.classList.remove('practice-mode');
  questView.stageId = stageId;
  const vault = app.server.vault();
  if (!questView.ownUid || !vault.some(i => i.uid === questView.ownUid)) questView.ownUid = vault[0]?.uid || null;
  const farm = isFarmStage(stageId), enemy = farm ? null : app.charMap[st.boss];
  const enemyHtml = farm
    ? `<div class="art" style="width:86px;height:86px;display:grid;place-items:center;font-family:var(--dot);font-size:26px">？</div><span><h2>${esc(st.difficulty)}　${esc(st.name)}</h2><p>${st.grades.join('・')}級からランダム</p></span>`
    : `${art(enemy,{size:86})}<span><h2>${esc(st.name)}</h2><p>敵：${esc(enemy.name)}</p><p>${enemy.grade}級・覚悟${esc(RESOLVE_LABEL[enemy.resolve])}</p></span>`;
  const featureText = st.features.map(f => `<b>${esc(f)}</b>：${esc(STAGE_FEATURES[f].text)}`).join('<br>') || 'なし';
  const rest = farm ? farmRemaining(stageId) : 0;
  $('#main').innerHTML = `<section class="quest-detail"><div style="display:flex;gap:6px;margin-bottom:8px"><button class="btn" id="questDetailBack">← クエスト一覧</button><button class="btn" id="questBattleHelp">戦闘について</button></div><div class="quest-detail-hero">${enemyHtml}</div><div class="quest-info"><dl><dt>舞台の特徴</dt><dd>${featureText}</dd>${farm ? `<dt>敵</dt><dd>${st.grades.join('・')}級からランダム</dd>` : `<dt>敵の状態</dt><dd>${esc(st.enemyText || 'なし')}</dd>`}<dt>出来事</dt><dd>${esc(st.eventText || 'なし')}</dd><dt>挑戦目標</dt><dd>${esc(st.goal?.text || 'なし')}</dd><dt>報酬</dt><dd>${esc(questRewardText(st))}</dd>${farm ? '' : `<dt>攻略のヒント</dt><dd>${esc(STAGE_HINTS[st.boss])}${stageRecommendHtml(st.boss)}</dd>`}</dl></div><h3 class="sec">挑戦する個体</h3><div class="quest-selected" id="questSelected">${selectedQuestIndividualHtml()}<button class="btn" id="chooseQuestOwn">個体・装備を選ぶ</button></div>${equipmentGuideHtml()}<button class="btn danger wide" id="startQuest" ${questView.ownUid && !rest ? '' : 'disabled'}>${rest ? `あと${fmtTime(rest)}` : '挑戦する'}</button></section>`;
  $('#questDetailBack').onclick = renderAdventure;
  $('#questBattleHelp').onclick = openBattleHelp;
  $('#chooseQuestOwn').onclick = () => openQuestPicker();
  const recommend = $('[data-quest-recommend]');
  if (recommend) recommend.onclick = () => openQuestPicker('', newCombatFilter(recommend.dataset.questRecommend.split('|')));
  $('#startQuest').onclick = () => { renderQuestBattle(); startQuestFight(); };
}

function openQuestPicker(filter = '', combat = newCombatFilter(), view = null) {
  view=pickerView(view);
  const all = app.server.vault(), list = sortIndividuals(filterIndividuals(all, combat, filter),view.sort,view.dir);
  const redraw = () => openQuestPicker(filter, combat, view);
  const body = openDialog(`<h2 style="margin:0 0 8px">挑戦する個体を選ぶ</h2><label class="small">キャラで絞り込み <select id="questFilter"><option value="">すべて</option>${app.chars.map(c => `<option value="${c.id}" ${c.id===filter?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label>${individualSortHtml(view)}${combatFilterHtml(combat,list.length,all.length)}<div class="practice-pick-list"><ul class="rows">${list.map(ind => `<li class="relay-pick-card">${individualRowHtml(ind,{sort:view.sort,selected:ind.uid===questView.ownUid,attr:`data-quest-uid="${ind.uid}"`})}<div class="relay-pick-equip"><span>${esc(equipmentSummary(ind))}</span><button type="button" class="btn" data-quest-equip="${ind.uid}">装備を変更</button></div></li>`).join('') || '<li class="muted small combat-filter-empty">条件に合う個体がいません。<br>条件を外してみてください。</li>'}</ul></div>`);
  $('#questFilter').onchange = e => openQuestPicker(e.target.value, combat, view);
  bindIndividualSort(body,view,redraw);
  bindCombatFilter(body, combat, redraw);
  body.querySelectorAll('[data-quest-equip]').forEach(b => b.onclick = () => openSkillEquip(Number(b.dataset.questEquip), { back:redraw, done:redraw }));
  body.querySelectorAll('[data-quest-uid]').forEach(b => b.onclick = () => { questView.ownUid=Number(b.dataset.questUid); closeDialog(); openQuestDetail(questView.stageId); });
}

function questCorner(side, hp = null, maxHp = null) {
  const st = questStageById(questView.stageId), own = app.server.vault().find(i => i.uid === questView.ownUid);
  const c = side === 0 ? app.charMap[own.char_id] : app.charMap[questView.enemyId || st.boss];
  const ind = side === 0 ? own : (isFarmStage(st.id) ? st.enemyInd : ENEMY_IND[st.level]);
  const el = $(`#questCorner${side}`), grade=ZUKAN_GRADE_INFO[c.grade], pct=hp==null||!maxHp?100:Math.max(0,hp)/maxHp*100, src=slotSrc(c,'base');
  el.style.setProperty('--c',grade[1]);
  el.innerHTML=`<div class="practice-art">${src?`<img src="${esc(src)}" alt="${esc(c.name)}">`:placeholderSvg(c,ind,false,1,1)}</div><div class="practice-name">${esc(c.name)}</div><div class="practice-grade"><b>${c.grade}</b>${esc(grade[0])}・覚悟${esc(RESOLVE_LABEL[c.resolve])}</div><div class="practice-ind"><span>パ<b>${num(ind.power)}</b></span><span>速<b>${num(ind.speed)}</b></span><span>賢<b>${num(ind.wisdom)}</b></span></div><div class="practice-hpbar"><i class="${pct<=30?'low':''}" style="width:${pct}%"></i></div><div class="practice-hpnum">${hp==null?'':`HP ${Math.max(0,Math.round(hp))} / ${maxHp}`}</div>`;
}

function renderQuestBattle() {
  const st=questStageById(questView.stageId), own=app.server.vault().find(i=>i.uid===questView.ownUid);
  if (!st || !own) return;
  if (questView.running) { questView.token++; questView.running=false; }
  practice.open=true; document.body.classList.add('practice-mode');
  questView.enemyId=isFarmStage(st.id)?app.chars.find(c=>st.grades.includes(c.grade)).id:st.boss;
  $('#main').innerHTML=`<section class="practice-battle ${questView.expanded?'log-wide':''}" id="questBattle"><div class="practice-top"><button class="practice-mini practice-back" id="questListBack">← 一覧</button><h1>${esc(st.name)}</h1><button class="practice-mini battle-view-toggle" id="questViewToggle">${questView.expanded?'絵を大きく':'実況を広く'}</button></div><div class="practice-versus"><div class="practice-corner" id="questCorner0"></div><div class="practice-vs">VS</div><div class="practice-corner" id="questCorner1"></div></div><div class="practice-stage"><b>${esc(isFarmStage(st.id)?`周回・${st.difficulty}`:`段階${st.level}`)}</b><p class="practice-feature-line">特徴：${st.features.map(esc).join('・')||'なし'}　／　目標：${esc(st.goal?.text||'なし')}</p></div><div class="practice-feed" id="questFeed" aria-live="polite"></div><div class="practice-actions"><button id="questBattleList">一覧へ</button><button id="questSpeed">実況：<br>${questView.fast?'はやい':'ふつう'}</button><button id="questSkip">結果まで<br>飛ばす</button><button class="go" id="questGo">戦わせる</button></div></section>`;
  questCorner(0); questCorner(1);
  const back=()=>{ practice.open=false; questView.token++; document.body.classList.remove('practice-mode'); renderAdventure(); };
  $('#questListBack').onclick=back; $('#questBattleList').onclick=back;
  $('#questSpeed').onclick=e=>{questView.fast=!questView.fast;e.currentTarget.innerHTML=`実況：<br>${questView.fast?'はやい':'ふつう'}`;};
  $('#questViewToggle').onclick=e=>{questView.expanded=!questView.expanded;$('#questBattle').classList.toggle('log-wide',questView.expanded);e.currentTarget.textContent=questView.expanded?'絵を大きく':'実況を広く';};
  $('#questSkip').onclick=()=>{questView.skip=true;}; $('#questGo').onclick=startQuestFight;
}

async function startQuestFight() {
  const st=questStageById(questView.stageId), token=++questView.token;
  questView.skip=false; questView.running=true;
  questView.expanded=true; $('#questBattle').classList.add('log-wide'); $('#questViewToggle').textContent='絵を大きく';
  const feed=$('#questFeed'), button=$('#questGo'); feed.innerHTML=''; button.textContent='やり直す'; button.classList.add('running');
  let res,ticket=null;
  try {
    if(onlineWalletEnabled())ticket=await OnlineRanking.beginBattle(st.id,[questView.ownUid]);
    res=isFarmStage(st.id)?app.server.farmBattle(st.id,questView.ownUid):app.server.questBattle(st.id,questView.ownUid);
    if(ticket){
      const settled=await OnlineRanking.finishBattle(ticket,res.quest.cleared,res.quest.goalDone);
      app.server.applyOnlineWallet(settled);
      res.quest={...res.quest,reward:Number(settled.reward||0),first:!!settled.first,goalFirst:!!settled.goal_first,
        streak:Number(settled.streak||0),multiplier:st.id==='farm_2'?1+Number(settled.streak||0)*0.1:(res.quest.multiplier||1),
        proof:!!settled.first&&st.level===3};
    }
  }
  catch(e){
    if(onlineWalletEnabled()){try{app.server.applyOnlineWallet(await OnlineRanking.wallet());}catch(ignore){}}
    questView.running=false;button.textContent='戦わせる';button.classList.remove('running');toast(e.message);return;
  }
  tutorialEvent(isFarmStage(st.id) ? 'farm' : 'quest', !!res.quest.cleared);
  questView.enemyId=res.quest.enemyId; renderCoins(true); questCorner(0,res.A.maxHp,res.A.maxHp); questCorner(1,res.B.maxHp,res.B.maxHp);
  const names=[res.A.name,res.B.name], wait=ms=>new Promise(r=>setTimeout(r,questView.skip?0:questView.fast?ms/4:ms));
  for(const event of compressPracticeLog(res.log,names)){if(token!==questView.token||!practice.open)return;feed.insertAdjacentHTML('beforeend',practiceEventHtml(event,names));if(event.hpA!=null){questCorner(0,event.hpA,res.A.maxHp);questCorner(1,event.hpB,res.B.maxHp);}if(!questView.skip){feed.scrollTop=feed.scrollHeight;await wait(event.kind==='skill'||event.kind==='big'?900:event.kind==='sum'?700:500);}}
  if(token!==questView.token||!practice.open)return;
  questCorner(0,res.A.hp,res.A.maxHp);questCorner(1,res.B.hp,res.B.maxHp);
  const q=res.quest,winner=res.winner==null?null:names[res.winner];
  let reward=q.reward?`${num(q.reward)}コイン獲得${q.first?'（初回）':''}${q.goalFirst?'・目標初達成ボーナス込み':''}`:'報酬なし';
  if(st.id==='farm_2'&&q.cleared) reward+=`（${q.streak}連勝・${q.multiplier.toFixed(1)}倍）`;
  if(st.id==='farm_3'&&q.multiplier>1) reward+='（目標達成・1.5倍）';
  const goal=st.goal?`<div class="quest-result-goal">挑戦目標：${esc(st.goal.text)}<br><b class="${q.goalDone?'ok':'ng'}">${q.goalDone?'達成！':'未達成'}</b></div>`:'';
  feed.insertAdjacentHTML('beforeend',`<div class="practice-result"><h2>${q.cleared?'クリア！':'敗北…'}</h2><p>${winner?esc(winner)+'の勝ち':'引き分け'}／${esc(res.reason)}／${res.rounds}ラウンド</p><p><b>${esc(reward)}</b></p>${q.proof?'<p>🏆 撃破の証を獲得！</p>':''}${goal}<div class="quest-result-actions"><button id="questRetry">もう一度挑戦</button><button id="questResultList">クエスト一覧へ</button></div></div>`);
  feed.scrollTop=feed.scrollHeight;questView.running=false;button.textContent='もう一度';button.classList.remove('running');
  $('#questRetry').onclick=()=>startQuestFight(); $('#questResultList').onclick=()=>{practice.open=false;document.body.classList.remove('practice-mode');renderAdventure();};
}

function practiceStage() {
  const preset = PRACTICE_STAGES[practice.stageIndex];
  return { name: preset ? preset.name : 'オリジナルの舞台', features: practice.features.slice() };
}

function practiceCorner(side, hp = null, maxHp = null) {
  const own = app.server.vault().find(i => i.uid === practice.ownUid);
  const el = $(`#practiceCorner${side}`);
  if (side === 0 && !own) {
    el.innerHTML = `<div class="practice-art" style="display:grid;place-items:center"><span class="muted small">個体未選択</span></div><button class="practice-name" id="choosePracticeOwn">保管庫から選ぶ</button><div class="practice-grade">ガチャで仲間にした個体を使います</div>`;
    el.querySelector('#choosePracticeOwn').onclick = () => openPracticePicker();
    return;
  }
  const ind = side === 0 ? own : practice.enemyInd;
  const c = side === 0 ? (own && app.charMap[own.char_id]) : app.charMap[practice.enemyId];
  if (!el || !c) return;
  const grade = ZUKAN_GRADE_INFO[c.grade] || [c.grade, '#8E99A8'];
  const pct = hp == null || !maxHp ? 100 : Math.max(0, hp) / maxHp * 100;
  const src = slotSrc(c, 'base');
  el.style.setProperty('--c', grade[1]);
  const nameControl = side === 0
    ? `<button class="practice-name" id="choosePracticeOwn">${own ? esc(c.name) : '保管庫から選ぶ'}</button>`
    : `<select class="practice-name" id="practiceEnemy" aria-label="対戦相手">${app.chars.map(x => `<option value="${x.id}" ${x.id === c.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;
  el.innerHTML = `<div class="practice-art">${src ? `<img src="${esc(src)}" alt="${esc(c.name)}">` : placeholderSvg(c, ind, false, 1, 1)}</div>
    ${nameControl}
    <div class="practice-grade"><b>${c.grade}</b>${esc(grade[0])}・覚悟${esc(RESOLVE_LABEL[c.resolve])}</div>
    <div class="practice-ind"><span>パ<b>${num(ind.power)}</b></span><span>速<b>${num(ind.speed)}</b></span><span>賢<b>${num(ind.wisdom)}</b></span></div>
    <div class="practice-hpbar"><i class="${pct <= 30 ? 'low' : ''}" style="width:${pct}%"></i></div>
    <div class="practice-hpnum">${hp == null ? '' : `HP ${Math.max(0, Math.round(hp))} / ${maxHp}`}</div>`;
  const choose = el.querySelector('#choosePracticeOwn');
  if (choose) choose.onclick = () => openPracticePicker();
  const enemy = el.querySelector('#practiceEnemy');
  if (enemy) enemy.onchange = () => {
    practice.enemyId = enemy.value;
    practice.enemyInd = app.server.rollPracticeEnemy(practice.enemyId);
    practiceCorner(1);
  };
}

function openPracticePicker(filter = '', combat = newCombatFilter(), view = null) {
  view=pickerView(view);
  const all = app.server.vault();
  const list = sortIndividuals(filterIndividuals(all, combat, filter),view.sort,view.dir);
  const redraw = () => openPracticePicker(filter, combat, view);
  const body = openDialog(`<h2 style="margin:0 0 8px">戦う個体を選ぶ</h2>
    <label class="small">キャラで絞り込み
      <select id="practiceFilter"><option value="">すべて</option>${app.chars.map(c => `<option value="${c.id}" ${c.id === filter ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    </label>
    ${individualSortHtml(view)}${combatFilterHtml(combat,list.length,all.length)}
    <div class="practice-pick-list"><ul class="rows">${list.map(ind => {
      return `<li class="relay-pick-card">${individualRowHtml(ind,{sort:view.sort,selected:ind.uid===practice.ownUid,attr:`data-practice-uid="${ind.uid}"`})}<div class="relay-pick-equip"><span>${esc(equipmentSummary(ind))}</span><button type="button" class="btn" data-practice-equip="${ind.uid}">装備を変更</button></div></li>`;
    }).join('') || '<li class="muted small combat-filter-empty">条件に合う個体がいません。<br>条件を外してみてください。</li>'}</ul></div>`);
  body.querySelector('#practiceFilter').onchange = e => openPracticePicker(e.target.value, combat, view);
  bindIndividualSort(body,view,redraw);
  bindCombatFilter(body, combat, redraw);
  body.querySelectorAll('[data-practice-equip]').forEach(b => b.onclick = () => openSkillEquip(Number(b.dataset.practiceEquip), { back:redraw, done:redraw }));
  body.querySelectorAll('[data-practice-uid]').forEach(b => b.onclick = () => {
    practice.ownUid = Number(b.dataset.practiceUid);
    closeDialog();
    practiceCorner(0);
  });
}

function openPracticeFeatures(onDone = renderPracticeBattle) {
  const descriptions = () => practice.features.length
    ? practice.features.map(f => `<b>${esc(f)}</b>：${esc(STAGE_FEATURES[f].text)}`).join('<br>')
    : 'いまは特徴なし';
  const body = openDialog(`<h2 style="margin:0 0 4px">舞台の特徴</h2><p class="muted small" style="margin:0">押すと入れたり外したりできます。両者に効きます。</p>
    <div class="practice-features">${PRACTICE_FEATURES.map(f => `<button data-practice-feature="${f}" aria-pressed="${practice.features.includes(f)}">${f}</button>`).join('')}</div>
    <p class="small" id="practiceFeatureText">${descriptions()}</p><button class="btn primary wide" id="practiceFeatureDone">決定</button>`);
  body.querySelectorAll('[data-practice-feature]').forEach(b => b.onclick = () => {
    const f = b.dataset.practiceFeature;
    practice.features = practice.features.includes(f) ? practice.features.filter(x => x !== f) : practice.features.concat(f);
    practice.stageIndex = -1;
    b.setAttribute('aria-pressed', String(practice.features.includes(f)));
    body.querySelector('#practiceFeatureText').innerHTML = descriptions();
    const line = $('.practice-feature-line');
    if (line) line.textContent = `特徴：${practice.features.length ? practice.features.join('・') : 'なし'}`;
  });
  body.querySelector('#practiceFeatureDone').onclick = () => { practice.expanded=false; teamView.expanded=false; closeDialog(); onDone(); };
}

function practiceEventHtml(e, names) {
  let text = esc(e.text);
  names.forEach((name, i) => { text = text.split(esc(name)).join(`<b class="s${i}">${esc(name)}</b>`); });
  return `<p class="ev ${e.kind}">${text}${e.note ? `<span class="note">${esc(e.note)}</span>` : ''}</p>`;
}

function compressPracticeLog(log, names) {
  const out = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const rounds = [...new Set(buf.map(e => e.round))];
    if (rounds.length <= 1) out.push(...buf);
    else {
      const damage = [0, 0];
      buf.forEach(e => { if (e.dmg && e.side != null) damage[e.side] += e.dmg; });
      const last = buf[buf.length - 1];
      out.push({ kind:'sum', round:last.round, text:`ラウンド${rounds[0]}〜${rounds[rounds.length - 1]}：打ち合いが続く（${names[0]}が${damage[0]}、${names[1]}が${damage[1]}ダメージ）`, hpA:last.hpA, hpB:last.hpB });
    }
    buf = [];
  };
  log.forEach(e => {
    if (e.kind === 'round') return;
    if (e.kind === 'hit' || e.kind === 'miss') buf.push(e);
    else { flush(); out.push(e); }
  });
  flush();
  return out;
}

async function startPracticeFight() {
  const own = app.server.vault().find(i => i.uid === practice.ownUid);
  if (!own) { openPracticePicker(); return; }
  const myToken = ++practice.token;
  practice.skip = false;
  practice.running = true;
  practice.expanded = true;
  $('#practiceBattle').classList.add('log-wide');
  $('#practiceViewToggle').textContent = '絵を大きく';
  const feed = $('#practiceFeed');
  const button = $('#practiceGo');
  feed.innerHTML = '';
  button.textContent = 'やり直す';
  button.classList.add('running');
  let result;
  try {
    result = app.server.practiceBattle(practice.ownUid, practice.enemyId, practiceStage(), practice.enemyInd);
  } catch (e) {
    practice.running = false;
    toast(e.message);
    return;
  }
  const names = [result.A.name, result.B.name];
  practiceCorner(0, result.A.maxHp, result.A.maxHp);
  practiceCorner(1, result.B.maxHp, result.B.maxHp);
  const wait = ms => new Promise(resolve => setTimeout(resolve, practice.skip ? 0 : practice.fast ? ms / 4 : ms));
  for (const event of compressPracticeLog(result.log, names)) {
    if (myToken !== practice.token || !practice.open) return;
    feed.insertAdjacentHTML('beforeend', practiceEventHtml(event, names));
    if (event.hpA != null) {
      practiceCorner(0, event.hpA, result.A.maxHp);
      practiceCorner(1, event.hpB, result.B.maxHp);
    }
    if (!practice.skip) {
      feed.scrollTop = feed.scrollHeight;
      await wait(event.kind === 'skill' || event.kind === 'big' ? 900 : event.kind === 'sum' ? 700 : 500);
    }
  }
  if (myToken !== practice.token || !practice.open) return;
  practiceCorner(0, result.A.hp, result.A.maxHp);
  practiceCorner(1, result.B.hp, result.B.maxHp);
  const winner = result.winner == null ? null : names[result.winner];
  feed.insertAdjacentHTML('beforeend', `<div class="practice-result"><h2>${winner ? `${esc(winner)}の勝ち` : '引き分け'}</h2><p>${esc(result.reason)}／${result.rounds}ラウンド</p></div>`);
  feed.scrollTop = feed.scrollHeight;
  practice.running = false;
  button.textContent = 'もう一度';
  button.classList.remove('running');
}

function renderPracticeBattle() {
  if (practice.running) { practice.token++; practice.running = false; }
  practice.open = true;
  document.body.classList.add('practice-mode');
  const presetOptions = PRACTICE_STAGES.map((s, i) => `<option value="${i}" ${i === practice.stageIndex ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  $('#main').innerHTML = `<section class="practice-battle ${practice.expanded?'log-wide':''}" id="practiceBattle">
    <div class="practice-top"><button class="practice-mini practice-back" id="practiceBack">← 冒険</button><h1>対戦（練習試合）</h1><button class="practice-mini battle-view-toggle" id="practiceViewToggle">${practice.expanded?'絵を大きく':'実況を広く'}</button></div>
    <div class="battle-mode-switch">${[1,2,3].map(n=>`<button data-battle-mode="${n}" class="${n===1?'active':''}">${n}対${n}</button>`).join('')}</div>
    <div class="practice-versus"><div class="practice-corner" id="practiceCorner0"></div><div class="practice-vs">VS</div><div class="practice-corner" id="practiceCorner1"></div></div>
    <div class="practice-stage"><div class="practice-stage-row"><label for="practiceStage">舞台</label><select id="practiceStage">${presetOptions}<option value="custom" ${practice.stageIndex < 0 ? 'selected' : ''}>オリジナルの舞台</option></select><button class="practice-mini" id="practiceFeatures">特徴</button><button class="practice-mini" id="practiceBattleHelp" aria-label="戦闘について">？</button></div><p class="practice-feature-line">特徴：${practice.features.length ? practice.features.map(esc).join('・') : 'なし'}</p></div>
    <div class="practice-feed" id="practiceFeed" aria-live="polite"></div>
    <div class="practice-actions"><button id="practiceReroll">相手を<br>引き直す</button><button id="practiceSpeed">実況：<br>${practice.fast ? 'はやい' : 'ふつう'}</button><button id="practiceSkip">結果まで<br>飛ばす</button><button class="go" id="practiceGo">戦わせる</button></div>
  </section>`;
  practiceCorner(0);
  practiceCorner(1);
  $('#practiceBack').onclick = () => show('adventure');
  $('#practiceViewToggle').onclick = e => { practice.expanded=!practice.expanded; $('#practiceBattle').classList.toggle('log-wide',practice.expanded); e.currentTarget.textContent=practice.expanded?'絵を大きく':'実況を広く'; };
  $$('[data-battle-mode]').forEach(b=>b.onclick=()=>{const n=Number(b.dataset.battleMode);if(n===1)return;practice.mode=n;prepareTeam(n,false);teamView.expanded=false;renderTeamBattle(false);});
  $('#practiceFeatures').onclick = () => openPracticeFeatures();
  $('#practiceBattleHelp').onclick = openBattleHelp;
  $('#practiceStage').onchange = e => {
    if (e.target.value === 'custom') { practice.stageIndex = -1; practice.expanded=false; $('#practiceBattle').classList.remove('log-wide'); $('#practiceViewToggle').textContent='実況を広く'; return; }
    practice.stageIndex = Number(e.target.value);
    practice.features = PRACTICE_STAGES[practice.stageIndex].features.slice();
    practice.expanded = false;
    renderPracticeBattle();
  };
  $('#practiceReroll').onclick = () => { practice.enemyInd = app.server.rollPracticeEnemy(practice.enemyId); practiceCorner(1); };
  $('#practiceSpeed').onclick = e => { practice.fast = !practice.fast; e.currentTarget.innerHTML = `実況：<br>${practice.fast ? 'はやい' : 'ふつう'}`; };
  $('#practiceSkip').onclick = () => { practice.skip = true; };
  $('#practiceGo').onclick = startPracticeFight;
}

function openPracticeBattle(enemyCharId = '') {
  const vault = app.server.vault();
  if (!practice.ownUid || !vault.some(i => i.uid === practice.ownUid)) practice.ownUid = vault[0] ? vault[0].uid : null;
  if (enemyCharId && app.charMap[enemyCharId]) practice.enemyId = enemyCharId;
  if (!app.charMap[practice.enemyId]) practice.enemyId = app.chars[0].id;
  practice.enemyInd = app.server.rollPracticeEnemy(practice.enemyId);
  practice.stageIndex = 0;
  practice.features = [];
  practice.mode = 1;
  practice.expanded = false;
  app.tab = 'adventure';
  renderPracticeBattle();
  if (!practice.ownUid) toast('先にガチャで個体を仲間にしてください');
}

// 冒険の中を「日課・探索」と「クエスト」に分ける。
function renderAdventure() {
  const main = $('#main');
  const tabs = `<nav class="adventure-switch" aria-label="冒険メニュー"><button data-adventure-view="home" class="${adventureView==='home'?'active':''}">日課・探索</button><button data-adventure-view="quests" class="${adventureView==='quests'?'active':''}">クエスト</button></nav>`;
  if (adventureView === 'quests') {
    main.innerHTML = `${tabs}<section id="questArea">${questSectionsHtml()}</section>`;
    bindQuestSections($('#questArea'));
  } else {
    main.innerHTML = `${tabs}<section class="panel practice-entry"><h2>対戦（練習試合）</h2><p class="muted small" style="margin:0 0 8px">保管庫の個体を選び、10体のキャラや好きな舞台と戦えます。報酬はありません。</p><button class="btn primary wide" id="openPractice">練習試合を始める</button></section><div id="dailyArea"></div>`;
    $('#openPractice').onclick = () => openPracticeBattle();
    renderDaily($('#dailyArea'));
  }
  $$('[data-adventure-view]').forEach(button => button.onclick = () => {
    adventureView = button.dataset.adventureView;
    renderAdventure();
  });
}

// ---------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------
async function boot() {
  $('#dlg').addEventListener('click', e => { if (e.target.id === 'dlg' || e.target.classList.contains('dlg-close')) closeDialog(); });
  $$('nav.tabs button').forEach(b => { b.onclick = () => show(b.dataset.tab); });
  $('#settingsBtn').onclick = () => app.server && openSettings();
  try {
    await ImageStore.open();
    // 修正前の「データを消す」で残った空の保存データも、新規開始として復旧する。
    const beforeBoot = store.get(SAVE_KEY);
    const emptyReset = beforeBoot && !beforeBoot.tutorial && !(beforeBoot.mine || []).length
      && !Object.keys(beforeBoot.zukan || {}).length && Number(beforeBoot.nextUid || 1) <= 1;
    if (emptyReset && typeof OnlineRanking !== 'undefined' && OnlineRanking.configured()) OnlineRanking.resetSession();
    app.server = new GameServer();
    app.server.init();
    app.chars = app.server.characters;
    app.charMap = app.server.charMap;
    let loginInfo = null;
    if (onlineWalletEnabled()) {
      app.server.applyOnlineWallet(await OnlineRanking.wallet());
      const daily = await OnlineRanking.daily();
      app.server.applyOnlineWallet(daily);
      if (daily.claimed) loginInfo = daily;
    } else {
      loginInfo = app.server.dailyLogin();
    }
    renderCoins();
    show('gacha');
    showLoginBonus(loginInfo);
    setInterval(tick, 1000);
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible' || !app.server) return;
      try {
        const info = onlineWalletEnabled() ? await OnlineRanking.daily() : app.server.dailyLogin();
        if (onlineWalletEnabled()) app.server.applyOnlineWallet(info);
        if (info && info.claimed !== false) showLoginBonus(info);
      } catch (e) { toast(e.message || 'オンライン残高を更新できませんでした'); }
      if (!$('.show') && !practice.open) render();
    });
  } catch (e) {
    $('#main').innerHTML = `<p class="error">起動できませんでした：${esc(e.message)}</p>`;
  }
}

if (typeof document !== 'undefined' && document.getElementById('main')) boot();
