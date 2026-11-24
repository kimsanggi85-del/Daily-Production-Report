-- 재고수불부(stock_ledger) 품번 별칭 (SmartFactory, 2026-11-20 적용)
-- MES 동기화(stock_ledger_sync)가 공용 작업지시 품번으로 올리는 전표를 재고 품번으로 바꿔 넣는다 (src_key 는 그대로).
--   '45631-26010 B/C' (02 심팩200 공용 작업지시) → 재고는 '45631-26010B'
-- 재고 품목 '45631-26010 B/C'(11/19 자동 등록)는 숨김(hide) 처리됨.
-- 다른 품번도 stock_pn_alias 에 한 줄 추가하면 같은 방식으로 바뀐다.
create table if not exists public.stock_pn_alias (
  raw text primary key,
  pn  text not null,
  memo text,
  created_at timestamptz default now()
);
alter table public.stock_pn_alias enable row level security;
insert into public.stock_pn_alias(raw, pn, memo) values
  ('45631-26010 B/C', '45631-26010B', 'MES B/C 공용 작업지시 생산 수량은 재고 B로 (2026-11-20 요청)')
on conflict (raw) do update set pn = excluded.pn, memo = excluded.memo;

create or replace function public.stock_ledger_pn_alias() returns trigger
language plpgsql security definer set search_path = public as $$
declare a text;
begin
  select pn into a from public.stock_pn_alias where raw = new.pn;
  if a is not null and a <> new.pn then
    new.note := trim(both ' ' from coalesce(new.note,'') || ' [품번 ' || new.pn || ' → ' || a || ']');
    new.pn := a;
  end if;
  return new;
end $$;
revoke all on function public.stock_ledger_pn_alias() from public, anon, authenticated;
drop trigger if exists trg_stock_ledger_pn_alias on public.stock_ledger;
create trigger trg_stock_ledger_pn_alias before insert or update on public.stock_ledger
  for each row execute function public.stock_ledger_pn_alias();

update public.stock_ledger set pn = pn where pn in (select raw from public.stock_pn_alias);

-- 2026-11-24 요청: 45464-4G600 → 45464-4G650L 통일 (일보 품목·일보 7줄·재고 원장 11건 함께 변경, 원장 백업 stock_ledger_bak_4g600_20261124)
insert into public.stock_pn_alias(raw, pn, memo) values ('45464-4G600','45464-4G650L','45464-4G600 은 45464-4G650L 로 통일 (2026-11-24 요청)') on conflict do nothing;
-- 2026-11-24 요청: 45464-4G650 도 45464-4G650L 로 합침 (원장 12건 변경, 백업 stock_ledger_bak_4g650_20261124)
insert into public.stock_pn_alias(raw, pn, memo) values ('45464-4G650','45464-4G650L','45464-4G650 은 45464-4G650L 로 통일 (2026-11-24 요청)') on conflict do nothing;
