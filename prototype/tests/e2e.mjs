// End-to-end run of the real extension in Chrome for Testing.
//   1. start the gateway:   cd gateway && uvicorn app.main:app --port 8000
//   2. node tests/e2e.mjs [lvg|respond|notice|login] [--headful]
// Approves every consent dialog automatically and saves screenshots to tests/out/.
import puppeteer from "puppeteer";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "tests", "out");
mkdirSync(out, { recursive: true });

const scenario = process.argv[2] || "lvg";
const headful = process.argv.includes("--headful");
const SCENARIOS = {
  lvg: ["lvg.html", "Register me for the Launch View Gallery for the PSLV-C62 launch. My name is Meera Iyer, mobile 9812345670, email meera.iyer@example.in and PAN BQJPI4821K. Then submit."],
  respond: ["respond.html", "Fill the bank details on my RESPOND proposal: account number 50100234567812 and IFSC SBIN0001234, then submit the proposal."],
  notice: ["notice.html", "Summarise the circulars on this page."],
  login: ["login.html", "Sign me in with employee ID ISRO-SAC-20417."],
  dashboard: ["index.html", "Open the Launch View Gallery visitor registration from the portal."],
};
const [pagePath, goal] = SCENARIOS[scenario];

const browser = await puppeteer.launch({
  headless: !headful,
  pipe: true,
  enableExtensions: [join(root, "extension")],
  args: ["--window-size=1300,900", "--enable-unsafe-webgpu"],
  defaultViewport: null,
});

const portal = (await browser.pages())[0] || (await browser.newPage());
await portal.setViewport({ width: +(process.env.VIEWPORT_W || 1280), height: +(process.env.VIEWPORT_H || 820), deviceScaleFactor: +(process.env.DSF || 1) });
await portal.goto(`http://localhost:8000/portal/${pagePath}`, { waitUntil: "networkidle0" });

const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
const extId = new URL(sw.url()).host;

const panel = await browser.newPage({ type: "window", windowBounds: { left: 1300, top: 0, width: 460, height: 900 } });
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
const tabId = await panel.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost:8000/*" }))[0].id);
await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
panel.on("console", (m) => { if (m.type() === "error" || m.type() === "debug") console.log("[panel]", m.text()); });

console.log(`extension ${extId}, portal tab ${tabId}, scenario ${scenario}`);
console.log("waiting for on-device models…");
await panel.waitForFunction(() => ["ner", "ocr", "face"].every((m) => /ready|failed/.test(document.querySelector(`[data-model="${m}"]`).className)), { timeout: 240000 });
console.log(await panel.evaluate(() => [...document.querySelectorAll(".model")].map((m) => `${m.dataset.model}: ${m.querySelector("i").textContent}`).join(" | ")));

await panel.type("#goal", goal);
await panel.click("#run");
const t0 = Date.now();
let consents = 0;
while (Date.now() - t0 < 300000) {
  await new Promise((r) => setTimeout(r, 700));
  const finished = await panel.evaluate(() => !document.getElementById("result").classList.contains("hidden") && !document.getElementById("run").disabled);
  if (finished) break;
  const hasConsent = await portal.evaluate(() => !!document.getElementById("safescreen-host")?.shadowRoot?.querySelector("#ok")).catch(() => false);
  if (hasConsent) {
    consents++;
    await portal.screenshot({ path: join(out, `${scenario}-consent-${consents}.png`) });
    const what = await portal.evaluate(() => document.getElementById("safescreen-host").shadowRoot.querySelector(".v").textContent);
    console.log(`consent #${consents}: ${what} → approving`);
    await portal.evaluate(() => document.getElementById("safescreen-host").shadowRoot.querySelector("#ok").click());
  }
}

const report = await panel.evaluate(() => ({
  result: document.getElementById("result-title").textContent + " - " + document.getElementById("result-body").textContent,
  steps: [...document.querySelectorAll(".step")].map((s) => `${s.dataset.step}: ${s.className.replace("step", "").trim() || "-"} ${s.querySelector("small").textContent} ${s.querySelector("span").textContent}`),
  layers: [...document.querySelectorAll(".layer")].map((l) => `${l.dataset.layer}: ${l.querySelector("span").textContent}`),
  log: [...document.querySelectorAll("#log li")].map((l) => l.textContent),
  payload: document.getElementById("payload").textContent,
  masked: document.getElementById("masked").src,
}));
if (report.masked.startsWith("data:image/png")) writeFileSync(join(out, `${scenario}-masked.png`), Buffer.from(report.masked.split(",")[1], "base64"));
writeFileSync(join(out, `${scenario}-payload.json`), report.payload);
await portal.screenshot({ path: join(out, `${scenario}-final.png`) });
await panel.screenshot({ path: join(out, `${scenario}-panel.png`), fullPage: true });

console.log("\nRESULT:", report.result);
console.log("\nLAST CYCLE STEPS:\n  " + report.steps.join("\n  "));
console.log("\nLAYERS:\n  " + report.layers.join("\n  "));
console.log("\nLOG:\n  " + report.log.join("\n  "));
await browser.close();
