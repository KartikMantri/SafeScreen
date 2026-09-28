// Records the live prototype for the demo video.
//   gateway must be running on :8000
//   node tools/record_demo.mjs  ->  video/build/demo/{portal,panel}/*.jpg + events.json
// The portal page and the side panel are captured as separate streams (CDP screencast)
// and composited side by side later by video/build.mjs.
import puppeteer from "puppeteer";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "video", "build", "demo");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "portal"), { recursive: true });
mkdirSync(join(out, "panel"), { recursive: true });

const PORTAL_W = 1400, PANEL_W = 520, H = 1080;
const LVG_GOAL = "Register me for the Launch View Gallery for the PSLV-C62 launch. My name is Meera Iyer, mobile 9812345670, email meera.iyer@example.in and PAN BQJPI4821K. Then submit.";
const LOGIN_GOAL = "Sign me in with employee ID ISRO-SAC-20417.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  enableExtensions: [join(root, "extension")],
  args: ["--enable-unsafe-webgpu", "--hide-scrollbars", `--window-size=${PORTAL_W},${H}`],
  defaultViewport: null,
});
const portal = (await browser.pages())[0] || (await browser.newPage());
await portal.setViewport({ width: PORTAL_W, height: H });
await portal.goto("http://localhost:8000/portal/lvg.html", { waitUntil: "networkidle0" });

const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
const extId = new URL(sw.url()).host;
const panel = await browser.newPage({ type: "window", windowBounds: { left: PORTAL_W, top: 0, width: PANEL_W, height: H } });
await panel.setViewport({ width: PANEL_W, height: H });
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
const tabId = await panel.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost:8000/*" }))[0].id);
await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}&present=1`);
console.log("waiting for on-device models…");
await panel.waitForFunction(() => ["ner", "ocr", "face", "yolo"].every((m) => /ready/.test(document.querySelector(`[data-model="${m}"]`).className)), { timeout: 300000 });

// ---------------------------------------------------------------- fake cursor
const CURSOR = `
  if (!window.__cur) {
    const c = document.createElement("div");
    c.id = "demo-cursor";
    c.style.cssText = "position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity .25s;will-change:transform";
    c.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#fff" stroke="#0B1F3A" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    let x = innerWidth * 0.6, y = innerHeight * 0.6;
    window.__cur = {
      async move(tx, ty, ms) {
        c.style.opacity = "1";
        const sx = x, sy = y, t0 = performance.now();
        await new Promise((res) => { const step = (now) => { const k = Math.min(1, (now - t0) / ms), e = k < .5 ? 2*k*k : 1 - Math.pow(-2*k+2, 2)/2;
          x = sx + (tx - sx) * e; y = sy + (ty - sy) * e; c.style.transform = "translate(" + x + "px," + y + "px)"; k < 1 ? requestAnimationFrame(step) : res(); }; requestAnimationFrame(step); });
      },
      async click() {
        const r = document.createElement("div");
        r.style.cssText = "position:fixed;left:" + (x - 14) + "px;top:" + (y - 14) + "px;width:28px;height:28px;border-radius:50%;border:3px solid #FF9933;z-index:2147483647;pointer-events:none;transition:all .45s ease-out";
        document.documentElement.appendChild(r);
        requestAnimationFrame(() => { r.style.transform = "scale(2.2)"; r.style.opacity = "0"; });
        setTimeout(() => r.remove(), 500);
      },
      hide() { c.style.opacity = "0"; },
    };
  }`;
const cursorTo = async (page, x, y, ms = 700) => { await page.evaluate(CURSOR); await page.evaluate((x, y, ms) => window.__cur.move(x, y, ms), x, y, ms); };
const cursorClick = (page) => page.evaluate(() => window.__cur.click());
const cursorHide = (page) => page.evaluate(() => window.__cur?.hide()).catch(() => {});

// ---------------------------------------------------------------- screencast
const t0 = Date.now();
const events = [];
const mark = (e, extra = {}) => { const t = (Date.now() - t0) / 1000; events.push({ t, e, ...extra }); console.log(t.toFixed(1).padStart(6), e, extra.detail || ""); };
async function screencast(page, name, width) {
  const cdp = await page.createCDPSession();
  const frames = [];
  let n = 0;
  cdp.on("Page.screencastFrame", async (f) => {
    const file = `${String(++n).padStart(6, "0")}.jpg`;
    writeFileSync(join(out, name, file), Buffer.from(f.data, "base64"));
    frames.push({ file, t: Date.now() / 1000 });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: width, maxHeight: H, everyNthFrame: 1 });
  return { frames, stop: () => cdp.send("Page.stopScreencast").catch(() => {}) };
}
// keep both pages repainting (screencast only emits on paint)
const ticker = `setInterval(() => { document.documentElement.style.setProperty("--tick", Math.random()); }, 100);`;
await portal.evaluate(ticker);
await panel.evaluate(ticker);
const castPortal = await screencast(portal, "portal", PORTAL_W);
const castPanel = await screencast(panel, "panel", PANEL_W);

// step watcher: record status transitions for the voice-over script
const seen = new Map();
const watcher = setInterval(async () => {
  try {
    const steps = await panel.evaluate(() => [...document.querySelectorAll(".step")].map((s) => [s.dataset.step, (s.className.match(/\b(run|ok|fail)\b/) || [""])[0], s.querySelector("small").textContent]));
    for (const [id, st, detail] of steps) {
      const key = `${id}:${st}`;
      if (st && seen.get(id) !== key) { seen.set(id, key); if (st !== "run") mark(`step ${id} ${st}`, { detail }); }
      if (!st) seen.delete(id);
    }
  } catch { /* page navigating */ }
}, 250);

async function runTask(goal, label, holds) {
  mark(`${label}: typing goal`);
  const box = await panel.$eval("#goal", (el) => { const r = el.getBoundingClientRect(); return [r.x + 40, r.y + 20]; });
  await cursorTo(panel, ...box, 800);
  await cursorClick(panel);
  await panel.$eval("#goal", (el) => { el.value = ""; });
  await panel.type("#goal", goal, { delay: 22 });
  const run = await panel.$eval("#run", (el) => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await cursorTo(panel, ...run, 600);
  await sleep(300);
  await cursorClick(panel);
  await panel.click("#run");
  mark(`${label}: run clicked`);
  await sleep(400);
  await cursorHide(panel);
  let consents = 0;
  const start = Date.now();
  while (Date.now() - start < 240000) {
    await sleep(250);
    const finished = await panel.evaluate(() => !document.getElementById("result").classList.contains("hidden") && !document.getElementById("run").disabled);
    if (finished) break;
    const consent = await portal.evaluate(() => {
      const root = document.getElementById("safescreen-host")?.shadowRoot;
      const ok = root?.querySelector("#ok");
      if (!ok) return null;
      const r = ok.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, what: root.querySelector(".v").textContent };
    }).catch(() => null);
    if (consent) {
      consents++;
      mark(`${label}: consent #${consents} shown`, { detail: consent.what });
      await sleep(holds[Math.min(consents - 1, holds.length - 1)]);
      await cursorTo(portal, consent.x, consent.y, 800);
      await sleep(250);
      await cursorClick(portal);
      await portal.evaluate(() => document.getElementById("safescreen-host").shadowRoot.querySelector("#ok").click());
      mark(`${label}: consent #${consents} approved`);
      await sleep(300);
      await cursorHide(portal);
    }
  }
  const result = await panel.evaluate(() => document.getElementById("result-title").textContent + " - " + document.getElementById("result-body").textContent);
  mark(`${label}: finished`, { detail: result });
}

await sleep(1500);
// hold per consent card (ms): first one longest so the voice-over can explain the card
await runTask(LVG_GOAL, "LVG", [9000, 5000, 4500, 6000, 4000, 7000]);
await sleep(5000);
mark("LOGIN: navigate");
await portal.goto("http://localhost:8000/portal/login.html", { waitUntil: "networkidle0" });
await portal.evaluate(ticker);
await sleep(2500);
await runTask(LOGIN_GOAL, "LOGIN", [5000]);
await sleep(6000);
mark("end");

clearInterval(watcher);
await castPortal.stop();
await castPanel.stop();
writeFileSync(join(out, "events.json"), JSON.stringify({ t0: t0 / 1000, events, portal: castPortal.frames, panel: castPanel.frames }, null, 1));
console.log(`frames: portal ${castPortal.frames.length}, panel ${castPanel.frames.length}; duration ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await browser.close();
