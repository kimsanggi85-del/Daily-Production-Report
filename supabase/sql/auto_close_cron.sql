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
