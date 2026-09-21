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
const SAVE_KEY = 'gachaZukanDemo_v2';
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
    const old = saved ? null : store.get(OLD_SAVE_KEY);
    this.s = saved || this._fresh(old);
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

  _fresh(old) {
    const base = {
      v: 2,
      player: { display_name: 'あなた', coins: START_COINS, vault_cap: VAULT_CAP },
      mine: [], zukan: {}, extraCounters: {}, nextUid: 1, hall: null
    };
    if (old) Object.assign(base, { player: old.player, mine: old.mine, zukan: old.zukan, extraCounters: old.extraCounters, nextUid: old.nextUid, hall: old.hall });
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
    s.battle = Object.assign({ deck: [], guardian: DEFAULT_GUARDIAN_ID, policy: 'attack', stance: {}, cleared: {}, daily: { date: '', count: 0 }, artifacts: [] }, s.battle || {});
    // 旧版のリーダー設定は使わず、初期守護者へ移行する
    if (!GUARDIAN_MAP[s.battle.guardian] || !this.isGuardianUnlocked(s.battle.guardian)) s.battle.guardian = DEFAULT_GUARDIAN_ID;
    s.guardianUnlocksKnown = Array.isArray(s.guardianUnlocksKnown) ? s.guardianUnlocksKnown : [];
    STARTER_ARTIFACTS.forEach(id => { if (!s.battle.artifacts.includes(id)) s.battle.artifacts.push(id); });
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


  // ---------- バトル ----------
  maxRarity(charId) {
    let m = 0;
    for (const z of Object.values(this.s.zukan)) if (z.char_id === charId) m = Math.max(m, z.rarity);
    return m;
  }
  ownedCharIds() { return CHARACTERS.filter(c => this.maxRarity(c.id) > 0).map(c => c.id); }

  // デッキに出す代表の個体（称号が多く、総合が高い個体）
  representative(charId) {
    const list = this.s.mine.filter(i => i.char_id === charId);
    if (!list.length) return null;
    list.sort((a, b) => (b.titles || []).length - (a.titles || []).length || b.total_score - a.total_score);
    const ind = list[0];
    const title = (ind.titles || []).find(t => TITLE_BONUS[t]);
    return { uid: ind.uid, rarity: ind.rarity, special: ind.special, title: title || null, bonus: title ? TITLE_BONUS[title] : null };
  }

  cardMods(charId) {
    const max = this.maxRarity(charId);
    const stance = max >= 3 ? (this.s.battle.stance[charId] || 'normal') : 'normal';
    const st = STANCES[stance];
    const rep = this.representative(charId);
    const mods = { atk: st.atk, hp: st.hp, speed: 0, bond: max >= 4, ultimate: max >= 5, stance, max, rep };
    if (rep && rep.bonus) mods[rep.bonus] += 1;
    return mods;
  }

  ownedArtifacts() { return ARTIFACTS.filter(a => this.s.battle.artifacts.includes(a.id)).map(a => a.id); }

  // ---------- 守護者 ----------
  isGuardianUnlocked(id) {
    const g = GUARDIAN_MAP[id];
    if (!g || !g.unlock || g.unlock.type === 'none') return false;
    if (g.unlock.type === 'start') return true;
    if (g.unlock.type === 'zukan') return new Set(Object.values(this.s.zukan).map(z => z.char_id)).size >= g.unlock.count;
    if (g.unlock.type === 'quest') return !!this.s.battle.cleared[g.unlock.id];
    return false;
  }

  unlockedGuardians() { return GUARDIANS.filter(g => this.isGuardianUnlocked(g.id)); }

  guardianUnlockText(g) {
    if (!g || !g.unlock) return '解放条件なし';
    if (g.unlock.type === 'start') return '最初から使用可能';
    if (g.unlock.type === 'zukan') return `図鑑で${g.unlock.count}体に出会う`;
    if (g.unlock.type === 'quest') {
      const q = QUESTS.find(x => x.id === g.unlock.id);
      return `「${q ? q.name : g.unlock.id}」をクリア`;
    }
    return '敵専用';
  }

  newGuardianUnlocks() {
    const known = new Set(this.s.guardianUnlocksKnown);
    const fresh = this.unlockedGuardians().filter(g => !known.has(g.id));
    if (fresh.length) {
      fresh.forEach(g => known.add(g.id));
      this.s.guardianUnlocksKnown = [...known];
      this._save();
    }
    return fresh;
  }

  buyArtifact(id) {
    const a = ARTIFACT_MAP[id];
    if (!a) throw new Error('アーティファクトが見つかりません');
    if (this.s.battle.artifacts.includes(id)) throw new Error('もう持っています');
    if (this.s.player.coins < a.price) throw new Error(`コインが足りません（あと${a.price - this.s.player.coins}コイン）`);
    this.s.player.coins -= a.price;
    this.s.battle.artifacts.push(id);
    this._save();
    return { coins: this.s.player.coins };
  }

  _usable() { return new Set([...this.ownedCharIds(), ...this.ownedArtifacts()]); }
  deckState() {
    const b = this.s.battle;
    const owned = this._usable();
    b.deck = b.deck.filter(id => owned.has(id) && getCard(id));
    if (!this.isGuardianUnlocked(b.guardian)) b.guardian = DEFAULT_GUARDIAN_ID;
    return { deck: b.deck.slice(), guardian: b.guardian, policy: b.policy, stance: { ...b.stance } };
  }

  setDeck({ deck, guardian, policy }) {
    const b = this.s.battle;
    const owned = this._usable();
    if (deck) {
      const clean = [...new Set(deck)].filter(id => owned.has(id));
      if (clean.length > RULES.DECK_SIZE) throw new Error(`デッキは${RULES.DECK_SIZE}枚までです`);
      if (clean.filter(isArtifact).length > RULES.MAX_ARTIFACTS) throw new Error(`アーティファクトは${RULES.MAX_ARTIFACTS}枚までです`);
      b.deck = clean;
    }
    if (guardian !== undefined) {
      if (!this.isGuardianUnlocked(guardian)) throw new Error('その守護者はまだ使えません');
      b.guardian = guardian;
    }
    if (policy && POLICIES[policy]) b.policy = policy;
    this._save();
    return this.deckState();
  }

  setStance(charId, stance) {
    if (!STANCES[stance]) throw new Error('型が見つかりません');
    if (this.maxRarity(charId) < 3) throw new Error('型を選ぶには★3が必要です');
    this.s.battle.stance[charId] = stance;
    this._save();
  }

  autoDeck(rules = []) {
    const limit = (rules.find(r => r.type === 'costLimit') || {}).max || 99;
    const owned = this.ownedCharIds().map(id => CARD_MAP[id]).filter(c => c.cost <= limit);
    const byEl = {};
    owned.forEach(c => { (byEl[c.element] = byEl[c.element] || []).push(c); });
    const els = Object.keys(byEl).sort((a, b) => byEl[b].length - byEl[a].length).slice(0, RULES.MAX_ELEMENTS);
    const value = c => (c.atk + c.hp + c.keywords.length * 1.5 + (c.ability ? 1.5 : 0)) / Math.max(1, c.cost);
    const pool = owned.filter(c => els.includes(c.element)).sort((a, b) => value(b) - value(a));
    const arts = this.ownedArtifacts().map(id => ARTIFACT_MAP[id]).filter(a => a.cost <= limit)
      .sort((a, b) => b.price - a.price || b.cost - a.cost).slice(0, Math.min(RULES.MAX_ARTIFACTS, 4)).map(a => a.id);
    const unitTarget = RULES.DECK_SIZE - arts.length;
    // コストの山を作る：低（2以下）35%、中（3〜4）40%、高（5以上）25%
    const low = Math.round(unitTarget * 0.35), high = Math.round(unitTarget * 0.25);
    const buckets = [[c => c.cost <= 2, low], [c => c.cost >= 3 && c.cost <= 4, unitTarget - low - high], [c => c.cost >= 5, high]];
    const deck = [];
    for (const [test, n] of buckets) pool.filter(test).slice(0, n).forEach(c => deck.push(c.id));
    for (const c of pool) { if (deck.length >= unitTarget) break; if (!deck.includes(c.id)) deck.push(c.id); }
    return this.setDeck({ deck: [...deck.slice(0, unitTarget), ...(deck.length >= RULES.MIN_UNITS ? arts : [])] });
  }

  deckErrors(rules = []) {
    const d = this.deckState();
    return validateDeck(d.deck, rules);
  }

  questStatus(qid) {
    const q = QUESTS.find(x => x.id === qid);
    const b = this.s.battle;
    if (b.daily.date !== this.today()) b.daily = { date: this.today(), count: 0 };
    return { cleared: !!b.cleared[qid], dailyLeft: Math.max(0, QUEST_DAILY_REWARDS - b.daily.count), reward: q.reward };
  }

  createQuestBattle(qid) {
    const q = QUESTS.find(x => x.id === qid);
    if (!q) throw new Error('クエストが見つかりません');
    const errors = this.deckErrors(q.rules);
    if (errors.length) throw new Error(errors[0]);
    const d = this.deckState();
    const mods = Object.fromEntries(d.deck.filter(id => !isArtifact(id)).map(id => [id, this.cardMods(id)]));
    return new Battle({
      seed: Math.floor(Math.random() * 1e9), rules: q.rules, goalTurns: q.goalTurns,
      players: [
        { name: this.s.player.display_name, deck: d.deck, guardian: d.guardian, policy: d.policy, mods },
        { name: q.enemy.name, deck: q.enemy.deck, guardian: q.enemy.guardian || DEFAULT_ENEMY_GUARDIAN_ID, guardianHp: q.enemy.guardianHp,
          guardianGaugeRate: q.enemy.guardianGaugeRate, guardianSkillUses: q.enemy.guardianSkillUses, policy: q.enemy.policy, ultimates: !!q.enemy.ultimates }
      ]
    });
  }

  finishQuest(qid, battle) {
    const q = QUESTS.find(x => x.id === qid);
    if (!q || !battle || !battle.over) throw new Error('バトルが終わっていません');
    if (battle.winner !== 0) return { win: false, gained: 0 };
    const b = this.s.battle;
    const st = this.questStatus(qid);
    let gained = 0, first = false, capped = false;
    if (!st.cleared) { gained += q.reward.first; first = true; b.cleared[qid] = true; }
    else if (st.dailyLeft > 0) { gained += q.reward.repeat; }
    else capped = true;
    if (!first && !capped) b.daily.count++;
    this.s.player.coins += gained;
    this._progress('battle', 1);
    this._save();
    const guardians = this.newGuardianUnlocks();
    return { win: true, gained, first, capped, coins: this.s.player.coins, guardians };
  }

  // テスト用
  debugAddCoins(n) { this.s.player.coins += n; this._save(); return this.s.player.coins; }
  debugFinishExpeditions() { const now = this.now(); this.s.expeditions.forEach(e => { e.end = Math.min(e.end, now); }); this._save(); }
  debugNextDay() { this.s.dayOffset += 1; this._save(); }
  reset() { store.del(SAVE_KEY); store.del(OLD_SAVE_KEY); }
}


// =====================================================================
// バトルの計算（オンライン化するときはサーバーで動かす部分）
//   同じ乱数の種と同じ号令なら、必ず同じ結果になる
// =====================================================================
class Rng {
  constructor(seed) { this.f = mulberry32(seed); }
  next() { return this.f(); }
  int(n) { return Math.floor(this.f() * n); }
  pick(a) { return a.length ? a[this.int(a.length)] : null; }
  shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = this.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
}

const SIDE_NAME = ['あなた', '相手'];

class Battle {
  // opts: { seed, players: [{ name, deck:[id], guardian:id, policy }, ...], rules:[], goalTurns, record }
  constructor(opts) {
    this.rng = new Rng(opts.seed >>> 0);
    this.rules = opts.rules || [];
    this.goalTurns = opts.goalTurns || null;
    this.record = opts.record !== false;
    this.events = [];
    this.turn = 0;
    this.over = false;
    this.winner = null;
    this.reason = '';
    this.uidSeq = 1;
    this.deathCount = 0;
    this.stats = { plays: [0, 0], damageToLeader: [0, 0] };
    this.p = opts.players.map((pl, side) => {
      const guardian = GUARDIAN_MAP[pl.guardian] || GUARDIAN_MAP[side === 0 ? DEFAULT_GUARDIAN_ID : DEFAULT_ENEMY_GUARDIAN_ID];
      const hp = pl.guardianHp || guardian.hp;
      return {
        side, name: pl.name, guardian, policy: pl.policy || 'attack', autoGuardian: pl.autoGuardian !== undefined ? !!pl.autoGuardian : side === 1,
        hp, maxHp: hp, deck: this.rng.shuffle(pl.deck.slice()), hand: [], energy: 0, fatigue: 0,
        board: { front: [null, null, null], back: [null, null, null] },
        guardianGauge: 0, guardianGaugeRate: pl.guardianGaugeRate || guardian.gaugeRate || 1, guardianUltimateUsed: false,
        guardianSkillUses: guardian.skills.map((s, i) => pl.guardianSkillUses?.[i] ?? s.uses), pendingGuardian: null,
        mods: pl.mods || {}, ultimates: !!pl.ultimates, relics: []
      };
    });
  }

  // ---------- 記録 ----------
  snapshot() {
    const u = x => x && ({ uid: x.uid, side: x.side, cardId: x.cardId, ultimate: !!x.ultimate, spd: this.speedOf(x), first: this.has(x, '先制'), name: x.name, atk: this.atkOf(x), hp: x.hp, maxHp: x.maxHp, keywords: x.keywords.slice(), shield: x.shield, hidden: x.hidden, poison: x.poison, frozen: x.frozen, token: x.token, hue: x.hue, shape: x.shape, img: x.img, element: x.element });
    return this.p.map(pl => ({
      hp: pl.hp, maxHp: pl.maxHp, energy: pl.energy, hand: pl.hand.length, relics: pl.relics.map(r => ({ id: r.id, name: r.name, icon: r.icon })), deck: pl.deck.length,
      guardian: { id: pl.guardian.id, name: pl.guardian.name, title: pl.guardian.title }, guardianGauge: pl.guardianGauge, guardianUltimateUsed: pl.guardianUltimateUsed, guardianSkillUses: pl.guardianSkillUses.slice(), pendingGuardian: pl.pendingGuardian,
      front: pl.board.front.map(u), back: pl.board.back.map(u)
    }));
  }
  emit(ev) {
    if (!this.record) return;
    ev.turn = this.turn;
    ev.snap = this.snapshot();
    this.events.push(ev);
  }
  unitLabel(u) { return `${SIDE_NAME[u.side]}の${u.name}`; }

  // ---------- 盤面の道具 ----------
  units(side) {
    const b = this.p[side].board;
    return [...b.front, ...b.back].filter(Boolean);
  }
  allUnits() { return [...this.units(0), ...this.units(1)]; }
  has(u, kw) { return u.keywords.includes(kw); }
  alive(u) { return u && u.onBoard && u.hp > 0; }
  costOf(card) {
    const r = card.costRule;
    if (!r || r.type !== 'perDeath') return card.cost;
    return Math.max(r.min, card.cost - r.amount * this.deathCount);
  }

  atkOf(u) {
    let a = u.atk + u.tempAtk;
    // 鼓舞：隣の列と、同じ列の前後
    const b = this.p[u.side].board;
    const near = [];
    const row = b[u.row];
    const other = b[u.row === 'front' ? 'back' : 'front'];
    if (row[u.lane - 1]) near.push(row[u.lane - 1]);
    if (row[u.lane + 1]) near.push(row[u.lane + 1]);
    if (other[u.lane]) near.push(other[u.lane]);
    a += near.filter(x => x !== u && this.has(x, '鼓舞') && x.hp > 0).length;
    for (const e of this.p[u.side].guardian.passive?.effects || []) {
      if (e.type === 'elementAtk' && u.element === e.element) a += e.amount;
    }
    return Math.max(0, a);
  }
  speedOf(u) { return u.speed; }

  guardianSource(side) {
    const g = this.p[side].guardian;
    return { side, lane: 1, row: 'front', hue: g.hue || 0, name: g.name, skill: g.name, tribes: [], keywords: [], onBoard: false, hp: 1, maxHp: 1, guardian: true, ability: null };
  }

  gainGuardianGauge(side, base) {
    const pl = this.p[side];
    if (pl.guardianUltimateUsed) return;
    const n = Math.max(0, Math.round(base * pl.guardianGaugeRate));
    pl.guardianGauge = Math.min(100, pl.guardianGauge + n);
  }

  guardianActionDef(side, action) {
    const pl = this.p[side];
    if (action === 'ultimate') return pl.guardian.ultimate;
    const m = /^skill([01])$/.exec(action || '');
    return m ? pl.guardian.skills[Number(m[1])] : null;
  }

  guardianActionAvailable(side, action) {
    const pl = this.p[side];
    if (!this.guardianActionDef(side, action)) return false;
    if (action === 'ultimate') return !pl.guardianUltimateUsed && pl.guardianGauge >= 100;
    const i = Number(action.slice(-1));
    return pl.guardianSkillUses[i] > 0;
  }

  guardianEffectUseful(side, e) {
    const pl = this.p[side];
    const allies = this.units(side), enemies = this.units(1 - side);
    switch (e.type) {
      case 'dreamRock': return allies.some(u => u.element === e.element);
      case 'summon': return ['front', 'back'].some(row => pl.board[row].some(x => !x));
      case 'shield': return allies.some(u => !u.shield);
      case 'heal': return e.target === 'leader' ? pl.hp < pl.maxHp : allies.some(u => u.hp < u.maxHp);
      case 'buff': return e.target === 'allEnemies' ? enemies.length > 0 : allies.length > 0;
      case 'debuff': return enemies.length > 0;
      case 'draw': return pl.deck.length > 0 && pl.hand.length < RULES.HAND_MAX;
      case 'status': return enemies.length > 0;
      case 'extraAttack': return allies.some(u => this.chooseTarget(u));
      case 'elementShift': return allies.some(u => u.element !== e.element);
      default: return true;
    }
  }

  guardianActionUseful(side, action) {
    const d = this.guardianActionDef(side, action);
    const effects = d ? (d.effects || (d.effect ? [d.effect] : [])) : [];
    return effects.some(e => this.guardianEffectUseful(side, e));
  }

  chooseGuardianAction(side) {
    if (this.guardianActionAvailable(side, 'ultimate') && this.guardianActionUseful(side, 'ultimate')) return 'ultimate';
    for (const action of ['skill0', 'skill1']) {
      if (this.guardianActionAvailable(side, action) && this.guardianActionUseful(side, action)) return action;
    }
    return null;
  }

  executeGuardianAction(side, action) {
    if (!this.guardianActionAvailable(side, action) || !this.guardianActionUseful(side, action)) return false;
    const pl = this.p[side];
    const d = this.guardianActionDef(side, action);
    const effects = d.effects || (d.effect ? [d.effect] : []);
    this.emit({ t: 'guardian', side, ultimate: action === 'ultimate', action, text: `${pl.guardian.name}の${action === 'ultimate' ? '必殺技' : 'スキル'}「${d.name}」` });
    for (const e of effects) {
      this.applyGuardianEffect(side, e);
      this.resolveDeaths();
      if (this.over) break;
    }
    if (action === 'ultimate') {
      pl.guardianGauge = 0;
      pl.guardianUltimateUsed = true;
    } else {
      pl.guardianSkillUses[Number(action.slice(-1))]--;
    }
    return true;
  }

  applyGuardianEffect(side, e) {
    const source = this.guardianSource(side);
    if (e.type === 'dreamRock') {
      const allies = this.units(side).filter(u => u.element === e.element);
      const hurt = allies.filter(u => u.hp < u.maxHp && !u.shield).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
      if (hurt) {
        hurt.shield = true;
        this.emit({ t: 'shield', side, uid: hurt.uid, text: `${this.unitLabel(hurt)}に盾` });
        return;
      }
      const attacker = allies.filter(u => this.chooseTarget(u)).sort((a, b) => this.atkOf(b) - this.atkOf(a))[0];
      if (attacker) this.attack(attacker, this.chooseTarget(attacker));
      else {
        const target = allies.find(u => !u.shield) || allies[0];
        if (!target) return;
        target.shield = true;
        this.emit({ t: 'shield', side, uid: target.uid, text: `${this.unitLabel(target)}に盾` });
      }
      return;
    }
    if (e.type === 'extraAttack') {
      let allies = this.units(side).filter(u => this.chooseTarget(u));
      if (e.target !== 'allAllies') allies = allies.length ? [this.rng.pick(allies)] : [];
      for (const u of allies.slice()) if (this.alive(u)) { const target = this.chooseTarget(u); if (target) this.attack(u, target); this.resolveDeaths(); }
      return;
    }
    if (e.type === 'elementShift') {
      for (const u of this.units(side)) {
        if (u.elementShiftTurns || u.element === e.element) continue;
        u.originalElement = u.element;
        u.element = e.element;
        u.elementShiftTurns = e.turns;
      }
      this.emit({ t: 'buff', side, text: `味方全員を${e.turns}ターンの間、${e.element}属性にした` });
      return;
    }
    this.applyEffect(source, e, {});
  }

  // ---------- 開始 ----------
  start() {
    this.emit({ t: 'start', text: 'バトル開始' });
    for (const pl of this.p) for (let i = 0; i < RULES.START_HAND; i++) this.draw(pl.side, true);
    this.emit({ t: 'info', text: '手札を3枚引いた' });
    return this.flush();
  }

  flush() { const e = this.events; this.events = []; return e; }

  draw(side, quiet = false) {
    const pl = this.p[side];
    if (!pl.deck.length) {
      pl.fatigue++;
      this.damageLeader(side, RULES.FATIGUE_DAMAGE || pl.fatigue, null, `${SIDE_NAME[side]}の山札が切れた`);
      return;
    }
    const id = pl.deck.shift();
    if (pl.hand.length >= RULES.HAND_MAX) {
      if (!quiet) this.emit({ t: 'info', side, text: `${SIDE_NAME[side]}は手札がいっぱいで「${getCard(id).name}」を捨てた` });
      return;
    }
    pl.hand.push(id);
  }

  // ---------- 1ターン ----------
  nextTurn(actions = {}) {
    if (this.over) return [];
    this.turn++;
    this.emit({ t: 'turn', text: `ターン ${this.turn}` });

    for (const side of [0, 1]) this.gainGuardianGauge(side, 8);
    for (const side of [0, 1]) {
      const action = actions[side];
      if (action && this.guardianActionAvailable(side, action)) this.p[side].pendingGuardian = action;
    }

    for (const pl of this.p) {
      pl.energy = Math.min(this.turn, RULES.MAX_ENERGY);
      this.draw(pl.side);
      if (this.over) return this.flush();
    }

    // ターン開始時
    for (const u of this.orderedUnits()) if (this.alive(u)) this.trigger(u, 'turnStart');
    for (const side of [0, 1]) this.triggerRelics(side, 'turnStart');
    for (const r of this.rules) {
      if ((r.type === 'bossPulse' || r.type === 'enemyPulse') && this.turn % r.every === 0) {
        this.emit({ t: 'boss', side: 1, text: r.type === 'bossPulse' ? 'ボスの力が放たれた！' : '相手の守護の力が広がった！' });
        for (const u of this.units(0)) this.damage(u, r.amount, { ignoreShield: false });
        this.resolveDeaths();
      }
    }
    if (this.checkEnd()) return this.flush();

    // 配置
    const order = this.turn % 2 === 1 ? [0, 1] : [1, 0];
    for (const side of order) { this.deploy(side); if (this.checkEnd()) return this.flush(); }

    // ガーディアンの能力（予約した次ターンの配置後に発動）
    for (const side of [0, 1]) {
      const pl = this.p[side];
      if (!pl.pendingGuardian && pl.autoGuardian) pl.pendingGuardian = this.chooseGuardianAction(side);
      if (pl.pendingGuardian) this.executeGuardianAction(side, pl.pendingGuardian);
      pl.pendingGuardian = null;
      if (this.checkEnd()) return this.flush();
    }

    // 戦闘
    this.combat();
    if (this.checkEnd()) return this.flush();

    // ターン終了
    this.endPhase();
    if (this.checkEnd()) return this.flush();

    if (this.goalTurns && this.turn >= this.goalTurns) {
      this.finish(1, `${this.goalTurns}ターン以内に勝てなかった`);
      return this.flush();
    }
    if (this.turn >= RULES.TURN_LIMIT) {
      const [a, b] = [this.p[0].hp, this.p[1].hp];
      this.finish(a === b ? null : (a > b ? 0 : 1), '時間切れ：ガーディアンの体力で判定');
    }
    return this.flush();
  }

  orderedUnits() {
    const list = this.allUnits().map(u => ({ u, k: (this.has(u, '先制') ? 100 : 0) + this.speedOf(u) + this.rng.next() * 0.5 }));
    return list.sort((a, b) => b.k - a.k).map(x => x.u);
  }

  // ---------- 配置 ----------
  deploy(side) {
    const pl = this.p[side];
    for (let guard = 0; guard < 12; guard++) {
      const options = pl.hand
        .map((id, i) => ({ id, i, c: getCard(id) }))
        .filter(o => this.costOf(o.c) <= pl.energy)
        .map(o => ({ ...o, slot: o.c.type === 'artifact' ? this.artifactUsable(side, o.c) : this.slotFor(side, o.c) }))
        .filter(o => o.slot);
      if (!options.length) break;
      const sorters = {
        attack: (a, b) => a.c.cost - b.c.cost || (b.c.atk - a.c.atk),
        defend: (a, b) => (this.has(b.c, '守護') - this.has(a.c, '守護')) || (b.c.hp - a.c.hp) || (b.c.cost - a.c.cost),
        big: (a, b) => b.c.cost - a.c.cost || (b.c.atk + b.c.hp) - (a.c.atk + a.c.hp)
      };
      // 設置型は先に置き、発動型はキャラを出したあとの残りのエナジーで使う
      const rank = o => o.c.type !== 'artifact' ? 1 : (o.c.mode === 'relic' ? 0 : 2);
      const base = sorters[pl.policy] || sorters.attack;
      options.sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? base(a, b) : b.c.cost - a.c.cost));
      const o = options[0];
      pl.hand.splice(o.i, 1);
      pl.energy -= this.costOf(o.c);
      this.stats.plays[side]++;
      if (o.c.type === 'artifact') this.playArtifact(side, o.c);
      else this.place(side, o.c, o.slot);
      if (this.over) return;
    }
  }

  // ---------- アーティファクト ----------
  artifactSource(side, a) {
    return { side, lane: 1, row: 'front', hue: 0, name: a.name, skill: a.name, tribes: [], keywords: [], onBoard: false, hp: 1, maxHp: 1, relic: true, ability: a.ability || null };
  }

  // 使う意味があるときだけ使う
  artifactUsable(side, a) {
    const pl = this.p[side];
    if (a.mode === 'relic') return pl.relics.length < RULES.RELIC_SLOTS && !pl.relics.some(r => r.id === a.id) ? { artifact: true } : null;
    const e = a.effect;
    const allies = this.units(side);
    const enemies = this.units(1 - side);
    let ok = true;
    switch (e.type) {
      case 'damage': ok = e.target === 'enemyLeader' || (e.target === 'allEnemies' ? enemies.length >= 2 : enemies.some(x => !x.hidden)); break;
      case 'heal': ok = e.target === 'leader' ? pl.maxHp - pl.hp >= Math.ceil(e.amount / 2) : allies.some(x => x.hp < x.maxHp); break;
      case 'buff': ok = allies.length >= (e.target === 'allAllies' ? 2 : 1); break;
      case 'status': ok = enemies.length >= (e.target === 'allEnemies' ? 2 : 1); break;
      case 'shield': ok = allies.some(x => !x.shield); break;
      case 'summon': ok = ['front', 'back'].some(row => pl.board[row].some(x => !x)); break;
      case 'draw': ok = pl.deck.length > 0 && pl.hand.length <= RULES.HAND_MAX - e.amount; break;
      case 'energy': ok = pl.hand.length > 1; break;
    }
    return ok ? { artifact: true } : null;
  }

  playArtifact(side, a) {
    const pl = this.p[side];
    if (a.mode === 'relic') {
      pl.relics.push({ id: a.id, name: a.name, icon: a.icon, ability: a.ability });
      this.emit({ t: 'relic', side, id: a.id, icon: a.icon, text: `${SIDE_NAME[side]}が「${a.name}」を設置` });
      return;
    }
    this.emit({ t: 'artifact', side, id: a.id, icon: a.icon, text: `${SIDE_NAME[side]}の「${a.name}」：${effectText(a.effect)}` });
    this.applyEffect(this.artifactSource(side, a), a.effect, {});
    this.resolveDeaths();
  }

  triggerRelics(side, name, ctx = {}) {
    if (this.over) return;
    for (const r of this.p[side].relics.slice()) {
      if (r.ability.trigger !== name) continue;
      this.trigger(this.artifactSource(side, r), name, ctx);
      if (this.over) return;
    }
  }

  wantsBack(c) {
    if (this.has(c, '守護')) return false;
    return this.has(c, '射程') || this.has(c, '飛行') || c.atk <= 1;
  }

  slotFor(side, c) {
    const b = this.p[side].board;
    const eb = this.p[1 - side].board;
    const pl = this.p[side];
    const emptyFront = [0, 1, 2].filter(l => !b.front[l]);
    const emptyBack = [0, 1, 2].filter(l => !b.back[l]);
    const canHitFromBack = this.has(c, '射程') || this.has(c, '飛行');

    const pickFront = () => {
      if (!emptyFront.length) return null;
      const threat = l => eb.front[l] ? eb.front[l].atk + eb.front[l].tempAtk : -1;
      let lanes = emptyFront.slice();
      if (this.has(c, '守護') || pl.policy === 'defend') {
        lanes.sort((x, y) => threat(y) - threat(x) || Math.abs(x - 1) - Math.abs(y - 1));
      } else if (pl.policy === 'attack') {
        lanes.sort((x, y) => (eb.front[x] ? 1 : 0) - (eb.front[y] ? 1 : 0) || threat(x) - threat(y));
      } else {
        lanes.sort((x, y) => {
          const kx = eb.front[x] && eb.front[x].hp <= c.atk ? 0 : 1;
          const ky = eb.front[y] && eb.front[y].hp <= c.atk ? 0 : 1;
          return kx - ky || Math.abs(x - 1) - Math.abs(y - 1);
        });
      }
      return { row: 'front', lane: lanes[0] };
    };
    const pickBack = () => {
      if (!emptyBack.length) return null;
      const lanes = emptyBack.slice().sort((x, y) => (b.front[y] ? 1 : 0) - (b.front[x] ? 1 : 0) || Math.abs(x - 1) - Math.abs(y - 1));
      return { row: 'back', lane: lanes[0] };
    };

    if (this.wantsBack(c)) {
      const s = pickBack();
      if (s) return s;
      return c.atk > 0 ? pickFront() : null;
    }
    const s = pickFront();
    if (s) return s;
    return canHitFromBack ? pickBack() : null;
  }

  makeUnit(side, c, slot, token = false) {
    const u = {
      uid: this.uidSeq++, side, cardId: c.id, name: c.name, element: c.element || '無',
      tribes: (c.tribes || []).slice(), atk: c.atk, hp: c.hp, maxHp: c.hp, speed: c.speed || 2,
      keywords: (c.keywords || []).slice(), ability: c.ability || null, skill: c.skill || '',
      shield: false, hidden: false, poison: 0, frozen: false, revived: false, tempAtk: 0,
      lane: slot.lane, row: slot.row, onBoard: true, token, hue: c.hue ?? 0, shape: c.shape ?? 0, img: c.img || '', bonds: []
    };
    const pl = this.p[side];
    const m = token ? {} : (pl.mods[c.id] || {});
    u.atk = Math.max(0, u.atk + (m.atk || 0));
    u.hp = Math.max(1, u.hp + (m.hp || 0)); u.maxHp = u.hp;
    u.speed += m.speed || 0;
    u.bondOk = token ? false : (m.bond !== undefined ? m.bond : true);
    u.ultimate = !token && (m.ultimate || pl.ultimates);
    u.shield = this.has(u, '盾');
    u.hidden = this.has(u, '潜伏');
    for (const r of this.rules) {
      if (r.type === 'tribeBuff' && u.tribes.includes(r.tribe)) { u.atk += r.atk; u.hp += r.hp; u.maxHp += r.hp; }
    }
    for (const e of pl.guardian.passive?.effects || []) {
      if (e.type === 'elementPlayHp' && u.element === e.element) { u.hp += e.amount; u.maxHp += e.amount; }
    }
    this.p[side].board[slot.row][slot.lane] = u;
    return u;
  }

  place(side, c, slot) {
    const u = this.makeUnit(side, c, slot);
    this.emit({ t: 'play', side, uid: u.uid, text: `${this.unitLabel(u)}が登場（${slot.row === 'front' ? '前列' : '後列'}${['左', '中央', '右'][slot.lane]}）` });
    this.trigger(u, 'play');
    for (const ally of this.units(side)) if (ally !== u && this.alive(ally)) this.trigger(ally, 'allyPlay', { played: u });
    this.triggerRelics(side, 'allyPlay', { played: u });
    const ul = c.ultimate || ULTIMATES[u.element];
    if (u.ultimate && this.alive(u) && ul) {
      this.emit({ t: 'ability', side, uid: u.uid, skill: ul.name, ultimate: true, text: `${this.unitLabel(u)}の「${ul.name}」：${ultimateEffectText(ul)}` });
      for (const effect of (ul.effects || [ul.effect])) this.applyEffect(u, effect, {});
      this.resolveDeaths();
    }
    this.checkBonds(u);
    this.resolveDeaths();
  }

  checkBonds(u) {
    for (const bond of bondsOf(u.cardId)) {
      const partner = this.units(u.side).find(x => x.cardId === bond.partner && !x.bonds.includes(bond.name) && this.alive(x));
      if (!partner || u.bonds.includes(bond.name)) continue;
      if (!u.bondOk && !partner.bondOk) continue;
      for (const x of [u, partner]) { x.atk += 1; x.hp += 1; x.maxHp += 1; x.bonds.push(bond.name); }
      this.emit({ t: 'bond', side: u.side, uid: u.uid, uid2: partner.uid, text: `縁「${bond.name}」：${u.name}と${partner.name}の攻撃+1、体力+1` });
    }
  }

  // ---------- 戦闘 ----------
  combat() {
    for (const u of this.orderedUnits()) {
      if (!this.alive(u)) continue;
      if (u.frozen) {
        u.frozen = false;
        this.emit({ t: 'frozen', uid: u.uid, text: `${this.unitLabel(u)}は凍っていて動けない` });
        continue;
      }
      const times = this.has(u, '連撃') ? 2 : 1;
      for (let k = 0; k < times; k++) {
        if (!this.alive(u)) break;
        const target = this.chooseTarget(u);
        if (!target) break;
        this.attack(u, target);
        if (this.checkEnd()) return;
      }
    }
  }

  canFly(u) {
    if (!this.has(u, '飛行')) return false;
    return !this.rules.some(r => r.type === 'laneNoFlying' && r.lane === u.lane);
  }

  chooseTarget(u) {
    const flying = this.canFly(u);
    const fromBack = u.row === 'back';
    if (fromBack && !this.has(u, '射程') && !flying) return null;
    if (this.atkOf(u) <= 0) return null;
    const eb = this.p[1 - u.side].board;
    const visible = x => x && x.hp > 0 && !x.hidden;
    if (flying) {
      if (visible(eb.back[u.lane])) return eb.back[u.lane];
      return { leader: 1 - u.side };
    }
    const guards = [0, 1, 2]
      .filter(l => Math.abs(l - u.lane) <= 1 && visible(eb.front[l]) && this.has(eb.front[l], '守護'))
      .map(l => eb.front[l]);
    if (guards.length) return guards.find(g => g.lane === u.lane) || guards[this.rng.int(guards.length)];
    if (visible(eb.front[u.lane])) return eb.front[u.lane];
    if (visible(eb.back[u.lane])) return eb.back[u.lane];
    return { leader: 1 - u.side };
  }

  attack(u, target) {
    let atk = this.atkOf(u);
    if (this.rules.some(r => r.type === 'nonFlyingAtkHalf') && !this.has(u, '飛行')) atk = Math.floor(atk / 2);
    const isLeader = target.leader !== undefined;
    this.emit({ t: 'attack', side: u.side, uid: u.uid, to: isLeader ? `leader${target.leader}` : target.uid,
      text: `${this.unitLabel(u)}の攻撃 → ${isLeader ? `${SIDE_NAME[target.leader]}のガーディアン` : target.name}` });
    if (u.hidden) { u.hidden = false; this.emit({ t: 'reveal', uid: u.uid, text: `${u.name}が姿を現した` }); }
    this.trigger(u, 'attack', { target: isLeader ? null : target });
    if (!this.alive(u)) { this.resolveDeaths(); return; }

    if (isLeader) {
      this.damageLeader(target.leader, atk, u);
      return;
    }
    if (!this.alive(target)) { this.resolveDeaths(); return; }

    const res = this.damage(target, atk, { source: u });
    if (this.alive(target) && !res.blocked) {
      if (this.has(u, '毒')) { target.poison += 1; this.emit({ t: 'status', uid: target.uid, text: `${target.name}に毒1` }); }
      if (this.has(u, '凍結')) { target.frozen = true; this.emit({ t: 'status', uid: target.uid, text: `${target.name}が凍った` }); }
    }
    if (this.has(u, '貫通') && res.overflow > 0) {
      const eb = this.p[target.side].board;
      const behind = target.row === 'front' ? eb.back[target.lane] : null;
      if (behind && this.alive(behind) && behind !== target) this.damage(behind, res.overflow, { source: u, label: '貫通' });
      else this.damageLeader(target.side, res.overflow, u, '貫通');
    }
    if (this.alive(target) && this.has(target, '反撃') && this.alive(u) && !res.blocked) {
      this.emit({ t: 'counter', uid: target.uid, to: u.uid, text: `${target.name}の反撃` });
      this.damage(u, this.atkOf(target), { source: target });
    }
    if (this.alive(target) && !res.blocked) this.trigger(target, 'hurt', { attacker: u });
    if (target.hp <= 0 && this.alive(u)) this.trigger(u, 'kill', { victim: target });
    this.resolveDeaths();
  }

  damage(u, n, opts = {}) {
    if (!u || n <= 0 || !u.onBoard) return { blocked: false, overflow: 0 };
    if (u.shield && !opts.ignoreShield) {
      u.shield = false;
      this.emit({ t: 'block', uid: u.uid, text: `${u.name}の盾がダメージを防いだ` });
      return { blocked: true, overflow: 0 };
    }
    const before = u.hp;
    u.hp -= n;
    const overflow = Math.max(0, n - before);
    this.emit({ t: 'damage', uid: u.uid, amount: n, text: `${u.name}に${n}ダメージ${opts.label ? `（${opts.label}）` : ''}` });
    return { blocked: false, overflow };
  }

  heal(u, n) {
    if (!u || n <= 0 || u.hp >= u.maxHp) return;
    const amt = Math.min(n, u.maxHp - u.hp);
    u.hp += amt;
    this.emit({ t: 'heal', uid: u.uid, amount: amt, text: `${u.name}が${amt}回復` });
  }

  damageLeader(side, n, source, label) {
    if (n <= 0) return;
    const pl = this.p[side];
    pl.hp -= n;
    this.stats.damageToLeader[side] += n;
    this.gainGuardianGauge(side, n);
    this.emit({ t: 'leaderDamage', side, amount: n, text: `${label ? label + '：' : ''}${SIDE_NAME[side]}のガーディアンに${n}ダメージ` });
    this.checkEnd();
  }

  resolveDeaths() {
    for (let guard = 0; guard < 30; guard++) {
      const dead = this.allUnits().filter(u => u.hp <= 0);
      if (!dead.length) return;
      for (const u of dead) {
        if (this.has(u, '復活') && !u.revived) {
          u.revived = true; u.hp = 1; u.poison = 0; u.frozen = false;
          this.emit({ t: 'revive', uid: u.uid, text: `${this.unitLabel(u)}が復活した` });
          continue;
        }
        this.p[u.side].board[u.row][u.lane] = null;
        u.onBoard = false;
        this.deathCount++;
        this.gainGuardianGauge(u.side, 12);
        this.gainGuardianGauge(1 - u.side, 10);
        this.emit({ t: 'death', side: u.side, uid: u.uid, row: u.row, lane: u.lane, text: `${this.unitLabel(u)}が倒れた` });
        this.trigger(u, 'death');
        this.triggerRelics(u.side, 'allyDeath', { victim: u });
        this.triggerRelics(1 - u.side, 'enemyDeath', { victim: u });
        for (const survivor of this.allUnits()) if (this.alive(survivor)) this.trigger(survivor, 'anyDeath', { victim: u });
        for (const side of [0, 1]) this.triggerRelics(side, 'anyDeath', { victim: u });
        if (this.over) return;
      }
    }
  }

  endPhase() {
    for (const u of this.orderedUnits()) {
      if (!this.alive(u)) continue;
      if (u.poison > 0) {
        this.emit({ t: 'poison', uid: u.uid, text: `${u.name}は毒で弱っている` });
        this.damage(u, u.poison, { ignoreShield: true, label: '毒' });
        u.poison -= 1;
      }
    }
    this.resolveDeaths();
    for (const u of this.orderedUnits()) {
      if (!this.alive(u)) continue;
      if (this.has(u, '再生')) this.heal(u, 1);
      this.trigger(u, 'turnEnd');
    }
    for (const side of [0, 1]) this.triggerRelics(side, 'turnEnd');
    for (const pl of this.p) {
      for (const e of pl.guardian.passive?.effects || []) {
        if (e.type !== 'turnEndStatus') continue;
        this.applyEffect(this.guardianSource(pl.side), { type: 'status', target: e.target, status: e.status, amount: e.amount }, {});
      }
    }
    for (const r of this.rules) {
      if (r.type === 'turnEndPoisonAll' && this.turn >= r.from) {
        const list = this.allUnits();
        if (list.length) { list.forEach(u => { u.poison += 1; }); this.emit({ t: 'rule', text: '霧の毒が全カードにしみこんだ' }); }
      }
    }
    this.allUnits().forEach(u => {
      u.tempAtk = 0;
      if (u.elementShiftTurns) {
        u.elementShiftTurns--;
        if (u.elementShiftTurns <= 0) { u.element = u.originalElement; delete u.originalElement; delete u.elementShiftTurns; }
      }
    });
    this.resolveDeaths();
  }

  // ---------- 固有能力 ----------
  trigger(u, name, ctx = {}) {
    const ab = u.ability;
    if (!ab || ab.trigger !== name) return;
    const c = ab.cond;
    if (c) {
      if (c.type === 'tribeCount' && this.units(u.side).filter(x => x.tribes.includes(c.tribe)).length < c.n) return;
      if (c.type === 'hpHalf' && u.hp * 2 > u.maxHp) return;
      if (c.type === 'outnumbered' && this.units(1 - u.side).length <= this.units(u.side).length) return;
      if (c.type === 'playedTribe' && !(ctx.played && ctx.played.tribes.includes(c.tribe))) return;
    }
    this.emit({ t: 'ability', side: u.side, uid: u.uid, relic: !!u.relic, skill: u.skill, text: `${this.unitLabel(u)}の「${u.skill}」：${effectText(ab.effect)}` });
    this.applyEffect(u, ab.effect, ctx);
    this.resolveDeaths();
  }

  applyEffect(u, e, ctx) {
    const side = u.side;
    const enemies = () => this.units(1 - side).filter(x => x.hp > 0);
    const visibleEnemies = () => enemies().filter(x => !x.hidden);
    const allies = () => this.units(side).filter(x => x.hp > 0);
    const laneEnemy = () => { const eb = this.p[1 - side].board; return [eb.front[u.lane], eb.back[u.lane]].find(x => x && x.hp > 0 && !x.hidden) || null; };
    const pickTargets = (kind) => {
      switch (kind) {
        case 'randomEnemy': { const t = this.rng.pick(visibleEnemies()); return t ? [t] : []; }
        case 'allEnemies': return enemies();
        case 'attackTarget': return ctx.target && this.alive(ctx.target) ? [ctx.target] : [];
        case 'laneEnemy': { const t = laneEnemy(); return t ? [t] : []; }
        case 'lowestAlly': { const t = allies().filter(x => x.hp < x.maxHp).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]; return t ? [t] : []; }
        case 'allAllies': return allies();
        case 'self': return this.alive(u) ? [u] : [];
        case 'playedAlly': return ctx.played && this.alive(ctx.played) ? [ctx.played] : [];
        case 'randomAlly': { const t = this.rng.pick(allies()); return t ? [t] : []; }
        case 'tribeAllies': return allies().filter(x => x.tribes.includes(e.tribe));
        default: return [];
      }
    };
    switch (e.type) {
      case 'damage':
        if (e.target === 'enemyLeader') { this.damageLeader(1 - side, e.amount, u); break; }
        pickTargets(e.target).forEach(t => this.damage(t, e.amount, { source: u }));
        break;
      case 'heal':
        if (e.target === 'leader') {
          const pl = this.p[side];
          const amt = Math.min(e.amount, pl.maxHp - pl.hp);
          if (amt > 0) { pl.hp += amt; this.emit({ t: 'leaderHeal', side, amount: amt, text: `${SIDE_NAME[side]}のガーディアンが${amt}回復` }); }
          break;
        }
        pickTargets(e.target).forEach(t => this.heal(t, e.amount));
        break;
      case 'buff':
        pickTargets(e.target).forEach(t => {
          t.atk += e.atk || 0;
          if (e.hp) { t.hp += e.hp; t.maxHp += e.hp; }
          this.emit({ t: 'buff', uid: t.uid, atk: e.atk || 0, hp: e.hp || 0, text: `${t.name}が強化された` });
        });
        break;
      case 'status':
        pickTargets(e.target).forEach(t => {
          if (e.status === 'poison') t.poison += e.amount; else t.frozen = true;
          this.emit({ t: 'status', uid: t.uid, text: e.status === 'poison' ? `${t.name}に毒${e.amount}` : `${t.name}が凍った` });
        });
        break;
      case 'shield':
        pickTargets(e.target).forEach(t => { t.shield = true; this.emit({ t: 'shield', uid: t.uid, text: `${t.name}に盾` }); });
        break;
      case 'summon': {
        const b = this.p[side].board;
        const lanes = [u.lane, u.lane - 1, u.lane + 1, 0, 1, 2].filter(l => l >= 0 && l < 3);
        let slot = null;
        const rows = e.token.prefer === 'back' ? ['back', 'front'] : ['front', 'back'];
        for (const row of rows) { for (const l of lanes) if (!b[row][l]) { slot = { row, lane: l }; break; } if (slot) break; }
        if (!slot) break;
        const tk = this.makeUnit(side, { id: 'token', name: e.token.name, atk: e.token.atk, hp: e.token.hp, element: e.token.element, keywords: e.token.keywords || [], speed: 2, hue: u.hue, shape: 0, tribes: u.tribes }, slot, true);
        this.emit({ t: 'play', side, uid: tk.uid, text: `「${tk.name}」が呼ばれた` });
        break;
      }
      case 'draw':
        for (let i = 0; i < e.amount; i++) this.draw(side);
        this.emit({ t: 'info', side, text: `${SIDE_NAME[side]}がカードを${e.amount}枚引いた` });
        break;
      case 'energy':
        this.p[side].energy += e.amount;
        this.emit({ t: 'info', side, text: `${SIDE_NAME[side]}のエナジー+${e.amount}` });
        break;
    }
  }

  // ---------- 勝敗 ----------
  checkEnd() {
    if (this.over) return true;
    const [a, b] = [this.p[0].hp <= 0, this.p[1].hp <= 0];
    if (a && b) this.finish(null, '相打ち');
    else if (a) this.finish(1, 'あなたのガーディアンが倒れた');
    else if (b) this.finish(0, '相手のガーディアンを倒した');
    return this.over;
  }

  finish(winner, reason) {
    if (this.over) return;
    this.over = true;
    this.winner = winner;
    this.reason = reason;
    this.emit({ t: 'end', winner, text: winner === null ? `引き分け（${reason}）` : `${SIDE_NAME[winner]}の勝ち（${reason}）` });
  }

  runToEnd() {
    this.start();
    while (!this.over) this.nextTurn();
    return this.winner;
  }
}

// ---------------------------------------------------------------------
// デッキの検証とおまかせ編成
// ---------------------------------------------------------------------
function validateDeck(deck, rules = []) {
  const errors = [];
  if (deck.length < RULES.DECK_MIN || deck.length > RULES.DECK_SIZE) errors.push(`デッキは${RULES.DECK_MIN}〜${RULES.DECK_SIZE}枚にしてください（今は${deck.length}枚）`);
  const units = deck.filter(id => !isArtifact(id));
  const arts = deck.length - units.length;
  if (units.length < RULES.MIN_UNITS) errors.push(`キャラカードが${RULES.MIN_UNITS}枚以上必要です（今は${units.length}枚）`);
  if (arts > RULES.MAX_ARTIFACTS) errors.push(`アーティファクトは${RULES.MAX_ARTIFACTS}枚までです（今は${arts}枚）`);
  const els = new Set(units.map(id => CARD_MAP[id].element));
  if (els.size > RULES.MAX_ELEMENTS) errors.push(`属性は${RULES.MAX_ELEMENTS}種類までです（今は${els.size}種類）`);
  for (const r of rules) {
    if (r.type === 'costLimit') {
      const over = deck.filter(id => getCard(id).cost > r.max);
      if (over.length) errors.push(`このクエストはコスト${r.max}以下のみ（${over.map(id => getCard(id).name).join('、')}が対象外）`);
    }
  }
  return errors;
}

function randomDeck(rng, rules = []) {
  const limit = (rules.find(r => r.type === 'costLimit') || {}).max || 99;
  const els = rng.shuffle(Object.keys(ELEMENTS)).slice(0, RULES.MAX_ELEMENTS);
  const pool = rng.shuffle(CARDS.filter(c => els.includes(c.element) && c.cost <= limit).map(c => c.id));
  const nArts = rng.int(RULES.MAX_ARTIFACTS + 1);
  const units = pool.slice(0, RULES.DECK_SIZE - nArts);
  const arts = rng.shuffle(ARTIFACTS.filter(a => a.cost <= limit).map(a => a.id)).slice(0, nArts);
  return { deck: [...units, ...arts], guardian: rng.pick(GUARDIANS).id, policy: rng.pick(Object.keys(POLICIES)), autoGuardian: true };
}


// =====================================================================
// 画面
// =====================================================================
const app = {
  server: null, chars: [], charMap: {}, tab: 'gacha', lastResults: [],
  selectMode: false, selected: new Set(),
  vf: { charId: '', rarity: '', titled: false, sort: 'new' },
  rk: { charId: '', stat: 'total_score', dir: 'desc', nature: NATURES[0] },
  busy: false,
  advSub: 'quest', deckFilter: '', battleSpeed: 1, sim: null
};

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
        <div class="cards">${results.map((ind, i) => `<button class="fcard r${ind.rarity}" data-i="${i}" aria-label="カードをめくる"><span class="flipper"><span class="face back"></span><span class="face front card r${ind.rarity}">${cardInner(ind)}</span></span></button>`).join('')}</div>
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
    const beat = line.length <= 12 && !quote;
    return `<p class="${quote ? 'q' : beat ? 'beat' : ''}">${esc(line)}</p>`;
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
  const pairs = rarity === 1 ? [['分類', c.category], ['種族', (c.tribes || []).join('・')], ...raw] : raw;
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

function openZukanPage(charId) {
  const byChar = zukanSummary();
  const g = byChar[charId];
  if (!g) { toast('ガチャで出会うと、図鑑のページが開きます'); return; }
  const c = app.charMap[charId];
  if (c.story && !STORIES[charId]) {
    openDialog('<p class="loading">図鑑の文章を読み込み中…</p>');
    loadStory(charId)
      .catch(() => { STORIES[charId] = {}; toast('図鑑の文章を読み込めませんでした'); })
      .then(() => openZukanPage(charId));
    return;
  }

  const idx = app.chars.indexOf(c) + 1;
  const mineCount = app.server.vault().filter(ind => ind.char_id === charId).length;
  const found = app.server.titleBook(charId);
  const storyData = STORIES[c.id] || {};
  const rarityOne = storyData['1'] || [];
  const rankPair = rarityOne.find(([key]) => key === 'ランク');
  const basicFacts = [
    ...(rankPair ? [['ランク', rankPair[1]]] : []),
    ['分類', c.category],
    ['種族', (c.tribes || []).join('・') || '—'],
    ['体重の基準', zukanMeasure(c.base_weight, 'kg')],
    ['身長の基準', zukanMeasure(c.base_height, 'cm')],
    ['すばやさ', zukanTrend(c, 'speed')],
    ['かしこさ', zukanTrend(c, 'wisdom')],
    ['うんのよさ', zukanTrend(c, 'luck')],
    ['出やすい性格', (c.likely_natures || []).join('・') || '—']
  ];
  const basicStory = rarityOne.length
    ? zukanStoryPairsHtml(rarityOne)
    : '<p class="muted small">★1の文章はまだ用意されていません。</p>';
  const storySections = [1, 2, 3, 4, 5].map(rarity => zukanStorySectionHtml(c, g, rarity)).join('');
  const hasLongStories = [1, 2, 3, 4, 5].some(rarity => g.max >= rarity && ((storyData[String(rarity)] || []).some(([, value]) => isLongZukanStory(value))));

  const variants = [
    { slot: 'base', label: '通常', need: 1 },
    { slot: 'r4', label: '別ポーズ', need: 4 },
    { slot: 'r5', label: '特別', need: 5 }
  ].filter(variant => variant.slot === 'base' || slotSrc(c, variant.slot));
  const variantButtons = variants.length > 1 ? `<div class="zukan-variants" aria-label="キャラ画像の切り替え">${variants.map(variant => {
    const locked = g.max < variant.need;
    return `<button data-art-slot="${variant.slot}" data-art-label="${variant.label}" aria-pressed="${variant.slot === 'base'}" ${locked ? 'disabled' : ''}>${esc(variant.label)}${locked ? `<small>★${variant.need}で開放</small>` : ''}</button>`;
  }).join('')}</div>` : '';

  const stamps = [1, 2, 3, 4, 5].map(rarity => `<span class="zukan-stamp ${g.rarities.has(rarity) ? `on${rarity}` : ''}" title="★${rarity}${g.rarities.has(rarity) ? ' 取得済み' : ' 未取得'}">★${rarity}</span>`).join('');
  const titleTags = TITLES.map(title => found.includes(title.id)
    ? `<em class="tag title" title="${esc(title.desc)}">${esc(title.name)}</em>`
    : '<em class="tag off">？？？</em>').join('');

  const hall = app.server.hall(charId);
  const hallMap = Object.fromEntries(hall.map(record => [`${record.stat}:${record.dir}`, record]));
  const recordFacts = RECORD_SPECS.map(([stat, dir]) => {
    const record = hallMap[`${stat}:${dir}`];
    return `<div class="zukan-fact"><dt>${esc(STAT_LABEL[stat])}（${esc(dirLabel(stat, dir))}）</dt><dd>${record ? `<b>${esc(fmtValue(stat, record.value))}</b><small>${esc(record.owner_name)}</small>` : '—'}</dd></div>`;
  }).join('');

  const body = openDialog(`
    <div class="zukan-page" style="--zukan-el:${elColor(c.element)}">
      <div class="zukan-page-tabs" role="tablist" aria-label="図鑑の項目">
        ${[['character', 'キャラ'], ['basic', '基本'], ['story', '物語'], ['battle', 'バトル'], ['records', '記録']].map(([key, label], i) => `<button role="tab" data-zukan-tab="${key}" aria-selected="${i === 0}">${label}</button>`).join('')}
      </div>
      <div class="zukan-panels">
        <section class="zukan-panel zukan-character-panel" data-zukan-panel="character" role="tabpanel">
          <div class="zukan-hero">
            <div class="zukan-art-stage">
              <span class="zukan-no">No.${String(idx).padStart(3, '0')}</span>
              <div class="zukan-stamps" aria-label="取得したスタンプ">${stamps}</div>
              <div class="zukan-hero-media" data-hero-media>${zukanHeroMediaHtml(c, 'base', '通常')}</div>
            </div>
            <div class="zukan-identity">
              <h2>${esc(c.name)}</h2>
              <div><span>種族</span>${(c.tribes || []).map(tribe => `<em>${esc(tribe)}</em>`).join('')}</div>
              ${variantButtons}
            </div>
          </div>
        </section>
        <section class="zukan-panel" data-zukan-panel="basic" role="tabpanel" hidden>
          <dl class="zukan-facts">${basicFacts.map(([label, value]) => `<div class="zukan-fact"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
          <h3 class="zukan-panel-title">★1の文章</h3>
          ${basicStory}
        </section>
        <section class="zukan-panel" data-zukan-panel="story" role="tabpanel" hidden>
          ${hasLongStories ? '<div class="story-tools"><button class="btn" id="openAllStories">すべて開く</button><button class="btn" id="closeAllStories">すべてたたむ</button></div>' : ''}
          ${storySections}
        </section>
        <section class="zukan-panel" data-zukan-panel="battle" role="tabpanel" hidden><div data-card-detail></div></section>
        <section class="zukan-panel" data-zukan-panel="records" role="tabpanel" hidden>
          <h3 class="zukan-panel-title">見つけた称号 ${found.length} / ${TITLES.length}</h3>
          <div class="title-list">${titleTags}</div>
          <p class="muted small">称号は、個体値がとびぬけている個体に付きます。</p>
          <h3 class="zukan-panel-title">世界記録</h3>
          <dl class="zukan-facts zukan-records">${recordFacts}</dl>
          <button class="btn primary wide" id="seeMine" ${mineCount ? '' : 'disabled'}>保管庫のこのキャラを見る（${mineCount}体）</button>
        </section>
      </div>
    </div>`, 'zukan');

  body.querySelectorAll('[data-zukan-tab]').forEach(button => {
    button.onclick = () => {
      body.querySelectorAll('[data-zukan-tab]').forEach(tab => tab.setAttribute('aria-selected', String(tab === button)));
      body.querySelectorAll('[data-zukan-panel]').forEach(panel => { panel.hidden = panel.dataset.zukanPanel !== button.dataset.zukanTab; });
    };
  });
  body.querySelectorAll('[data-art-slot]').forEach(button => {
    button.onclick = () => {
      body.querySelector('[data-hero-media]').innerHTML = zukanHeroMediaHtml(c, button.dataset.artSlot, button.dataset.artLabel);
      body.querySelectorAll('[data-art-slot]').forEach(choice => choice.setAttribute('aria-pressed', String(choice === button)));
    };
  });
  const storyPanel = body.querySelector('[data-zukan-panel="story"]');
  const openAll = body.querySelector('#openAllStories'), closeAll = body.querySelector('#closeAllStories');
  if (openAll) openAll.onclick = () => storyPanel.querySelectorAll('details.story').forEach(detail => { detail.open = true; });
  if (closeAll) closeAll.onclick = () => storyPanel.querySelectorAll('details.story').forEach(detail => { detail.open = false; });
  const mineButton = body.querySelector('#seeMine');
  if (mineButton) mineButton.onclick = () => {
    app.vf = { ...app.vf, charId, rarity: '', titled: false };
    closeDialog();
    show('vault');
  };
  const cardRoot = body.querySelector('[data-card-detail]');
  const refreshCard = () => mountCardDetail(cardRoot, charId, { refresh: refreshCard, showImage: false });
  refreshCard();
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
  if (app.tab === 'adventure' && (app.advSub || 'quest') === 'daily') {
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
      <button class="btn" id="dbgSim">バランス検証</button>
      <button class="btn danger" id="dbgReset">データを消す</button>
    </div>`);
  body.querySelector('#nameSave').onclick = () => {
    try { app.server.setName(body.querySelector('#nameInput').value); toast('名前を変更しました'); } catch (e) { toast(e.message); }
  };
  body.querySelector('#sSound').onchange = e => { app.server.setSetting('sound', e.target.checked); if (e.target.checked) Sound.coin(); };
  body.querySelector('#sFx').onchange = e => app.server.setSetting('effects', e.target.value);
  body.querySelector('#sImages').onclick = () => openImageManager();
  body.querySelector('#dbgCoins').onclick = () => { app.server.debugAddCoins(1000); gained(1000, 'テスト'); };
  body.querySelector('#dbgSim').onclick = () => openSim();
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
    const freshGuardians = app.server.newGuardianUnlocks();
    app.chars = app.server.characters;
    app.charMap = app.server.charMap;
    renderCoins();
    show('gacha');
    showLoginBonus(app.server.dailyLogin());
    if (freshGuardians.length) setTimeout(() => toast(`守護者「${freshGuardians.map(g => g.name).join('・')}」が仲間になりました！`), 500);
    setInterval(tick, 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !app.server) return;
      const info = app.server.dailyLogin();
      if (info) showLoginBonus(info);
      if (!$('.show')) render();
    });
  } catch (e) {
    $('#main').innerHTML = `<p class="error">起動できませんでした：${esc(e.message)}</p>`;
  }
}

if (typeof document !== 'undefined' && document.getElementById('main')) boot();


// =====================================================================
// バトルの画面（冒険タブの「クエスト」「デッキ」）
// =====================================================================
const elColor = el => (ELEMENTS[el] || {}).color || '#1E2A4A';

function guardianArt(g, size, hidden = false) { return art(g, { rarity: 1, size, hidden }); }
function guardianAbilitiesHtml(g) {
  return `${g.passive ? `<div class="bc-sec"><h3>常時効果「${esc(g.passive.name)}」</h3>${esc(g.passive.text)}</div>` : ''}
    ${g.skills.map(s => `<div class="bc-sec"><h3>スキル「${esc(s.name)}」 <small>残り${s.uses}回</small></h3>${esc(s.text)}</div>`).join('')}
    <div class="bc-sec"><h3>必殺技「${esc(g.ultimate.name)}」 <small>ゲージ100</small></h3>${esc(g.ultimate.text)}</div>`;
}

function renderAdventure() {
  const main = $('#main');
  const sub = app.advSub || 'quest';
  const dailyCount = app.server.missions().filter(m => m.claimable).length + app.server.expeditions().filter(e => e.done).length;
  main.innerHTML = `
    <div class="adv-seg" role="tablist">
      <button data-sub="quest" aria-pressed="${sub === 'quest'}">クエスト</button>
      <button data-sub="deck" aria-pressed="${sub === 'deck'}">デッキ</button>
      <button data-sub="guardian" aria-pressed="${sub === 'guardian'}">守護者</button>
      <button data-sub="daily" aria-pressed="${sub === 'daily'}">日課・探索${dailyCount ? `<span class="dotn">${dailyCount}</span>` : ''}</button>
    </div>
    <div id="advBody"></div>`;
  main.querySelectorAll('[data-sub]').forEach(b => { b.onclick = () => { app.advSub = b.dataset.sub; window.scrollTo(0, 0); renderAdventure(); }; });
  const box = $('#advBody');
  ({ quest: renderQuestList, deck: renderDeckBuilder, guardian: renderGuardians, daily: renderDaily })[sub](box);
}

function renderGuardians(box) {
  const s = app.server;
  const visible = GUARDIANS.filter(g => g.unlock.type !== 'none');
  box.innerHTML = `<section class="panel"><h2 style="margin:0 0 4px">守護者図鑑</h2><p class="small muted" style="margin:0">カードとは別に1体選び、専用HPと能力でバトルを支えます。</p></section>
    <div class="zgrid">${visible.map((g, i) => { const unlocked = s.isGuardianUnlocked(g.id); return `<button class="zcell" data-guardian="${g.id}" ${unlocked ? '' : 'disabled'}>
      <span class="no">Guardian No.${String(i + 1).padStart(3, '0')}</span>${guardianArt(g, 72, !unlocked)}
      <span class="zname">${unlocked ? esc(g.name) : '？？？'}</span><span class="small muted">${unlocked ? `HP ${g.hp}` : esc(s.guardianUnlockText(g))}</span></button>`; }).join('')}</div>`;
  box.querySelectorAll('[data-guardian]').forEach(b => { b.onclick = () => openGuardianDetail(b.dataset.guardian); });
}

function openGuardianDetail(id) {
  const g = GUARDIAN_MAP[id];
  if (!g || !app.server.isGuardianUnlocked(g.id)) return;
  if (g.story && !STORIES[id]) {
    openDialog('<p class="loading">守護者の記録を読み込み中…</p>');
    loadStory(id).catch(() => { STORIES[id] = {}; toast('記録を読み込めませんでした'); }).then(() => openGuardianDetail(id));
    return;
  }
  const stories = [1, 2, 3, 4, 5].map(r => {
    const pairs = (STORIES[id] || {})[String(r)] || [];
    return `<section class="zsec"><h3>${starsHtml(r)}</h3>${pairs.length ? zukanStoryPairsHtml(pairs) : '<p class="muted small">この段階の記録はまだありません。</p>'}</section>`;
  }).join('');
  openDialog(`<div class="zukan-page"><div class="zukan-hero"><div class="zukan-hero-media">${zukanHeroMediaHtml(g, 'base', '全身')}</div></div>
    <div class="bigcard"><h2>${esc(g.name)}</h2><p class="muted">${esc(g.title)}　HP ${g.hp}</p>${guardianAbilitiesHtml(g)}</div>${stories}</div>`);
}

function deckChips(deck) {
  return deck.map(id => isArtifact(id)
    ? `<span class="chip art-chip">${ARTIFACT_MAP[id].icon} ${esc(ARTIFACT_MAP[id].name)}</span>`
    : `<span class="chip" style="--el:${elColor(CARD_MAP[id].element)}">${esc(CARD_MAP[id].name)}</span>`).join('');
}

function artifactArt(a, size) {
  const src = ImageStore.cache[`${a.id}:base`] || imagePath(a, 'base', size <= 72);
  const inner = src ? `<img src="${esc(src)}" alt="">` : `<span class="art-icon" style="font-size:${Math.round(size * 0.62)}px">${a.icon}</span>`;
  return `<span class="art artifact-art" style="width:${size}px;height:${size}px;--ac:${a.color}">${inner}</span>`;
}

function artifactMini(a, { inDeck = false, owned = true } = {}) {
  return `<button class="mcard artifact ${inDeck ? 'in' : ''} ${owned ? '' : 'unowned'}" data-artifact="${a.id}" style="--el:${a.color}">
    <span class="m-cost">${a.cost}</span>${inDeck ? '<span class="m-in">入</span>' : ''}
    ${artifactArt(a, 52)}
    <span class="m-name">${esc(a.name)}</span>
    <span class="m-kw">${ARTIFACT_MODES[a.mode].name}</span>
    ${owned ? '' : `<span class="m-price">${num(a.price)}コイン</span>`}
  </button>`;
}

function openArtifactDetail(id) {
  const s = app.server;
  const a = ARTIFACT_MAP[id];
  const d = s.deckState();
  const owned = s.ownedArtifacts().includes(id);
  const inDeck = d.deck.includes(id);
  const artsInDeck = d.deck.filter(isArtifact).length;
  const body = openDialog(`
    <div class="bigcard" style="--el:${a.color}">
      <div class="bc-head">
        <span class="bc-cost">${a.cost}</span>
        ${artifactArt(a, 64)}
        <div><h2>${esc(a.name)}</h2><span class="chip art-chip">アーティファクト・${ARTIFACT_MODES[a.mode].name}</span></div>
      </div>
      <div class="bc-sec"><h3>効果</h3><b>${esc(a.text)}</b></div>
      <div class="bc-sec"><h3>${ARTIFACT_MODES[a.mode].name}とは</h3>${ARTIFACT_MODES[a.mode].desc}</div>
      <div class="bc-sec small muted">場には出ないので、前列・後列の枠を使いません。バトルでは、効果が役に立つ場面で自動的に使われます。デッキには${RULES.MAX_ARTIFACTS}枚まで入れられます。</div>
    </div>
    ${owned
      ? `<button class="btn ${inDeck ? '' : 'primary'} wide" id="toggleArt" style="margin-top:10px">${inDeck ? 'デッキから外す' : 'デッキに入れる'}</button>`
      : `<button class="btn gold wide" id="buyArt" style="margin-top:10px">工房で作る（${num(a.price)}コイン）</button>`}`);
  const tg = body.querySelector('#toggleArt');
  if (tg) tg.onclick = () => {
    try {
      if (!inDeck && artsInDeck >= RULES.MAX_ARTIFACTS) { toast(`アーティファクトは${RULES.MAX_ARTIFACTS}枚までです`); return; }
      const next = inDeck ? d.deck.filter(x => x !== id) : [...d.deck, id];
      if (!inDeck && next.length > RULES.DECK_SIZE) { toast(`デッキは${RULES.DECK_SIZE}枚までです`); return; }
      s.setDeck({ deck: next });
      closeDialog();
      if (app.tab === 'adventure') renderAdventure();
    } catch (e) { toast(e.message); }
  };
  const by = body.querySelector('#buyArt');
  if (by) by.onclick = () => {
    try {
      s.buyArtifact(id);
      renderCoins(true); Sound.coin();
      toast(`「${a.name}」を作りました`);
      openArtifactDetail(id);
      if (app.tab === 'adventure') renderAdventure();
    } catch (e) { toast(e.message); }
  };
}

// ---------------------------------------------------------------------
// クエスト一覧
// ---------------------------------------------------------------------
function renderQuestList(box) {
  const s = app.server;
  const d = s.deckState();
  const errors = s.deckErrors();
  const ownedCount = s.ownedCharIds().length;
  const guardian = GUARDIAN_MAP[d.guardian];

  box.innerHTML = `
    <section class="panel">
      <div class="deck-head"><b>${d.deck.length}</b><span>/ ${RULES.DECK_SIZE}枚のデッキ</span>
        ${guardian ? `<span class="small muted" style="margin-left:auto">守護者 ${esc(guardian.name)}・作戦「${POLICIES[d.policy].name}」</span>` : ''}</div>
      ${d.deck.length ? `<div class="deck-strip">${deckChips(d.deck)}</div>` : ''}
      ${ownedCount < RULES.DECK_MIN
        ? `<p class="small" style="margin:8px 0 0">カードとして使えるキャラが足りません（${ownedCount} / ${RULES.DECK_MIN}体）。ガチャで出会ったキャラは、図鑑に登録されるとカードとして使えます。</p>
           <button class="btn primary wide" style="margin-top:8px" id="goGacha">ガチャへ</button>`
        : `${errors.length ? `<ul class="errors">${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
           <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px">
             <button class="btn" id="editDeck">デッキを編集</button>
             <button class="btn primary" id="autoDeck">おまかせで組む</button>
           </div>`}
    </section>
    <details class="panel">
      <summary><b>バトルの遊び方</b></summary>
      <p class="small" style="margin:6px 0 0">バトルは自動で進みます。守護者のスキルを予約すると次のターンに発動します。必殺技はゲージ100で1バトルに1回だけ使えます。前列と後列の戦い方、★3の型・★4の縁・★5の奥義はこれまでどおりです。</p>
    </details>
    ${QUESTS.map(q => {
      const st = s.questStatus(q.id);
      return `<button class="quest" data-quest="${q.id}">
        <h3><span class="lv">Lv.${q.level}</span>${esc(q.name)}${st.cleared ? '<span class="clear">クリア</span>' : ''}</h3>
        <p>${esc(q.story)}</p>
        <div class="rules">${q.rules.map(r => `<span class="chip rule">${esc(ruleText(r))}</span>`).join('')}${q.goalTurns ? `<span class="chip rule">勝利条件：${q.goalTurns}ターン以内に勝つ</span>` : ''}</div>
        <div class="quest-reward">${st.cleared
          ? `<span>勝利 +${num(q.reward.repeat)}コイン</span><span class="muted" style="background:none;font-weight:500">今日の報酬 あと${st.dailyLeft}回</span>`
          : `<span>初回クリア +${num(q.reward.first)}コイン</span>`}</div>
      </button>`;
    }).join('')}`;

  const goG = box.querySelector('#goGacha');
  if (goG) goG.onclick = () => show('gacha');
  const ed = box.querySelector('#editDeck');
  if (ed) ed.onclick = () => { app.advSub = 'deck'; renderAdventure(); };
  const au = box.querySelector('#autoDeck');
  if (au) au.onclick = () => { s.autoDeck(); toast('手持ちのキャラでデッキを組みました'); renderAdventure(); };
  box.querySelectorAll('[data-quest]').forEach(b => { b.onclick = () => openQuest(b.dataset.quest); });
}

function openQuest(id) {
  const s = app.server;
  const q = QUESTS.find(x => x.id === id);
  const st = s.questStatus(id);
  const d = s.deckState();
  const errors = s.deckErrors(q.rules);
  const enemyGuardian = GUARDIAN_MAP[q.enemy.guardian];
  const myGuardian = GUARDIAN_MAP[d.guardian];
  const body = openDialog(`
    <h2 style="margin:0">${esc(q.name)}</h2>
    <p class="muted small" style="margin:2px 0 10px">${esc(q.story)}</p>
    <div class="panel" style="background:#fff;display:flex;gap:10px;align-items:center">
      ${guardianArt(enemyGuardian, 64)}
      <div><b>${esc(q.enemy.name)}</b><br><span class="small">守護者：${esc(enemyGuardian.name)}　HP ${q.enemy.guardianHp || enemyGuardian.hp}<br>作戦「${POLICIES[q.enemy.policy].name}」</span><br>
      <span class="small muted">${esc(enemyGuardian.passive?.text || enemyGuardian.title)}</span></div>
    </div>
    ${q.rules.length || q.goalTurns ? `<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px">${q.rules.map(r => `<span class="chip rule">${esc(ruleText(r))}</span>`).join('')}${q.goalTurns ? `<span class="chip rule">勝利条件：${q.goalTurns}ターン以内に勝つ</span>` : ''}</div>` : ''}
    <div class="quest-reward" style="margin:0 0 10px">${st.cleared
      ? (st.dailyLeft ? `<span>勝利 +${num(q.reward.repeat)}コイン（今日あと${st.dailyLeft}回）</span>` : '<span>今日の報酬は受け取り済み（練習はできます）</span>')
      : `<span>初回クリア +${num(q.reward.first)}コイン</span>`}</div>
    <div class="panel" style="background:#fff">
      <b>あなたのデッキ</b>${myGuardian ? `<span class="small">　守護者：${esc(myGuardian.name)}　作戦「${POLICIES[d.policy].name}」</span>` : ''}
      <div class="deck-strip">${deckChips(d.deck)}</div>
      ${errors.length ? `<ul class="errors">${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
    </div>
    <button class="btn danger wide" id="startQ" ${errors.length ? 'disabled' : ''}>挑戦する</button>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px">
      <button class="btn" id="editDeckQ">デッキを編集</button>
      <button class="btn" id="autoQ">このクエスト用におまかせ</button>
    </div>`);
  body.querySelector('#startQ').onclick = () => { closeDialog(); startBattle(q); };
  body.querySelector('#editDeckQ').onclick = () => { closeDialog(); app.advSub = 'deck'; show('adventure'); };
  body.querySelector('#autoQ').onclick = () => { s.autoDeck(q.rules); toast('このクエストに合わせてデッキを組みました'); openQuest(id); if (app.tab === 'adventure') renderAdventure(); };
}

// ---------------------------------------------------------------------
// デッキ編集
// ---------------------------------------------------------------------
function renderDeckBuilder(box) {
  const s = app.server;
  const d = s.deckState();
  const errors = s.deckErrors();
  const owned = s.ownedCharIds();
  const curve = Array.from({ length: 8 }, (_, i) => d.deck.filter(id => Math.min(8, getCard(id).cost) === i + 1).length);
  const maxC = Math.max(1, ...curve);
  const units = d.deck.filter(id => !isArtifact(id));
  const artCount = d.deck.length - units.length;
  const elCount = {};
  units.forEach(id => { const e = CARD_MAP[id].element; elCount[e] = (elCount[e] || 0) + 1; });
  const guardian = GUARDIAN_MAP[d.guardian];
  const guardianChoices = GUARDIANS.filter(g => g.unlock.type !== 'none');
  const showArts = !app.deckFilter || app.deckFilter === '__art';
  const pool = app.deckFilter === '__art' ? [] : owned.map(id => CARD_MAP[id]).filter(c => !app.deckFilter || c.element === app.deckFilter).sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
  const ownedArts = s.ownedArtifacts();

  box.innerHTML = `
    <section class="panel">
      <div class="deck-head"><b>${d.deck.length}</b><span>/ ${RULES.DECK_SIZE}枚（キャラ${units.length}・道具${artCount}）</span>
        <span style="margin-left:auto;display:flex;gap:3px;flex-wrap:wrap">${Object.entries(elCount).map(([e, n]) => `<span class="chip" style="--el:${elColor(e)}">${e} ${n}</span>`).join('')}</span></div>
      <div class="curve">${curve.map(n => `<div style="height:${n / maxC * 100}%"></div>`).join('')}</div>
      <div class="curve-labels">${curve.map((n, i) => `<span>${i + 1}${i === 7 ? '+' : ''}</span>`).join('')}</div>
      <label class="field">守護者
        <select id="guardianSel">${guardianChoices.map(g => `<option value="${g.id}" ${g.id === d.guardian ? 'selected' : ''} ${s.isGuardianUnlocked(g.id) ? '' : 'disabled'}>${s.isGuardianUnlocked(g.id) ? esc(g.name) : '？？？（' + esc(s.guardianUnlockText(g)) + '）'}</option>`).join('')}</select>
        ${guardian ? `<span class="muted" style="font-weight:500;display:flex;align-items:center;gap:8px">${guardianArt(guardian, 48)}<span>HP ${guardian.hp}<br>${esc(guardian.passive?.text || guardian.title)}</span></span>` : ''}
      </label>
      ${guardian ? `<div class="small" style="margin:-4px 0 10px">${guardian.skills.map(s => `<b>${esc(s.name)}</b>（${s.uses}回）：${esc(s.text)}`).join('<br>')}<br><b>${esc(guardian.ultimate.name)}</b>：${esc(guardian.ultimate.text)}</div>` : ''}
      <div class="field">作戦
        <div class="seg">${Object.entries(POLICIES).map(([k, p]) => `<button data-policy="${k}" aria-pressed="${k === d.policy}">${p.name}</button>`).join('')}</div>
        <span class="muted" style="font-weight:500">${POLICIES[d.policy].desc}</span>
      </div>
      <div class="presets"><button class="btn" id="autoDeck2">おまかせで組む</button><button class="btn" id="clearDeck" ${d.deck.length ? '' : 'disabled'}>デッキを空にする</button></div>
      <p class="small muted" style="margin:6px 0 0">${RULES.DECK_MIN}〜${RULES.DECK_SIZE}枚、キャラカード${RULES.MIN_UNITS}枚以上、アーティファクト${RULES.MAX_ARTIFACTS}枚まで。</p>
      ${errors.length && d.deck.length ? `<ul class="errors">${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
    </section>
    <div class="filter">
      <button data-filter="" aria-pressed="${!app.deckFilter}">すべて</button>
      ${Object.keys(ELEMENTS).map(e => `<button data-filter="${e}" style="--el:${elColor(e)}" aria-pressed="${app.deckFilter === e}">${e}</button>`).join('')}
      <button data-filter="__art" style="--el:#34436C" aria-pressed="${app.deckFilter === '__art'}">アーティファクト</button>
    </div>
    ${app.deckFilter === '__art' ? '' : `<p class="small muted" style="margin:0 0 6px">使えるカード ${owned.length} / ${CHARACTERS.length}枚。ガチャで出会ったキャラが増えます。タップで詳しく見て、出し入れできます。</p>
    <div class="pool">${pool.map(c => {
      const max = s.maxRarity(c.id);
      const inDeck = d.deck.includes(c.id);
      return `<button class="mcard ${inDeck ? 'in' : ''}" data-card="${c.id}" style="--el:${elColor(c.element)}">
        <span class="m-cost">${c.cost}</span>${inDeck ? '<span class="m-in">入</span>' : ''}
        ${art(app.charMap[c.id], { rarity: max, size: 52 })}
        <span class="m-name">${esc(c.name)}</span>
        ${starsHtml(max)}
        <span class="m-stats"><span class="atk">${c.atk}</span> / <span class="hp">${c.hp}</span></span>
        <span class="m-kw">${c.keywords.join('・') || (c.ability ? '固有能力' : '')}</span>
      </button>`;
    }).join('')}</div>
    ${pool.length ? '' : '<p class="muted">この属性のカードはまだありません。</p>'}`}
    ${showArts ? `
      <h2 class="sec" style="margin-top:16px">アーティファクト</h2>
      <p class="small muted" style="margin:0 0 6px">場に出ず、能力を発動するだけのカードです。「発動」は使うとすぐ効果が出て、「設置」は置いている間ずっと効果が続きます。</p>
      <div class="pool">${ownedArts.map(id => artifactMini(ARTIFACT_MAP[id], { inDeck: d.deck.includes(id) })).join('')}</div>
      ${ARTIFACTS.some(a => !ownedArts.includes(a.id)) ? `
        <h2 class="sec" style="margin-top:16px">工房</h2>
        <p class="small muted" style="margin:0 0 6px">コインを使って、新しいアーティファクトを作れます。</p>
        <div class="pool">${ARTIFACTS.filter(a => !ownedArts.includes(a.id)).map(a => artifactMini(a, { owned: false })).join('')}</div>` : ''}` : ''}`;

  const sel = box.querySelector('#guardianSel');
  if (sel) sel.onchange = e => { s.setDeck({ guardian: e.target.value }); renderAdventure(); };
  box.querySelectorAll('[data-policy]').forEach(b => { b.onclick = () => { s.setDeck({ policy: b.dataset.policy }); renderAdventure(); }; });
  box.querySelector('#autoDeck2').onclick = () => { s.autoDeck(); toast('手持ちのキャラでデッキを組みました'); renderAdventure(); };
  box.querySelector('#clearDeck').onclick = () => { s.setDeck({ deck: [] }); renderAdventure(); };
  box.querySelectorAll('[data-filter]').forEach(b => { b.onclick = () => { app.deckFilter = b.dataset.filter; renderAdventure(); }; });
  box.querySelectorAll('[data-card]').forEach(b => { b.onclick = () => openCardDetail(b.dataset.card); });
  box.querySelectorAll('[data-artifact]').forEach(b => { b.onclick = () => openArtifactDetail(b.dataset.artifact); });
}

function cardDetailHtml(id, { showImage = true } = {}) {
  const s = app.server;
  const c = CARD_MAP[id];
  const ch = app.charMap[id];
  const d = s.deckState();
  const inDeck = d.deck.includes(id);
  const m = s.cardMods(id);
  const bonds = bondsOf(id);
  const plus = n => n ? `<small style="font-size:12px">${n > 0 ? '+' : ''}${n}</small>` : '';
  const ult = c.ultimate || ULTIMATES[c.element];
  const rep = m.rep;
  const repInd = rep ? s.vault().find(i => i.uid === rep.uid) : null;

  return `
    <div class="bigcard" style="--el:${elColor(c.element)}">
      <div class="bc-head">
        <span class="bc-cost">${c.cost}</span>
        ${showImage ? art(ch, { rarity: m.max, size: 64 }) : ''}
        <div><h2>${esc(c.name)}</h2>
          ${starsHtml(m.max)}
          <span class="chip" style="--el:${elColor(c.element)}">${c.element}</span>
          ${c.tribes.map(t => `<span class="chip soft">${esc(t)}</span>`).join(' ')}</div>
      </div>
      <div class="bc-stats">
        <div>攻撃<b class="atk">${Math.max(0, c.atk + m.atk)}${plus(m.atk)}</b></div>
        <div>体力<b class="hp">${Math.max(1, c.hp + m.hp)}${plus(m.hp)}</b></div>
        <div>速さ<b>${c.speed + m.speed}${plus(m.speed)}</b></div>
      </div>
      <div class="upgrades">
        <div class="${m.max >= 3 ? 'on' : ''}"><b>★3 型</b>${m.max >= 3 ? STANCES[m.stance].name : '未開放'}</div>
        <div class="${m.max >= 4 ? 'on' : ''}"><b>★4 縁</b>${m.max >= 4 ? '使える' : (bonds.length ? '未開放' : '縁なし')}</div>
        <div class="${m.max >= 5 ? 'on' : ''}"><b>★5 奥義</b>${m.max >= 5 ? esc(ult.name) : '未開放'}</div>
      </div>
      ${m.max >= 3 ? `<div class="field" style="margin-top:0">型を選ぶ
        <div class="seg">${Object.entries(STANCES).map(([k, v]) => `<button data-stance="${k}" aria-pressed="${k === m.stance}">${v.name}</button>`).join('')}</div>
        <span class="muted" style="font-weight:500">攻め型は攻撃+1・体力-1、守り型は攻撃-1・体力+1</span></div>` : ''}
      <div class="bc-sec"><h3>代表個体（オマケ）</h3>${repInd
        ? `#${pad6(repInd.serial)} ${starsHtml(repInd.rarity)} ${rep.title ? `称号「${esc(titleName(rep.title))}」→ ${BONUS_WORDS[rep.bonus]}` : '称号なし（オマケなし）'}
           <button class="btn" id="seeRep" style="font-size:12px;padding:1px 8px;margin-left:4px">個体票</button>`
        : '<span class="muted">保管庫にこのキャラの個体がいません（カードは使えます）</span>'}
        <div class="muted small">称号が多い個体が自動で選ばれます。</div></div>
      ${c.keywords.length ? `<div class="bc-sec"><h3>キーワード</h3>${c.keywords.map(k => `<div class="kwline"><b>${k}</b><span>${KEYWORDS[k].desc}</span></div>`).join('')}</div>` : ''}
      <div class="bc-sec"><h3>固有能力</h3><span class="skill-name">「${esc(c.skill)}」</span><br>${c.ability ? esc(c.text) : '<span class="muted">キーワードの力で戦う（固有能力なし）</span>'}</div>
      ${c.costRule && c.costRule.type === 'perDeath' ? `<div class="bc-sec"><h3>コスト変化</h3>場のカードが1体倒れるごとにコスト−${c.costRule.amount}（最低${c.costRule.min}）</div>` : ''}
      ${bonds.length ? `<div class="bc-sec"><h3>縁（★4で使える）</h3>${bonds.map(b => `「${esc(b.name)}」：${esc(CARD_MAP[b.partner].name)}と一緒に場にいると、2体とも攻撃+1・体力+1`).join('<br>')}</div>` : ''}
      <div class="bc-sec"><h3>奥義（★5で使える）</h3>「${esc(ult.name)}」登場時に1回：${esc(ultimateEffectText(ult))}</div>
      <div class="bc-sec small muted">自動計算：点数 ${c.points.budget}（コスト×2+3）− キーワード ${c.points.keywords} − 固有能力 ${c.points.ability} → 攻撃${c.atk}・体力${c.hp}</div>
    </div>
    <button class="btn ${inDeck ? '' : 'primary'} wide" id="toggleCard" style="margin-top:10px">${inDeck ? 'デッキから外す' : 'デッキに入れる'}</button>`;
}

// 図鑑とデッキ編集で同じバトル詳細を使う
function mountCardDetail(root, id, { refresh = null, closeAfterToggle = false, showImage = true } = {}) {
  const s = app.server;
  const d = s.deckState();
  const inDeck = d.deck.includes(id);
  const m = s.cardMods(id);
  const rep = m.rep;
  root.innerHTML = cardDetailHtml(id, { showImage });
  const rerender = refresh || (() => mountCardDetail(root, id, { closeAfterToggle, showImage }));

  root.querySelectorAll('[data-stance]').forEach(button => {
    button.onclick = () => {
      s.setStance(id, button.dataset.stance);
      rerender();
    };
  });
  const seeRep = root.querySelector('#seeRep');
  if (seeRep && rep) seeRep.onclick = () => openDetail(rep.uid);
  root.querySelector('#toggleCard').onclick = () => {
    try {
      const next = inDeck ? d.deck.filter(x => x !== id) : [...d.deck, id];
      if (!inDeck && next.length > RULES.DECK_SIZE) { toast(`デッキは${RULES.DECK_SIZE}枚までです`); return; }
      s.setDeck({ deck: next });
      if (closeAfterToggle) {
        closeDialog();
        if (app.tab === 'adventure') renderAdventure();
      } else rerender();
    } catch (e) { toast(e.message); }
  };
}

function openCardDetail(id) {
  const body = openDialog('<div data-card-detail></div>');
  mountCardDetail(body.querySelector('[data-card-detail]'), id, { refresh: () => openCardDetail(id), closeAfterToggle: true });
}

// ---------------------------------------------------------------------
// バトル観戦
// ---------------------------------------------------------------------
const BATTLE_DELAYS = { start: 300, turn: 750, play: 420, attack: 380, damage: 260, block: 320, heal: 260, buff: 260, status: 260, shield: 280, ability: 700, bond: 900, death: 360, revive: 520, leaderDamage: 360, leaderHeal: 300, guardian: 850, frozen: 380, counter: 260, reveal: 220, poison: 260, info: 180, rule: 550, boss: 800, end: 200 };

function startBattle(q) {
  let battle;
  try { battle = app.server.createQuestBattle(q.id); } catch (e) { toast(e.message); return; }
  const view = { q, battle, speed: app.battleSpeed || 1, skipping: false, pendingAction: null, log: [], closed: false };
  const guardian = battle.p[0].guardian;
  const el = document.createElement('div');
  el.className = 'battle';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'バトル');
  el.innerHTML = `
    <div class="b-top">
      <span class="title">${esc(q.name)}</span>
      <span class="turn" id="bTurn">準備</span>
      <span class="spd">${[1, 2, 4].map(sp => `<button data-spd="${sp}" aria-pressed="${sp === view.speed}">×${sp}</button>`).join('')}<button data-skip>結果へ</button></span>
    </div>
    <div class="b-field" id="bField">
      <div class="leader" id="leader1"></div>
      <div class="b-rows foe"><div class="row3" id="row-1-back"></div><div class="row3" id="row-1-front"></div></div>
      <div class="midline">${q.rules.filter(r => r.type === 'laneNoFlying').map(r => `${['左', '中央', '右'][r.lane]}の列は霧（飛行できない）　`).join('')}<span class="stat-legend"><span style="color:#FF8A95">${STAT_ICONS.atk}攻撃</span><span style="color:#6EE7A8">${STAT_ICONS.hp}体力</span><span style="color:#8FC2FF">${STAT_ICONS.spd}速さ</span></span></div>
      <div class="b-rows me"><div class="row3" id="row-0-front"></div><div class="row3" id="row-0-back"></div></div>
      <div class="leader" id="leader0"></div>
    </div>
    <div class="b-bottom">
      ${guardian.skills.map((skill, i) => `<button class="cmd" data-action="skill${i}" aria-pressed="false">${esc(skill.name)}<small>残り${skill.uses}回</small></button>`).join('')}
      <button class="cmd" data-action="ultimate" aria-pressed="false">${esc(guardian.ultimate.name)}<small>0%</small></button>
      <button class="logbtn" id="bLog">記録</button>
    </div>`;
  document.body.appendChild(el);
  document.body.classList.add('noscroll');
  view.el = el;

  for (const side of [0, 1]) for (const row of ['front', 'back']) {
    el.querySelector(`#row-${side}-${row}`).innerHTML = [0, 1, 2].map(l => `<div class="slot ${row === 'back' ? 'back-row' : ''}" data-slot="${side}-${row}-${l}"></div>`).join('');
  }
  el.querySelectorAll('[data-spd]').forEach(b => {
    b.onclick = () => { view.speed = app.battleSpeed = Number(b.dataset.spd); el.querySelectorAll('[data-spd]').forEach(x => x.setAttribute('aria-pressed', x === b)); };
  });
  el.querySelector('[data-skip]').onclick = () => { view.skipping = true; };
  el.querySelectorAll('[data-action]').forEach(b => {
    b.onclick = () => {
      if (!battle.guardianActionAvailable(0, b.dataset.action) || battle.over) return;
      view.pendingAction = view.pendingAction === b.dataset.action ? null : b.dataset.action;
      Sound.click();
      updateGuardianButtons(view);
    };
  });
  el.querySelector('#bLog').onclick = () => openBattleLog(view);
  el.querySelector('#bField').addEventListener('click', e => {
    const t = e.target.closest('.unit');
    if (t) openUnitInfo(view, Number(t.dataset.uid));
  });
  runBattle(view);
}

function updateGuardianButtons(view) {
  const pl = view.battle.p[0];
  view.el.querySelectorAll('[data-action]').forEach(b => {
    const action = b.dataset.action;
    const on = view.pendingAction === action;
    b.setAttribute('aria-pressed', on);
    b.disabled = !view.battle.guardianActionAvailable(0, action) || view.battle.over;
    if (on) b.querySelector('small').textContent = '次ターン';
    else if (action === 'ultimate') b.querySelector('small').textContent = pl.guardianUltimateUsed ? '使用済み' : `${pl.guardianGauge}%`;
    else { const i = Number(action.slice(-1)); b.querySelector('small').textContent = `残り${pl.guardianSkillUses[i]}回`; }
  });
}

async function runBattle(view) {
  const { battle } = view;
  let queue = battle.start();
  updateGuardianButtons(view);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  while (!view.closed) {
    if (!queue.length) {
      if (battle.over) break;
      const action = view.pendingAction;
      view.pendingAction = null;
      queue = battle.nextTurn({ 0: action });
      updateGuardianButtons(view);
      continue;
    }
    while (view.paused && !view.closed && !view.skipping) await sleep(120);
    const ev = queue.shift();
    view.log.push(ev);
    if (view.skipping) { if (!queue.length) await sleep(0); continue; }
    showBattleEvent(view, ev);
    await sleep((BATTLE_DELAYS[ev.t] || 250) / view.speed);
  }
  if (view.closed) return;
  const last = view.log[view.log.length - 1];
  if (last) { renderBattleSnap(view, last.snap); view.el.querySelector('#bTurn').textContent = `ターン ${battle.turn}`; }
  showBattleResult(view);
}

function unitArt(u, size) {
  if (u.token) return `<span class="art" style="width:${size}px;height:${size}px">${placeholderSvg({ hue: u.hue, shape: 0 }, null, false, 1, 1).replace('<svg viewBox="0 0 100 100"', '<svg preserveAspectRatio="xMinYMid meet" viewBox="0 0 100 100"')}</span>`;
  const rarity = u.side === 0 ? app.server.maxRarity(u.cardId) : 1;
  return art(app.charMap[u.cardId], { rarity, size }).replace('<svg viewBox="0 0 100 100"', '<svg preserveAspectRatio="xMinYMid meet" viewBox="0 0 100 100"');
}

const KW_SHORT = { '守護': '守', '先制': '先', '連撃': '連', '飛行': '飛', '貫通': '貫', '反撃': '反', '射程': '射', '再生': '再', '毒': '毒', '凍結': '凍', '復活': '復', '鼓舞': '鼓' };

const STAT_ICONS = {
  atk: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 1.5 7 8l1 1 6.5-6.5V1.5zM3 9.5l3.5 3.5-1 1-1-1L3 14.5 1.5 13 3 11.5l-1-1z"/><path d="M6 9l1 1-3 3-1-1z"/></svg>',
  hp: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 14.5S1.5 10.3 1.5 5.8A3.3 3.3 0 0 1 8 4.2a3.3 3.3 0 0 1 6.5 1.6C14.5 10.3 8 14.5 8 14.5z"/></svg>',
  spd: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 1 3 9h4l-1 6 6.5-8h-4z"/></svg>'
};

function unitHtml(u, entering) {
  const status = [
    u.ultimate ? '<span class="st ult">★</span>' : '',
    u.shield ? '<span class="st shield">盾</span>' : '',
    u.poison ? `<span class="st poison">毒${u.poison}</span>` : '',
    u.frozen ? '<span class="st frz">凍</span>' : '',
    u.hidden ? '<span class="st">潜</span>' : ''
  ].join('');
  const kws = u.keywords.filter(k => KW_SHORT[k]).map(k => `<span class="kw">${KW_SHORT[k]}</span>`).join('');
  const base = CARD_MAP[u.cardId];
  const hpNow = Math.max(0, u.hp);
  const atkCls = base && u.atk > base.atk ? 'up' : base && u.atk < base.atk ? 'down' : '';
  const hpCls = hpNow < u.maxHp ? (hpNow * 3 <= u.maxHp ? 'low' : 'hurt') : '';
  return `<div class="unit ${entering ? 'enter' : ''} ${u.hidden ? 'hidden-u' : ''} ${u.frozen ? 'frozen' : ''} ${u.shield ? 'shielded' : ''}" data-uid="${u.uid}" style="--el:${elColor(u.element)}" role="button" aria-label="${esc(u.name)} 攻撃${u.atk} 体力${hpNow} 速さ${u.spd}">
    <div class="u-art">${unitArt(u, 96)}</div>
    <div class="u-stats">
      <span class="stat atk ${atkCls}">${STAT_ICONS.atk}${u.atk}</span>
      <span class="stat hp ${hpCls}">${STAT_ICONS.hp}${hpNow}</span>
      <span class="stat spd">${STAT_ICONS.spd}${u.first ? '先' : u.spd}</span>
    </div>
    <div class="u-top">${status}${kws}</div>
  </div>`;
}

// 盤面のキャラをタップすると、バトルを止めて詳しく見る
function openUnitInfo(view, uid) {
  const last = view.log[view.log.length - 1];
  if (!last) return;
  let u = null;
  for (const side of [0, 1]) for (const row of ['front', 'back']) for (const x of last.snap[side][row]) if (x && x.uid === uid) u = x;
  if (!u) return;
  view.paused = true;
  const card = CARD_MAP[u.cardId];
  const ult = card && card.ultimate ? card.ultimate : ULTIMATES[u.element];
  const panel = document.createElement('div');
  panel.className = 'unit-info';
  const kwLines = u.keywords.map(k => KEYWORDS[k] ? `<div class="kwline"><b>${k}</b><span>${KEYWORDS[k].desc}</span></div>` : '').join('');
  const status = [u.shield ? '盾（次のダメージを防ぐ）' : '', u.poison ? `毒${u.poison}（ターン終了時にダメージ）` : '', u.frozen ? '凍結（次の行動を休む）' : '', u.hidden ? '潜伏（攻撃するまで狙われない）' : ''].filter(Boolean);
  panel.innerHTML = `<div class="ui-card" style="--el:${elColor(u.element)}">
    <button class="dlg-close" aria-label="閉じる">×</button>
    <div class="ui-art">${unitArt(u, 160)}</div>
    <h3>${esc(u.name)} <span class="chip" style="--el:${elColor(u.element)}">${u.element}</span> <span class="small muted">${u.side === 0 ? 'あなたのカード' : '相手のカード'}</span></h3>
    <div class="ui-stats">
      <div>攻撃<b class="atk">${u.atk}</b>${card ? `<small>もと ${card.atk}</small>` : ''}</div>
      <div>体力<b class="hp">${Math.max(0, u.hp)}<small> / ${u.maxHp}</small></b>${card ? `<small>もと ${card.hp}</small>` : ''}</div>
      <div>速さ<b style="color:#2E86DE">${u.first ? '先制' : u.spd}</b><small>大きいほど先に動く</small></div>
    </div>
    ${status.length ? `<p class="small" style="margin:6px 0 0"><b>状態：</b>${status.join('、')}</p>` : ''}
    ${kwLines ? `<div class="bc-sec">${kwLines}</div>` : ''}
    ${card && card.ability ? `<div class="bc-sec"><b>「${esc(card.skill)}」</b><br>${esc(card.text)}</div>` : ''}
    ${u.ultimate && ult ? `<div class="bc-sec"><b>「${esc(ult.name)}」</b>（登場時に発動）</div>` : ''}
    <p class="small muted" style="margin:8px 0 0">見ている間、バトルは止まっています。</p>
  </div>`;
  view.el.appendChild(panel);
  const close = () => { panel.remove(); view.paused = false; };
  panel.querySelector('.dlg-close').onclick = close;
  panel.onclick = e => { if (e.target === panel) close(); };
}

function renderBattleSnap(view, snap, enteringUid) {
  const el = view.el;
  for (const side of [0, 1]) {
    const sn = snap[side];
    for (const row of ['front', 'back']) {
      sn[row].forEach((u, l) => {
        const slot = el.querySelector(`[data-slot="${side}-${row}-${l}"]`);
        const cur = slot.querySelector('.unit');
        if (!u) { if (cur) cur.remove(); return; }
        const html = unitHtml(u, u.uid === enteringUid);
        if (cur && Number(cur.dataset.uid) === u.uid && u.uid !== enteringUid) {
          const tmp = document.createElement('div');
          tmp.innerHTML = html;
          cur.className = tmp.firstElementChild.className;
          cur.innerHTML = tmp.firstElementChild.innerHTML;
        } else {
          slot.querySelectorAll('.unit').forEach(x => x.remove());
          slot.insertAdjacentHTML('beforeend', html);
        }
      });
    }
    const pl = view.battle.p[side];
    const L = el.querySelector(`#leader${side}`);
    const hpNow = Math.max(0, sn.hp);
    const pct = hpNow / sn.maxHp * 100;
    const floats = [...L.querySelectorAll('.float')];
    const relics = (sn.relics || []).map(r => `<span class="relic" title="${esc(r.name)}">${r.icon}<small>${esc(r.name)}</small></span>`).join('');
    L.innerHTML = `${guardianArt(pl.guardian, 34)}
      <div class="l-main">
        <div class="l-primary"><div class="l-name">${esc(pl.name)}・${esc(pl.guardian.name)}</div><div class="l-hpbar"><i class="${pct <= 30 ? 'low' : ''}" style="width:${pct}%"></i></div><span class="l-hp"><small>HP</small>${hpNow}<small>/${sn.maxHp}</small></span></div>
        <div class="l-meta"><span class="l-passive">${pl.guardian.passive ? `常時「${esc(pl.guardian.passive.name)}」` : '常時効果なし'}</span><span class="l-gauge">ゲージ ${sn.guardianGauge}%</span><span class="l-resources">E ${sn.energy}　手 ${sn.hand}　山 ${sn.deck}</span>${relics ? `<span class="relics">${relics}</span>` : ''}</div>
      </div>`;
    floats.forEach(f => L.appendChild(f));
  }
}

function floatAt(target, text, cls) {
  if (!target) return;
  const f = document.createElement('span');
  f.className = `float ${cls}`;
  f.textContent = text;
  target.appendChild(f);
  setTimeout(() => f.remove(), 900);
}
const unitEl = (view, uid) => view.el.querySelector(`.unit[data-uid="${uid}"]`);
const slotOfUnit = (view, uid) => { const u = unitEl(view, uid); return u ? u.parentElement : null; };
function battleBanner(view, html, cls = '', ms = 700) {
  const b = document.createElement('div');
  b.className = `banner ${cls}`;
  b.innerHTML = html;
  view.el.querySelector('#bField').appendChild(b);
  setTimeout(() => b.remove(), ms / Math.max(1, view.speed * 0.8));
}

function showBattleEvent(view, ev) {
  const el = view.el;
  if (ev.t === 'death') floatAt(el.querySelector(`[data-slot="${ev.side}-${ev.row}-${ev.lane}"]`), '撃破', 'info');
  renderBattleSnap(view, ev.snap, ev.t === 'play' ? ev.uid : null);
  el.querySelector('#bTurn').textContent = ev.turn ? `ターン ${ev.turn}` : '準備';
  const quiet = view.speed >= 4;
  switch (ev.t) {
    case 'turn': battleBanner(view, `ターン ${ev.turn}`, 'turn', 700); break;
    case 'attack': {
      const u = unitEl(view, ev.uid);
      if (u) { u.classList.add(ev.side === 0 ? 'lunge-up' : 'lunge-down', 'acting'); setTimeout(() => u.classList.remove('lunge-up', 'lunge-down', 'acting'), 260 / view.speed); }
      break;
    }
    case 'damage': {
      const u = unitEl(view, ev.uid);
      if (u) { u.classList.remove('hit'); void u.offsetWidth; u.classList.add('hit'); }
      floatAt(slotOfUnit(view, ev.uid), `-${ev.amount}`, 'dmg');
      break;
    }
    case 'leaderDamage': {
      const L = el.querySelector(`#leader${ev.side}`);
      L.classList.remove('hit'); void L.offsetWidth; L.classList.add('hit');
      floatAt(L, `-${ev.amount}`, 'dmg');
      if (!quiet) Sound.tone(180, 0.12, 'triangle', 0.12);
      break;
    }
    case 'leaderHeal': floatAt(el.querySelector(`#leader${ev.side}`), `+${ev.amount}`, 'heal'); break;
    case 'heal': floatAt(slotOfUnit(view, ev.uid), `+${ev.amount}`, 'heal'); break;
    case 'buff': if (ev.uid) floatAt(slotOfUnit(view, ev.uid), [ev.atk ? `攻+${ev.atk}` : '', ev.hp ? `体+${ev.hp}` : ''].filter(Boolean).join(' ') || '攻+1', 'buff'); else battleBanner(view, esc(ev.text), '', 650); break;
    case 'block': floatAt(slotOfUnit(view, ev.uid), '防いだ', 'info'); break;
    case 'status': floatAt(slotOfUnit(view, ev.uid), ev.text.includes('毒') ? '毒' : '凍結', 'info'); break;
    case 'shield': if (ev.uid) floatAt(slotOfUnit(view, ev.uid), '盾', 'buff'); else battleBanner(view, esc(ev.text), '', 650); break;
    case 'revive': floatAt(slotOfUnit(view, ev.uid), '復活', 'heal'); break;
    case 'frozen': floatAt(slotOfUnit(view, ev.uid), '動けない', 'info'); break;
    case 'ability': {
      const name = ev.text.split('の「')[0];
      battleBanner(view, `${ev.relic ? `<span class="b-icon">${(ARTIFACTS.find(x => x.name === ev.skill) || {}).icon || ''}</span>` : ''}${esc(name)}「${esc(ev.skill)}」<small>${esc(ev.text.split('：').slice(1).join('：'))}</small>`, ev.ultimate ? 'bond' : ev.relic ? 'artifact' : '', ev.ultimate ? 1100 : 800);
      if (!quiet) { if (ev.ultimate) { Sound.rare(5); vibrate(60); } else Sound.up(); }
      break;
    }
    case 'guardian': battleBanner(view, `${ev.ultimate ? '必殺技' : 'スキル'}<small>${esc(ev.text)}</small>`, ev.ultimate ? 'bond' : '', ev.ultimate ? 1100 : 850); if (!quiet) ev.ultimate ? Sound.rare(5) : Sound.up(); break;
    case 'bond': battleBanner(view, `縁<small>${esc(ev.text)}</small>`, 'bond', 1000); if (!quiet) Sound.rare(4); break;
    case 'artifact': battleBanner(view, `<span class="b-icon">${ev.icon}</span>${esc(ev.text.split('：')[0])}<small>${esc(ev.text.split('：').slice(1).join('：'))}</small>`, 'artifact', 900); if (!quiet) Sound.up(); break;
    case 'relic': {
      const a = ARTIFACT_MAP[ev.id];
      battleBanner(view, `<span class="b-icon">${ev.icon}</span>${esc(ev.text)}<small>${esc(a ? a.text : '')}</small>`, 'artifact', 900);
      if (!quiet) Sound.click();
      break;
    }
    case 'boss': case 'rule': battleBanner(view, esc(ev.text), '', 800); break;
  }
}

function showBattleResult(view) {
  const b = view.battle;
  const win = b.winner === 0;
  let reward = { gained: 0 };
  try { reward = app.server.finishQuest(view.q.id, b); } catch (e) { toast(e.message); }
  if (reward.gained) { renderCoins(true); Sound.coin(); }
  if (reward.guardians?.length) setTimeout(() => toast(`守護者「${reward.guardians.map(g => g.name).join('・')}」が仲間になりました！`), 300);
  if (win) { Sound.rare(5); vibrate([40, 30, 80]); }
  updateBadges();
  const rewardText = !win ? 'デッキや作戦を変えて、もう一度挑戦してみましょう。'
    : reward.first ? `初回クリア報酬 +${num(reward.gained)}コイン`
    : reward.capped ? '今日のクエスト報酬は受け取り済みです'
    : `勝利報酬 +${num(reward.gained)}コイン`;
  const box = document.createElement('div');
  box.className = 'result';
  box.innerHTML = `<div class="r-card">
    <h2 class="${win ? 'win' : 'lose'}">${b.winner === null ? '引き分け' : win ? '勝利！' : '敗北'}</h2>
    <p style="margin:0" class="small muted">${esc(b.reason)}</p>
    <div class="rs">
      <div>ターン<b>${b.turn}</b></div>
      <div>残り体力<b>${Math.max(0, b.p[0].hp)}</b></div>
      <div>与えたダメージ<b>${b.stats.damageToLeader[1]}</b></div>
      <div>出したカード<b>${b.stats.plays[0]}</b></div>
    </div>
    <p class="small" style="margin:0 0 10px;font-weight:700">${esc(rewardText)}</p>
    <div class="r-actions">
      <button class="btn danger" data-r="again">もう一度挑戦</button>
      <button class="btn" data-r="log">戦闘記録を見る</button>
      <button class="btn primary" data-r="close">もどる</button>
    </div></div>`;
  view.el.appendChild(box);
  box.querySelector('[data-r="again"]').onclick = () => { closeBattle(view); startBattle(view.q); };
  box.querySelector('[data-r="log"]').onclick = () => openBattleLog(view);
  box.querySelector('[data-r="close"]').onclick = () => closeBattle(view);
}

function closeBattle(view) {
  view.closed = true;
  view.el.remove();
  document.body.classList.remove('noscroll');
  if (app.tab === 'adventure') renderAdventure();
  updateBadges();
}

function openBattleLog(view) {
  const panel = document.createElement('div');
  panel.className = 'logpanel';
  let html = `<h3>戦闘記録<button class="btn" data-x>とじる</button></h3>`;
  for (const ev of view.log) {
    if (ev.t === 'turn') { html += `<div class="lt">ターン ${ev.turn}</div>`; continue; }
    if (ev.t === 'start') continue;
    const sideCls = ev.side === 0 ? 's0' : ev.side === 1 ? 's1' : '';
    html += `<div class="ll ${sideCls} ${ev.t === 'ability' || ev.t === 'bond' ? 'ab' : ''}">${esc(ev.text)}</div>`;
  }
  if (!view.battle.over) html += '<p class="small muted">バトルは続いています。</p>';
  panel.innerHTML = html;
  view.el.appendChild(panel);
  panel.scrollTop = panel.scrollHeight;
  panel.querySelector('[data-x]').onclick = () => panel.remove();
}

// ---------------------------------------------------------------------
// バランス検証（設定のテスト用から開く）
// ---------------------------------------------------------------------
function openSim() {
  const r = app.sim;
  const body = openDialog(`
    <h2 style="margin:0 0 6px">バランス検証</h2>
    <p class="small" style="margin:0">全カードからランダムにデッキを作って裏で大量に戦わせ、属性・キーワード・カードごとの勝率を出します。50%から大きく外れた部品を直すと、その部品を使う全キャラがまとめて調整されます。</p>
    <div style="display:flex;gap:6px;margin-top:10px">
      <button class="btn primary" data-run="500">500戦</button>
      <button class="btn primary" data-run="3000">3000戦</button>
    </div>
    <div class="sim-bar"><i id="simBar" style="width:${r ? r.done / r.total * 100 : 0}%"></i></div>
    <div class="small muted" id="simText">${r ? `${r.done} / ${r.total}戦` : 'まだ実行していません'}</div>
    <div id="simResult">${r && r.done && !r.running ? simResultHtml(r) : ''}</div>`);
  body.querySelectorAll('[data-run]').forEach(b => { b.onclick = () => runSim(Number(b.dataset.run)); });
}

function runSim(total) {
  const rng = new Rng(Date.now() % 1e9);
  const r = app.sim = { total, done: 0, turns: 0, first: 0, draws: 0, card: {}, kw: {}, guardian: {}, art: {}, running: true };
  const add = (map, key, won) => { const v = map[key] || (map[key] = { g: 0, w: 0 }); v.g++; if (won) v.w++; };
  const step = () => {
    if (app.sim !== r) return;
    const end = Math.min(total, r.done + 60);
    for (; r.done < end; r.done++) {
      const A = randomDeck(rng), B = randomDeck(rng);
      const bt = new Battle({ seed: rng.int(1e9), record: false, players: [{ name: 'A', ...A }, { name: 'B', ...B }] });
      const w = bt.runToEnd();
      r.turns += bt.turn;
      if (w === null) r.draws++; else if (w === 0) r.first++;
      [[A, 0], [B, 1]].forEach(([d, side]) => {
        const won = w === side;
        d.deck.forEach(id => {
          if (isArtifact(id)) { add(r.art, id, won); return; }
          add(r.card, id, won); CARD_MAP[id].keywords.forEach(k => add(r.kw, k, won));
        });
        add(r.guardian, d.guardian, won);
      });
    }
    const bar = $('#simBar'), txt = $('#simText');
    if (bar) bar.style.width = `${r.done / r.total * 100}%`;
    if (txt) txt.textContent = `${r.done} / ${r.total}戦`;
    if (r.done < total) setTimeout(step, 0);
    else { r.running = false; const res = $('#simResult'); if (res) res.innerHTML = simResultHtml(r); }
  };
  const res = $('#simResult'); if (res) res.innerHTML = '';
  setTimeout(step, 30);
}

function simResultHtml(r) {
  const rows = (map, label) => Object.entries(map)
    .map(([k, v]) => ({ k, rate: v.w / v.g * 100 }))
    .sort((a, b) => b.rate - a.rate)
    .map(x => {
      const cls = x.rate >= 56 ? 'hi' : x.rate <= 44 ? 'lo' : '';
      const left = Math.min(50, x.rate), width = Math.abs(x.rate - 50);
      return `<tr class="${cls}"><td>${label(x.k)}</td><td style="width:40%"><div class="wbar"><i style="left:${left}%;width:${width}%;background:${x.rate >= 50 ? '#E6394A' : '#2E86DE'}"></i></div></td><td class="n">${x.rate.toFixed(1)}%</td></tr>`;
    }).join('');
  const games = r.done;
  return `
    <div class="stat-grid" style="margin-top:10px">
      <div>平均ターン<b>${(r.turns / games).toFixed(1)}</b></div>
      <div>先攻側の勝率<b>${(r.first / Math.max(1, games - r.draws) * 100).toFixed(1)}%</b></div>
      <div>引き分け<b>${(r.draws / games * 100).toFixed(1)}%</b></div>
    </div>
    <p class="small muted" style="margin:0 0 8px">赤い数字は56%以上（強すぎるかも）、青い数字は44%以下（弱すぎるかも）。</p>
    <h3 style="font-size:14px;margin:10px 0 4px">ガーディアン</h3><table class="wr">${rows(r.guardian, k => esc(GUARDIAN_MAP[k].name))}</table>
    <h3 style="font-size:14px;margin:10px 0 4px">キーワード</h3><table class="wr">${rows(r.kw, k => esc(k))}</table>
    <h3 style="font-size:14px;margin:10px 0 4px">アーティファクト</h3><table class="wr">${rows(r.art || {}, k => `${ARTIFACT_MAP[k].icon} ${esc(ARTIFACT_MAP[k].name)}`)}</table>
    <h3 style="font-size:14px;margin:10px 0 4px">カード</h3><table class="wr">${rows(r.card, k => `<span class="chip" style="--el:${elColor(CARD_MAP[k].element)}">${CARD_MAP[k].element}</span> ${esc(CARD_MAP[k].name)}`)}</table>`;
}
