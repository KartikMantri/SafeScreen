// Captures a raw vs masked pair of the filled Launch View Gallery page for the demo video.
//   node tools/capture_pair.mjs  ->  video/assets/{raw,masked}.png
import puppeteer from "puppeteer";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "video", "assets");
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [join(root, "extension")], args: ["--enable-unsafe-webgpu"], defaultViewport: null });
const portal = (await browser.pages())[0];
await portal.setViewport({ width: 1400, height: 1080 });
await portal.goto("http://localhost:8000/portal/lvg.html", { waitUntil: "networkidle0" });
await portal.evaluate(() => {
  const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
  set("full_name", "Meera Iyer"); set("mobile", "9812345670"); set("email", "meera.iyer@example.in"); set("pan_number", "BQJPI4821K");
});
const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
const extId = new URL(sw.url()).host;
const panel = await browser.newPage({ type: "window" });
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
const tabId = await panel.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost:8000/*" }))[0].id);
await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
await panel.waitForFunction(() => ["ner", "ocr", "face", "yolo"].every((m) => /ready/.test(document.querySelector(`[data-model="${m}"]`).className)), { timeout: 300000 });
const pair = await panel.evaluate(async (tabId) => {
  const { agent } = window.__safescreen;
  const tab = await chrome.tabs.get(tabId);
  Object.assign(agent, { tabId, windowId: tab.windowId, sessionId: crypto.randomUUID(), vault: [] });
  const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const cycle = await agent.perceive("Register me for the Launch View Gallery.");
  return { raw, masked: cycle.maskedDataUrl };
}, tabId);
writeFileSync(join(out, "raw.png"), Buffer.from(pair.raw.split(",")[1], "base64"));
writeFileSync(join(out, "masked.png"), Buffer.from(pair.masked.split(",")[1], "base64"));
console.log("saved raw.png + masked.png");
await browser.close();
