-- 2026-11-24 요청: "생산실적 중요 · 마감 무조건 되어야 · 0으로 돌아가면 안 됨 · 0으로 돌아가도 기록을 남기고 다시 마감"
-- ① 현장 마감(production_close) 모든 변경 기록 (production_close_hist)
-- ② 마감 수량이 있던 행을 0/빈값으로 덮어쓰면 → 이전 수량 유지 + 기록
-- ③ 앱(anon·authenticated)이 현장 마감 행을 지우면 → 지우지 않고 기록만 (생산일보 앱이 만든 source='생산일보' 행은 예외)
--    MES 간이 화면이 품번을 바꿔 다시 저장할 때 앞 품번 마감을 지우던 문제(11/16 48호기) 방지
create table if not exists public.production_close_hist (
  id bigserial primary key,
  at timestamptz not null default now(),
  op text not null,
  who text,
  ymd text, machine_code text, item_code text,
  old_qty integer, new_qty integer,
  note text,
  old_row jsonb, new_row jsonb
);
create index if not exists production_close_hist_key on public.production_close_hist (ymd, machine_code, item_code);
alter table public.production_close_hist enable row level security;
drop policy if exists "read production_close_hist" on public.production_close_hist;
create policy "read production_close_hist" on public.production_close_hist for select to anon, authenticated using (true);

create or replace function public.production_close_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  who text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', session_user);
  app boolean := who in ('anon', 'authenticated');
begin
  if tg_op = 'INSERT' then
    insert into production_close_hist(op, who, ymd, machine_code, item_code, new_qty, new_row)
    values ('INSERT', who, new.ymd, new.machine_code, new.item_code, new.actual_qty, to_jsonb(new));
    return new;
  elsif tg_op = 'UPDATE' then
    if coalesce(old.actual_qty, 0) > 0 and coalesce(new.actual_qty, 0) = 0 then
      insert into production_close_hist(op, who, ymd, machine_code, item_code, old_qty, new_qty, note, old_row, new_row)
      values ('UPDATE', who, old.ymd, old.machine_code, old.item_code, old.actual_qty, new.actual_qty, '0 덮어쓰기 차단 → 이전 수량 유지', to_jsonb(old), to_jsonb(new));
      new.actual_qty := old.actual_qty;
      new.diff_qty := old.diff_qty;
      return new;
    end if;
    if new.actual_qty is distinct from old.actual_qty or new.item_code is distinct from old.item_code or new.ymd is distinct from old.ymd then
      insert into production_close_hist(op, who, ymd, machine_code, item_code, old_qty, new_qty, old_row, new_row)
      values ('UPDATE', who, new.ymd, new.machine_code, new.item_code, old.actual_qty, new.actual_qty, to_jsonb(old), to_jsonb(new));
    end if;
    return new;
  else
    if app and coalesce(old.source, '') <> '생산일보' and coalesce(old.actual_qty, 0) > 0 then
      insert into production_close_hist(op, who, ymd, machine_code, item_code, old_qty, note, old_row)
      values ('DELETE', who, old.ymd, old.machine_code, old.item_code, old.actual_qty, '삭제 차단 → 행 유지', to_jsonb(old));
      return null;
    end if;
    insert into production_close_hist(op, who, ymd, machine_code, item_code, old_qty, note, old_row)
    values ('DELETE', who, old.ymd, old.machine_code, old.item_code, old.actual_qty, '삭제', to_jsonb(old));
    return old;
  end if;
end $$;

drop trigger if exists production_close_guard on public.production_close;
create trigger production_close_guard before insert or update or delete on public.production_close
  for each row execute function public.production_close_guard();
