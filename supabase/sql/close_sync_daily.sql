-- 2026-11-24 요청: 마감은 무조건 일보에 반영 · 0으로 돌아가면 기록 남기고 다시 마감
-- 현장 마감(production_close) → 생산일보(kv tj_prod_daily_v1 recs) 대조·보정
--   · 마감 수량이 있는데 일보에 그 설비·품번 줄이 없으면 → 줄 추가 (note '마감자료 자동 반영')
--   · 일보 줄 수량이 마감과 다르면 (0 포함) → 마감 수량으로 (src '조정' 줄은 사용자가 고친 것이라 그대로)
--   · 같은 설비·품번 일보 줄이 여러 개면 손대지 않고 보고만
--   · 제외 목록(close_sync_skip)에 있는 마감은 건너뜀 (예: 11/16 48호기 1179-2 — 1113-2 와 같은 수량 중복 저장)
--   · 대상: 최근 p_days 일 중 어제까지 + 오늘은 저녁 자동 마감이 끝난 뒤
--   · 바꾼 내용은 close_sync_log 에 남기고 ntfy(taejincall)로 알림
create table if not exists public.close_sync_skip (
  ymd text, machine_code text, item_code text, memo text, created_at timestamptz default now(),
  primary key (ymd, machine_code, item_code));
create table if not exists public.close_sync_log (
  id bigserial primary key, at timestamptz default now(), ymd text, mc text, pn text, action text, old_qty numeric, new_qty numeric, memo text);
alter table public.close_sync_skip enable row level security;
alter table public.close_sync_log enable row level security;
drop policy if exists "read close_sync_log" on public.close_sync_log;
create policy "read close_sync_log" on public.close_sync_log for select to anon, authenticated using (true);
insert into public.close_sync_skip values ('2026-11-16','026','IW/OW-BDA-1179-2','같은 날 1113-2 와 같은 수량 13,600 중복 저장 — 일보는 1113-2 로 (2026-11-24 사용자 결정)', now()) on conflict do nothing;

create or replace function public.close_sync_daily(p_days int default 14, p_dry boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb; recs jsonb; items jsonb;
  td date := (now() at time zone 'Asia/Seoul')::date;
  ts text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  c record; m record; it jsonb;
  out jsonb := '[]'::jsonb; warn jsonb := '[]'::jsonb;
  n int; idx int; wd int; early boolean; msg text;
begin
  select value into v from kv_store where key = 'tj_prod_daily_v1' for update;
  recs := v -> 'recs'; items := v -> 'master' -> 'items';
  for c in
    with mcm as (select e.key code, e.value name from jsonb_each_text(v -> 'master' -> 'mesMc') e),
         pm  as (select e.key raw, e.value pn from jsonb_each_text(v -> 'master' -> 'mesPn') e),
         itn as (select i ->> 'pn' pn, upper(regexp_replace(i ->> 'pn', '[^0-9A-Za-z]', '', 'g')) nn from jsonb_array_elements(items) i),
         ac  as (select value ac from kv_store where key = 'tj_prod_autoclose_v1')
    select pc.ymd, pc.machine_code, mcm.name mc, sum(pc.actual_qty) q, string_agg(distinct pc.item_code, ',') raw,
           coalesce(pm.pn, (select itn.pn from itn where itn.nn = upper(regexp_replace(pc.item_code, '[^0-9A-Za-z]', '', 'g')) limit 1)) pn,
           string_agg(distinct nullif(pc.worker, ''), ',') worker
    from production_close pc
    left join mcm on mcm.code = pc.machine_code
    left join pm on pm.raw = pc.item_code
    where pc.ymd::date between td - p_days and td
      and coalesce(pc.actual_qty, 0) > 0
      and (pc.ymd::date < td or ((select ac from ac) -> pc.ymd ->> 'evening') is not null)
      and not exists (select 1 from close_sync_skip s where s.ymd = pc.ymd and s.machine_code = pc.machine_code and s.item_code = pc.item_code)
    group by 1, 2, 3, 6
  loop
    if c.mc is null or c.pn is null then
      warn := warn || jsonb_build_object('d', c.ymd, 'mc', c.machine_code, 'item', c.raw, 'why', case when c.mc is null then '설비 연결 없음' else '품번 연결 없음' end);
      continue;
    end if;
    select count(*), min(o) into n, idx from jsonb_array_elements(recs) with ordinality x(r, o)
      where r ->> 'date' = c.ymd and r ->> 'mc' = c.mc and upper(regexp_replace(r ->> 'pn', '[^0-9A-Za-z]', '', 'g')) = upper(regexp_replace(c.pn, '[^0-9A-Za-z]', '', 'g'))
        and not ((v -> 'del') ? (r ->> 'id'));
    if n = 0 then
      it := (select i from jsonb_array_elements(items) i where i ->> 'pn' = c.pn limit 1);
      wd := extract(isodow from c.ymd::date);
      early := wd = 3 or c.ymd between '2026-11-23' and '2026-11-27';
      recs := recs || jsonb_build_array(jsonb_build_object(
        'id', 'C' || substr(md5(c.ymd || c.mc || c.pn || clock_timestamp()::text), 1, 12),
        'date', c.ymd, 'mc', c.mc, 'proc', '', 'cust', coalesce(it ->> 'cust', ''), 'pn', c.pn, 'name', coalesce(it ->> 'name', ''),
        'w1', coalesce(split_part(c.worker, ',', 1), ''), 'w2', '', 'w3', '', 'w4', '',
        'spm', coalesce(nullif((it ->> 'spm')::numeric, 0), (select (r ->> 'spm')::numeric from jsonb_array_elements(recs) r where r ->> 'mc' = c.mc and r ->> 'pn' = c.pn and coalesce((r ->> 'spm')::numeric, 0) > 0 order by r ->> 'date' desc limit 1), 0),  -- 2026-11-25: 품목 SPM 이 0이면 그 설비·품번 최근 일보 SPM (0이면 앱이 '단발'로 표시)
         'work', case when early then 540 else 660 end, 'brk', case when early then 80 else 90 end,
        'stop', 0, 'qty', c.q, 'ng', 0, 'ngp', 0, 'sr', '', 'note', '마감자료 자동 반영 (근무·정지 확인 필요)', 'reg', 1, 'src', '마감', 'ua', ts, 'by', ''));
      out := out || jsonb_build_object('d', c.ymd, 'mc', c.mc, 'pn', c.pn, 'act', '추가', 'old', null, 'new', c.q);
    elsif n = 1 then
      if coalesce((recs -> (idx - 1) ->> 'qty')::numeric, 0) <> c.q and coalesce(recs -> (idx - 1) ->> 'src', '') <> '조정' then
        out := out || jsonb_build_object('d', c.ymd, 'mc', c.mc, 'pn', c.pn, 'act', '수량', 'old', (recs -> (idx - 1) ->> 'qty')::numeric, 'new', c.q);
        recs := jsonb_set(recs, array[(idx - 1)::text], (recs -> (idx - 1)) || jsonb_build_object('qty', c.q, 'src', '마감', 'ua', ts));
      end if;
    else
      if (select sum((r ->> 'qty')::numeric) from jsonb_array_elements(recs) r where r ->> 'date' = c.ymd and r ->> 'mc' = c.mc and r ->> 'pn' = c.pn and not ((v -> 'del') ? (r ->> 'id'))) <> c.q then
        warn := warn || jsonb_build_object('d', c.ymd, 'mc', c.mc, 'pn', c.pn, 'why', '일보 줄 ' || n || '개 · 합계가 마감과 다름', 'close', c.q);
      end if;
    end if;
  end loop;

  if not p_dry and jsonb_array_length(out) > 0 then
    update kv_store set value = jsonb_set(v, '{recs}', recs), updated_at = now() where key = 'tj_prod_daily_v1';
    insert into close_sync_log (ymd, mc, pn, action, old_qty, new_qty)
      select o ->> 'd', o ->> 'mc', o ->> 'pn', o ->> 'act', (o ->> 'old')::numeric, (o ->> 'new')::numeric from jsonb_array_elements(out) o;
    select string_agg(to_char((o ->> 'd')::date, 'MM/DD') || ' ' || (o ->> 'mc') || ' ' || (o ->> 'pn') || ' ' ||
             case when o ->> 'act' = '추가' then '줄 추가 ' else coalesce(o ->> 'old', '0') || ' → ' end || to_char((o ->> 'new')::numeric, 'FM999,999,999'), chr(10))
      into msg from jsonb_array_elements(out) o;
    perform net.http_post(url := 'https://ntfy.sh/', headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('topic', 'taejincall', 'title', '생산일보 ← 현장 마감 자동 보정 ' || jsonb_array_length(out) || '건',
        'message', msg || chr(10) || '(일보가 현장 마감 수량과 달라 마감 수량으로 맞췄습니다)', 'tags', jsonb_build_array('arrows_counterclockwise'), 'priority', 3),
      timeout_milliseconds := 30000);
  end if;
  return jsonb_build_object('dry', p_dry, 'fixed', out, 'warn', warn);
end $$;
revoke all on function public.close_sync_daily(int, boolean) from public, anon, authenticated;

-- 11/16 48호기 1113-2 현장 마감 복구 (18:49 저장분, 19:11 1179-2 저장 때 MES 가 지움) — 2026-11-24 적용됨
-- insert into production_close (...) values ('2026-11-16','026','IW/OW-BDA-1113-2', ..., 13600, ..., '황덕순', '2026-11-16 18:49:46+09');
-- 2026-11-24 사용자 허용: 07:20~23:50 30분마다 자동 실행. 수동 확인: select public.close_sync_daily(14, true);  -- true = 보기만
select cron.schedule('prod-close-sync', '20,50 22,23,0-14 * * *', $$select public.close_sync_daily(14, false)$$);
