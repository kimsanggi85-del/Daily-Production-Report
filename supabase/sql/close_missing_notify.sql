-- 2026-11-24 요청: 생산하다 멈췄거나 마감을 안 한 설비는 알람으로 "마감 등록하세요"
--  오늘 생산한 설비 = MES 일별집계 정상 타발 > 0  또는  일별집계가 없는데 오늘 타발 기록(machine_status.last_shot_at)이 있음
--                    또는 카운터 고장 설비(close_remind_always: 47·48호기) — 평일 항상 대상
--  그중 오늘 현장 마감(production_close, 수량 > 0)이 없는 설비를 ntfy(taejincall)로 알림
--  발송 시각: 업무 종료 30분 전(마감 등록 안내) · 종료 30분 뒤(미등록 재알림) · 21:00(최종) — 미등록 설비가 있을 때만
--  업무 종료: 평일 19:00 / 수·토·일 17:00 / 2026-11-23~27 17:00 (check_auto_close 와 같은 기준)
create table if not exists public.close_remind_always (machine_code text primary key, memo text);
insert into public.close_remind_always values ('025','47호기 카운터 고장 — 현장 수량으로 마감'),('026','48호기 카운터 고장 — 현장 수량으로 마감') on conflict do nothing;
create table if not exists public.close_remind_sent (d text, slot text, at timestamptz default now(), cnt int, msg text, primary key (d, slot));
alter table public.close_remind_always enable row level security;
alter table public.close_remind_sent enable row level security;

create or replace function public.close_missing_list(p_d date default null) returns table(machine_code text, ho text, item text, why text)
language sql stable security definer set search_path = public as $$
  with d as (select coalesce(p_d, (now() at time zone 'Asia/Seoul')::date) d),
  ms as (select m.*, (select sum(coalesce(normal_shot, shot_qty)) from daily_production x, d where x.machine_code = m.machine_code and x.ymd::date = d.d) dp,
                (select count(*) from daily_production x, d where x.machine_code = m.machine_code and x.ymd::date = d.d) dpn
         from machine_status m where coalesce(m.is_virtual, false) = false)
  select ms.machine_code, coalesce(substring(ms.machine_name from '^(\d+)'), ms.machine_code),
         coalesce(ms.current_item_code, ''),
         case when ms.dp > 0 then 'MES 정상 타발 ' || to_char(ms.dp, 'FM999,999')
              when a.machine_code is not null then a.memo
              else '오늘 타발 기록 (최종 ' || to_char(ms.last_shot_at at time zone 'Asia/Seoul', 'HH24:MI') || ')' end
  from ms cross join d
  left join close_remind_always a on a.machine_code = ms.machine_code
  where (ms.dp > 0
         or (ms.dpn = 0 and (ms.last_shot_at at time zone 'Asia/Seoul')::date = d.d)
         or a.machine_code is not null)
    and not exists (select 1 from production_close c where c.machine_code = ms.machine_code and c.ymd::date = d.d and coalesce(c.actual_qty, 0) > 0)
  order by 2;
$$;

create or replace function public.close_missing_notify(p_force text default null) returns text
language plpgsql security definer set search_path = public as $$
declare
  now_k timestamp := now() at time zone 'Asia/Seoul';
  d date := now_k::date;
  ds text := to_char(d, 'YYYY-MM-DD');
  off_t time := case when extract(isodow from d) in (3, 6, 7) or d between date '2026-11-23' and date '2026-11-27' then time '17:00' else time '19:00' end;
  slot text; title text; lines text; n int;
begin
  slot := coalesce(p_force,
    case when now_k::time >= off_t - interval '30 min' and now_k::time < off_t - interval '20 min' then 'before'
         when now_k::time >= off_t + interval '30 min' and now_k::time < off_t + interval '40 min' then 'after'
         when now_k::time >= time '21:00' and now_k::time < time '21:10' then 'final' end);
  if slot is null then return '발송 시각 아님'; end if;
  if p_force is null and exists (select 1 from close_remind_sent where close_remind_sent.d = ds and close_remind_sent.slot = slot) then return '이미 발송'; end if;
  select count(*), string_agg('· ' || l.ho || '호기 ' || l.item || ' — ' || l.why, chr(10)) into n, lines from close_missing_list(d) l;
  if n = 0 then return '미등록 설비 없음'; end if;
  title := case slot when 'before' then '마감 등록하세요 — 미등록 ' || n || '대 (' || to_char(off_t, 'HH24:MI') || ' 종료)'
                     when 'after'  then '⚠ 마감 미등록 ' || n || '대 — 지금 마감 등록하세요'
                     else '⚠ 마감 미등록 ' || n || '대 (최종) — 오늘 안에 등록하세요' end;
  perform net.http_post(url := 'https://ntfy.sh/', headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('topic', 'taejincall', 'title', title,
      'message', lines || chr(10) || chr(10) || '생산한 설비는 MES 모바일 생산마감에서 실제 양품 수량을 등록해 주세요.' ||
                 case when slot <> 'before' then chr(10) || '(늦게 등록해도 일보에 자동 반영됩니다)' else '' end,
      'tags', jsonb_build_array(case when slot = 'before' then 'memo' else 'warning' end), 'priority', case when slot = 'before' then 3 else 4 end),
    timeout_milliseconds := 30000);
  insert into close_remind_sent(d, slot, cnt, msg) values (ds, slot, n, lines) on conflict (d, slot) do update set at = now(), cnt = excluded.cnt, msg = excluded.msg;
  return slot || ' 발송 ' || n || '대';
end $$;
revoke all on function public.close_missing_notify(text) from public, anon, authenticated;

-- 10분마다 시각 확인 (UTC 07~12시 = KST 16:00~21:59), 평일만
select cron.schedule('prod-close-missing-notify', '*/10 7-12 * * *', $$select public.run_if_weekday('select public.close_missing_notify()')$$);
-- 확인: select * from public.close_missing_list();   수동 발송: select public.close_missing_notify('before');
