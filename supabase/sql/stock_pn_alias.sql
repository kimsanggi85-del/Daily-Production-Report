-- 재고수불부(stock_ledger) 품번 별칭 (SmartFactory, 2026-11-20 적용)
-- 재고 앱이 MES 생산마감을 자동집계할 때 MES 공용 작업지시 품번이 그대로 들어오는 것을 재고 품번으로 바꾼다.
--   '45631-26010 B/C' (02 심팩200 공용 작업지시) → 재고는 '45631-26010C'
-- 다른 품번도 stock_pn_alias 에 한 줄 추가하면 같은 방식으로 바뀐다 (src_key 는 그대로 — 재고 앱 업서트와 충돌 없음)
create table if not exists public.stock_pn_alias (
  raw text primary key,
  pn  text not null,
  memo text,
  created_at timestamptz default now()
);
alter table public.stock_pn_alias enable row level security;
insert into public.stock_pn_alias(raw, pn, memo) values
  ('45631-26010 B/C', '45631-26010C', 'MES B/C 공용 작업지시 → 재고는 C (2026-11-20 요청)')
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
create trigger trg_stock_ledger_pn_alias before insert or update of pn on public.stock_ledger
  for each row execute function public.stock_ledger_pn_alias();

update public.stock_ledger set pn = pn where pn in (select raw from public.stock_pn_alias);
