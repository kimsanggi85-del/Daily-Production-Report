// 생산관리 아침 브리핑 — 매일 08:30 실행 (GitHub Actions, 07:00 자동 재마감과 별도)
//   ① 생산일보 앱(index.html)을 그대로 실행: 마지막 생산일 실적·월 계획 진척·이상 항목 → 이상 대응 목록(issues) 등록
//   ② 재고수불부 앱(kimsanggi85-del/stock_ledger)을 읽기 전용으로 실행: 품목별 현재고·안전재고·재고일수
//      → 요약을 kv_store 'tj_pm_stock_v1' 에 남김 (생산일보 앱 생산관리 화면 표시용)
//   ③ ntfy(taejincall)로 브리핑 발송, 발송 기록은 kv_store 'tj_prod_autoclose_v1' 의 그 날짜 brief
// 사용: node scripts/pm_brief.mjs [YYYY-MM-DD(실적 기준일)] [--dry] [--force]
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SB_URL = "https://omngtyewdaqpphnzeate.supabase.co";
const SB_KEY = "sb_publishable_9j2YkkL-7ul1TrhH-NjVdQ_vWDG2-1D";
const DONE_KEY = "tj_prod_autoclose_v1";
const STOCK_KEY = "tj_pm_stock_v1";
const STOCK_URL = "https://raw.githubusercontent.com/kimsanggi85-del/stock_ledger/main/index.html";
const NTFY_TOPIC = "taejincall";

const args = process.argv.slice(2);
const dry = args.includes("--dry"), force = args.includes("--force");
const pos = args.filter((a) => !a.startsWith("--"));
const kstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const hdr = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[브리핑]", ...a);
async function kvGet(key) { const r = await fetch(`${SB_URL}/rest/v1/kv_store?key=eq.${key}&select=value`, { headers: hdr }); if (!r.ok) throw new Error(key + " " + r.status); const j = await r.json(); return (j[0] && j[0].value) || null; }
async function kvPut(key, value) {
  const r = await fetch(`${SB_URL}/rest/v1/kv_store?on_conflict=key`, { method: "POST",
    headers: { ...hdr, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]) });
  if (!r.ok) throw new Error(key + " 저장 실패 " + r.status);
}
function vconsole() { const vc = new VirtualConsole(); vc.on("jsdomError", (e) => { if (!/navigation|Not implemented/i.test(String(e.message))) console.warn("jsdom:", e.message); }); return vc; }

/* ② 재고수불부 — 쓰기 요청(POST·PATCH·DELETE 등)은 서버로 보내지 않는다 */
async function stockSummary() {
  const html = await (await fetch(STOCK_URL)).text();
  const dom = new JSDOM(html.replace(/<script src="[^"]+"><\/script>/g, ""), {
    url: "https://kimsanggi85-del.github.io/stock_ledger/", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vconsole(),
    beforeParse(w) {
      w.fetch = (u, o = {}) => {
        const m = String(o.method || "GET").toUpperCase();
        if (m !== "GET" && m !== "HEAD") return Promise.resolve(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
        return fetch(u, o);
      };
      w.alert = () => {}; w.confirm = () => false; w.prompt = () => null; w.scrollTo = () => {};
    },
  });
  const w = dom.window, ev = (c) => w.eval(c);
  for (let i = 0; i < 60; i++) { await sleep(1000); try { if (ev("typeof autoDone!=='undefined'&&autoDone")) break; } catch (e) {} }
  if (!ev("typeof autoDone!=='undefined'&&autoDone")) { w.close(); throw new Error("재고수불부 자료를 받지 못함"); }
  const res = ev(`(()=>{const t='${kstToday}',from=new Date(Date.parse(t)-30*864e5).toISOString().slice(0,10);
    const ship={};S.led.forEach(r=>{if(r.k==='출하'&&r.d>from&&r.d<=t)ship[r.pn]=(ship[r.pn]||0)+(+r.q||0)});
    const L=S.items.filter(it=>it.pn&&!(typeof isExcl==='function'&&isExcl(it.pn))).map(it=>{
      const base=String(it.pn).replace(/\\s*\\[2F\\]\\s*$/,'');const cur=stockAt(it,t),sf=+it.sf||0,day=(ship[base]||0)/30;
      return{pn:it.pn,nm:it.nm||'',cu:it.cu||'',cur,sf,day:Math.round(day),doi:day>0?Math.round(cur/day*10)/10:null}});
    const short=L.filter(x=>x.sf>0&&x.cur<x.sf).sort((a,b)=>(a.cur/a.sf)-(b.cur/b.sf));
    const low=L.filter(x=>x.doi!=null&&x.doi<3&&!(x.sf>0&&x.cur<x.sf)).sort((a,b)=>a.doi-b.doi);
    return{at:new Date().toISOString(),n:L.length,nShort:short.length,short:short.slice(0,15),low:low.slice(0,15)}})()`);
  w.close();
  return res;
}

async function main() {
  // ① 생산일보
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");
  const dom = new JSDOM(html.replace(/<script src="[^"]+"><\/script>/g, ""), {
    url: "https://kimsanggi85-del.github.io/daily-production-report/", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vconsole(),
    beforeParse(w) {
      w.fetch = fetch.bind(globalThis); w.alert = () => {}; w.confirm = () => true; w.prompt = () => null; w.scrollTo = () => {};
      w.localStorage.setItem("tj_me", "생산관리(자동)"); w.localStorage.setItem("tj_autoentry", "0");
    },
  });
  const w = dom.window, ev = (c) => w.eval(c);
  await sleep(1500);
  await ev("pull()");
  const d = pos[0] || ev("pmLastDay()");
  const done = (await kvGet(DONE_KEY)) || {};
  const rec = done[d] || {};
  if (rec.brief && !force && !dry) { log(`이미 발송 (${d} ${rec.brief})`); w.close(); return; }
  log("실적 기준일", d);
  await ev(`loadMoldRep('${d.slice(0, 7)}')`);

  let st = null;
  try { st = await stockSummary(); log(`재고 ${st.n}품목 · 안전재고 미달 ${st.nShort} · 3일분 미만 ${st.low.length}`); }
  catch (e) { log("재고 요약 실패:", e.message); try { st = await kvGet(STOCK_KEY); } catch (e2) {} }

  const n = dry ? 0 : ev(`pmScan('${d}')`);
  if (n) { ev("clearTimeout(pushT)"); await ev("push()"); log(`이상 대응 목록 ${n}건 등록`); }
  const B = ev(`pmBrief('${d}',${JSON.stringify(st)})`);
  log(B.title); console.log(B.msg);
  w.close();
  if (dry) return log("(dry) 발송·저장하지 않음");
  if (st && st.at) await kvPut(STOCK_KEY, st);
  const r = await fetch("https://ntfy.sh/", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: NTFY_TOPIC, title: B.title, message: B.msg, tags: ["clipboard"], priority: 3 }) });
  if (!r.ok) throw new Error("ntfy " + r.status);
  const done2 = (await kvGet(DONE_KEY)) || {};
  done2[d] = { ...(done2[d] || {}), brief: new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16) };
  await kvPut(DONE_KEY, Object.fromEntries(Object.entries(done2).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 40)));
  log("발송 완료");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
