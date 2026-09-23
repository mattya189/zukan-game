-- ガチャ用コインをブラウザ保存からSupabaseへ移す。
-- 既存プレイヤーも初回アクセス時に3,000コインから開始する。

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.player_wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  coins bigint not null default 3000 check (coins >= 0),
  login_last date,
  login_streak smallint not null default 0 check (login_streak between 0 and 7),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table private.player_wallets enable row level security;
revoke all on table private.player_wallets from public, anon, authenticated;
grant select, insert, update on table private.player_wallets to service_role;

create or replace function public.wallet_status(p_user_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  wallet private.player_wallets%rowtype;
begin
  insert into private.player_wallets(user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  select * into wallet from private.player_wallets where user_id = p_user_id;
  return jsonb_build_object(
    'coins', wallet.coins,
    'login_last', wallet.login_last,
    'login_streak', wallet.login_streak
  );
end;
$$;

create or replace function public.claim_daily_wallet(p_user_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  wallet private.player_wallets%rowtype;
  today_jst date := (clock_timestamp() at time zone 'Asia/Tokyo')::date;
  new_streak smallint;
  reward bigint;
begin
  insert into private.player_wallets(user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  select * into wallet from private.player_wallets where user_id = p_user_id for update;

  if wallet.login_last = today_jst then
    return jsonb_build_object('claimed', false, 'day', wallet.login_streak, 'amount', 0,
      'coins', wallet.coins, 'login_last', wallet.login_last, 'login_streak', wallet.login_streak);
  end if;

  new_streak := case when wallet.login_last = today_jst - 1
    then (wallet.login_streak % 7) + 1 else 1 end;
  reward := case when new_streak = 7 then 1000 else 300 end;
  update private.player_wallets
  set coins = coins + reward, login_last = today_jst, login_streak = new_streak, updated_at = now()
  where user_id = p_user_id
  returning * into wallet;

  return jsonb_build_object('claimed', true, 'day', new_streak, 'amount', reward,
    'coins', wallet.coins, 'login_last', wallet.login_last, 'login_streak', wallet.login_streak);
end;
$$;

create or replace function public.commit_verified_pull_v2(p_user_id uuid, p_player_name text, p_entries jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  item jsonb;
  item_count integer;
  pull_cost bigint;
  assigned_serial bigint;
  clean_name text;
  wallet private.player_wallets%rowtype;
  inserted public.ranking_entries%rowtype;
  results jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_entries) <> 'array' then raise exception '抽選結果が正しくありません'; end if;
  item_count := jsonb_array_length(p_entries);
  if item_count not in (1, 10) then raise exception '引ける回数は1回か10回です'; end if;
  pull_cost := case item_count when 1 then 100 else 1000 end;
  clean_name := left(coalesce(nullif(btrim(p_player_name), ''), 'あなた'), 12);

  insert into private.player_wallets(user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  select * into wallet from private.player_wallets where user_id = p_user_id for update;
  if wallet.coins < pull_cost then
    raise exception 'コインが足りません（あと%コイン）', pull_cost - wallet.coins;
  end if;
  update private.player_wallets set coins = coins - pull_cost, updated_at = now()
  where user_id = p_user_id returning * into wallet;

  for item in select value from jsonb_array_elements(p_entries)
  loop
    insert into private.character_serials(char_id, next_serial)
    values (item->>'char_id', 2)
    on conflict (char_id) do update set next_serial = private.character_serials.next_serial + 1
    returning next_serial - 1 into assigned_serial;

    insert into public.ranking_entries(
      user_id, local_uid, player_name, char_id, rarity, special, nature, serial,
      weight, height, weight_dev, height_dev, power, speed, wisdom, luck,
      nature_strength, shine, appetite, total_score, updated_at, verified, verified_at
    ) values (
      p_user_id, (item->>'local_uid')::bigint, clean_name, item->>'char_id', (item->>'rarity')::smallint,
      (item->>'special')::boolean, item->>'nature', assigned_serial,
      (item->>'weight')::numeric, (item->>'height')::numeric, (item->>'weight_dev')::numeric,
      (item->>'height_dev')::numeric, (item->>'power')::integer, (item->>'speed')::integer,
      (item->>'wisdom')::integer, (item->>'luck')::integer, (item->>'nature_strength')::integer,
      (item->>'shine')::integer, (item->>'appetite')::integer, (item->>'total_score')::integer,
      now(), true, now()
    ) returning * into inserted;
    results := results || jsonb_build_array(to_jsonb(inserted));
  end loop;

  return jsonb_build_object('coins', wallet.coins, 'results', results);
end;
$$;

create or replace function public.release_verified_entries(p_user_id uuid, p_local_uids bigint[])
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  wallet private.player_wallets%rowtype;
  reward bigint := 0;
  released jsonb := '[]'::jsonb;
begin
  if coalesce(array_length(p_local_uids, 1), 0) not between 1 and 200 then
    raise exception '送り出す個体が正しくありません';
  end if;
  insert into private.player_wallets(user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  select * into wallet from private.player_wallets where user_id = p_user_id for update;

  with deleted as (
    delete from public.ranking_entries
    where user_id = p_user_id and verified = true and local_uid = any(p_local_uids)
    returning local_uid, rarity, special
  ), valued as (
    select local_uid,
      (case rarity when 1 then 10 when 2 then 20 when 3 then 50 when 4 then 150 when 5 then 500 else 0 end)
      * (case when special then 5 else 1 end) as value
    from deleted
  )
  select coalesce(sum(value), 0), coalesce(jsonb_agg(local_uid order by local_uid), '[]'::jsonb)
  into reward, released from valued;

  update private.player_wallets set coins = coins + reward, updated_at = now()
  where user_id = p_user_id returning * into wallet;
  return jsonb_build_object('coins', wallet.coins, 'gained', reward, 'released', released);
end;
$$;

revoke all on function public.wallet_status(uuid) from public, anon, authenticated;
revoke all on function public.claim_daily_wallet(uuid) from public, anon, authenticated;
revoke all on function public.commit_verified_pull_v2(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.release_verified_entries(uuid, bigint[]) from public, anon, authenticated;
grant execute on function public.wallet_status(uuid) to service_role;
grant execute on function public.claim_daily_wallet(uuid) to service_role;
grant execute on function public.commit_verified_pull_v2(uuid, text, jsonb) to service_role;
grant execute on function public.release_verified_entries(uuid, bigint[]) to service_role;
