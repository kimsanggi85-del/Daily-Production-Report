// 생산일보 마감 자동 알림 (ntfy) — pg_cron: 16:00~23:50 10분마다 + 매일 08:00(전날 미마감 재발송)
//  ① 업무 종료(평일 19:00 / 수·토·일·빨간날 17:00, 연장이면 최종 가동시각) 10분 뒤 1회 발송
//  ② 그때 작업자 마감(production_close)이 덜 들어온 설비는 '미마감'으로 표시
//  ③ 미마감이 있던 날은 다음날 08:00 최신 마감 수량으로 다시 발송 (?at=morning, 전날 기준)
//  수량 = 작업자 마감 실제양품 → (미마감) 일보 → MES 타발
//  ?d=YYYY-MM-DD 날짜 지정, ?dry=1 보내지 않고 판단·내용만, ?now=HH:MM 시각 가정(시험용)
//  [2026-10-27 Supabase 통합] SB_URL/SB_KEY 를 과장님 DB(ebthltd…) → SmartFactory 로 변경 (kv_store·daily_production 이 SmartFactory 로 이전됨)
//  [2026-11-05] 저녁 마감 알림 끝에 하루 마무리 인사 (요일별, 금요일·특근은 따로), 08:00 재발송에는 아침 인사
//  주말 알림 끄기는 pg_cron 쪽(run_if_weekday)에서 한다
const SB_URL = "https://omngtyewdaqpphnzeate.supabase.co";
const SB_KEY = "sb_publishable_9j2YkkL-7ul1TrhH-NjVdQ_vWDG2-1D";
const DT_URL = "https://omngtyewdaqpphnzeate.supabase.co";
const DT_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9tbmd0eWV3ZGFxcHBobnplYXRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4ODk4ODksImV4cCI6MjA5MDQ2NTg4OX0.Zxur3t02JHtOcXforCMSwO3i2mMaf5sViE0tXXUC0-s";
const KV_KEY = "tj_prod_daily_v1";
const NTFY_TOPIC = "taejincall";
const SENT_KEY = "tj_prod_notify_sent_v1";   // 자동 발송 기록 {날짜: {t, open, morning}}
const DEF_MESPN: Record<string, string> = { "54610-D3501-(BK)": "54610-D3501", "1958-365-2(2호)": "1958-365-2", "AT3037-GC-00": "AT3037-GC-01", "IW/OW-BDA-1159B": "IW/OW BDA 1159B" };
// 달력 빨간날(법정공휴일·대체공휴일) — 평일 빨간날은 특근 08~17시
const HOLI: Record<string, string> = { "2026-01-01": "신정", "2026-02-16": "설날 연휴", "2026-02-17": "설날", "2026-02-18": "설날 연휴",
  "2026-03-01": "삼일절", "2026-03-02": "대체공휴일(삼일절)", "2026-05-01": "근로자의 날", "2026-05-05": "어린이날",
  "2026-05-24": "부처님오신날", "2026-05-25": "대체공휴일(부처님오신날)", "2026-06-03": "지방선거", "2026-06-06": "현충일",
  "2026-07-17": "제헌절", "2026-08-15": "광복절", "2026-08-17": "대체공휴일(광복절)",
  "2026-09-24": "추석 연휴", "2026-09-25": "추석", "2026-09-26": "추석 연휴",
  "2026-10-03": "개천절", "2026-10-05": "대체공휴일(개천절)", "2026-10-09": "한글날", "2026-12-25": "성탄절" };
const AFTER = 10;    // 업무 종료 후 이 시간(분) 뒤 발송
const ACTIVE = 60;   // 종료 직전 이 시간 안에 가동한 설비는 마감 대상
// 하루 마무리 인사 — 날짜로 돌아가며 고른다
const GREET = [
  "오늘 하루도 고생 많으셨습니다. 편안한 저녁 보내세요 🙂",
  "오늘도 안전하게 마무리해 주셔서 감사합니다. 푹 쉬세요.",
  "하루 동안 수고 많으셨습니다. 내일도 안전하게 힘내요!",
  "오늘도 정성껏 만들어 주셔서 감사합니다. 따뜻한 저녁 되세요.",
  "모두 수고하셨습니다. 오늘 하루도 무사히 마쳤습니다 👏",
];

// 아침 재발송 인사 — 앱(index.html) morningGreet 과 같은 문구·같은 순서
const MORNING_GREET = [
  "좋은 아침입니다. 오늘 하루도 고생하십시오 🙂",
  "오늘 하루도 안전하게, 힘내십시오! 💪",
  "오늘도 무사고! 함께 힘내 봅시다.",
  "오늘 하루도 잘 부탁드립니다. 안전이 최우선입니다.",
  "상쾌한 아침입니다. 오늘도 좋은 하루 되십시오.",
];
const morningGreet = (d: string) => {
  if (new Date(d + "T00:00:00Z").getUTCDay() === 1) return "새로운 한 주 시작입니다. 이번 주도 안전하게 힘내십시오! 💪";
  return MORNING_GREET[Math.floor(Date.parse(d + "T00:00:00Z") / 86400e3) % MORNING_GREET.length];
};

const toMin = (t: string) => { const [h, m] = String(t).split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const offOf = (d: string) => { const w = new Date(d + "T00:00:00Z").getUTCDay(); return (HOLI[d] || w === 0 || w === 3 || w === 6) ? "17:00" : "19:00"; };
const norm = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
const fm = (x: number) => Math.round(x).toLocaleString("ko-KR");
const kstNow = () => new Date(Date.now() + 9 * 3600e3).toISOString();
const greetOf = (d: string) => {
  const wd = new Date(d + "T00:00:00Z").getUTCDay();
  if (HOLI[d] || wd === 0 || wd === 6) return "쉬는 날까지 나와 주셔서 정말 감사합니다. 고생 많으셨습니다.";
  if (wd === 5) return "한 주 동안 고생 많으셨습니다. 편안한 주말 보내세요 🙂";
  return GREET[Math.floor(Date.parse(d + "T00:00:00Z") / 86400e3) % GREET.length];
};

async function getJson(url: string, key: string) {
  const r = await fetch(url, { headers: { apikey: key, Authorization: "Bearer " + key } });
  if (!r.ok) throw new Error(url.split("?")[0].split("/").pop() + " " + r.status);
  return await r.json();
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const morning = u.searchParams.get("at") === "morning";
  const yday = new Date(Date.now() + 9 * 3600e3 - 86400e3).toISOString().slice(0, 10);
  const d = u.searchParams.get("d") || (morning ? yday : kstNow().slice(0, 10));
  const dry = u.searchParams.get("dry") === "1";
  const nowMin = toMin(u.searchParams.get("now") || kstNow().slice(11, 16));
  const skip = (reason: string) => Response.json({ ok: true, sent: false, d, reason });
  try {
    const off = offOf(d);
    if (!morning && nowMin < toMin(off) + AFTER) return skip(`종료 전 (표준 ${off})`);
    const sk = await getJson(`${SB_URL}/rest/v1/kv_store?key=eq.${SENT_KEY}&select=value`, SB_KEY);
    const sent: Record<string, any> = (sk[0] && sk[0].value) || {};
    const prev = sent[d] && typeof sent[d] === "object" && sent[d].t ? sent[d] : null;
    if (morning) {
      if (prev && !prev.open) return skip("전날 미마감 없음");
      if (prev && prev.morning) return skip("이미 재발송");
    } else if (prev) return skip(`이미 발송 (${prev.t})`);

    // MES 실적 (모니터링 서버 → 없으면 공유 백엔드)
    const q = `/rest/v1/daily_production?select=machine_code,item_code,shot_qty,end_time&ymd=eq.${d}&limit=1000`;
    let dp: any[] = [];
    try { dp = await getJson(DT_URL + q, DT_KEY); } catch (_) { /* 다음 경로 */ }
    if (!dp.length) dp = await getJson(SB_URL + q, SB_KEY);
    if (!dp.length) return skip("생산 자료 없음");
    const lastEnd = dp.map((r) => String(r.end_time || "").slice(0, 5)).filter(Boolean).sort().pop() || off;
    if (!morning && nowMin < toMin(lastEnd) + AFTER) return skip(`가동 중 (최종 ${lastEnd})`);
    const endRef = Math.max(toMin(off), toMin(lastEnd));   // 연장 근무면 최종 가동 기준

    // 작업자 마감 (실제양품)
    let clo: any[] = [];
    try { clo = await getJson(`${DT_URL}/rest/v1/production_close?select=machine_code,item_code,actual_qty&ymd=eq.${d}&limit=1000`, DT_KEY); } catch (_) { /* 없음 */ }
    const act: Record<string, number> = {};
    clo.forEach((c) => { if (c.actual_qty != null) act[(c.machine_code || "") + "|" + c.item_code] = +c.actual_qty || 0; });
    const keyOf = (r: any) => (r.machine_code || "") + "|" + r.item_code;
    const openActive = dp.filter((r) => !(keyOf(r) in act) && r.end_time && toMin(r.end_time) >= endRef - ACTIVE);

    // 품번·고객사 매핑 (일보 앱 기준정보)
    const kv = await getJson(`${SB_URL}/rest/v1/kv_store?key=eq.${KV_KEY}&select=value`, SB_KEY);
    const S = (kv[0] && kv[0].value) || {};
    const delSet = new Set(Object.keys(S.del || {}));
    const recs = (S.recs || []).filter((r: any) => !delSet.has(r.id));
    const items: any[] = (S.master && S.master.items) || [];
    const mesPn: Record<string, string> = { ...DEF_MESPN, ...((S.master && S.master.mesPn) || {}) };
    const custOf = (pn: string) => {
      const it = items.find((i) => i.pn === pn) || items.find((i) => norm(i.pn) === norm(pn));
      if (it && it.cust) return it.cust;
      const rs = recs.filter((r: any) => r.cust && (r.pn === pn || norm(r.pn) === norm(pn)))
        .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)));
      if (rs[0]) return rs[0].cust;
      const sim = items.find((i) => i.cust && i.pn.slice(0, 4) === pn.slice(0, 4));
      return (sim && sim.cust) || "";
    };
    const appPn = (raw: string) => mesPn[raw] || (items.find((i) => norm(i.pn) === norm(raw)) || {}).pn || raw || "(품번 없음)";
    // 미마감분: 같은 품번이 일보에 있고 그 품번에 마감된 설비가 없으면 일보 수량(설비 여러 대면 MES 비율 배분), 아니면 MES 타발
    const dayRec: Record<string, number> = {};
    recs.filter((r: any) => r.date === d).forEach((r: any) => { dayRec[norm(r.pn)] = (dayRec[norm(r.pn)] || 0) + (+r.qty || 0); });
    const rows = dp.map((r) => {
      const pn = appPn(String(r.item_code || ""));
      const same = dp.filter((x) => appPn(String(x.item_code)) === pn);
      let qty: number;
      if (keyOf(r) in act) qty = act[keyOf(r)];
      else if (norm(pn) in dayRec && !same.some((x) => keyOf(x) in act)) {
        const tot = same.reduce((a, x) => a + (+x.shot_qty || 0), 0);
        qty = tot ? dayRec[norm(pn)] * ((+r.shot_qty || 0) / tot) : dayRec[norm(pn)] / same.length;
      } else qty = +r.shot_qty || 0;
      return { cust: custOf(pn), pn, qty, mc: r.machine_code };
    });
    const total = rows.reduce((a, r) => a + r.qty, 0);
    if (total <= 0) return skip("생산 수량 0");

    const by: Record<string, { t: number; p: Record<string, number> }> = {};
    rows.forEach((r) => {
      const c = r.cust || "고객사 미지정";
      const g = (by[c] = by[c] || { t: 0, p: {} });
      g.t += r.qty; g.p[r.pn] = (g.p[r.pn] || 0) + r.qty;
    });
    const out: string[] = [];
    if (openActive.length) out.push(`※ 미마감 ${openActive.length}건(MES·일보 수량): ${openActive.map((r) => r.machine_code + "호기 " + appPn(String(r.item_code))).join(", ")}` + (morning ? "" : " → 내일 08:00 재발송"), "");
    else if (morning) out.push("※ 미마감분 마감 반영 완료", "");
    Object.entries(by).filter(([, g]) => g.t > 0).sort((a, b) => b[1].t - a[1].t).forEach(([c, g], k) => {
      if (k) out.push("");
      out.push(`[${c}] ${fm(g.t)} EA`);
      Object.entries(g.p).filter(([, q]) => q > 0).sort((a, b) => b[1] - a[1]).forEach(([p, q]) => out.push(`· ${p} ${fm(q)}`));
    });
    let msg = out.join("\n");
    if (msg.length > 3400) msg = msg.slice(0, 3400) + "\n…";
    msg += "\n\n" + (morning ? morningGreet(kstNow().slice(0, 10)) : greetOf(d));   // 저녁: 마무리 인사 / 아침 재발송: 아침 인사
    const wd = new Date(d + "T00:00:00Z").getUTCDay();
    const dw = "일월화수목금토"[wd];
    const tg = HOLI[d] ? "공휴일 특근 · " + HOLI[d] : wd === 6 ? "토요일 특근" : wd === 0 ? "일요일 특근" : "";
    const extTag = toMin(lastEnd) > toMin(off) + 5 ? ` · 연장 ${lastEnd}` : "";
    const title = `생산일보 마감 ${d.slice(5).replace("-", "/")}(${dw})${tg ? " · " + tg : ""}${extTag}${morning ? " · 익일 재발송" : ""} · 자동`;

    if (dry) return Response.json({ ok: true, dry: true, d, lastEnd, openActive: openActive.length, title, msg });
    const r = await fetch("https://ntfy.sh/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: NTFY_TOPIC, title, message: msg, tags: [openActive.length ? "warning" : "clipboard"], priority: 3 }),
    });
    if (!r.ok) throw new Error("ntfy " + r.status);
    sent[d] = morning ? { ...(prev || {}), morning: kstNow().slice(11, 16), openAfter: openActive.length }
                      : { t: kstNow().slice(11, 16), open: openActive.length };
    const keep = Object.fromEntries(Object.entries(sent).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 40));
    await fetch(`${SB_URL}/rest/v1/kv_store?on_conflict=key`, { method: "POST",
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([{ key: SENT_KEY, value: keep, updated_at: new Date().toISOString() }]) }).catch(() => {});
    return Response.json({ ok: true, sent: true, d, title });
  } catch (e) {
    return Response.json({ ok: false, d, error: String((e as Error).message || e) }, { status: 500 });
  }
});
