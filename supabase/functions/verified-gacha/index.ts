import "jsr:@supabase/functions-js/edge-runtime.d.ts";

type Character = {
  id: string;
  base_weight: number;
  base_height: number;
  speed_bias: number;
  wisdom_bias: number;
  luck_bias: number;
  appetite_bias: number;
  likely_natures: string[];
};

const CHARACTERS: Character[] = [
  { id:'chr_001', base_weight:900, base_height:360, speed_bias:200, wisdom_bias:600, luck_bias:400, appetite_bias:800, likely_natures:['負けず嫌い','ゆうかん','いじっぱり'] },
  { id:'chr_002', base_weight:25, base_height:190, speed_bias:650, wisdom_bias:800, luck_bias:350, appetite_bias:300, likely_natures:['れいせい','しんちょう','がんこ'] },
  { id:'chr_003', base_weight:68, base_height:178, speed_bias:500, wisdom_bias:850, luck_bias:550, appetite_bias:450, likely_natures:['いじっぱり','れいせい','マイペース'] },
  { id:'chr_004', base_weight:30, base_height:90, speed_bias:350, wisdom_bias:400, luck_bias:700, appetite_bias:600, likely_natures:['ようき','むじゃき','のんき'] },
  { id:'chr_005', base_weight:1200, base_height:420, speed_bias:250, wisdom_bias:250, luck_bias:500, appetite_bias:950, likely_natures:['のんき','マイペース','ねぼすけ'] },
  { id:'chr_006', base_weight:62, base_height:182, speed_bias:550, wisdom_bias:650, luck_bias:600, appetite_bias:500, likely_natures:['ようき','すなお','おしゃべり'] },
  { id:'chr_007', base_weight:45, base_height:170, speed_bias:700, wisdom_bias:900, luck_bias:650, appetite_bias:250, likely_natures:['れいせい','しんちょう','ひかえめ'] },
  { id:'chr_008', base_weight:70, base_height:185, speed_bias:800, wisdom_bias:300, luck_bias:400, appetite_bias:650, likely_natures:['いじっぱり','せっかち','さみしがり'] },
  { id:'chr_009', base_weight:850, base_height:520, speed_bias:850, wisdom_bias:400, luck_bias:350, appetite_bias:600, likely_natures:['まじめ','がんこ','せっかち'] },
  { id:'chr_010', base_weight:1100, base_height:400, speed_bias:200, wisdom_bias:250, luck_bias:450, appetite_bias:850, likely_natures:['いじっぱり','がんこ','負けず嫌い'] }
  ,{ id:'chr_011', base_weight:65, base_height:210, speed_bias:800, wisdom_bias:500, luck_bias:450, appetite_bias:400, likely_natures:['せっかち','やんちゃ','おしゃべり'] }
  ,{ id:'chr_012', base_weight:400, base_height:300, speed_bias:700, wisdom_bias:950, luck_bias:500, appetite_bias:200, likely_natures:['れいせい','しんちょう','ひかえめ'] }
  ,{ id:'chr_013', base_weight:120, base_height:200, speed_bias:600, wisdom_bias:800, luck_bias:700, appetite_bias:900, likely_natures:['しっかりもの','しんちょう','くいしんぼう'] }
  ,{ id:'chr_014', base_weight:150, base_height:250, speed_bias:200, wisdom_bias:650, luck_bias:300, appetite_bias:250, likely_natures:['ひかえめ','しんちょう','がんこ'] }
  ,{ id:'chr_015', base_weight:1500, base_height:480, speed_bias:800, wisdom_bias:700, luck_bias:400, appetite_bias:750, likely_natures:['すなお','ようき','しっかりもの'] }
  ,{ id:'chr_016', base_weight:550, base_height:420, speed_bias:850, wisdom_bias:800, luck_bias:450, appetite_bias:150, likely_natures:['マイペース','しんちょう','れいせい'] }
];
const GACHAS = {
  normal_1: { price:100, price10:1000, chars:['chr_001','chr_002','chr_003','chr_004','chr_005','chr_006','chr_007','chr_008','chr_009','chr_010'], minRarity:3 },
  limited_1: { price:300, price10:3000, chars:['chr_013','chr_012','chr_011','chr_004','chr_001'], minRarity:4 },
  limited_2: { price:300, price10:3000, chars:['chr_014','chr_015','chr_016','chr_002','chr_008'], minRarity:4 }
} as const;
const NATURES = ['さみしがり','のんき','負けず嫌い','おっとり','せっかち','きまぐれ','まじめ','ひかえめ','ようき','ゆうかん','しんちょう','れいせい','てれや','がんこ','すなお','いじっぱり','おくびょう','むじゃき','やんちゃ','くいしんぼう','ねぼすけ','おしゃべり','ロマンチスト','しっかりもの','マイペース'];
const RATES: [number, number][] = [[5,1.5],[4,5.5],[3,15],[2,28],[1,50]];
const STAT_MAX = 9999999;
const POWER_RULE = { min:100, a:1.4, b:0.3 };
const RATIO_RULE = { a:7, b:1, maxDigits:2 };
const SPECIAL_RATE = 0.005;

function random() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return ((a[0] & 0x001fffff) * 4294967296 + a[1] + 1) / 9007199254740993;
}
const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
const round1 = (x: number) => Math.round(x * 10) / 10;

function rollRarity(min = 1) {
  const pool = RATES.filter(([r]) => r >= min);
  let x = random() * pool.reduce((sum, [, chance]) => sum + chance, 0);
  for (const [rarity, chance] of pool) {
    if (x < chance) return rarity;
    x -= chance;
  }
  return pool[pool.length - 1][0];
}

function rollStat(start: number) {
  const y = -Math.log10(random());
  const { a, b } = POWER_RULE;
  const d = (-a + Math.sqrt(a * a + 4 * b * y)) / (2 * b);
  return Math.min(STAT_MAX, Math.max(1, Math.floor(start * Math.pow(10, d))));
}

function rollRatio() {
  const up = random() < 0.5;
  const y = -Math.log10(random());
  const { a, b, maxDigits } = RATIO_RULE;
  const e = Math.min(maxDigits, (-a + Math.sqrt(a * a + 4 * b * y)) / (2 * b));
  return Math.pow(10, up ? e : -e);
}

function makeIndividual(c: Character, rarity: number, localUid: number) {
  const weight = Math.max(0.1, round1(c.base_weight * rollRatio()));
  const height = Math.max(0.1, round1(c.base_height * rollRatio()));
  const nature = c.likely_natures.length && random() < 0.6 ? pick(c.likely_natures) : pick(NATURES);
  const result = {
    local_uid: localUid, char_id: c.id, rarity, special: random() < SPECIAL_RATE, nature,
    weight, height,
    weight_dev: round1((weight - c.base_weight) / c.base_weight * 100),
    height_dev: round1((height - c.base_height) / c.base_height * 100),
    power: rollStat(POWER_RULE.min), speed: rollStat(Math.round(c.speed_bias / 5)),
    wisdom: rollStat(Math.round(c.wisdom_bias / 5)), luck: rollStat(Math.round(c.luck_bias / 5)),
    nature_strength: rollStat(30), shine: rollStat(30),
    appetite: Math.max(1, Math.min(STAT_MAX, Math.round(c.appetite_bias * rollRatio())))
  };
  const total_score = Math.round(100 * [result.power,result.speed,result.wisdom,result.luck,result.shine]
    .reduce((sum, value) => sum + Math.log10(Math.max(1, value)), 0));
  return { ...result, total_score };
}

const allowedOrigins = new Set(['https://mattya189.github.io', 'http://localhost', 'http://127.0.0.1']);
function cors(req: Request) {
  const origin = req.headers.get('Origin') || '';
  const safeOrigin = [...allowedOrigins].some(x => origin === x || origin.startsWith(`${x}:`)) ? origin : 'https://mattya189.github.io';
  return { 'Access-Control-Allow-Origin': safeOrigin, 'Access-Control-Allow-Headers': 'authorization, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
}
function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return json(req, { error:'POSTで送信してください' }, 405);
  try {
    const url = Deno.env.get('SUPABASE_URL') || '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const authorization = req.headers.get('Authorization') || '';
    const userRes = await fetch(`${url}/auth/v1/user`, { headers:{ apikey:anonKey, Authorization:authorization } });
    if (!userRes.ok) return json(req, { error:'ログインを確認できませんでした' }, 401);
    const user = await userRes.json();
    if (!user?.id) return json(req, { error:'プレイヤーを確認できませんでした' }, 401);

    const body = await req.json();
    const playerName = String(body.player_name || 'あなた').trim().slice(0, 12) || 'あなた';
    const rpcHeaders = { apikey:serviceKey, Authorization:`Bearer ${serviceKey}`, 'Content-Type':'application/json' };
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method:'POST', headers:rpcHeaders, body:JSON.stringify(args) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'サーバー処理に失敗しました');
      return result;
    };
    if (body.action === 'rename') {
      const response = await fetch(`${url}/rest/v1/rpc/rename_verified_entries`, { method:'POST', headers:rpcHeaders, body:JSON.stringify({ p_user_id:user.id, p_name:playerName }) });
      if (!response.ok) throw new Error((await response.json()).message || '名前を更新できませんでした');
      return json(req, { ok:true });
    }
    if (body.action === 'wallet' || body.action === 'status') {
      return json(req, await rpc('game_status', { p_user_id:user.id }));
    }
    if (body.action === 'daily') {
      const daily = await rpc('claim_daily_wallet', { p_user_id:user.id });
      const status = await rpc('game_status', { p_user_id:user.id });
      return json(req, { ...status, claimed:daily.claimed, day:daily.day, amount:daily.amount });
    }
    if (body.action === 'claim-stamps') {
      return json(req, await rpc('claim_stamp_rewards', { p_user_id:user.id }));
    }
    if (body.action === 'claim-mission') {
      return json(req, await rpc('claim_daily_mission', { p_user_id:user.id, p_mission:String(body.mission || '') }));
    }
    if (body.action === 'claim-tutorial') {
      return json(req, await rpc('claim_tutorial_reward', { p_user_id:user.id }));
    }
    if (body.action === 'detail-view') {
      return json(req, await rpc('record_detail_view', { p_user_id:user.id }));
    }
    if (body.action === 'expedition-start') {
      const localUids = Array.isArray(body.local_uids) ? body.local_uids.map(Number) : [];
      if (!localUids.length || localUids.length > 3 || localUids.some(x => !Number.isSafeInteger(x) || x < 1)) return json(req, { error:'探索メンバーが正しくありません' }, 400);
      return json(req, await rpc('start_verified_expedition', { p_user_id:user.id, p_destination:String(body.destination || ''), p_local_uids:localUids }));
    }
    if (body.action === 'expedition-claim') {
      const expeditionId = Number(body.expedition_id);
      if (!Number.isSafeInteger(expeditionId) || expeditionId < 1) return json(req, { error:'探索が正しくありません' }, 400);
      return json(req, await rpc('claim_verified_expedition', { p_user_id:user.id, p_expedition_id:expeditionId }));
    }
    if (body.action === 'battle-begin') {
      const localUids = Array.isArray(body.local_uids) ? body.local_uids.map(Number) : [];
      if (!localUids.length || localUids.length > 3 || localUids.some(x => !Number.isSafeInteger(x) || x < 1)) return json(req, { error:'出場個体が正しくありません' }, 400);
      return json(req, await rpc('begin_verified_battle', { p_user_id:user.id, p_stage_id:String(body.stage_id || ''), p_local_uids:localUids }));
    }
    if (body.action === 'battle-finish') {
      const ticket = String(body.ticket || '');
      if (!/^[0-9a-f-]{36}$/i.test(ticket)) return json(req, { error:'挑戦券が正しくありません' }, 400);
      return json(req, await rpc('finish_verified_battle', { p_user_id:user.id, p_ticket:ticket, p_won:body.won === true, p_goal:body.goal === true }));
    }
    if (body.action === 'release') {
      const localUids = Array.isArray(body.local_uids) ? body.local_uids.map(Number) : [];
      if (!localUids.length || localUids.length > 200 || localUids.some(x => !Number.isSafeInteger(x) || x < 1)) {
        return json(req, { error:'送り出す個体が正しくありません' }, 400);
      }
      const response = await fetch(`${url}/rest/v1/rpc/release_verified_entries`, {
        method:'POST', headers:rpcHeaders, body:JSON.stringify({ p_user_id:user.id, p_local_uids:localUids })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'オンライン個体を送り出せませんでした');
      return json(req, result);
    }
    if (body.action !== 'pull') return json(req, { error:'操作が正しくありません' }, 400);

    const count = Number(body.count);
    if (count !== 1 && count !== 10) return json(req, { error:'引ける回数は1回か10回です' }, 400);
    const gachaId = String(body.gacha_id || '');
    const gacha = GACHAS[gachaId as keyof typeof GACHAS];
    if (!gacha) return json(req, { error:'開催中のガチャを確認できませんでした' }, 400);
    const localUids = Array.isArray(body.local_uids) ? body.local_uids.map(Number) : [];
    if (localUids.length !== count || localUids.some(x => !Number.isSafeInteger(x) || x < 1)) return json(req, { error:'保管番号が正しくありません' }, 400);
    const rarities = Array.from({ length:count }, () => rollRarity());
    if (count === 10 && Math.max(...rarities) < gacha.minRarity) rarities[9] = rollRarity(gacha.minRarity);
    const charMap = Object.fromEntries(CHARACTERS.map(c => [c.id, c]));
    const entries = rarities.map((rarity, i) => makeIndividual(charMap[pick(gacha.chars)], rarity, localUids[i]));
    const response = await fetch(`${url}/rest/v1/rpc/commit_verified_pull_v3`, { method:'POST', headers:rpcHeaders, body:JSON.stringify({ p_user_id:user.id, p_player_name:playerName, p_entries:entries, p_gacha_id:gachaId }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'オンライン抽選を保存できませんでした');
    return json(req, result);
  } catch (error) {
    return json(req, { error:error instanceof Error ? error.message : 'オンライン抽選に失敗しました' }, 400);
  }
});
