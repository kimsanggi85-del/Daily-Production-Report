-- 재고수불부(stock_ledger)에 넣지 않을 MES 품번 (SmartFactory, 2026-11-20 적용)
-- MES 동기화(stock_ledger_sync)가 같은 전표를 계속 다시 올려도 트리거가 막는다. 재고 품목은 숨김 처리.
--   '45631-26010 B/C' : 02 심팩200 공용 작업지시 — 재고는 완성품(C) 기준으로 따로 잡는다
-- (같은 날 잠깐 썼던 품번 별칭 stock_pn_alias 트리거는 삭제함)
create table if not exists public.stock_pn_exclude (
  pn text primary key,
  memo text,
  created_at timestamptz default now()
);
alter table public.stock_pn_exclude enable row level security;
insert into public.stock_pn_exclude(pn, memo) values
  ('45631-26010 B/C', 'MES B/C 공용 작업지시 — 재고 미반영 (완성품 C 기준으로 별도 입력)')
on conflict (pn) do update set memo = excluded.memo;

create or replace function public.stock_ledger_pn_exclude() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.stock_pn_exclude where pn = new.pn) then
    return null;   -- 넣지 않는다
  end if;
  return new;
end $$;
revoke all on function public.stock_ledger_pn_exclude() from public, anon, authenticated;

drop trigger if exists trg_stock_ledger_pn_exclude on public.stock_ledger;
create trigger trg_stock_ledger_pn_exclude before insert or update on public.stock_ledger
  for each row execute function public.stock_ledger_pn_exclude();

delete from public.stock_ledger where pn in (select pn from public.stock_pn_exclude);
update public.stock_item set hide = true, updated_at = now() where pn in (select pn from public.stock_pn_exclude);
