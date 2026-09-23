// Supabase と通信する、ビルド不要のオンラインランキング接続。
// 個体値はブラウザから登録せず、Edge Function 側で抽選する。
(function (root) {
  'use strict';

  const SESSION_KEY = 'gachaZukanSupabaseSession_v1';
  const TABLE = 'ranking_entries';
  const GACHA_FUNCTION = 'verified-gacha';
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

  // 「データを消す」では匿名プレイヤーも新しくする。
  // 端末の個体番号だけ1へ戻し、以前のオンライン個体番号と衝突するのを防ぐ。
  function resetSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* 保存できない環境 */ }
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

  async function invoke(body) {
    const session = await ensureSession();
    return request(`/functions/v1/${GACHA_FUNCTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, session.access_token);
  }

  async function pull(count, playerName, localUids) {
    const data = await invoke({ action: 'pull', count, player_name: playerName, local_uids: localUids });
    if (!data || !Number.isSafeInteger(Number(data.coins)) || !Array.isArray(data.results) || data.results.length !== count) {
      throw new Error('オンライン抽選の結果を受け取れませんでした');
    }
    return { coins: Number(data.coins), results: data.results };
  }

  async function wallet() {
    const data = await invoke({ action: 'status' });
    if (!data || !Number.isSafeInteger(Number(data.coins))) throw new Error('オンライン残高を受け取れませんでした');
    return data;
  }

  async function daily() {
    const data = await invoke({ action: 'daily' });
    if (!data || !Number.isSafeInteger(Number(data.coins))) throw new Error('ログインボーナスを確認できませんでした');
    return data;
  }

  async function claimStamps() { return invoke({ action: 'claim-stamps' }); }
  async function claimMission(mission) { return invoke({ action: 'claim-mission', mission }); }
  async function claimTutorial() { return invoke({ action: 'claim-tutorial' }); }
  async function recordDetail() { return invoke({ action: 'detail-view' }); }
  async function startExpedition(destination, localUids) {
    return invoke({ action: 'expedition-start', destination, local_uids: localUids });
  }
  async function claimExpedition(expeditionId) {
    return invoke({ action: 'expedition-claim', expedition_id: expeditionId });
  }
  async function beginBattle(stageId, localUids) {
    const data = await invoke({ action: 'battle-begin', stage_id: stageId, local_uids: localUids });
    if (!data || !data.ticket) throw new Error('挑戦を開始できませんでした');
    return data.ticket;
  }
  async function finishBattle(ticket, won, goal) {
    return invoke({ action: 'battle-finish', ticket, won: !!won, goal: !!goal });
  }

  async function sync(playerName) {
    await invoke({ action: 'rename', player_name: playerName });
  }

  async function release(localUids) {
    if (!localUids.length) return wallet();
    const data = await invoke({ action: 'release', local_uids: localUids });
    if (!data || !Number.isSafeInteger(Number(data.coins))) throw new Error('オンライン残高を受け取れませんでした');
    return { ...data, coins: Number(data.coins), gained: Number(data.gained || 0) };
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

  root.OnlineRanking = {
    configured, ensureSession, resetSession, pull, wallet, daily, claimStamps, claimMission, claimTutorial, recordDetail,
    startExpedition, claimExpedition, beginBattle, finishBattle, release, sync, ranking
  };
})(typeof window !== 'undefined' ? window : globalThis);
