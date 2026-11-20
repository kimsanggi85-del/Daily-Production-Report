-- 재고 전표를 생산일보 기준으로 매일 정리 (SmartFactory, 2026-11-20 적용)
--  생산일보에 그날 그 품번 줄이 없는데 MES 불량폐기 전표만 있으면(생산 안 한 품번에 불량 등록)
--  → 같은 수량을 재고조정(+) 'DAILY|일자|품번' 으로 되돌린다. 나중에 일보 줄이 생기면 0 으로.
--  오늘은 일보 마감 전이라 제외. pg_cron 07:50 · 19:50 (최근 14일)
create or replace function public.stock_daily_fix(p_days int default 14)
returns int language plpgsql security definer set search_path = public as $$
declare n int; td date := (now() at time zone 'Asia/Seoul')::date;
begin
  with kv as (select value v from kv_store where key = 'tj_prod_daily_v1'),
  pm as (select e.key raw, e.value pn from kv, jsonb_each_text(v->'master'->'mesPn') e),
  del as (select jsonb_object_keys(coalesce(v->'del','{}'::jsonb)) id from kv),
  rec as (select distinct r->>'date' d, upper(regexp_replace(r->>'pn','[^0-9A-Za-z]','','g')) npn
          from kv, jsonb_array_elements(v->'recs') r
          where r->>'date' >= to_char(td - p_days, 'YYYY-MM-DD')
            and coalesce((r->>'qty')::numeric,0) > 0 and r->>'id' not in (select id from del)),
  bad as (select l.led_date::text d, l.pn, sum(l.qty) q,
            upper(regexp_replace(coalesce(pm.pn, l.pn),'[^0-9A-Za-z]','','g')) npn
          from stock_ledger l left join pm on pm.raw = l.pn
          where l.kind = '불량폐기' and l.src_key like 'MES|%'
            and l.led_date >= td - p_days and l.led_date < td
          group by 1,2,4),
  fix as (select b.d, b.pn, case when exists (select 1 from rec where rec.d = b.d and rec.npn = b.npn) then 0 else b.q end q
          from bad b),
  up as (insert into stock_ledger (src_key, led_date, pn, kind, qty, party, lot, note, by_name, updated_at)
         select 'DAILY|' || f.d || '|' || f.pn, f.d::date, f.pn, '재고조정(+)', f.q, '', '',
                case when f.q > 0 then '생산일보 기준 정리 · 생산 안 한 품번 MES 불량 ' || f.q || ' 되돌림' else '생산일보 기준 정리 · 일보 생산 있음(조정 없음)' end,
                '생산일보', now()
         from fix f
         where f.q > 0 or exists (select 1 from stock_ledger s where s.src_key = 'DAILY|' || f.d || '|' || f.pn and s.qty <> 0)
         on conflict (src_key) do update set qty = excluded.qty, note = excluded.note, updated_at = now()
         where stock_ledger.qty is distinct from excluded.qty
         returning 1)
  select count(*) into n from up;
  return n;
end $$;
revoke all on function public.stock_daily_fix(int) from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job where jobname like 'stock-daily-fix-%';
select cron.schedule('stock-daily-fix-0750', '50 22 * * *', $$select public.stock_daily_fix(14)$$);
select cron.schedule('stock-daily-fix-1950', '50 10 * * *', $$select public.stock_daily_fix(14)$$);
