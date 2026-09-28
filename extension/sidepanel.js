import { Agent } from "./lib/pipeline.js";
import { loadConfig, saveConfig, isWorkspaceUrl } from "./lib/config.js";

const $ = (id) => document.getElementById(id);
// ?present=1 : recording layout for demo videos (compact, follows the running step)
const PRESENT = new URLSearchParams(location.search).get("present") === "1";
if (PRESENT) document.body.classList.add("present");
const follow = (el) => { if (PRESENT && el) el.scrollIntoView({ block: "center", behavior: "smooth" }); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const SAMPLES = [
  ["Launch View Gallery", "Register me for the Launch View Gallery for the PSLV-C62 launch. My name is Meera Iyer, mobile 9812345670, email meera.iyer@example.in and PAN BQJPI4821K. Then submit."],
  ["RESPOND bank details", "Fill the bank details on my RESPOND proposal: account number 50100234567812 and IFSC SBIN0001234, then submit the proposal."],
  ["Open a service", "Open the Launch View Gallery visitor registration from the portal."],
  ["Explain page", "Explain what this page is for and what I need to do next."],
];

// ------------------------------------------------------------------ UI adapter
const ui = {
  runtime(device) { $("runtime").textContent = device === "webgpu" ? "WebGPU" : "WASM fallback"; },
  model(name, status, detail = "") {
    const el = document.querySelector(`[data-model="${name}"]`);
    el.className = `model ${status}`;
    el.querySelector("i").textContent = status === "ready" ? `ready ${detail}` : status === "not-trained" ? "not trained" : status;
    el.title = detail;
  },
  reset() {
    document.querySelectorAll(".step").forEach((s) => { s.className = s.className.replace(/\b(run|ok|fail)\b/g, "").trim(); s.querySelector("small").textContent = ""; s.querySelector("span").textContent = ""; });
    document.querySelectorAll(".layer").forEach((l) => { l.className = "layer"; l.querySelector("span").textContent = ""; });
    $("log").innerHTML = "";
    $("result").classList.add("hidden");
    $("sanitized").classList.add("hidden");
    $("payload").textContent = "";
    $("reply").textContent = "";
    $("flags").innerHTML = "";
  },
  resetCycle() {
    for (const id of ["s2", "s3", "s4", "s5a", "s5b", "lfv", "s6", "s7", "s8", "s9", "s10", "s11", "s12"]) this.step(id, "idle");
    document.querySelectorAll(".layer").forEach((l) => { l.className = "layer run"; l.querySelector("span").textContent = "…"; });
  },
  step(id, status, detail = "", t = null) {
    const el = document.querySelector(`[data-step="${id}"]`);
    if (!el) return;
    el.className = `step${el.classList.contains("gate") ? " gate" : ""}${status === "idle" ? "" : " " + status}`;
    if (PRESENT && id === "s8") detail = detail.replace(/mock:[\w-]+/, "Cloud VLM");
    el.querySelector("small").textContent = status === "idle" ? "" : detail;
    if (status === "run") follow(el);
    el.querySelector("span").textContent = t != null ? `${t} ms` : "";
    if (status === "fail" && detail) this.log("warn", `Step ${id.replace("s", "")}: ${detail}`);
  },
  layer(id, status, count, t, note = "") {
    const el = document.querySelector(`[data-layer="${id}"]`);
    el.className = `layer ${status}`;
    el.querySelector("span").textContent = status === "skip" ? `skipped` : status === "fail" ? "error" : `${count} hit${count === 1 ? "" : "s"} · ${t} ms`;
    el.title = note;
    if (status === "fail") this.log("warn", `Layer ${id} failed: ${note}`);
  },
  gate(id, status, detail) { this.log(status === "block" ? "warn" : "info", `${id.toUpperCase()} ${status === "block" ? "BLOCKED" : "passed"}: ${detail}`); },
  iteration(n) { $("iter").textContent = `cycle ${n}`; },
  sanitizedGoal(text, tokens) {
    const el = $("sanitized");
    el.innerHTML = `<b>Sent to cloud as:</b> ${esc(text).replace(/\{\{[A-Z_0-9]+\}\}/g, (t) => `<code>${t}</code>`)}${tokens.length ? `<br><small>Real values held on this device: ${tokens.map(esc).join(", ")}</small>` : ""}`;
    el.classList.remove("hidden");
  },
  masked(dataUrl, boxes) {
    if (dataUrl) follow($("masked"));
    if (dataUrl) { $("masked").src = dataUrl; $("masked").classList.remove("hidden"); $("masked-empty").classList.add("hidden"); }
    else { $("masked").classList.add("hidden"); $("masked-empty").classList.remove("hidden"); $("masked-empty").textContent = "Strict mode - no image sent (text-only element map)"; }
    this.log("info", `${boxes.length} region(s) masked: ${[...new Set(boxes.map((b) => b.type))].join(", ") || "none"}`);
  },
  flags(flags) {
    $("flags").innerHTML = Object.entries(flags).map(([k, v]) => `<span class="flag ${v === true ? "t" : v === false ? "f" : ""}">${esc(k)}: ${v === null ? "n/a" : v}</span>`).join("");
  },
  payload(p, bytes) {
    const shown = { ...p, masked_image: p.masked_image ? `<base64 PNG, ${Math.round(bytes / 1024)} KB - see preview above>` : null };
    $("payload").textContent = JSON.stringify(shown, null, 2);
    $("bytes").textContent = `${Math.round((JSON.stringify(p).length) / 1024)} KB`;
  },
  reply(a) { $("reply").textContent = JSON.stringify(a, null, 2); this.log("info", `Cloud → ${a.action}${a.element_id != null ? " #" + a.element_id : ""}: ${a.explanation}`); },
  finish(title, body) {
    $("result").classList.remove("hidden", "ok", "bad");
    $("result").classList.add(/complete|explanation/i.test(title) ? "ok" : "bad");
    $("result-title").textContent = title;
    $("result-body").textContent = body;
    follow($("result"));
  },
  log(level, text) {
    const li = document.createElement("li");
    li.className = level;
    li.textContent = `${new Date().toLocaleTimeString()} ${text}`;
    $("log").appendChild(li);
    $("log").scrollTop = $("log").scrollHeight;   // scroll the log only, not the whole panel
  },
  idle() { $("run").disabled = false; $("stop").disabled = true; },
};

// ------------------------------------------------------------------ boot
const agent = new Agent(ui);
const forcedTab = +new URLSearchParams(location.search).get("tab") || null;
agent.targetTabId = forcedTab;
window.__safescreen = { agent, ui };   // used by the e2e harness
let cfg = await loadConfig();
await agent.init(cfg);

function fillSettings() {
  $("cfg-gateway").value = cfg.gatewayUrl;
  $("cfg-key").value = cfg.apiKey;
  $("cfg-iter").value = cfg.maxLoopIterations;
  $("cfg-origins").value = cfg.workspaceOrigins.join("\n");
  $("cfg-audit").checked = cfg.auditLog;
}
fillSettings();

$("samples").innerHTML = SAMPLES.map(([label], i) => `<button class="chip" data-i="${i}">${esc(label)}</button>`).join("");
$("samples").addEventListener("click", (e) => { const i = e.target.dataset.i; if (i != null) $("goal").value = SAMPLES[i][1]; });

async function refreshWorkspace() {
  const tab = forcedTab ? await chrome.tabs.get(forcedTab).catch(() => null) : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  const el = $("workspace");
  if (!tab?.url) { el.className = "workspace"; el.textContent = "No active tab"; return; }
  let origin = tab.url;
  try { origin = new URL(tab.url).origin; } catch { /* keep raw */ }
  const inside = isWorkspaceUrl(tab.url, cfg.workspaceOrigins);
  el.className = `workspace ${inside ? "in" : "out"}`;
  el.textContent = inside ? `✓ ISRO workspace - ${origin}` : `✕ Outside ISRO workspace - agent disabled here (${origin})`;
}
chrome.tabs.onActivated.addListener(refreshWorkspace);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.status === "complete") refreshWorkspace(); });
refreshWorkspace();

$("run").addEventListener("click", () => {
  const goal = $("goal").value.trim();
  if (!goal) { $("goal").focus(); return; }
  $("run").disabled = true;
  $("stop").disabled = false;
  agent.run(goal);
});
$("stop").addEventListener("click", () => agent.stop());
$("masked").addEventListener("click", () => {
  const w = window.open();
  if (w) w.document.write(`<title>Masked screenshot</title><img src="${$("masked").src}" style="max-width:100%">`);
});

$("cfg-save").addEventListener("click", async () => {
  cfg = {
    ...cfg,
    gatewayUrl: $("cfg-gateway").value.trim(),
    apiKey: $("cfg-key").value.trim(),
    maxLoopIterations: Math.max(1, Math.min(50, +$("cfg-iter").value || 20)),
    workspaceOrigins: $("cfg-origins").value.split("\n").map((s) => s.trim()).filter(Boolean),
    auditLog: $("cfg-audit").checked,
  };
  await saveConfig(cfg);
  agent.cfg = cfg;
  refreshWorkspace();
  ui.log("info", "Settings saved");
});
$("audit-export").addEventListener("click", async () => {
  const { audit = [] } = await chrome.storage.local.get("audit");
  const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), note: "SafeScreen DPDP audit log - no real values recorded", entries: audit }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `safescreen-audit-${Date.now()}.json`;
  a.click();
});
