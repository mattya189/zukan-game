-- ガチャ図鑑 オンラインランキング
-- Supabase の SQL Editor で、このファイル全体を1回実行してください。

create table if not exists public.ranking_entries (
  user_id uuid not null references auth.users(id) on delete cascade,
  local_uid bigint not null check (local_uid > 0),
  player_name text not null check (char_length(player_name) between 1 and 12),
  char_id text not null check (char_id ~ '^chr_[0-9]{3}$'),
  rarity smallint not null check (rarity between 1 and 5),
  special boolean not null default false,
  nature text not null check (char_length(nature) between 1 and 20),
  serial bigint not null check (serial > 0),
  weight numeric not null check (weight between 0.1 and 9999999),
  height numeric not null check (height between 0.1 and 9999999),
  weight_dev numeric not null check (weight_dev between -100 and 10000),
  height_dev numeric not null check (height_dev between -100 and 10000),
  power integer not null check (power between 1 and 9999999),
  speed integer not null check (speed between 1 and 9999999),
  wisdom integer not null check (wisdom between 1 and 9999999),
  luck integer not null check (luck between 1 and 9999999),
  nature_strength integer not null check (nature_strength between 1 and 9999999),
  shine integer not null check (shine between 1 and 9999999),
  appetite integer not null check (appetite between 1 and 9999999),
  total_score integer not null check (total_score between 0 and 10000),
  updated_at timestamptz not null default now(),
  primary key (user_id, local_uid)
);

alter table public.ranking_entries enable row level security;

revoke all on table public.ranking_entries from anon;
grant select, insert, update, delete on table public.ranking_entries to authenticated;

drop policy if exists "ランキングは全員が読める" on public.ranking_entries;
create policy "ランキングは全員が読める"
on public.ranking_entries for select
to authenticated
using (true);

drop policy if exists "自分の記録だけ追加できる" on public.ranking_entries;
create policy "自分の記録だけ追加できる"
on public.ranking_entries for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "自分の記録だけ更新できる" on public.ranking_entries;
create policy "自分の記録だけ更新できる"
on public.ranking_entries for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "自分の記録だけ削除できる" on public.ranking_entries;
create policy "自分の記録だけ削除できる"
on public.ranking_entries for delete
to authenticated
using ((select auth.uid()) = user_id);

create index if not exists ranking_entries_char_id_idx on public.ranking_entries (char_id);
create index if not exists ranking_entries_nature_idx on public.ranking_entries (nature);
create index if not exists ranking_entries_updated_at_idx on public.ranking_entries (updated_at);

create or replace function public.prepare_ranking_entry()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and (
    select count(*) from public.ranking_entries where user_id = new.user_id
  ) >= 200 then
    raise exception 'ランキングへ登録できる個体は200体までです';
  end if;
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.prepare_ranking_entry() from public, anon, authenticated;
drop trigger if exists prepare_ranking_entry on public.ranking_entries;
create trigger prepare_ranking_entry
before insert or update on public.ranking_entries
for each row execute function public.prepare_ranking_entry();

-- 新規プロジェクト作成時に「自動RLS」を有効にした場合の安全設定。
-- 関数自体はイベントトリガーから使えるまま、Data APIからの直接実行だけを止める。
do $guard$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end
$guard$;

-- 匿名プレイヤーを使うため、Dashboard の
-- Authentication > Sign In / Providers > Anonymous を有効にしてください。
