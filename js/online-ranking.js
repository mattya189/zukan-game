// Supabase と直接通信する、ビルド不要のオンラインランキング接続。
// 接続先が未設定または通信できない場合は、game.js が端末内ランキングへ戻す。
(function (root) {
  'use strict';

  const SESSION_KEY = 'gachaZukanSupabaseSession_v1';
  const TABLE = 'ranking_entries';
  const FIELDS = [
    'user_id', 'local_uid', 'player_name', 'char_id', 'rarity', 'special', 'nature', 'serial',
    'weight', 'height', 'weight_dev', 'height_dev', 'power', 'speed', 'wisdom', 'luck',
    'nature_strength', 'shine', 'appetite', 'total_score'
  ];
  const SORTABLE = new Set([
    'weight', 'height', 'weight_dev', 'height_dev', 'power', 'speed', 'wisdom', 'luck',
    'nature_strength', 'shine', 'appetite', 'serial', 'total_score'
  ]);

  function config() {
    const c = root.SUPABASE_CONFIG || {};
    return {
      url: String(c.url || '').replace(/\/$/, ''),
      key: String(c.publishableKey || c.anonKey || '')
    };
  }

  function configured() {
    const c = config();
    return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(c.url) && c.key.length > 20;
  }

  function readSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
  }

  function saveSession(session) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* 保存できない環境 */ }
    return session;
  }

  async function request(path, options, token) {
    const c = config();
    const headers = Object.assign({ apikey: c.key, Authorization: `Bearer ${token || c.key}` }, options && options.headers);
    const res = await fetch(c.url + path, Object.assign({}, options, { headers }));
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body.message || body.msg || body.error_description || body.error || '';
      } catch (e) { /* 本文がJSONでない場合 */ }
      throw new Error(detail || `通信エラー（${res.status}）`);
    }
    if (res.status === 204 || res.headers.get('content-length') === '0') return null;
    return res.json();
  }

  function normalizeSession(data) {
    if (!data || !data.access_token || !data.refresh_token || !data.user) throw new Error('ログイン情報を受け取れませんでした');
    const expiresAt = data.expires_at || Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600);
    return saveSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: expiresAt,
      user_id: data.user.id
    });
  }

  async function ensureSession() {
    if (!configured()) throw new Error('Supabaseがまだ設定されていません');
    const old = readSession();
    const now = Math.floor(Date.now() / 1000);
    if (old && old.access_token && old.user_id && Number(old.expires_at) > now + 60) return old;
    if (old && old.refresh_token) {
      try {
        const data = await request('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: old.refresh_token })
        });
        return normalizeSession(data);
      } catch (e) { /* 期限切れなら新しい匿名プレイヤーを作る */ }
    }
    const data = await request('/auth/v1/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    return normalizeSession(data);
  }

  function finite(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function rowOf(ind, playerName, userId) {
    return {
      user_id: userId,
      local_uid: Math.max(1, Math.trunc(finite(ind.uid, 1, Number.MAX_SAFE_INTEGER))),
      player_name: String(playerName || 'あなた').trim().slice(0, 12) || 'あなた',
      char_id: String(ind.char_id || '').slice(0, 7),
      rarity: Math.trunc(finite(ind.rarity, 1, 5)),
      special: !!ind.special,
      nature: String(ind.nature || 'まじめ').slice(0, 20),
      serial: Math.max(1, Math.trunc(finite(ind.serial, 1, Number.MAX_SAFE_INTEGER))),
      weight: finite(ind.weight, 0.1, 9999999),
      height: finite(ind.height, 0.1, 9999999),
      weight_dev: finite(ind.weight_dev, -100, 10000),
      height_dev: finite(ind.height_dev, -100, 10000),
      power: Math.trunc(finite(ind.power, 1, 9999999)),
      speed: Math.trunc(finite(ind.speed, 1, 9999999)),
      wisdom: Math.trunc(finite(ind.wisdom, 1, 9999999)),
      luck: Math.trunc(finite(ind.luck, 1, 9999999)),
      nature_strength: Math.trunc(finite(ind.nature_strength, 1, 9999999)),
      shine: Math.trunc(finite(ind.shine, 1, 9999999)),
      appetite: Math.trunc(finite(ind.appetite, 1, 9999999)),
      total_score: Math.trunc(finite(ind.total_score, 0, 10000)),
      updated_at: new Date().toISOString()
    };
  }

  async function sync(playerName, individuals) {
    const session = await ensureSession();
    const auth = session.access_token;
    const ownFilter = encodeURIComponent(`eq.${session.user_id}`);
    await request(`/rest/v1/${TABLE}?user_id=${ownFilter}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    }, auth);
    const rows = (individuals || []).map(i => rowOf(i, playerName, session.user_id));
    if (rows.length) {
      await request(`/rest/v1/${TABLE}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(rows)
      }, auth);
    }
    return session;
  }

  async function ranking(options) {
    const stat = SORTABLE.has(options.stat) ? options.stat : 'total_score';
    const dir = options.dir === 'asc' ? 'asc' : 'desc';
    const session = await ensureSession();
    const params = new URLSearchParams({ select: FIELDS.join(','), order: `${stat}.${dir},local_uid.asc`, limit: '100' });
    if (options.charId) params.set('char_id', `eq.${options.charId}`);
    if (options.nature) params.set('nature', `eq.${options.nature}`);
    const rows = await request(`/rest/v1/${TABLE}?${params}`, { method: 'GET' }, session.access_token);
    return rows.map((row, index) => ({
      rank: index + 1,
      uid: Number(row.local_uid),
      char_id: row.char_id,
      rarity: Number(row.rarity),
      value: Number(row[stat]),
      owner_name: row.player_name,
      is_mine: row.user_id === session.user_id,
      special: !!row.special
    }));
  }

  root.OnlineRanking = { configured, ensureSession, sync, ranking };
})(typeof window !== 'undefined' ? window : globalThis);
