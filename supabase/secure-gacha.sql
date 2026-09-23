-- オンラインランキングの個体値をSupabase側で確定する。
-- 過去にブラウザから登録された行は残すが、ランキングには表示しない。

alter table public.ranking_entries
  add column if not exists verified boolean not null default false,
  add column if not exists verified_at timestamptz;

revoke insert, update, delete on table public.ranking_entries from authenticated;
grant select on table public.ranking_entries to authenticated;
grant select, insert, update, delete on table public.ranking_entries to service_role;

drop policy if exists "ランキングは全員が読める" on public.ranking_entries;
drop policy if exists "自分の記録だけ追加できる" on public.ranking_entries;
drop policy if exists "自分の記録だけ更新できる" on public.ranking_entries;
drop policy if exists "自分の記録だけ削除できる" on public.ranking_entries;
create policy "検証済みランキングは全員が読める"
on public.ranking_entries for select
to authenticated
using (verified = true);

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.character_serials (
  char_id text primary key check (char_id ~ '^chr_[0-9]{3}$'),
  next_serial bigint not null check (next_serial > 0)
);

create table if not exists private.gacha_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  pull_count integer not null default 0 check (pull_count >= 0 and pull_count <= 100),
  primary key (user_id, usage_date)
);

alter table private.character_serials enable row level security;
alter table private.gacha_daily_usage enable row level security;

revoke all on table private.character_serials, private.gacha_daily_usage from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update on table private.character_serials, private.gacha_daily_usage to service_role;

create or replace function public.commit_verified_pull(p_user_id uuid, p_player_name text, p_entries jsonb)
returns setof public.ranking_entries
language plpgsql
security invoker
set search_path = ''
as $$
declare
  item jsonb;
  item_count integer;
  assigned_serial bigint;
  clean_name text;
begin
  item_count := jsonb_array_length(p_entries);
  if item_count not in (1, 10) then raise exception '引ける回数は1回か10回です'; end if;
  clean_name := left(coalesce(nullif(btrim(p_player_name), ''), 'あなた'), 12);

  insert into private.gacha_daily_usage(user_id, usage_date, pull_count)
  values (p_user_id, (now() at time zone 'Asia/Tokyo')::date, item_count)
  on conflict (user_id, usage_date) do update
    set pull_count = private.gacha_daily_usage.pull_count + excluded.pull_count;

  for item in select value from jsonb_array_elements(p_entries)
  loop
    insert into private.character_serials(char_id, next_serial)
    values (item->>'char_id', 2)
    on conflict (char_id) do update set next_serial = private.character_serials.next_serial + 1
    returning next_serial - 1 into assigned_serial;

    return query insert into public.ranking_entries(
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
    ) returning *;
  end loop;
end;
$$;

create or replace function public.rename_verified_entries(p_user_id uuid, p_name text)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.ranking_entries
  set player_name = left(coalesce(nullif(btrim(p_name), ''), 'あなた'), 12), updated_at = now()
  where user_id = p_user_id and verified = true;
$$;

revoke all on function public.commit_verified_pull(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.rename_verified_entries(uuid, text) from public, anon, authenticated;
grant execute on function public.commit_verified_pull(uuid, text, jsonb) to service_role;
grant execute on function public.rename_verified_entries(uuid, text) to service_role;

create index if not exists ranking_entries_verified_idx
on public.ranking_entries (verified, updated_at desc);

-- 既存の未検証データは200体制限に数えず、検証済み個体だけを数える。
create or replace function public.prepare_ranking_entry()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.verified = true and (
    select count(*) from public.ranking_entries where user_id = new.user_id and verified = true
  ) >= 200 then
    raise exception 'ランキングへ登録できる個体は200体までです';
  end if;
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.prepare_ranking_entry() from public, anon, authenticated;
