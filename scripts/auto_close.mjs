// 생산일보 자동 마감 — 앱(index.html)의 '일보콜' 코드를 그대로 서버에서 실행해 일보에 저장한다.
//   evening : 오늘 업무 종료(월·화·목·금 19:00 / 수·토·일·빨간날 17:00, 연장이면 최종 가동) 10분 뒤 1회
//   morning : 07:00 — 전날 일보를 다시 마감 (늦게 들어온 작업자 마감 수량 반영, 누락 줄 추가)
//             전날이 말일이면 그 달 개선 활동도 확정 (말일에 생산이 없어도 실행)
// 사용: node scripts/auto_close.mjs [auto|evening|morning] [YYYY-MM-DD] [--dry] [--force]
//   auto = 실행 시각으로 판단 (06~08시 → morning, 그 외 → evening)
// GitHub 예약 실행은 몇 시간씩 늦게 돌 때가 있다 (19:10 예약이 다음날 00:00 에 실행된 적 있음)
//   → 날짜를 안 주면 자정~06시 evening 은 전날을 마감하고,
//     최근 며칠 중 저녁 마감·재마감이 모두 빠진 날이 있으면 그날을 먼저 재마감(morning)한다
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SB_URL = "https://omngtyewdaqpphnzeate.supabase.co";
const SB_KEY = "sb_publishable_9j2YkkL-7ul1TrhH-NjVdQ_vWDG2-1D";
const DONE_KEY = "tj_prod_autoclose_v1";   // 자동 마감 기록 {날짜: {evening, morning, n}}
const AFTER = 10;                          // 업무 종료 후 이 시간(분) 뒤 마감

const args = process.argv.slice(2);
const dry = args.includes("--dry"), force = args.includes("--force");
const pos = args.filter((a) => !a.startsWith("--"));
const kst = () => new Date(Date.now() + 9 * 3600e3);
const kstDate = (ms = 0) => new Date(Date.now() + 9 * 3600e3 + ms).toISOString().slice(0, 10);
let mode = pos[0] || "auto";
if (mode === "auto") { const h = kst().getUTCHours(); mode = h >= 6 && h < 9 ? "morning" : "evening"; }
let d = pos[1] || (mode === "morning" || kst().getUTCHours() < 6 ? kstDate(-86400e3) : kstDate());
const log = (...a) => console.log(`[${mode} ${d}]`, ...a);
const CATCH_DAYS = 4;                      // 빠진 마감을 찾아볼 기간(일)

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "index.html"), "utf8");
const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const hdr = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY };
async function sb(p) { const r = await fetch(SB_URL + p, { headers: hdr }); if (!r.ok) throw new Error(p + " " + r.status); return r.json(); }

// 빨간날 목록은 앱 코드에서 그대로 읽는다
const HOLI = Function("return " + html.match(/const HOLI=(\{[\s\S]*?\});/)[1])();
const offOf = (dt) => { const w = new Date(dt + "T00:00:00Z").getUTCDay(); return (HOLI[dt] || w === 0 || w === 3 || w === 6) ? "17:00" : "19:00"; };

async function main() {
  const doneRow = await sb(`/rest/v1/kv_store?key=eq.${DONE_KEY}&select=value`);
  const done = (doneRow[0] && doneRow[0].value) || {};
  // 예약 실행이 늦어 빠진 날 보충 — 날짜를 직접 준 실행은 그대로 둔다
  if (!pos[1] && !force) {
    for (let k = CATCH_DAYS; k >= 1; k--) {
      const x = kstDate(-k * 86400e3);
      if (x >= d) continue;
      const r0 = done[x] || {};
      if (r0.evening || r0.morning) continue;
      const has = await sb(`/rest/v1/daily_production?select=ymd&ymd=eq.${x}&limit=1`);
      if (!has.length) continue;
      console.log(`[${mode} ${d}] ${x} 마감 기록 없음 → ${x} 재마감 먼저 실행`);
      mode = "morning"; d = x; break;
    }
  }
  const rec = done[d] || {};
  // 말일 익일 재마감 → 그 달 개선 활동 확정 (말일이 휴무여도 진행)
  const monthEnd = mode === "morning" && new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).toISOString().slice(0, 10) === d;
  const needFix = monthEnd && !rec.fixed;

  // ── 실행 여부 판단 (가벼운 조회만) ──
  const dp = await sb(`/rest/v1/daily_production?select=end_time&ymd=eq.${d}&order=end_time.desc&limit=1`);
  if (!dp.length && !needFix) return log("생산 자료 없음 → 건너뜀");
  const lastEnd = String((dp[0] || {}).end_time || "").slice(0, 5) || offOf(d);
  if (mode === "evening" && !force) {
    if (rec.evening) return log(`이미 마감 (${rec.evening})`);
    const endRef = Math.max(toMin(offOf(d)), toMin(lastEnd));
    const nowMin = kst().getUTCHours() * 60 + kst().getUTCMinutes();
    if (nowMin < endRef + AFTER) return log(`아직 (종료 ${offOf(d)}, 최종 가동 ${lastEnd})`);
  }
  if (mode === "morning" && !force && rec.morning && !needFix) return log(`이미 재마감 (${rec.morning})`);
  const doClose = dp.length && !(mode === "morning" && !force && rec.morning);

  // ── 앱 실행 ──
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => { if (!/navigation|Not implemented/i.test(String(e.message))) console.warn("jsdom:", e.message); });
  const dom = new JSDOM(html.replace(/<script src="[^"]+"><\/script>/g, ""), {
    url: "https://kimsanggi85-del.github.io/daily-production-report/",
    runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = fetch.bind(globalThis);
      w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
      w.scrollTo = () => {};
      w.localStorage.setItem("tj_me", "자동마감");
      w.localStorage.setItem("tj_autoentry", "0");
    },
  });
  const w = dom.window;
  const ev = (code) => w.eval(code);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1500);
  await ev("pull()");                       // 서버 최신본 받기 (앱 시작 pull 과 별개로 한 번 더 확실히)
  const before = ev(`S.recs.filter(r=>r.date==='${d}').length`);

  const rows = doClose ? await ev(`openMes('${d}',true)`) : null;
  if ((!rows || !rows.length) && !needFix) { log("MES 자료 없음"); w.close(); return; }
  let ok = [], hold = [], wait = 0, summary = [], n = 0;
  if (rows && rows.length) {
  ok = ev(`MESROWS.filter(r=>r.use&&r.mc&&r.pn&&!String(r.pn).startsWith('@')&&(spmFor(r.mc,r.pn)||singleMc(r.mc)))`);
  hold = ev(`MESROWS.filter(r=>!(r.use&&r.mc&&r.pn&&!String(r.pn).startsWith('@')&&(spmFor(r.mc,r.pn)||singleMc(r.mc)))&&!r.dup&&!r.pending).map(r=>(r.code||'')+' '+(r.pnCode||'')+(r.mc?'':' 설비미지정')+(String(r.pn).startsWith('@')?' 품번미등록':''))`);
  wait = ev(`MESROWS.filter(r=>r.waitClose).length`);
  summary = ok.map((r) => `${r.mc} ${r.pn} ${r.qty}${r.upd ? " (갱신)" : ""}${r.closed ? "" : " (미마감)"}`);
  log(`대상 ${ok.length}줄 · 보류 ${hold.length}줄 · 미마감 ${wait}줄 · 기존 일보 ${before}줄`);
  summary.forEach((s) => log("  ·", s));
  hold.forEach((s) => log("  보류:", s));

  if (ok.length && !dry) {
    ev(`MESROWS=MESROWS.filter(r=>r.use&&r.mc&&r.pn&&!String(r.pn).startsWith('@')&&(spmFor(r.mc,r.pn)||singleMc(r.mc)))`);
    n = ev(`saveMes(true,'${d}')`);
    ev(`logAdd('일보 자동 마감','${mode === "morning" ? "익일 재마감" : "업무 종료"} ${d.slice(5)} ${n}건'+(${hold.length}?' (보류 ${hold.length})':''))`);
    ev("clearTimeout(pushT)");
    await ev("push()");
    const st = ev("document.getElementById('syncState')&&document.getElementById('syncState').textContent||''");
    log(`일보 저장 ${n}건${st ? " · " + st : ""}`);
  }
  } else log("일보 마감 생략(생산 없음·이미 재마감) → 개선 활동만 확정");
  // 말일 익일 재마감 뒤 그 달 개선 활동 확정 → 다음 달 보고서 '전월 개선활동 이행 점검'
  if (!dry && needFix) {
    await ev(`loadMoldRep('${d.slice(0, 7)}')`);
    const nf = ev(`autoFixMonth('${d.slice(0, 7)}')`);
    log(`개선 활동 자동 확정 ${nf}개 보고서 (말일 ${d})`);
    if (nf) { ev("clearTimeout(pushT)"); await ev("push()"); }
    rec.fixed = kst().toISOString().slice(11, 16);
  }
  if (!dry) {
    rec[mode] = kst().toISOString().slice(11, 16); rec.n = n; rec.wait = wait;
    done[d] = rec;
    const keep = Object.fromEntries(Object.entries(done).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 40));
    const r = await fetch(`${SB_URL}/rest/v1/kv_store?on_conflict=key`, { method: "POST",
      headers: { ...hdr, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([{ key: DONE_KEY, value: keep, updated_at: new Date().toISOString() }]) });
    if (!r.ok) throw new Error("마감 기록 저장 실패 " + r.status);
  } else {
    log("(dry) 저장하지 않음");
    // 확인용 결과를 남김 (원격 실행 결과 점검)
    await fetch(`${SB_URL}/rest/v1/kv_store?on_conflict=key`, { method: "POST",
      headers: { ...hdr, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([{ key: "tj_prod_autoclose_dry", value: { d, mode, at: new Date().toISOString(), before, wait, ok: summary, hold }, updated_at: new Date().toISOString() }]) });
  }
  w.close();
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
