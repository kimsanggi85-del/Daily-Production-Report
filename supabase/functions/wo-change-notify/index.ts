// 작업지시 변경 알림 (ntfy taejincall) — pg_cron 5분마다 (07:00~20:59 KST)
//  MES 설비 현재 상태(SmartFactory machine_status)의 설비별 품번·작업지시번호를 직전 확인값과 비교해
//  바뀐 설비가 있으면 알린다 → 초물 자주검사 성적서 작성 대상
//  09:30 이전은 기준값만 갱신하고 알리지 않는다 (아침 작업지시는 09:30 '금일 작업지시' 알림으로 한꺼번에)
//  직전 확인값: 이 프로젝트 kv_store 'tj_wo_watch_v1'
//  초물 검사 미실시: 생산 중(is_producing)인데 그 작업지시로 생산을 시작한 지 30분이 지나도 초물(inspect_top)이 'N' 이면
//  작업지시마다 한 번 알린다 (08:30 부터). 값이 비어 있는(null) 설비는 검사 기록 대상이 아닌 것으로 보고 제외
//  ?dry=1 보내지 않고 판단 결과만, ?now=HH:MM 시각 가정(시험용)
const DT_URL = "https://omngtyewdaqpphnzeate.supabase.co";
const DT_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9tbmd0eWV3ZGFxcHBobnplYXRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4ODk4ODksImV4cCI6MjA5MDQ2NTg4OX0.Zxur3t02JHtOcXforCMSwO3i2mMaf5sViE0tXXUC0-s";
const SB_URL = Deno.env.get("SUPABASE_URL") || "https://ebthltdmxpzlkfwvdloz.supabase.co";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const STATE_KEY = "tj_wo_watch_v1";
const NTFY_TOPIC = "taejincall";
const FROM = 9 * 60 + 30;   // 09:30 부터 작업지시 변경 알림
const TOP_FROM = 8 * 60 + 30, TOP_AFTER = 30;   // 08:30 부터, 생산 시작 30분 뒤 초물 N 알림

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
      mesMc = { "012": "29 국일200", "016": "33 심팩250", ...((kv[0] && kv[0].mc) || {}) }; mesPn = (kv[0] && kv[0].pn) || {};
    } catch (_) { /* 이름 매칭 없이 코드로 */ }
    const st = await getJson(`${SB_URL}/rest/v1/kv_store?key=eq.${STATE_KEY}&select=value`, SB_KEY);
    const prev: any = (st[0] && st[0].value) || {};
    type St = { i: string; w: string; tp?: string; al?: number };
    const pm: Record<string, St> = prev.d === d ? (prev.m || {}) : {};
    const cur: Record<string, St> = {};
    const chg: any[] = [], top: any[] = [];
    ms.forEach((m) => {
      if (!m.current_item_code) return;
      // 오늘 갱신되지 않은 설비 상태(멈춰 있는 옛 작업)는 보지 않는다
      const ua = m.updated_at || m.last_update || ""; const upd = ua && isFinite(Date.parse(ua)) ? new Date(Date.parse(ua) + 9 * 3600e3).toISOString().slice(0, 10) : d;
      if (upd !== d) return;
      const c: St = { i: String(m.current_item_code), w: String(m.current_wo || m.work_order_no || "") };
      const p = pm[m.machine_code];
      const same = !!p && p.i === c.i && p.w === c.w;
      // 그 작업지시로 생산이 처음 확인된 시각 · 초물 알림 여부는 같은 작업지시 동안 이어간다
      c.tp = same && p!.tp ? p!.tp : (m.is_producing === true ? hm : undefined);
      c.al = same ? p!.al : undefined;
      if (m.is_producing === true && String(m.inspect_top || "") === "N" && c.tp && !c.al
          && toMin(hm) >= TOP_FROM && toMin(hm) - toMin(c.tp) >= TOP_AFTER) {
        top.push({ mc: mesMc[m.machine_code] || m.machine_code, pn: mesPn[c.i] || c.i, wo: c.w, tp: c.tp });
        if (!dry) c.al = 1;
      }
      cur[m.machine_code] = c;
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
    const tTitle = top.length ? `초물 검사 미실시 ${+d.slice(5, 7)}/${+d.slice(8)} ${hm} · ${top.length}건` : "";
    const tMsg = top.map((x) => `· ${x.mc} ${x.pn}${x.wo ? " [" + x.wo + "]" : ""} — 생산 ${x.tp}~ 초물 N`).join("\n") + (top.length ? "\n\n※ 초물 자주검사 실시·MES 입력 확인" : "");
    if (dry) return Response.json({ ok: true, dry: true, d, hm, rows: ms.length, machines: Object.keys(cur).length, base: prev.d === d, send, title, msg, top: tTitle, topMsg: tMsg,
      producing: ms.filter((m) => m.is_producing === true).map((m) => [m.machine_code, m.inspect_top, m.inspect_mid, m.inspect_bottom]) });
    const ntfy = async (t: string, m: string, tag: string, pr: number) => {
      const r = await fetch("https://ntfy.sh/", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: NTFY_TOPIC, title: t, message: m.slice(0, 3800), tags: [tag], priority: pr }) });
      if (!r.ok) throw new Error("ntfy " + r.status);
    };
    if (send) await ntfy(title, msg, "arrows_counterclockwise", 3);
    if (top.length) await ntfy(tTitle, tMsg, "warning", 4);
    // 기준값 갱신 (오늘 처음이면 그대로 기준만 잡는다)
    await fetch(`${SB_URL}/rest/v1/kv_store?on_conflict=key`, { method: "POST",
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([{ key: STATE_KEY, value: { d, at: hm, m: { ...pm, ...cur } }, updated_at: new Date().toISOString() }]) });
    return Response.json({ ok: true, d, hm, machines: Object.keys(cur).length, changes: chg.length, sent: send, top: top.length });
  } catch (e) {
    return Response.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
});
