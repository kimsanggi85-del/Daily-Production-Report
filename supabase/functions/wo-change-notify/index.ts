// 작업지시 변경 알림 (ntfy taejincall) — pg_cron 5분마다 (07:00~20:59 KST)
//  MES 설비 현재 상태(SmartFactory machine_status)의 설비별 품번·작업지시번호를 직전 확인값과 비교해
//  바뀐 설비가 있으면 알린다 → 초물 자주검사 성적서 작성 대상
//  09:30 이전은 기준값만 갱신하고 알리지 않는다 (아침 작업지시는 09:30 '금일 작업지시' 알림으로 한꺼번에)
//  직전 확인값: 이 프로젝트 kv_store 'tj_wo_watch_v1'
//  ?dry=1 보내지 않고 판단 결과만, ?now=HH:MM 시각 가정(시험용)
const DT_URL = "https://omngtyewdaqpphnzeate.supabase.co";
const DT_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9tbmd0eWV3ZGFxcHBobnplYXRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4ODk4ODksImV4cCI6MjA5MDQ2NTg4OX0.Zxur3t02JHtOcXforCMSwO3i2mMaf5sViE0tXXUC0-s";
const SB_URL = Deno.env.get("SUPABASE_URL") || "https://ebthltdmxpzlkfwvdloz.supabase.co";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const STATE_KEY = "tj_wo_watch_v1";
const NTFY_TOPIC = "taejincall";
const FROM = 9 * 60 + 30;   // 09:30 부터 알림

const kstNow = () => new Date(Date.now() + 9 * 3600e3).toISOString();
const toMin = (t: string) => { const [h, m] = String(t).split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const fmt = (x: number) => Math.round(x).toLocaleString("ko-KR");

async function getJson(url: string, key: string) {
  const r = await fetch(url, { headers: { apikey: key, Authorization: "Bearer " + key } });
  if (!r.ok) throw new Error(url.split("?")[0].split("/").pop() + " " + r.status);
  return await r.json();
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const dry = u.searchParams.get("dry") === "1";
  const now = kstNow(), d = now.slice(0, 10), hm = u.searchParams.get("now") || now.slice(11, 16);
  try {
    const ms: any[] = await getJson(`${DT_URL}/rest/v1/machine_status?select=*&order=machine_code.asc`, DT_KEY);
    // 앱 기준정보의 MES 설비코드·품번 → 앱 이름
    let mesMc: Record<string, string> = {}, mesPn: Record<string, string> = {};
    try {
      const kv = await getJson(`${DT_URL}/rest/v1/kv_store?key=eq.tj_prod_daily_v1&select=mc:value->master->mesMc,pn:value->master->mesPn`, DT_KEY);
      mesMc = (kv[0] && kv[0].mc) || {}; mesPn = (kv[0] && kv[0].pn) || {};
    } catch (_) { /* 이름 매칭 없이 코드로 */ }
    const st = await getJson(`${SB_URL}/rest/v1/kv_store?key=eq.${STATE_KEY}&select=value`, SB_KEY);
    const prev: any = (st[0] && st[0].value) || {};
    const pm: Record<string, { i: string; w: string }> = prev.d === d ? (prev.m || {}) : {};
    const cur: Record<string, { i: string; w: string }> = {};
    const chg: any[] = [];
    ms.forEach((m) => {
      if (!m.current_item_code) return;
      // 오늘 갱신되지 않은 설비 상태(멈춰 있는 옛 작업)는 보지 않는다
      const ua = m.updated_at || m.last_update || ""; const upd = ua && isFinite(Date.parse(ua)) ? new Date(Date.parse(ua) + 9 * 3600e3).toISOString().slice(0, 10) : d;
      if (upd !== d) return;
      const c = { i: String(m.current_item_code), w: String(m.current_wo || m.work_order_no || "") };
      cur[m.machine_code] = c;
      const p = pm[m.machine_code];
      if (prev.d === d && (!p || p.i !== c.i || (c.w && p.w !== c.w)))
        chg.push({ mc: mesMc[m.machine_code] || m.machine_code, from: p ? (mesPn[p.i] || p.i) : "", to: mesPn[c.i] || c.i, wo: c.w, same: !!p && p.i === c.i, tq: +m.target_qty || 0 });
    });
    const send = toMin(hm) >= FROM && chg.length > 0;
    let title = "", msg = "";
    if (chg.length) {
      title = `작업지시 변경 ${+d.slice(5, 7)}/${+d.slice(8)} ${hm} · ${chg.length}건`;
      msg = chg.map((x) => `· ${x.mc}: ${x.from ? (x.same ? x.to + " (작업지시 변경)" : x.from + " → " + x.to) : "신규 " + x.to}${x.wo ? " [" + x.wo + "]" : ""}${x.tq ? " 목표 " + fmt(x.tq) : ""}`).join("\n")
        + "\n\n※ 초물 자주검사 성적서 작성";
    }
    if (dry) return Response.json({ ok: true, dry: true, d, hm, rows: ms.length, cols: Object.keys(ms[0] || {}), machines: Object.keys(cur).length, base: prev.d === d, send, title, msg });
    if (send) {
      const r = await fetch("https://ntfy.sh/", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: NTFY_TOPIC, title, message: msg.slice(0, 3800), tags: ["arrows_counterclockwise"], priority: 3 }) });
      if (!r.ok) throw new Error("ntfy " + r.status);
    }
    // 기준값 갱신 (오늘 처음이면 그대로 기준만 잡는다)
    await fetch(`${SB_URL}/rest/v1/kv_store?on_conflict=key`, { method: "POST",
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([{ key: STATE_KEY, value: { d, at: hm, m: { ...pm, ...cur } }, updated_at: new Date().toISOString() }]) });
    return Response.json({ ok: true, d, hm, machines: Object.keys(cur).length, changes: chg.length, sent: send });
  } catch (e) {
    return Response.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
});
