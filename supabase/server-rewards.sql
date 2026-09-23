-- ミッション・図鑑・クエスト・探索の報酬をSupabaseで精算する。
-- ブラウザは報酬額を指定できず、サーバーが固定ルールから計算する。

create extension if not exists pgcrypto;

create table if not exists private.player_daily_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  progress_date date not null,
  pull_count integer not null default 0 check (pull_count >= 0),
  release_count integer not null default 0 check (release_count >= 0),
  expedition_count integer not null default 0 check (expedition_count >= 0),
  quest_count integer not null default 0 check (quest_count >= 0),
  detail_count integer not null default 0 check (detail_count >= 0),
  claimed text[] not null default '{}',
  primary key (user_id, progress_date)
);

create table if not exists private.player_collection (
  user_id uuid not null references auth.users(id) on delete cascade,
  char_id text not null check (char_id ~ '^chr_[0-9]{3}$'),
  rarity smallint not null check (rarity between 1 and 5),
  obtained_count integer not null default 1 check (obtained_count > 0),
  primary key (user_id, char_id, rarity)
);

create table if not exists private.reward_claims (
  user_id uuid not null references auth.users(id) on delete cascade,
  reward_key text not null,
  amount bigint not null check (amount >= 0),
  claimed_at timestamptz not null default now(),
  primary key (user_id, reward_key)
);

create table if not exists private.player_quest_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  stage_id text not null,
  cleared boolean not null default false,
  goal boolean not null default false,
  arena_streak integer not null default 0 check (arena_streak between 0 and 5),
  farm_ready_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, stage_id)
);

create table if not exists private.player_expeditions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  destination text not null check (destination in ('field', 'forest', 'mountain')),
  local_uids bigint[] not null,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  base_reward bigint not null check (base_reward > 0),
  reward bigint not null check (reward > 0),
  great boolean not null default false
);

create table if not exists private.battle_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stage_id text not null,
  local_uids bigint[] not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);

alter table private.player_daily_progress enable row level security;
alter table private.player_collection enable row level security;
alter table private.reward_claims enable row level security;
alter table private.player_quest_progress enable row level security;
alter table private.player_expeditions enable row level security;
alter table private.battle_tickets enable row level security;

revoke all on table private.player_daily_progress, private.player_collection,
  private.reward_claims, private.player_quest_progress, private.player_expeditions,
  private.battle_tickets from public, anon, authenticated;
grant select, insert, update, delete on table private.player_daily_progress,
  private.player_collection, private.reward_claims, private.player_quest_progress,
  private.player_expeditions, private.battle_tickets to service_role;
grant usage, select on all sequences in schema private to service_role;

create index if not exists player_expeditions_user_idx
on private.player_expeditions(user_id, ends_at);
create index if not exists battle_tickets_user_idx
on private.battle_tickets(user_id, expires_at);

-- 現在残っている検証済み個体を、図鑑の取得履歴へ移す。
insert into private.player_collection(user_id, char_id, rarity, obtained_count)
select user_id, char_id, rarity, count(*)::integer
from public.ranking_entries where verified = true
group by user_id, char_id, rarity
on conflict (user_id, char_id, rarity) do update
set obtained_count = greatest(private.player_collection.obtained_count, excluded.obtained_count);

create or replace function public.game_status(p_user_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  today_jst date := (clock_timestamp() at time zone 'Asia/Tokyo')::date;
  wallet private.player_wallets%rowtype;
  daily private.player_daily_progress%rowtype;
  stamp_rows jsonb;
  quest_rows jsonb;
  expedition_rows jsonb;
begin
  insert into private.player_wallets(user_id) values (p_user_id) on conflict (user_id) do nothing;
  insert into private.player_daily_progress(user_id, progress_date) values (p_user_id, today_jst)
  on conflict (user_id, progress_date) do nothing;
  select * into wallet from private.player_wallets where user_id = p_user_id;
  select * into daily from private.player_daily_progress where user_id = p_user_id and progress_date = today_jst;

  with available as (
    select 'stamp:' || c.char_id || ':' || c.rarity as reward_key,
      c.char_id, c.rarity::integer as rarity,
      case c.rarity when 1 then 50 when 2 then 100 when 3 then 200 when 4 then 500 else 1000 end::bigint as amount,
      'stamp'::text as kind
    from private.player_collection c
    where c.user_id = p_user_id
      and not exists (select 1 from private.reward_claims r where r.user_id=p_user_id and r.reward_key='stamp:'||c.char_id||':'||c.rarity)
    union all
    select 'complete:' || c.char_id, c.char_id, null::integer, 1500::bigint, 'complete'::text
    from private.player_collection c
    where c.user_id = p_user_id
    group by c.char_id
    having count(distinct c.rarity) = 5
      and not exists (select 1 from private.reward_claims r where r.user_id=p_user_id and r.reward_key='complete:'||c.char_id)
  )
  select coalesce(jsonb_agg(jsonb_build_object('key',reward_key,'char_id',char_id,'rarity',rarity,'amount',amount,'kind',kind) order by char_id, rarity nulls last), '[]'::jsonb)
  into stamp_rows from available;

  select coalesce(jsonb_agg(jsonb_build_object(
    'stage_id',stage_id,'cleared',cleared,'goal',goal,'arena_streak',arena_streak,
    'farm_ready_at',case when farm_ready_at is null then null else extract(epoch from farm_ready_at)*1000 end
  ) order by stage_id), '[]'::jsonb)
  into quest_rows from private.player_quest_progress where user_id=p_user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'dest',destination,'uids',local_uids,
    'start',extract(epoch from started_at)*1000,'end',extract(epoch from ends_at)*1000,
    'reward',reward,'base_reward',base_reward,'great',great
  ) order by started_at), '[]'::jsonb)
  into expedition_rows from private.player_expeditions where user_id=p_user_id;

  return jsonb_build_object(
    'coins',wallet.coins,'login_last',wallet.login_last,'login_streak',wallet.login_streak,
    'missions',jsonb_build_object(
      'date',today_jst,
      'progress',jsonb_build_object('pull',daily.pull_count,'release',daily.release_count,
        'expedition',daily.expedition_count,'quest',daily.quest_count,'detail',daily.detail_count),
      'claimed',to_jsonb(daily.claimed)
    ),
    'stamp_rewards',stamp_rows,'quest_progress',quest_rows,'expeditions',expedition_rows
  );
end;
$$;

create or replace function public.claim_stamp_rewards(p_user_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare gained bigint := 0; claimed_count integer := 0; wallet private.player_wallets%rowtype;
begin
  insert into private.player_wallets(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into wallet from private.player_wallets where user_id=p_user_id for update;
  with available as (
    select 'stamp:'||c.char_id||':'||c.rarity as reward_key,
      (case c.rarity when 1 then 50 when 2 then 100 when 3 then 200 when 4 then 500 else 1000 end)::bigint as amount
    from private.player_collection c where c.user_id=p_user_id
    union all
    select 'complete:'||c.char_id, 1500::bigint from private.player_collection c
    where c.user_id=p_user_id group by c.char_id having count(distinct c.rarity)=5
  ), inserted as (
    insert into private.reward_claims(user_id,reward_key,amount)
    select p_user_id,a.reward_key,a.amount from available a
    on conflict (user_id,reward_key) do nothing returning amount
  )
  select coalesce(sum(amount),0),count(*) into gained,claimed_count from inserted;
  update private.player_wallets set coins=coins+gained,updated_at=now() where user_id=p_user_id;
  return public.game_status(p_user_id) || jsonb_build_object('gained',gained,'count',claimed_count);
end;
$$;

create or replace function public.record_detail_view(p_user_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare today_jst date := (clock_timestamp() at time zone 'Asia/Tokyo')::date;
begin
  insert into private.player_daily_progress(user_id,progress_date,detail_count)
  values(p_user_id,today_jst,1)
  on conflict (user_id,progress_date) do update
  set detail_count=least(3,private.player_daily_progress.detail_count+1);
  return public.game_status(p_user_id);
end;
$$;

-- はじめての案内を完了したプレイヤーへ、1アカウントにつき1度だけ渡す。
create or replace function public.claim_tutorial_reward(p_user_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare gained bigint := 0;
begin
  insert into private.player_wallets(user_id) values (p_user_id) on conflict (user_id) do nothing;
  with inserted as (
    insert into private.reward_claims(user_id,reward_key,amount)
    values (p_user_id,'tutorial:complete',100)
    on conflict (user_id,reward_key) do nothing
    returning amount
  ) select coalesce(sum(amount),0) into gained from inserted;
  update private.player_wallets set coins=coins+gained,updated_at=now() where user_id=p_user_id;
  return public.game_status(p_user_id) || jsonb_build_object('gained',gained);
end;
$$;

create or replace function public.claim_daily_mission(p_user_id uuid,p_mission text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  today_jst date := (clock_timestamp() at time zone 'Asia/Tokyo')::date;
  daily private.player_daily_progress%rowtype;
  progress_value integer; target_value integer; reward_value bigint;
begin
  if p_mission not in ('pull','release','expedition','quest','detail','all') then raise exception 'ミッションが正しくありません'; end if;
  insert into private.player_daily_progress(user_id,progress_date) values(p_user_id,today_jst)
  on conflict (user_id,progress_date) do nothing;
  insert into private.player_wallets(user_id) values(p_user_id) on conflict (user_id) do nothing;
  select * into daily from private.player_daily_progress where user_id=p_user_id and progress_date=today_jst for update;
  if p_mission = any(daily.claimed) then raise exception '受け取り済みです'; end if;
  if p_mission='all' then
    if not (array['pull','release','expedition','quest','detail'] <@ daily.claimed) then raise exception 'まだ受け取れません'; end if;
    reward_value:=300;
  else
    progress_value:=case p_mission when 'pull' then daily.pull_count when 'release' then daily.release_count when 'expedition' then daily.expedition_count when 'quest' then daily.quest_count else daily.detail_count end;
    target_value:=case p_mission when 'pull' then 10 when 'release' then 5 when 'expedition' then 2 when 'quest' then 1 else 3 end;
    reward_value:=case p_mission when 'pull' then 200 when 'release' then 150 when 'expedition' then 200 when 'quest' then 200 else 50 end;
    if progress_value < target_value then raise exception 'まだ受け取れません'; end if;
  end if;
  update private.player_daily_progress set claimed=array_append(claimed,p_mission)
  where user_id=p_user_id and progress_date=today_jst;
  update private.player_wallets set coins=coins+reward_value,updated_at=now() where user_id=p_user_id;
  return public.game_status(p_user_id) || jsonb_build_object('gained',reward_value);
end;
$$;

create or replace function public.start_verified_expedition(p_user_id uuid,p_destination text,p_local_uids bigint[])
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid_count integer := coalesce(array_length(p_local_uids,1),0);
  owned_count integer; active_count integer; base_amount integer; minutes_amount integer;
  sum_power numeric; wisdom_level numeric; speed_level numeric; luck_level numeric;
  reward_amount bigint; duration_ms bigint; great_chance numeric; is_great boolean;
begin
  if p_destination not in ('field','forest','mountain') then raise exception '行き先が正しくありません'; end if;
  if uid_count not between 1 and 3 or (select count(distinct x) from unnest(p_local_uids) x) <> uid_count then raise exception '探索メンバーが正しくありません'; end if;
  select count(*),coalesce(sum(power),0),coalesce(avg(log(10,greatest(1,wisdom)::numeric/100)),0),
    coalesce(avg(log(10,greatest(1,speed)::numeric/100)),0),coalesce(avg(log(10,greatest(1,luck)::numeric/100)),0)
  into owned_count,sum_power,wisdom_level,speed_level,luck_level
  from public.ranking_entries where user_id=p_user_id and verified=true and local_uid=any(p_local_uids);
  if owned_count<>uid_count then raise exception '保管庫にいない個体が含まれています'; end if;
  select count(*) into active_count from private.player_expeditions where user_id=p_user_id;
  if active_count>=2 then raise exception '探索に出せるのは同時に2組までです'; end if;
  if exists(select 1 from private.player_expeditions e,unnest(e.local_uids) u where e.user_id=p_user_id and u=any(p_local_uids)) then raise exception 'すでに探索中の個体が含まれています'; end if;
  base_amount:=case p_destination when 'field' then 40 when 'forest' then 320 else 1800 end;
  minutes_amount:=case p_destination when 'field' then 5 when 'forest' then 60 else 480 end;
  reward_amount:=round(base_amount*(1+0.8*log(10,1+sum_power/150)+greatest(0,0.25*(wisdom_level+1))));
  duration_ms:=round(minutes_amount*60000*(1-least(0.5,greatest(0,0.1+0.15*speed_level))));
  great_chance:=least(0.5,greatest(0.03,0.1+0.12*luck_level)); is_great:=random()<great_chance;
  insert into private.player_expeditions(user_id,destination,local_uids,ends_at,base_reward,reward,great)
  values(p_user_id,p_destination,p_local_uids,now()+(duration_ms||' milliseconds')::interval,reward_amount,reward_amount*(case when is_great then 2 else 1 end),is_great);
  return public.game_status(p_user_id);
end;
$$;

create or replace function public.claim_verified_expedition(p_user_id uuid,p_expedition_id bigint)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare exp private.player_expeditions%rowtype; today_jst date := (clock_timestamp() at time zone 'Asia/Tokyo')::date;
begin
  select * into exp from private.player_expeditions where id=p_expedition_id and user_id=p_user_id for update;
  if exp.id is null then raise exception '探索が見つかりません'; end if;
  if exp.ends_at>now() then raise exception 'まだ帰ってきていません'; end if;
  insert into private.player_wallets(user_id) values(p_user_id) on conflict(user_id) do nothing;
  delete from private.player_expeditions where id=exp.id;
  update private.player_wallets set coins=coins+exp.reward,updated_at=now() where user_id=p_user_id;
  insert into private.player_daily_progress(user_id,progress_date,expedition_count) values(p_user_id,today_jst,1)
  on conflict(user_id,progress_date) do update set expedition_count=private.player_daily_progress.expedition_count+1;
  return public.game_status(p_user_id)||jsonb_build_object('gained',exp.reward,'great',exp.great);
end;
$$;

create or replace function public.begin_verified_battle(p_user_id uuid,p_stage_id text,p_local_uids bigint[])
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare expected integer; owned integer; stage_no integer; level_no integer; prior_id text; ready timestamptz; ticket uuid;
begin
  if p_stage_id ~ '^q(00[1-9]|010)_[1-3]$' then expected:=1;
  elsif p_stage_id in ('farm_1','farm_2','farm_3') then expected:=1;
  elsif p_stage_id in ('t001','t002','t003','t005','t010') then expected:=2;
  elsif p_stage_id in ('t004','t006','t007','t008','t009') then expected:=3;
  else raise exception 'ステージが正しくありません'; end if;
  if coalesce(array_length(p_local_uids,1),0)<>expected or (select count(distinct x) from unnest(p_local_uids)x)<>expected then raise exception '出場個体が正しくありません'; end if;
  select count(*) into owned from public.ranking_entries where user_id=p_user_id and verified=true and local_uid=any(p_local_uids);
  if owned<>expected then raise exception 'オンラインで確認できない個体が含まれています'; end if;
  if (select count(distinct char_id) from public.ranking_entries where user_id=p_user_id and verified=true and local_uid=any(p_local_uids))<>expected then raise exception '同じキャラを同じチームに入れることはできません'; end if;
  if p_stage_id like 'q%' then
    level_no:=right(p_stage_id,1)::integer;
    if level_no>1 then prior_id:=left(p_stage_id,5)||(level_no-1); if not exists(select 1 from private.player_quest_progress where user_id=p_user_id and stage_id=prior_id and cleared) then raise exception '前の段階をクリアすると挑戦できます'; end if; end if;
  elsif p_stage_id like 't%' then
    stage_no:=right(p_stage_id,3)::integer; prior_id:='q'||lpad(stage_no::text,3,'0')||'_3';
    if not exists(select 1 from private.player_quest_progress where user_id=p_user_id and stage_id=prior_id and cleared) then raise exception 'このキャラの段階3をクリアすると挑戦できます'; end if;
  else
    select farm_ready_at into ready from private.player_quest_progress where user_id=p_user_id and stage_id=p_stage_id;
    if ready>now() then raise exception 'まだ再挑戦できません'; end if;
    insert into private.player_quest_progress(user_id,stage_id,farm_ready_at) values(p_user_id,p_stage_id,now()+(case p_stage_id when 'farm_1' then interval '30 seconds' when 'farm_2' then interval '120 seconds' else interval '300 seconds' end))
    on conflict(user_id,stage_id) do update set farm_ready_at=excluded.farm_ready_at,updated_at=now();
  end if;
  delete from private.battle_tickets where user_id=p_user_id;
  insert into private.battle_tickets(user_id,stage_id,local_uids) values(p_user_id,p_stage_id,p_local_uids) returning id into ticket;
  return jsonb_build_object('ticket',ticket,'stage_id',p_stage_id);
end;
$$;

create or replace function public.finish_verified_battle(p_user_id uuid,p_ticket uuid,p_won boolean,p_goal boolean)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t private.battle_tickets%rowtype; q private.player_quest_progress%rowtype;
  reward_value bigint:=0; is_first boolean:=false; goal_first boolean:=false;
  level_no integer; today_jst date := (clock_timestamp() at time zone 'Asia/Tokyo')::date; new_streak integer:=0;
begin
  select * into t from private.battle_tickets where id=p_ticket and user_id=p_user_id for update;
  if t.id is null or t.expires_at<now() then raise exception '挑戦の有効期限が切れました'; end if;
  delete from private.battle_tickets where id=t.id;
  select * into q from private.player_quest_progress where user_id=p_user_id and stage_id=t.stage_id;
  if t.stage_id like 'farm%' then
    if t.stage_id='farm_2' then new_streak:=case when p_won then least(5,coalesce(q.arena_streak,0)+1) else 0 end; end if;
    if p_won then reward_value:=case t.stage_id when 'farm_1' then 60 when 'farm_2' then round(150*(1+new_streak*0.1)) else case when p_goal then 600 else 400 end end; end if;
    update private.player_quest_progress set arena_streak=new_streak,updated_at=now() where user_id=p_user_id and stage_id=t.stage_id;
  else
    is_first:=p_won and not coalesce(q.cleared,false); goal_first:=p_won and p_goal and not coalesce(q.goal,false);
    if p_won then
      if t.stage_id like 'q%' then
        level_no:=right(t.stage_id,1)::integer;
        reward_value:=case level_no when 1 then case when is_first then 300 else 30 end when 2 then case when is_first then 800 else 60 end else case when is_first then 2000 else 100 end end;
        if goal_first then reward_value:=reward_value+(case level_no when 1 then 100 when 2 then 300 else 800 end); end if;
      else reward_value:=case when is_first then 3000 else 150 end; if goal_first then reward_value:=reward_value+1000; end if;
      end if;
      insert into private.player_quest_progress(user_id,stage_id,cleared,goal)
      values(p_user_id,t.stage_id,true,p_goal)
      on conflict(user_id,stage_id) do update set cleared=true,goal=private.player_quest_progress.goal or excluded.goal,updated_at=now();
    end if;
  end if;
  if reward_value>0 then
    insert into private.player_wallets(user_id) values(p_user_id) on conflict(user_id) do nothing;
    update private.player_wallets set coins=coins+reward_value,updated_at=now() where user_id=p_user_id;
    insert into private.player_daily_progress(user_id,progress_date,quest_count) values(p_user_id,today_jst,1)
    on conflict(user_id,progress_date) do update set quest_count=private.player_daily_progress.quest_count+1;
  end if;
  return public.game_status(p_user_id)||jsonb_build_object('reward',reward_value,'first',is_first,'goal_first',goal_first,'won',p_won,'stage_id',t.stage_id,'streak',new_streak);
end;
$$;

-- ガチャ確定時に図鑑履歴と日課を同じトランザクションで更新する。
create or replace function public.commit_verified_pull_v2(p_user_id uuid,p_player_name text,p_entries jsonb)
returns jsonb language plpgsql security invoker set search_path=''
as $$
declare item jsonb; item_count integer; pull_cost bigint; assigned_serial bigint; clean_name text; wallet private.player_wallets%rowtype; inserted public.ranking_entries%rowtype; results jsonb:='[]'::jsonb; today_jst date:=(clock_timestamp() at time zone 'Asia/Tokyo')::date;
begin
  if jsonb_typeof(p_entries)<>'array' then raise exception '抽選結果が正しくありません'; end if; item_count:=jsonb_array_length(p_entries); if item_count not in(1,10) then raise exception '引ける回数は1回か10回です'; end if;
  pull_cost:=case item_count when 1 then 100 else 1000 end; clean_name:=left(coalesce(nullif(btrim(p_player_name),''),'あなた'),12);
  insert into private.player_wallets(user_id) values(p_user_id) on conflict(user_id) do nothing; select * into wallet from private.player_wallets where user_id=p_user_id for update;
  if wallet.coins<pull_cost then raise exception 'コインが足りません（あと%コイン）',pull_cost-wallet.coins; end if;
  update private.player_wallets set coins=coins-pull_cost,updated_at=now() where user_id=p_user_id returning * into wallet;
  for item in select value from jsonb_array_elements(p_entries) loop
    insert into private.character_serials(char_id,next_serial) values(item->>'char_id',2) on conflict(char_id) do update set next_serial=private.character_serials.next_serial+1 returning next_serial-1 into assigned_serial;
    insert into public.ranking_entries(user_id,local_uid,player_name,char_id,rarity,special,nature,serial,weight,height,weight_dev,height_dev,power,speed,wisdom,luck,nature_strength,shine,appetite,total_score,updated_at,verified,verified_at)
    values(p_user_id,(item->>'local_uid')::bigint,clean_name,item->>'char_id',(item->>'rarity')::smallint,(item->>'special')::boolean,item->>'nature',assigned_serial,(item->>'weight')::numeric,(item->>'height')::numeric,(item->>'weight_dev')::numeric,(item->>'height_dev')::numeric,(item->>'power')::integer,(item->>'speed')::integer,(item->>'wisdom')::integer,(item->>'luck')::integer,(item->>'nature_strength')::integer,(item->>'shine')::integer,(item->>'appetite')::integer,(item->>'total_score')::integer,now(),true,now()) returning * into inserted;
    insert into private.player_collection(user_id,char_id,rarity) values(p_user_id,inserted.char_id,inserted.rarity) on conflict(user_id,char_id,rarity) do update set obtained_count=private.player_collection.obtained_count+1;
    results:=results||jsonb_build_array(to_jsonb(inserted));
  end loop;
  insert into private.player_daily_progress(user_id,progress_date,pull_count) values(p_user_id,today_jst,item_count) on conflict(user_id,progress_date) do update set pull_count=private.player_daily_progress.pull_count+item_count;
  return jsonb_build_object('coins',wallet.coins,'results',results);
end;
$$;

-- ガチャIDから価格を決める。ブラウザから価格や排出キャラは受け取らない。
create or replace function public.commit_verified_pull_v3(p_user_id uuid,p_player_name text,p_entries jsonb,p_gacha_id text)
returns jsonb language plpgsql security invoker set search_path=''
as $$
declare item jsonb; item_count integer; pull_cost bigint; assigned_serial bigint; clean_name text; wallet private.player_wallets%rowtype; inserted public.ranking_entries%rowtype; results jsonb:='[]'::jsonb; today_jst date:=(clock_timestamp() at time zone 'Asia/Tokyo')::date;
begin
  if jsonb_typeof(p_entries)<>'array' then raise exception '抽選結果が正しくありません'; end if;
  item_count:=jsonb_array_length(p_entries); if item_count not in(1,10) then raise exception '引ける回数は1回か10回です'; end if;
  pull_cost:=case p_gacha_id when 'normal_1' then case item_count when 1 then 100 else 1000 end when 'limited_1' then case item_count when 1 then 300 else 3000 end else null end;
  if pull_cost is null then raise exception '開催中のガチャを確認できませんでした'; end if;
  clean_name:=left(coalesce(nullif(btrim(p_player_name),''),'あなた'),12);
  insert into private.player_wallets(user_id) values(p_user_id) on conflict(user_id) do nothing; select * into wallet from private.player_wallets where user_id=p_user_id for update;
  if wallet.coins<pull_cost then raise exception 'コインが足りません（あと%コイン）',pull_cost-wallet.coins; end if;
  update private.player_wallets set coins=coins-pull_cost,updated_at=now() where user_id=p_user_id returning * into wallet;
  for item in select value from jsonb_array_elements(p_entries) loop
    insert into private.character_serials(char_id,next_serial) values(item->>'char_id',2) on conflict(char_id) do update set next_serial=private.character_serials.next_serial+1 returning next_serial-1 into assigned_serial;
    insert into public.ranking_entries(user_id,local_uid,player_name,char_id,rarity,special,nature,serial,weight,height,weight_dev,height_dev,power,speed,wisdom,luck,nature_strength,shine,appetite,total_score,updated_at,verified,verified_at)
    values(p_user_id,(item->>'local_uid')::bigint,clean_name,item->>'char_id',(item->>'rarity')::smallint,(item->>'special')::boolean,item->>'nature',assigned_serial,(item->>'weight')::numeric,(item->>'height')::numeric,(item->>'weight_dev')::numeric,(item->>'height_dev')::numeric,(item->>'power')::integer,(item->>'speed')::integer,(item->>'wisdom')::integer,(item->>'luck')::integer,(item->>'nature_strength')::integer,(item->>'shine')::integer,(item->>'appetite')::integer,(item->>'total_score')::integer,now(),true,now()) returning * into inserted;
    insert into private.player_collection(user_id,char_id,rarity) values(p_user_id,inserted.char_id,inserted.rarity) on conflict(user_id,char_id,rarity) do update set obtained_count=private.player_collection.obtained_count+1;
    results:=results||jsonb_build_array(to_jsonb(inserted));
  end loop;
  insert into private.player_daily_progress(user_id,progress_date,pull_count) values(p_user_id,today_jst,item_count) on conflict(user_id,progress_date) do update set pull_count=private.player_daily_progress.pull_count+item_count;
  return jsonb_build_object('coins',wallet.coins,'results',results);
end;
$$;
revoke all on function public.commit_verified_pull_v3(uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.commit_verified_pull_v3(uuid,text,jsonb,text) to service_role;

create or replace function public.release_verified_entries(p_user_id uuid,p_local_uids bigint[])
returns jsonb language plpgsql security invoker set search_path=''
as $$
declare wallet private.player_wallets%rowtype; reward bigint:=0; released jsonb:='[]'::jsonb; released_count integer:=0; today_jst date:=(clock_timestamp() at time zone 'Asia/Tokyo')::date;
begin
  if coalesce(array_length(p_local_uids,1),0) not between 1 and 200 then raise exception '送り出す個体が正しくありません'; end if;
  insert into private.player_wallets(user_id) values(p_user_id) on conflict(user_id) do nothing; select * into wallet from private.player_wallets where user_id=p_user_id for update;
  with deleted as(delete from public.ranking_entries where user_id=p_user_id and verified=true and local_uid=any(p_local_uids) returning local_uid,rarity,special),valued as(select local_uid,(case rarity when 1 then 10 when 2 then 20 when 3 then 50 when 4 then 150 when 5 then 500 else 0 end)*(case when special then 5 else 1 end) value from deleted)
  select coalesce(sum(value),0),coalesce(jsonb_agg(local_uid order by local_uid),'[]'::jsonb),count(*) into reward,released,released_count from valued;
  update private.player_wallets set coins=coins+reward,updated_at=now() where user_id=p_user_id returning * into wallet;
  if released_count>0 then insert into private.player_daily_progress(user_id,progress_date,release_count) values(p_user_id,today_jst,released_count) on conflict(user_id,progress_date) do update set release_count=private.player_daily_progress.release_count+released_count; end if;
  return jsonb_build_object('coins',wallet.coins,'gained',reward,'released',released);
end;
$$;

revoke all on function public.game_status(uuid),public.claim_stamp_rewards(uuid),public.record_detail_view(uuid),public.claim_tutorial_reward(uuid),
  public.claim_daily_mission(uuid,text),public.start_verified_expedition(uuid,text,bigint[]),
  public.claim_verified_expedition(uuid,bigint),public.begin_verified_battle(uuid,text,bigint[]),
  public.finish_verified_battle(uuid,uuid,boolean,boolean) from public,anon,authenticated;
grant execute on function public.game_status(uuid),public.claim_stamp_rewards(uuid),public.record_detail_view(uuid),public.claim_tutorial_reward(uuid),
  public.claim_daily_mission(uuid,text),public.start_verified_expedition(uuid,text,bigint[]),
  public.claim_verified_expedition(uuid,bigint),public.begin_verified_battle(uuid,text,bigint[]),
  public.finish_verified_battle(uuid,uuid,boolean,boolean) to service_role;
