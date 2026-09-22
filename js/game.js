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

// 画像を最大512pxに縮めて保存用の文字列にする
function resizeImage(file, max = 512) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('画像を読み込めませんでした'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('この形式の画像は使えません'));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

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
    this._migrate();
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
      mine: [], zukan: {}, extraCounters: {}, nextUid: 1, hall: null
    };
    return base;
  }

  _migrate() {
    const s = this.s;
    s.bests = s.bests || {};
    s.titleBook = s.titleBook || {};
    s.claimed = s.claimed || {};
    s.login = s.login || { last: '', streak: 0 };
    s.missions = s.missions || { date: '', progress: {}, claimed: {} };
    s.expeditions = s.expeditions || [];
    s.settings = Object.assign({ sound: true, effects: 'full' }, s.settings || {});
    s.dayOffset = s.dayOffset || 0;
    s.expSeq = s.expSeq || 1;
    for (const ind of s.mine) {
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
  pull(n) {
    const cost = PULL_COST[n];
    if (!cost) throw new Error('引ける回数は1回か10回です');
    const p = this.s.player;
    if (p.coins < cost) throw new Error(`コインが足りません（あと${cost - p.coins}コイン）`);
    if (this.s.mine.length + n > p.vault_cap) throw new Error('保管庫がいっぱいです。個体を送り出してから引いてください');
    p.coins -= cost;

    const rarities = Array.from({ length: n }, () => rollRarity(Math.random));
    if (n === 10 && Math.max(...rarities) < 3) rarities[9] = rollRarity(Math.random, 3); // 10回で★3以上1体確定

    const results = rarities.map(rarity => {
      const c = pickWith(Math.random, CHARACTERS);
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
      a: { ch: this.charMap[own.char_id], ind: own },
      b: { ch: enemy, ind: enemyInd || this.rollPracticeEnemy(enemyCharId) },
      stage: stage || { name: '無名の荒野（特徴なし）', features: [] }
    });
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

  release(uids) {
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
    this.s.player.coins += gained;
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

  // テスト用
  debugAddCoins(n) { this.s.player.coins += n; this._save(); return this.s.player.coins; }
  debugFinishExpeditions() { const now = this.now(); this.s.expeditions.forEach(e => { e.end = Math.min(e.end, now); }); this._save(); }
  debugNextDay() { this.s.dayOffset += 1; this._save(); }
  reset() { store.del(SAVE_KEY); store.del(OLD_SAVE_KEY); }
}


const app = {
  server: null, chars: [], charMap: {}, tab: 'gacha', lastResults: [],
  selectMode: false, selected: new Set(),
  vf: { charId: '', rarity: '', titled: false, sort: 'new' },
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
const practice = { open:false, ownUid:null, enemyId:'chr_002', enemyInd:null, stageIndex:0, features:[], token:0, fast:false, skip:false, running:false };

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
  const rateRows = RATES.map(([r, p]) => `<tr><td>${starsHtml(r)}</td><td class="num">${p}%</td><td class="num">${RELEASE_COINS[r]}</td></tr>`).join('');
  const ratioRows = RATIO_MILESTONES.map(r => `<tr><td>${r}倍 ／ ${r === 1.5 ? '3分の2' : `${r}分の1`}${r === 100 ? '（上限）' : ''}</td><td class="num">約 1 / ${oddsText(1 / ratioChance(r))}</td></tr>`).join('');
  const powerRows = POWER_MILESTONES.map(v => `<tr><td>${v === POWER_RULE.max ? `上限 ${num(v)}` : `${num(v)} 以上`}</td><td class="num">約 1 / ${oddsText(1 / powerChance(v))}</td></tr>`).join('');
  const last = app.lastResults;
  $('#main').innerHTML = `
    <div class="machine">${machineSvg()}</div>
    <div class="pull-row">
      <button class="pull" data-n="1">1回引く<span>100コイン</span></button>
      <button class="pull pull-10" data-n="10">10回引く<span>1000コイン</span></button>
    </div>
    <p class="guarantee">10回引くと★3以上が1体確定</p>
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
  $$('.pull').forEach(b => { b.onclick = () => doPull(Number(b.dataset.n)); });
  $$('#main .card').forEach(el => { el.onclick = () => openDetail(Number(el.dataset.uid)); });
}

async function doPull(n) {
  if (app.busy) return;
  Sound.click();
  let data;
  try { data = app.server.pull(n); } catch (e) { toast(e.message); return; }
  app.busy = true;
  renderCoins();
  app.lastResults = data.results;
  updateBadges();
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
      inner.querySelector('[data-act="again"]').onclick = () => { close(); setTimeout(() => doPull(n), 30); };

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
  if (claim) claim.onclick = () => { const r = app.server.claimStampRewards(); gained(r.gained, '図鑑報酬'); renderZukan(); };
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
const COMBAT_STAT_LABEL = { atk:'攻撃', def:'防御', wis:'賢さ', spd:'素早さ', sta:'持久力', amb:'野望力' };

function combatPanelHtml(c) {
  const data = COMBATS[c.id] || { type:'読み込み中', sections:[] };
  const bars = Object.entries(c.stats).map(([key,value]) => `<div class="combat-stat"><span>${COMBAT_STAT_LABEL[key]}</span><div><i style="width:${value}%"></i></div><b>${value}</b></div>`).join('');
  const sections = data.sections.map(([heading,text], index) => `<details class="story" ${index === 0 ? 'open' : ''}><summary><span class="story-label">${esc(heading)}</span><span class="story-preview">${esc(String(text).split('\n')[0])}</span><span class="story-more">続きを読む</span><span class="story-less">たたむ</span></summary><div class="story-body">${zukanStoryTextHtml(text)}</div></details>`).join('');
  return `<span class="combat-type">${esc(data.type)}</span><div class="combat-stats">${bars}</div><div class="combat-labels"><b>覚悟：${RESOLVE_LABEL[c.resolve]}</b>${c.tags.map(tag => `<em>${esc(tag)}</em>`).join('')}</div>${sections}<button class="btn primary wide" data-practice-char="${c.id}" style="margin-top:12px">このキャラと練習試合をする</button>`;
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
  const records = RECORD_SPECS.map(([stat,dir]) => { const r=hallMap[`${stat}:${dir}`]; return `<div class="zukan-fact"><dt>${STAT_LABEL[stat]}（${dirLabel(stat,dir)}）</dt><dd>${r ? `<b>${fmtValue(stat,r.value)}</b><small>${esc(r.owner_name)}</small>` : '—'}</dd></div>`; }).join('');
  const grade = ZUKAN_GRADE_INFO[c.grade];
  const body = openDialog(`<div class="zukan-page" style="--zukan-el:${grade[1]}">
    <header class="zukan-hero"><div class="zukan-art-stage"><span class="zukan-no">No.${String(idx).padStart(3,'0')}</span><div class="zukan-hero-media">${zukanHeroMediaHtml(c,'base','通常')}</div></div>
    <div class="zukan-identity"><h2>${esc(c.name)}</h2><p>${esc(c.title)}</p><div><strong class="grade" style="--grade:${grade[1]}">${c.grade}級・${grade[0]}${c.category === 'マッチ守護者' ? '（守護者）' : ''}</strong><em>${esc(c.category)}</em>${c.kind ? `<em>${esc(c.kind)}</em>` : ''}</div></div></header>
    <div class="zukan-page-tabs" role="tablist">${[['basic','基本'],['story','物語'],['combat','戦闘能力'],['records','記録']].map(([k,l],i)=>`<button data-zukan-tab="${k}" aria-selected="${i===0}">${l}</button>`).join('')}</div>
    <div class="zukan-panels"><section class="zukan-panel" data-zukan-panel="basic"><dl class="zukan-facts">${basicFacts.map(([l,v])=>`<div class="zukan-fact"><dt>${l}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>${ability ? `<h3 class="zukan-panel-title">マッチアビリティ</h3>${zukanStoryPairsHtml([ability])}` : ''}</section>
    <section class="zukan-panel" data-zukan-panel="story" hidden><div class="story-tools"><button class="btn" id="openAllStories">すべて開く</button><button class="btn" id="closeAllStories">すべてたたむ</button></div>${[1,2,3,4,5].map(r=>zukanStorySectionHtml(c,g,r)).join('')}</section>
    <section class="zukan-panel" data-zukan-panel="combat" hidden>${combatPanelHtml(c)}</section>
    <section class="zukan-panel" data-zukan-panel="records" hidden><h3 class="zukan-panel-title">見つけた称号 ${found.length} / ${TITLES.length}</h3><div class="title-list">${titleTags}</div><h3 class="zukan-panel-title">世界記録</h3><dl class="zukan-facts zukan-records">${records}</dl><button class="btn primary wide" id="seeMine" ${mineCount?'':'disabled'}>保管庫のこのキャラを見る（${mineCount}体）</button></section></div></div>`, 'zukan');
  const page = body.querySelector('.zukan-page');
  const panels = [...body.querySelectorAll('[data-zukan-panel]')];
  const updateCompact = panel => page.classList.toggle('is-compact', panel.scrollTop > 12);
  panels.forEach(panel => panel.addEventListener('scroll', () => updateCompact(panel), { passive:true }));
  body.querySelectorAll('[data-zukan-tab]').forEach(b => b.onclick=()=>{ body.querySelectorAll('[data-zukan-tab]').forEach(x=>x.setAttribute('aria-selected',String(x===b))); panels.forEach(x=>x.hidden=x.dataset.zukanPanel!==b.dataset.zukanTab); updateCompact(panels.find(x=>!x.hidden)); });
  const storyPanel=body.querySelector('[data-zukan-panel="story"]');
  body.querySelector('#openAllStories').onclick=()=>storyPanel.querySelectorAll('details.story').forEach(x=>{x.open=true;});
  body.querySelector('#closeAllStories').onclick=()=>storyPanel.querySelectorAll('details.story').forEach(x=>{x.open=false;});
  const mine=body.querySelector('#seeMine'); if(mine) mine.onclick=()=>{ app.vf={...app.vf,charId,rarity:'',titled:false}; closeDialog(); show('vault'); };
  const fight=body.querySelector('[data-practice-char]'); if(fight) fight.onclick=()=>{ closeDialog(); openPracticeBattle(fight.dataset.practiceChar); };
}

// ---------------------------------------------------------------------
// 保管庫
// ---------------------------------------------------------------------
const VAULT_SORTS = {
  new: ['新しい順', (a, b) => b.uid - a.uid],
  rarity: ['レアリティ', (a, b) => b.rarity - a.rarity || b.uid - a.uid],
  power: ['パワー', (a, b) => b.power - a.power],
  total_score: ['総合', (a, b) => b.total_score - a.total_score],
  weight: ['体重のズレ', (a, b) => Math.abs(b.weight_dev) - Math.abs(a.weight_dev)],
  shine: ['かがやき', (a, b) => b.shine - a.shine],
  titles: ['称号の数', (a, b) => (b.titles || []).length - (a.titles || []).length || b.uid - a.uid]
};

function protectedReason(ind, away, holders) {
  if (ind.locked) return 'ロック中';
  if (away.has(ind.uid)) return '探索中';
  if (ind.special) return '特異個体';
  if (holders.has(ind.uid)) return '世界記録';
  if (ind.titles && ind.titles.length) return '称号つき';
  return '';
}

function renderVault() {
  const main = $('#main');
  const all = app.server.vault();
  const away = app.server.dispatchedUids();
  const holders = app.server.recordHolderUids();
  const vf = app.vf;
  const list = all
    .filter(i => (!vf.charId || i.char_id === vf.charId) && (!vf.rarity || i.rarity === Number(vf.rarity)) && (!vf.titled || (i.titles && i.titles.length)))
    .sort(VAULT_SORTS[vf.sort][1]);
  const seen = zukanSummary();

  const charOpts = `<option value="">全キャラ</option>` + app.chars.filter(c => seen[c.id]).map(c => `<option value="${c.id}" ${c.id === vf.charId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const rarOpts = `<option value="">全レア</option>` + [5, 4, 3, 2, 1].map(r => `<option value="${r}" ${String(r) === String(vf.rarity) ? 'selected' : ''}>★${r}</option>`).join('');
  const sortOpts = Object.entries(VAULT_SORTS).map(([k, [label]]) => `<option value="${k}" ${k === vf.sort ? 'selected' : ''}>${label}</option>`).join('');

  main.innerHTML = `
    <div class="toolbar">
      <span class="count">${all.length} / ${app.server.player().vault_cap}</span>
      <button class="btn ${app.selectMode ? 'primary' : ''}" id="vselect" ${all.length ? '' : 'disabled'}>${app.selectMode ? '選ぶのをやめる' : '選んで送り出す'}</button>
    </div>
    <div class="filter-row">
      <select id="fChar" aria-label="キャラ">${charOpts}</select>
      <select id="fRar" aria-label="レアリティ">${rarOpts}</select>
      <select id="fSort" aria-label="並び順">${sortOpts}</select>
      <label class="check"><input type="checkbox" id="fTitled" ${vf.titled ? 'checked' : ''}>称号つきの個体だけ表示</label>
    </div>
    ${app.selectMode ? `<div class="bulk">
      <button class="btn" data-bulk="1">★1をまとめて選ぶ</button>
      <button class="btn" data-bulk="2">★2以下をまとめて選ぶ</button>
      <button class="btn" data-bulk="0">選択を解除</button>
    </div><p class="muted small" style="margin:-4px 0 10px">まとめて選ぶときは、ロック中・探索中・特異個体・世界記録・称号つきの個体を除きます。</p>` : ''}
    ${list.length ? `<ul class="rows">${list.map(ind => {
      const c = app.charMap[ind.char_id];
      const sel = app.selected.has(ind.uid);
      const blocked = ind.locked || away.has(ind.uid);
      const tags = [
        away.has(ind.uid) ? '<em class="tag exp">探索中</em>' : '',
        ind.locked ? '<em class="tag">ロック</em>' : '',
        ind.special ? '<em class="tag sp">特異</em>' : '',
        holders.has(ind.uid) ? '<em class="tag rec">世界記録</em>' : '',
        ...(ind.titles || []).slice(0, 2).map(t => `<em class="tag title">${esc(titleName(t))}</em>`)
      ].join('');
      return `<li><button class="row ${sel ? 'selected' : ''} ${app.selectMode && blocked ? 'dim' : ''}" data-uid="${ind.uid}" ${app.selectMode ? `aria-pressed="${sel}"` : ''}>
        ${art(c, { ind, size: 48 })}
        <span><span class="rt">${esc(c.name)} ${starsHtml(ind.rarity)}</span><br>
          <span class="rs">#${pad6(ind.serial)} ${esc(ind.nature)} ${Number(ind.weight).toFixed(1)}kg</span>
          ${tags ? `<span class="tags" style="justify-content:flex-start">${tags}</span>` : ''}</span>
        <span class="rv">${num(ind.power)}<small>パワー</small></span>
      </button></li>`;
    }).join('')}</ul>` : `<p class="muted">${all.length ? 'この条件の個体はいません。' : '保管庫は空です。ガチャを引くと、ここに個体が入ります。'}</p>`}`;

  $('#fChar').onchange = e => { vf.charId = e.target.value; renderVault(); };
  $('#fRar').onchange = e => { vf.rarity = e.target.value; renderVault(); };
  $('#fSort').onchange = e => { vf.sort = e.target.value; renderVault(); };
  $('#fTitled').onchange = e => { vf.titled = e.target.checked; renderVault(); };
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
  const notes = [];
  if (w.special) notes.push(`特異個体 ${w.special}体`);
  if (w.record) notes.push(`世界記録を持つ個体 ${w.record}体`);
  if (w.titled) notes.push(`称号つき ${w.titled}体`);
  if (w.high) notes.push(`★4以上 ${w.high}体`);
  return notes.length ? `\n\n次の個体が含まれています：\n・${notes.join('\n・')}` : '';
}

function renderReleaseBar(all) {
  let bar = $('.release-bar');
  document.body.classList.toggle('selecting', app.selectMode);
  if (!app.selectMode) { if (bar) bar.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.className = 'release-bar'; document.body.appendChild(bar); }
  const picked = all.filter(i => app.selected.has(i.uid));
  const gain = picked.reduce((s, i) => s + RELEASE_COINS[i.rarity] * (i.special ? 5 : 1), 0);
  bar.innerHTML = `<div class="inner"><span>${picked.length}体選択中（+${num(gain)}コイン）</span><button class="btn danger" ${picked.length ? '' : 'disabled'}>送り出す</button></div>`;
  bar.querySelector('button').onclick = async () => {
    const uids = picked.map(i => i.uid);
    if (!await askConfirm(`${picked.length}体を送り出して、${num(gain)}コインを受け取ります。送り出した個体は戻せません。${releaseConfirmText(uids)}`, '送り出す')) return;
    try {
      const r = app.server.release(uids);
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
    b.onclick = () => { try { const r = app.server.claimMission(b.dataset.mission); gained(r.gained, 'ミッション'); renderAdventure(); } catch (e) { toast(e.message); } };
  });
  $$('[data-claim]').forEach(b => {
    b.onclick = () => {
      try {
        const r = app.server.claimExpedition(Number(b.dataset.claim));
        gained(r.gained, r.great ? '大成功！' : '探索');
        if (r.great) vibrate(60);
        renderAdventure();
      } catch (e) { toast(e.message); }
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
  body.querySelector('#goExp').onclick = () => {
    try {
      app.server.startExpedition(state.dest, state.picked);
      closeDialog();
      toast('探索に出発しました');
      if (app.tab === 'adventure') renderAdventure();
    } catch (e) { toast(e.message); }
  };
}

function tick() {
  if (!app.server) return;
  if (app.tab === 'adventure' && !practice.open) {
    const now = app.server.now();
    const doneNow = app.server.expeditions().filter(e => e.done).length;
    $$('[data-end]').forEach(el => { el.textContent = fmtTime(Math.max(0, Number(el.dataset.end) - now)); });
    if (doneNow !== app.renderedDone && !$('#dlg').open) renderAdventure();
  }
  if (Math.floor(Date.now() / 1000) % 15 === 0) updateBadges();
}

// ---------------------------------------------------------------------
// ランキング
// ---------------------------------------------------------------------
function renderRanking() {
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
  const rows = app.server.ranking({ stat: rk.stat, dir: rk.dir, charId: rk.charId, nature: def.needsNature ? rk.nature : null });

  main.innerHTML = `
    <div class="filters">
      <label>キャラ<select id="rkChar">${charOpts}</select></label>
      <label>項目<select id="rkStat">${statOpts}</select></label>
      <label>並び<select id="rkDir" ${def.dirs.length < 2 ? 'disabled' : ''}>${dirOpts}</select></label>
      ${def.needsNature ? `<label>性格<select id="rkNature">${natureOpts}</select></label>` : ''}
    </div>
    ${rows.length ? `<ul class="rows">${rows.map(r => {
      const c = app.charMap[r.char_id];
      return `<li><button class="row rank-row ${r.is_mine ? 'mine' : ''}" data-uid="${r.uid}">
        <span class="rank-no">${r.rank}</span>
        ${art(c, { rarity: r.rarity, size: 40 })}
        <span><span class="rt">${esc(c.name)} ${starsHtml(r.rarity)}${r.special ? ' ✦' : ''}</span><br><span class="rs">${esc(r.owner_name)}${r.is_mine ? '（あなた）' : ''}</span></span>
        <span class="rv">${fmtValue(rk.stat, r.value)}</span>
      </button></li>`;
    }).join('')}</ul>` : '<p class="muted">まだこの条件の個体がいません。</p>'}`;

  $('#rkChar').onchange = e => { rk.charId = e.target.value; renderRanking(); };
  $('#rkStat').onchange = e => { rk.stat = e.target.value; renderRanking(); };
  $('#rkDir').onchange = e => { rk.dir = e.target.value; renderRanking(); };
  if ($('#rkNature')) $('#rkNature').onchange = e => { rk.nature = e.target.value; renderRanking(); };
  $$('#main .row').forEach(el => { el.onclick = () => openDetail(Number(el.dataset.uid)); });
}

// ---------------------------------------------------------------------
// 個体票
// ---------------------------------------------------------------------
function openDetail(uid) {
  let ind;
  try { ind = app.server.individual(uid, true); } catch (e) { toast(e.message); return; }
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
  const releaseCoins = RELEASE_COINS[ind.rarity] * (ind.special ? 5 : 1);

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
      <button class="btn" id="dLock">${ind.locked ? 'ロックを外す' : 'ロックする'}</button>
      <button class="btn danger" id="dRelease" ${ind.locked || ind.dispatched ? 'disabled' : ''}>送り出す（+${num(releaseCoins)}）</button>
    </div>` : ''}`);

  if (mine) {
    body.querySelector('#dLock').onclick = () => {
      try { app.server.toggleLock(uid); openDetail(uid); if (app.tab === 'vault') renderVault(); } catch (e) { toast(e.message); }
    };
    body.querySelector('#dRelease').onclick = async () => {
      if (!await askConfirm(`${c.name} #${pad6(ind.serial)} を送り出して、${num(releaseCoins)}コインを受け取ります。送り出した個体は戻せません。${releaseConfirmText([uid])}`, '送り出す')) return;
      try {
        const r = app.server.release([uid]);
        closeDialog();
        app.lastResults = app.lastResults.filter(x => x.uid !== uid);
        gained(r.gained, '送り出しました');
        if (app.tab !== 'gacha' || !$('.show')) render();
      } catch (e) { toast(e.message); }
    };
  }
  updateBadges();
}

// ---------------------------------------------------------------------
// 設定・画像登録
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
    <div class="setting-row"><span>キャラ画像</span><button class="btn" id="sImages">登録する</button></div>
    <h3 style="font-size:14px;margin:16px 0 4px">テスト用</h3>
    <p class="muted small" style="margin:0 0 6px">デモで動きを確かめるための機能です。本番版にはありません。</p>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      <button class="btn" id="dbgCoins">+1000コイン</button>
      <button class="btn" id="dbgExp">探索を今すぐ終える</button>
      <button class="btn" id="dbgDay">次の日にする</button>
      <button class="btn danger" id="dbgReset">データを消す</button>
    </div>`);
  body.querySelector('#nameSave').onclick = () => {
    try { app.server.setName(body.querySelector('#nameInput').value); toast('名前を変更しました'); } catch (e) { toast(e.message); }
  };
  body.querySelector('#sSound').onchange = e => { app.server.setSetting('sound', e.target.checked); if (e.target.checked) Sound.coin(); };
  body.querySelector('#sFx').onchange = e => app.server.setSetting('effects', e.target.value);
  body.querySelector('#sImages').onclick = () => openImageManager();
  body.querySelector('#dbgCoins').onclick = () => { app.server.debugAddCoins(1000); gained(1000, 'テスト'); };
  body.querySelector('#dbgExp').onclick = () => { app.server.debugFinishExpeditions(); toast('探索を終わらせました'); render(); };
  body.querySelector('#dbgDay').onclick = () => {
    app.server.debugNextDay();
    closeDialog();
    render();
    showLoginBonus(app.server.dailyLogin());
  };
  body.querySelector('#dbgReset').onclick = async () => {
    if (!await askConfirm('デモのデータをすべて消します。登録した画像は残ります。', '消す')) return;
    app.server.reset();
    location.reload();
  };
}

function openImageManager(charId = app.chars[0].id) {
  const c = app.charMap[charId];
  const slots = [['base', '通常（★1〜）'], ['r4', '別ポーズ（★4）'], ['r5', '特別（★5）']];
  const body = openDialog(`
    <h2 style="margin:0 0 6px">キャラ画像の登録</h2>
    <p class="muted small" style="margin:0 0 8px">背景が透明なPNGがおすすめです。正方形に近い画像がきれいに収まります。画像はこの端末の中だけに保存されます。${ImageStore.db ? '' : '<br><b>この環境では画像を保存できないため、ページを閉じると消えます。</b>'}</p>
    <select id="imgChar" style="width:100%">${app.chars.map(x => `<option value="${x.id}" ${x.id === charId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
    <div class="img-slots">${slots.map(([slot, label]) => {
      const key = `${c.id}:${slot}`;
      const src = slotSrc(c, slot);
      return `<div class="img-slot">
        <div class="preview">${src ? `<img src="${esc(src)}" alt="">` : '<span class="muted">未登録</span>'}</div>
        ${label}
        <label class="btn" style="position:relative">画像を選ぶ<input type="file" accept="image/*" data-slot="${slot}"></label>
        ${ImageStore.cache[key] ? `<button class="btn" data-del="${slot}">削除</button>` : ''}
      </div>`;
    }).join('')}</div>
    <p class="muted small">別ポーズと特別が未登録なら、通常の画像を使います。</p>
    <button class="btn wide" id="backSettings">設定にもどる</button>`);

  body.querySelector('#imgChar').onchange = e => openImageManager(e.target.value);
  body.querySelectorAll('input[type="file"]').forEach(inp => {
    inp.onchange = async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      try {
        const dataUrl = await resizeImage(file);
        await ImageStore.put(`${c.id}:${inp.dataset.slot}`, dataUrl);
        toast('画像を登録しました');
        openImageManager(c.id);
        render();
      } catch (e) { toast(e.message); }
    };
  });
  body.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => { await ImageStore.del(`${c.id}:${b.dataset.del}`); openImageManager(c.id); render(); };
  });
  body.querySelector('#backSettings').onclick = () => openSettings();
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

function openPracticePicker(filter = '') {
  const all = app.server.vault();
  const list = filter ? all.filter(i => i.char_id === filter) : all;
  const body = openDialog(`<h2 style="margin:0 0 8px">戦う個体を選ぶ</h2>
    <label class="small">キャラで絞り込み
      <select id="practiceFilter"><option value="">すべて</option>${app.chars.map(c => `<option value="${c.id}" ${c.id === filter ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    </label>
    <div class="practice-pick-list"><ul class="rows">${list.map(ind => {
      const c = app.charMap[ind.char_id];
      const titles = (ind.titles || []).map(titleName).filter(Boolean);
      return `<li><button class="row ${ind.uid === practice.ownUid ? 'selected' : ''}" data-practice-uid="${ind.uid}">
        ${art(c, { ind, size:44 })}<span><span class="rt">${esc(c.name)} ${starsHtml(ind.rarity)}</span><br><span class="rs">パ ${num(ind.power)}　速 ${num(ind.speed)}　賢 ${num(ind.wisdom)}${titles.length ? `<br>称号：${titles.map(esc).join('・')}` : ''}</span></span><span class="rv">#${pad6(ind.serial)}</span>
      </button></li>`;
    }).join('') || '<li class="muted small" style="padding:16px">該当する個体がいません</li>'}</ul></div>`);
  body.querySelector('#practiceFilter').onchange = e => openPracticePicker(e.target.value);
  body.querySelectorAll('[data-practice-uid]').forEach(b => b.onclick = () => {
    practice.ownUid = Number(b.dataset.practiceUid);
    closeDialog();
    practiceCorner(0);
  });
}

function openPracticeFeatures() {
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
  body.querySelector('#practiceFeatureDone').onclick = () => { closeDialog(); renderPracticeBattle(); };
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
  $('#main').innerHTML = `<section class="practice-battle">
    <div class="practice-top"><button class="practice-mini practice-back" id="practiceBack">← 冒険</button><h1>対戦（練習試合）</h1></div>
    <div class="practice-versus"><div class="practice-corner" id="practiceCorner0"></div><div class="practice-vs">VS</div><div class="practice-corner" id="practiceCorner1"></div></div>
    <div class="practice-stage"><div class="practice-stage-row"><label for="practiceStage">舞台</label><select id="practiceStage">${presetOptions}<option value="custom" ${practice.stageIndex < 0 ? 'selected' : ''}>オリジナルの舞台</option></select><button class="practice-mini" id="practiceFeatures">特徴</button></div><p class="practice-feature-line">特徴：${practice.features.length ? practice.features.map(esc).join('・') : 'なし'}</p></div>
    <div class="practice-feed" id="practiceFeed" aria-live="polite"></div>
    <div class="practice-actions"><button id="practiceReroll">相手を<br>引き直す</button><button id="practiceSpeed">実況：<br>${practice.fast ? 'はやい' : 'ふつう'}</button><button id="practiceSkip">結果まで<br>飛ばす</button><button class="go" id="practiceGo">戦わせる</button></div>
  </section>`;
  practiceCorner(0);
  practiceCorner(1);
  $('#practiceBack').onclick = () => show('adventure');
  $('#practiceFeatures').onclick = openPracticeFeatures;
  $('#practiceStage').onchange = e => {
    if (e.target.value === 'custom') { practice.stageIndex = -1; return; }
    practice.stageIndex = Number(e.target.value);
    practice.features = PRACTICE_STAGES[practice.stageIndex].features.slice();
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
  app.tab = 'adventure';
  renderPracticeBattle();
  if (!practice.ownUid) toast('先にガチャで個体を仲間にしてください');
}

// 冒険には日課・探索と練習試合の入口を表示する。
function renderAdventure() {
  const main = $('#main');
  main.innerHTML = `<section class="panel practice-entry"><h2>対戦（練習試合）</h2><p class="muted small" style="margin:0 0 8px">保管庫の個体を選び、10体のキャラや好きな舞台と戦えます。報酬はありません。</p><button class="btn primary wide" id="openPractice">練習試合を始める</button></section><div id="dailyArea"></div>`;
  $('#openPractice').onclick = () => openPracticeBattle();
  renderDaily($('#dailyArea'));
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
    app.server = new GameServer();
    app.server.init();
    app.chars = app.server.characters;
    app.charMap = app.server.charMap;
    renderCoins();
    show('gacha');
    showLoginBonus(app.server.dailyLogin());
    setInterval(tick, 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !app.server) return;
      const info = app.server.dailyLogin();
      if (info) showLoginBonus(info);
      if (!$('.show') && !practice.open) render();
    });
  } catch (e) {
    $('#main').innerHTML = `<p class="error">起動できませんでした：${esc(e.message)}</p>`;
  }
}

if (typeof document !== 'undefined' && document.getElementById('main')) boot();
