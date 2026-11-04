-- 작업지시 변경 즉시 알림 (SmartFactory)
-- machine_status 의 작업지시(current_wo)·품번(current_item_code)이 바뀌면 표시해 두고,
-- pg_cron 'wo-change-kick'(1분마다, 07:00~20:59 KST)이 표시가 있을 때만 wo-change-notify 를 호출한다.
--  · 여러 설비가 한꺼번에 바뀌어도 한 번만 호출 (알림 중복 방지)
--  · 5분 주기 실행(wo-change-notify)은 초물 미실시 확인용으로 유지, 같은 순간이면 kick 은 건너뜀
--  · 07:00~20:59 KST 에만 호출. 09:30 전 기준값만 갱신하는 판단은 함수가 한다.
-- 옛 프로젝트(ebthltd…)의 wo-change-notify / -early 예약은 2026-11-05 비활성화 (중복 알림 원인)

create table if not exists public.wo_change_flag (
  id int primary key default 1 check (id = 1),
  dirty_at timestamptz
);
alter table public.wo_change_flag enable row level security;
insert into public.wo_change_flag(id) values (1) on conflict do nothing;

create or replace function public.wo_change_mark() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.wo_change_flag set dirty_at = now() where id = 1 and dirty_at is null;
  return null;
end $$;

drop trigger if exists trg_wo_change_mark on public.machine_status;
create trigger trg_wo_change_mark
  after update of current_wo, current_item_code on public.machine_status
  for each row
  when (old.current_wo is distinct from new.current_wo or old.current_item_code is distinct from new.current_item_code)
  execute function public.wo_change_mark();

create or replace function public.wo_change_kick() returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  k timestamp := now() at time zone 'Asia/Seoul';
  cmd text;
begin
  if extract(minute from k)::int % 5 = 0 and extract(second from k) < 15 then
    update public.wo_change_flag set dirty_at = null where id = 1;
    return '5분 주기 실행과 겹침';
  end if;
  update public.wo_change_flag set dirty_at = null where id = 1 and dirty_at is not null returning 'x' into cmd;
  if cmd is null then return '변경 없음'; end if;
  if extract(hour from k) < 7 or extract(hour from k) > 20 then return '업무 시간 외'; end if;
  select command into cmd from cron.job where jobname = 'wo-change-notify';
  if cmd is null then return '호출 명령 없음'; end if;
  execute cmd;
  return '알림 함수 호출';
end $$;
revoke all on function public.wo_change_kick() from public, anon, authenticated;
revoke all on function public.wo_change_mark() from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job where jobname = 'wo-change-kick';
select cron.schedule('wo-change-kick', '* 22,23,0-11 * * *', $$select public.wo_change_kick()$$);  -- UTC 22~11시 = KST 07~20시
