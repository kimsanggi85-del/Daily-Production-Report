-- 생산일보 자동 마감 정시 실행 (SmartFactory pg_cron → GitHub workflow_dispatch)
-- GitHub 예약 실행(schedule)은 몇 시간씩 늦게 돌아 마감이 빠지므로,
-- 정시 실행이 확실한 Supabase pg_cron 이 정해진 시각에 auto-close.yml 을 수동 실행(workflow_dispatch)한다.
-- (수동 실행은 몇 초 안에 시작됨. GitHub 예약 실행은 예비로 그대로 둔다 — 이미 마감한 날은 스크립트가 건너뜀)
-- 토큰: Vault 비밀 'github_autoclose_token' (GitHub fine-grained token, 이 저장소만 · Actions: Read and write)
--       없으면 아무것도 하지 않는다.

create or replace function public.trigger_auto_close(p_mode text default 'evening')
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  tok text;
begin
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'github_autoclose_token' limit 1;
  if tok is null or tok = '' then
    raise notice 'github_autoclose_token 없음 → 건너뜀';
    return null;
  end if;
  return net.http_post(
    url := 'https://api.github.com/repos/kimsanggi85-del/Daily-Production-Report/actions/workflows/auto-close.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || tok,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'smartfactory-pg-cron',
      'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('mode', p_mode)),
    timeout_milliseconds := 30000);
end $$;

revoke all on function public.trigger_auto_close(text) from public, anon, authenticated;

-- 시각(UTC = KST-9). 업무 종료 판단(19시/17시, 연장이면 최종 가동 + 10분)은 스크립트가 한다.
select cron.unschedule(jobname) from cron.job where jobname like 'prod-auto-close-%';
select cron.schedule('prod-auto-close-1710', '10 8 * * *',         $$select public.trigger_auto_close('evening')$$);  -- 17:10 수·토·일·빨간날
select cron.schedule('prod-auto-close-1910', '10 10 * * 1,2,4,5',  $$select public.trigger_auto_close('evening')$$);  -- 19:10 월·화·목·금
select cron.schedule('prod-auto-close-late', '10 11-14 * * *',     $$select public.trigger_auto_close('evening')$$);  -- 20:10~23:10 연장 예비
select cron.schedule('prod-auto-close-0700', '0 22 * * *',         $$select public.trigger_auto_close('morning')$$);  -- 07:00 전날 재마감

-- ── 마감 누락 점검 (10/30 처럼 마감이 빠지는 일 방지) ──
-- 마감 시각이 지났는데 마감 기록(kv tj_prod_autoclose_v1)이 없고 생산 자료가 있으면
--   ① 자동 마감을 다시 실행(토큰 있을 때) ② ntfy taejincall 로 알림
-- p_which = 'today'     : 오늘 저녁 마감 확인 (가동 중이면 — 최종 가동 30분 이내 — 건너뜀)
--           'yesterday' : 전날 마감(저녁 또는 07시 재마감) 확인
create or replace function public.check_auto_close(p_which text default 'today')
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  now_k timestamp := now() at time zone 'Asia/Seoul';
  d date := case when p_which = 'yesterday' then (now_k - interval '1 day')::date else now_k::date end;
  ds text := to_char(d, 'YYYY-MM-DD');
  rec jsonb;
  last_end text;
  off_t time := case when extract(isodow from d) in (3, 6, 7) then time '17:00' else time '19:00' end;
  has_tok boolean;
  req bigint;
  msg text;
begin
  select value -> ds into rec from kv_store where key = 'tj_prod_autoclose_v1';
  if p_which = 'yesterday' then
    if coalesce(rec ->> 'evening', rec ->> 'morning') is not null then return ds || ' 마감 완료'; end if;
  else
    if rec ->> 'evening' is not null then return ds || ' 마감 완료'; end if;
    if now_k::time < off_t + interval '30 min' then return ds || ' 아직 업무 시간'; end if;
  end if;
  select max(end_time) into last_end from daily_production where ymd = ds;
  if last_end is null then return ds || ' 생산 자료 없음'; end if;
  if p_which = 'today' and now_k::time < (last_end || ':00')::time + interval '30 min' then
    return ds || ' 가동 중 (최종 ' || last_end || ')';
  end if;
  has_tok := exists (select 1 from vault.decrypted_secrets where name = 'github_autoclose_token' and coalesce(decrypted_secret, '') <> '');
  if has_tok then req := public.trigger_auto_close(case when p_which = 'yesterday' then 'morning' else 'evening' end); end if;
  msg := to_char(d, 'MM/DD') || ' 생산일보 자동 마감 기록이 없습니다 (최종 가동 ' || last_end || ').' || chr(10)
      || case when has_tok then '자동 마감을 다시 실행했습니다. 10분 뒤 일보를 확인하세요.'
              else 'GitHub 토큰이 없어 다시 실행하지 못했습니다 — 앱에서 일보콜로 ' || to_char(d, 'MM/DD') || ' 일보를 저장하세요.' end;
  perform net.http_post(url := 'https://ntfy.sh/',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('topic', 'taejincall', 'title', '생산일보 마감 누락 ' || to_char(d, 'MM/DD'),
                               'message', msg, 'tags', jsonb_build_array('warning'), 'priority', 4),
    timeout_milliseconds := 30000);
  return msg;
end $$;

revoke all on function public.check_auto_close(text) from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job where jobname like 'prod-close-check-%';
select cron.schedule('prod-close-check-1750', '50 8 * * *',  $$select public.check_auto_close('today')$$);      -- 17:50
select cron.schedule('prod-close-check-1950', '50 10 * * *', $$select public.check_auto_close('today')$$);      -- 19:50
select cron.schedule('prod-close-check-2340', '40 14 * * *', $$select public.check_auto_close('today')$$);      -- 23:40 (연장)
select cron.schedule('prod-close-check-0740', '40 22 * * *', $$select public.check_auto_close('yesterday')$$);  -- 07:40
select cron.schedule('prod-close-check-0940', '40 0 * * *',  $$select public.check_auto_close('yesterday')$$);  -- 09:40
