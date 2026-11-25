-- 2026-11-25: Edge Function 이 ntfy.sh 에서 429(공용 IP 하루 한도)로 거절될 때 DB(pg_net)를 거쳐 보내는 중계 함수. 토픽은 taejincall 고정.
--  prod-close-notify 가 ntfy 발송 실패 시 rpc/ntfy_relay 를 부른다 (11/25 17:10 마감 알림이 429 로 못 나간 원인 대응)
create table if not exists public.ntfy_relay_log (id bigserial primary key, at timestamptz default now(), title text, req bigint);
alter table public.ntfy_relay_log enable row level security;
create or replace function public.ntfy_relay(p_title text, p_message text, p_tags jsonb default '[]'::jsonb, p_priority int default 3) returns bigint
language plpgsql security definer set search_path = public as $$
declare req bigint;
begin
  if coalesce(length(p_title), 0) = 0 or length(p_title) > 200 or coalesce(length(p_message), 0) > 4000 then raise exception 'bad input'; end if;
  if (select count(*) from ntfy_relay_log where at > now() - interval '1 hour') >= 30 then raise exception 'relay limit'; end if;
  req := net.http_post(url := 'https://ntfy.sh/', headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('topic', 'taejincall', 'title', p_title, 'message', coalesce(p_message, ''), 'tags', coalesce(p_tags, '[]'::jsonb), 'priority', least(greatest(coalesce(p_priority, 3), 1), 5)),
    timeout_milliseconds := 30000);
  insert into ntfy_relay_log(title, req) values (p_title, req);
  return req;
end $$;
revoke all on function public.ntfy_relay(text, text, jsonb, int) from public;
grant execute on function public.ntfy_relay(text, text, jsonb, int) to anon, authenticated;
