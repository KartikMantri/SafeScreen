// SafeScreen pipeline orchestrator - runs in the side panel.
// Order follows the Technical Approach slide exactly:
//   01 Data capture & DOM inspection   Steps 1-2
//   02 Detect & identify               Step 3 (six layers) -> 4 -> 5a / 5b / LFV -> 6
//   ---- PRIVACY LINE ----
//   03 In the cloud                    Steps 7-8
//   04 Back on device                  Steps 9-12

import { findPII, applyPlaceholders } from "./pii_regex.js";
import { mergeBoxes } from "./merge.js";
import { drawMasks, toPngBase64, cropCanvas } from "./mask.js";
import { checkPolicy } from "./policy.js";
import { verifyLeaks, redactText } from "./leak_verifier.js";
import { requestAction, GatewayError } from "./gateway_client.js";
import { isWorkspaceUrl } from "./config.js";
import { domLayer } from "./detectors/dom_layer.js";
import { loadNER, nerSpans, nerInfo } from "./detectors/ner.js";
import { loadOCR, ocrCanvas, spanBox, labelledNameLines, capsNameLines, ocrInfo } from "./detectors/ocr.js";
import { loadFace, detectFaces, faceInfo } from "./detectors/face.js";
import { loadYOLO, detectRegions, yoloInfo } from "./detectors/yolo.js";

const ms = (t0) => Math.round(performance.now() - t0);

export class Agent {
  constructor(ui) {
    this.ui = ui;
    this.cfg = null;
    this.device = "wasm";
    this.stopped = false;
    this.running = false;
    this.vault = [];        // prompt placeholder -> real value; side-panel memory only, wiped at task end
  }

  // ------------------------------------------------------------------ setup
  async init(cfg) {
    this.cfg = cfg;
    try {
      const adapter = navigator.gpu && (await navigator.gpu.requestAdapter());
      this.device = adapter ? "webgpu" : "wasm";
    } catch { this.device = "wasm"; }
    this.ui.runtime(this.device);
    this.preload();
  }

  preload() {
    const track = (name, p, info) => {
      this.ui.model(name, "loading");
      p.then(() => this.ui.model(name, info.status, info.device || info.delegate || info.ep || ""))
        .catch(() => this.ui.model(name, "failed", info.error));
    };
    track("ner", loadNER(this.device), nerInfo);
    track("ocr", loadOCR(), ocrInfo);
    track("face", loadFace(), faceInfo);
    track("yolo", loadYOLO(this.device), yoloInfo);
  }

  stop() {
    this.stopped = true;
    if (this.tabId) this.send({ type: "session:end" }).catch(() => {});
  }

  // ------------------------------------------------------------------ messaging
  async send(msg) {
    const attempt = () => chrome.tabs.sendMessage(this.tabId, msg);
    let res;
    try {
      res = await attempt();
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: this.tabId }, files: ["content/content.js"] });
      res = await attempt();
    }
    if (!res?.ok) throw new Error(res?.error || "content script error");
    return res.data;
  }

  // ------------------------------------------------------------------ main loop
  async run(goal) {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.sessionId = crypto.randomUUID();
    const ui = this.ui;
    ui.reset();
    try {
      const tab = this.targetTabId
        ? await chrome.tabs.get(this.targetTabId)    // test harness: panel opened as a page (?tab=<id>)
        : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      if (!tab) throw new Error("no active tab");
      this.tabId = tab.id;
      this.windowId = tab.windowId;
      if (!isWorkspaceUrl(tab.url, this.cfg.workspaceOrigins)) {
        throw new Error(`"${new URL(tab.url).origin}" is outside the ISRO workspace - SafeScreen only operates on approved ISRO portals.`);
      }

      // STEP 1 - user goal + prompt PII check
      let t0 = performance.now();
      ui.step("s1", "run");
      const { sanitized, tokens } = await this.promptCheck(goal);
      this.vault = tokens;
      ui.step("s1", "ok", `${tokens.length} PII item(s) → placeholders`, ms(t0));
      ui.sanitizedGoal(sanitized, tokens.map((t) => `${t.token} (${t.type})`));

      const history = [];
      let reuse = null;       // cached cycle when the change hash says nothing changed
      for (let iter = 1; iter <= this.cfg.maxLoopIterations && !this.stopped; iter++) {
        ui.iteration(iter);
        const cycle = reuse || (await this.perceive(sanitized));
        reuse = null;
        if (this.stopped) break;
        if (!cycle) break;       // blocked by Gate 1

        // STEPS 7-8 - gateway + VLM (with NFR-REL-02 retries on invalid actions)
        let decision = null;
        for (let attempt = 0; attempt < 3 && !decision && !this.stopped; attempt++) {
          const payload = { ...cycle.payload, history: [...history] };
          ui.payload(payload, cycle.imageBytes);
          t0 = performance.now();
          ui.step("s7", "run");
          ui.step("s8", "run");
          let res;
          try {
            res = await requestAction(this.cfg, payload);
          } catch (e) {
            ui.step("s7", "fail", e.message);
            ui.step("s8", "idle");
            throw e;
          }
          ui.step("s7", "ok", `authenticated · zero-retention`, res.roundTripMs - (res.vlmMs || 0));
          ui.step("s8", "ok", `${res.model || "VLM"} → ${res.action.action}`, res.vlmMs || res.roundTripMs);
          ui.reply(res.action);

          // STEP 9 - policy check (Gate 2)
          t0 = performance.now();
          ui.step("s9", "run");
          const verdict = checkPolicy(res.action, { elements: cycle.elementIndex, tokens: new Set(this.vault.map((v) => v.token)) });
          ui.gate("g2", verdict.verdict === "reject" ? "block" : "pass", verdict.reasons.join("; ") || verdict.verdict);
          if (verdict.verdict === "reject") {
            ui.step("s9", "fail", verdict.reasons.join("; "), ms(t0));
            history.push(`REJECTED by local policy: ${JSON.stringify(res.action)} - ${verdict.reasons.join("; ")}`);
            continue;
          }
          ui.step("s9", "ok", verdict.verdict === "auto" ? "low-risk → auto" : verdict.verdict === "consent" ? "→ consent guard" : "finish", ms(t0));
          decision = { action: res.action, verdict };
        }
        if (!decision) {
          if (!this.stopped) ui.log("error", "VLM returned 3 invalid actions in a row - stopping.");
          break;
        }
        const { action, verdict } = decision;
        const target = cycle.elementIndex.get(action.element_id);

        if (verdict.verdict === "finish") {
          ui.finish(action.action === "done" ? "Task complete" : "Agent explanation", action.explanation);
          await this.audit(cycle, action, "finish");
          break;
        }

        if (verdict.verdict === "auto") {
          // STEP 12 - low-risk loop: scroll / highlight run automatically
          t0 = performance.now();
          ui.step("s12", "run");
          const before = cycle.hash;
          await this.send({ type: "execute", action });
          await new Promise((r) => setTimeout(r, 350));
          const after = await this.send({ type: "hash" });
          history.push(`${action.action} ${action.element_id != null ? "#" + action.element_id : "page"} ${action.value || ""} (auto, low-risk)`.trim());
          if (after === before) {
            ui.step("s12", "ok", "page unchanged → reuse masked view", ms(t0));
            reuse = cycle;
          } else {
            ui.step("s12", "ok", "page changed → re-capture (Step 2)", ms(t0));
          }
          await this.audit(cycle, action, "auto");
          continue;
        }

        // STEP 10 - consent + change guard (Gate 3)
        t0 = performance.now();
        ui.step("s10", "run", "waiting for your approval on the page…");
        const result = await this.send({
          type: "consent",
          action,
          targetLabel: target?.label || "",
          reasons: verdict.reasons,
          maskedPreview: cycle.maskedDataUrl,
        });
        ui.gate("g3", result === "approved" ? "pass" : "block", result);
        ui.step("s10", result === "approved" ? "ok" : "fail", result, ms(t0));
        if (result === "dismissed") {
          ui.finish("Stopped", "You dismissed the action. Control is back with you.");
          await this.audit(cycle, action, "dismissed");
          break;
        }
        if (result === "voided") {
          history.push(`consent VOIDED for ${action.action} #${action.element_id} - form changed, re-reading page`);
          continue;   // new cycle from Step 2
        }

        // STEP 11 - act: direct submit (no re-capture, no re-detection, no model call)
        t0 = performance.now();
        ui.step("s11", "run");
        const exec = await this.send({ type: "execute", action });
        ui.step("s11", exec.ok ? "ok" : "fail", exec.ok ? `${action.action} #${action.element_id} executed` : exec.error, ms(t0));
        history.push(`${action.action} #${action.element_id} "${target?.sanitizedLabel || ""}"${action.value ? ` value=${action.value}` : ""} → approved by user, ${exec.ok ? "executed" : "FAILED: " + exec.error}`);
        await this.audit(cycle, action, exec.ok ? "executed" : "failed");
        // Flow for this action ends; the loop controller starts a fresh cycle (SRS v1.1 FR-013-06)
        await new Promise((r) => setTimeout(r, 700));
      }
      if (this.stopped) ui.finish("Stopped", "Agent stopped by user.");
    } catch (e) {
      ui.log("error", e.message);
      ui.finish("Error", e instanceof GatewayError ? `Cloud step failed: ${e.message}. Nothing was cached or queued.` : e.message);
    } finally {
      this.vault = [];
      if (this.tabId) this.send({ type: "session:end" }).catch(() => {});
      this.running = false;
      ui.idle();
    }
  }

  // ------------------------------------------------------------------ Step 1
  async promptCheck(goal) {
    const spans = findPII(goal, { customRules: this.cfg.customRules });
    try {
      const [names] = await nerSpans([goal], { minScore: 0.85 });
      for (const n of names) {
        if (n.type === "NAME" && !spans.some((s) => n.start < s.end && s.start < n.end)) spans.push(n);
      }
    } catch (e) {
      this.ui.log("warn", `Prompt NER unavailable (${e.message}) - regex only; Gate 1 will block if a name remains`);
    }
    return applyPlaceholders(goal, spans.filter((s) => s.type !== "LOCATION" && s.type !== "ORGANIZATION"));
  }

  // ------------------------------------------------------------------ Steps 2-6
  async perceive(sanitizedGoal) {
    const ui = this.ui;
    ui.resetCycle();

    // STEP 2 - capture screen state
    let t0 = performance.now();
    ui.step("s2", "run");
    await this.send({ type: "overlay:hide", hide: true });
    const dom = await this.send({ type: "walk" });
    const shotUrl = await chrome.tabs.captureVisibleTab(this.windowId, { format: "png" });
    await this.send({ type: "overlay:hide", hide: false });
    const shot = await loadCanvas(shotUrl);
    const k = shot.width / dom.viewport.w;
    const scale = (r) => ({ x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k });
    dom.elements.forEach((e) => (e.box = scale(e.rect)));
    dom.media.forEach((m) => (m.box = scale(m.rect)));
    const hash = await this.send({ type: "hash" });
    ui.step("s2", "ok", `${dom.elements.length} elements · ${dom.texts.length} text nodes · ${dom.media.length} media`, ms(t0));

    // STEP 3 - six parallel layers
    t0 = performance.now();
    ui.step("s3", "run");
    const boxes = [];
    const elementPII = new Map();         // elementId -> type found in its value
    const cardNames = [];

    // Layer 1: DOM structural (synchronous with Step 2)
    const l1t = performance.now();
    const l1 = domLayer(dom.elements);
    boxes.push(...l1.boxes);
    ui.layer("L1", "ok", l1.boxes.length, ms(l1t));

    const textBranch = async () => {
      // Layer 2: regex + checksum over visible text nodes and field values
      let lt = performance.now();
      const spanReq = [];
      const textHits = new Map();
      for (const t of dom.texts) {
        const hits = findPII(t.text, { customRules: this.cfg.customRules });
        if (hits.length) textHits.set(t.id, hits);
        hits.forEach((h) => spanReq.push({ textId: t.id, start: h.start, end: h.end, type: h.type, source: "L2-REGEX" }));
      }
      let l2count = spanReq.length;
      for (const e of dom.elements) {
        if (!e.value || ["checkbox", "radio", "file", "submit", "button"].includes(e.type)) continue;
        const hits = findPII(e.value, { otpField: l1.flags.get(e.id)?.maskType === "OTP", customRules: this.cfg.customRules });
        if (hits.length) {
          elementPII.set(e.id, hits[0].type);
          boxes.push({ ...e.box, type: hits[0].type, source: "L2-REGEX", elementId: e.id });
          l2count++;
        }
      }
      ui.layer("L2", "ok", l2count, ms(lt));

      // Layer 3a: NER on the same text (names always; LOC/ORG only next to other PII)
      lt = performance.now();
      try {
        const nodes = dom.texts.filter((t) => /[A-Za-z]{3,}/.test(t.text));
        const nodeSpans = await nerSpans(nodes.map((t) => t.text));
        let n = 0;
        nodes.forEach((t, i) => {
          for (const s of nodeSpans[i]) {
            if (s.type !== "NAME" && !textHits.has(t.id)) continue;
            spanReq.push({ textId: t.id, start: s.start, end: s.end, type: s.type, source: "L3a-NER" });
            n++;
          }
        });
        const valued = dom.elements.filter((e) => e.value && /[A-Za-z]{3,}/.test(e.value) && !["checkbox", "radio", "file", "submit", "button", "password"].includes(e.type) && e.tag !== "select");
        const valueSpans = await nerSpans(valued.map((e) => e.value));
        valued.forEach((e, i) => {
          if (valueSpans[i].some((s) => s.type === "NAME")) {
            elementPII.set(e.id, elementPII.get(e.id) || "NAME");
            boxes.push({ ...e.box, type: "NAME", source: "L3a-NER", elementId: e.id });
            n++;
          }
        });
        ui.layer("L3a", "ok", n, ms(lt));
      } catch (e) {
        ui.layer("L3a", "fail", 0, ms(lt), e.message);
      }

      // map text spans to pixel rects on the page
      if (spanReq.length) {
        const rects = await this.send({ type: "rects", spans: spanReq.map(({ textId, start, end }) => ({ textId, start, end })) });
        spanReq.forEach((s, i) => {
          for (const r of rects[i]) boxes.push({ ...scale(r), type: s.type, source: s.source, spans: [{ textId: s.textId, start: s.start, end: s.end }] });
        });
      }
    };

    const imageMedia = dom.media.filter((m) => ["img", "canvas", "video", "embed", "object"].includes(m.kind));

    const ocrBranch = async () => {
      // Layer 3b: OCR only when media is present (FR-003-04-07); feeds Layers 2 and 3a
      if (!imageMedia.length) { ui.layer("L3b", "skip", 0, 0, "no media on page"); return; }
      const lt = performance.now();
      try {
        let n = 0;
        for (const m of imageMedia) {
          const { canvas, scale: s, offset } = cropCanvas(shot, m.box, 900);
          const lines = await ocrCanvas(canvas, s);
          const names = await nerSpans(lines.map((l) => l.text), { minScore: 0.7 }).catch(() => lines.map(() => []));
          const labelled = [...labelledNameLines(lines), ...capsNameLines(lines)];
          lines.forEach((line, i) => {
            // ID cards put the field label on the line above the value ("Date of Birth" / "14/08/1996")
            const prev = i > 0 ? lines[i - 1].text + " \n " : "";
            const regexHits = findPII(prev + line.text, { customRules: this.cfg.customRules, idImage: true })
              .filter((h) => h.start >= prev.length)
              .map((h) => ({ ...h, start: h.start - prev.length, end: h.end - prev.length }));
            const nameType = /fa\w{0,3}er|husband/i.test(prev) ? "FATHERS_NAME" : "NAME";   // tolerate OCR noise ("Faher's")
            const hits = [...regexHits, ...names[i].filter((x) => x.type === "NAME").map((x) => ({ ...x, type: nameType }))];
            const kv = labelled.find((l) => l.line === i);
            if (kv) {
              const value = (line.text.match(/\b[A-Z][A-Za-z]{2,}\b/g) || []).join(" ");
              hits.push({ type: kv.type === "NAME" ? nameType : kv.type, start: 0, end: line.text.length, value });
            }
            for (const h of hits) {
              const b = spanBox(line, h.start, h.end);
              if (!b) continue;
              boxes.push({ x: b.x + offset.x, y: b.y + offset.y, w: b.w, h: b.h, type: h.type, source: "L3b-OCR" });
              if (h.type === "NAME") cardNames.push(h.value);
              n++;
            }
          });
        }
        ui.layer("L3b", "ok", n, ms(lt));
      } catch (e) {
        ui.layer("L3b", "fail", 0, ms(lt), e.message);
      }
    };

    const faceBranch = async () => {
      // Layer 4: BlazeFace on images / video frames >= 50px
      if (!imageMedia.length) { ui.layer("L4", "skip", 0, 0, "no media on page"); return; }
      const lt = performance.now();
      try {
        let n = 0;
        for (const m of imageMedia) {
          const { canvas, offset } = cropCanvas(shot, m.box);
          for (const f of await detectFaces(canvas)) {
            boxes.push({ x: f.x + offset.x, y: f.y + offset.y, w: f.w, h: f.h, type: "FACE", source: "L4-FACE" });
            n++;
          }
        }
        ui.layer("L4", "ok", n, ms(lt));
      } catch (e) {
        ui.layer("L4", "fail", 0, ms(lt), e.message);
      }
    };

    const yoloBranch = async () => {
      // Layer 5: fine-tuned YOLO-nano on images >= 100px wide
      const big = imageMedia.filter((m) => m.rect.w >= 100);
      if (!big.length) { ui.layer("L5", "skip", 0, 0, "no images ≥100px"); return; }
      const lt = performance.now();
      try {
        const sess = await loadYOLO(this.device);
        if (!sess) { ui.layer("L5", "skip", 0, ms(lt), yoloInfo.error || "model unavailable"); return; }
        let n = 0;
        for (const m of big) {
          const { canvas, offset } = cropCanvas(shot, m.box);
          for (const d of await detectRegions(canvas, 0.5)) {
            boxes.push({ x: d.x + offset.x, y: d.y + offset.y, w: d.w, h: d.h, type: d.type, source: "L5-YOLO" });
            n++;
          }
        }
        ui.layer("L5", "ok", n, ms(lt));
      } catch (e) {
        ui.layer("L5", "fail", 0, ms(lt), e.message);
      }
    };

    await Promise.all([textBranch(), ocrBranch(), faceBranch(), yoloBranch()]);
    ui.step("s3", "ok", `${boxes.length} raw detections`, ms(t0));

    // STEP 4 - merge boxes
    t0 = performance.now();
    ui.step("s4", "run");
    let merged = mergeBoxes(boxes, shot);
    ui.step("s4", "ok", `${boxes.length} → ${merged.length} regions (IoU≥0.3, +8px)`, ms(t0));

    // element facts for the element map + policy check
    const elementIndex = new Map();
    const maskedByElement = new Map();
    for (const b of merged) if (b.elementId != null) maskedByElement.set(b.elementId, b.type);
    // FR-002-08: labels and option texts are sanitised (regex + NER, one batched call)
    const labelTexts = dom.elements.flatMap((e) => [e.label, ...(e.options || [])]);
    const labelNames = await nerSpans(labelTexts, { minScore: 0.85 }).catch(() => labelTexts.map(() => []));
    const clean = new Map();
    labelTexts.forEach((s, i) => {
      const hits = findPII(s, { customRules: this.cfg.customRules });
      labelNames[i].filter((x) => x.type === "NAME" && !hits.some((h) => x.start < h.end && h.start < x.end)).forEach((x) => hits.push(x));
      let out = s;
      for (const h of hits.sort((a, b) => b.start - a.start)) out = out.slice(0, h.start) + `[${h.type}]` + out.slice(h.end);
      clean.set(s, out);
    });
    for (const e of dom.elements) {
      const flag = l1.flags.get(e.id);
      elementIndex.set(e.id, {
        id: e.id, tag: e.tag, type: e.type, label: e.label, isSubmit: e.isSubmit,
        maskType: maskedByElement.get(e.id) || flag?.maskType || elementPII.get(e.id) || null,
        sensitive: flag?.sensitive || null,
        sanitizedLabel: clean.get(e.label),
        state: e.type === "checkbox" || e.type === "radio" ? (e.checked ? "checked" : "unchecked") : e.value ? "filled" : "empty",
        options: e.options?.map((o) => clean.get(o)),
        required: e.required, disabled: e.disabled,
      });
    }

    // STEP 5a / 5b / Local Form Validator - in parallel
    t0 = performance.now();
    ui.step("s5a", "run");
    ui.step("s5b", "run");
    ui.step("lfv", "run");
    const strict = dom.pageFlags.hasPassword || dom.pageFlags.hasCardField;   // FR-007-07
    const entries = () => merged.map((b) => ({ id: b.id, type: b.type, elementId: b.elementId ?? null, spans: b.spans, box: { x: b.x, y: b.y, w: b.w, h: b.h } }));
    let maskedCanvas;
    const [, stored, flags] = await Promise.all([
      (async () => { maskedCanvas = strict ? null : drawMasks(shot, merged); ui.step("s5a", "ok", strict ? "strict mode - no image will be sent" : `${merged.length} solid masks · PNG re-encoded`, ms(t0)); })(),
      this.send({ type: "maskmap:store", entries: entries(), promptTokens: this.vault }).then((r) => { ui.step("s5b", "ok", `${r.stored} regions + ${r.tokens} prompt tokens · stays on device`, ms(t0)); return r; }),
      this.send({ type: "validator:run", cardNames }).then((f) => { ui.step("lfv", "ok", `${Object.keys(f).length} pass/fail flags`, ms(t0)); return f; }),
    ]);
    ui.flags(flags);

    // outgoing text fields (for Gate 1 text scan)
    let textFields = {
      goal: sanitizedGoal,
      title: dom.title,
      ...Object.fromEntries([...elementIndex.values()].map((e) => [`label#${e.id}`, e.sanitizedLabel])),
      ...Object.fromEntries([...elementIndex.values()].filter((e) => e.options).map((e) => [`options#${e.id}`, e.options.join(" | ")])),
    };

    // STEP 6 - Leak Verifier (Gate 1): verify, re-mask once, verify again, else block
    t0 = performance.now();
    ui.step("s6", "run");
    const nameCheck = (texts) => nerSpans(texts, { minScore: 0.85 });
    let verdict;
    try {
      verdict = await verifyLeaks(maskedCanvas, textFields, this.cfg, nameCheck, imageMedia.map((m) => m.box), merged);
      if (!verdict.clean) {
        const what = [...verdict.imageFindings.map((f) => `${f.type} (${f.source})`), ...verdict.textFindings.map((f) => `${f.type} in ${f.field}`)];
        ui.log("warn", `Leak Verifier found ${what.length} residual item(s): ${what.join(", ")} - re-masking and re-checking`);
        const extra = verdict.imageFindings.map((f) => ({ ...f.box, type: f.type, source: f.source }));
        merged = mergeBoxes([...merged, ...extra], shot, { dilation: 4 });
        textFields = redactText(textFields, verdict.textFindings);
        if (maskedCanvas) maskedCanvas = drawMasks(shot, merged);
        const residual = verdict.imageFindings.length + verdict.textFindings.length;
        verdict = await verifyLeaks(maskedCanvas, textFields, this.cfg, nameCheck, imageMedia.map((m) => m.box), merged);
        verdict.leakRate = residual / Math.max(1, merged.length);
        await this.send({ type: "maskmap:store", entries: entries(), promptTokens: this.vault });
      }
    } catch (e) {
      verdict = { clean: false, error: e.message, imageFindings: [], textFindings: [] };   // fail-closed (NFR-REL-01)
    }
    if (!verdict.clean) {
      const left = [...(verdict.imageFindings || []).map((f) => `${f.type} (${f.source})`), ...(verdict.textFindings || []).map((f) => `${f.type} in ${f.field}`)];
      if (left.length) ui.log("error", `Still readable after re-mask: ${left.join(", ")}`);
      ui.step("s6", "fail", verdict.error ? `verifier error: ${verdict.error}` : "PII still readable after re-mask", ms(t0));
      ui.gate("g1", "block", "transmission blocked");
      ui.finish("Blocked by Leak Verifier", "SafeScreen could not guarantee a clean screenshot, so nothing was sent to the cloud.");
      return null;
    }
    ui.step("s6", "ok", `clean · leak-rate ${((verdict.leakRate || 0) * 100).toFixed(1)}%`, ms(t0));
    ui.gate("g1", "pass", "nothing readable - cleared to send");

    // ---- PRIVACY LINE: assemble the only payload that leaves the device ----
    let masked_image = null, imageBytes = 0, maskedDataUrl = null;
    if (maskedCanvas) {
      ({ base64: masked_image, bytes: imageBytes } = await toPngBase64(maskedCanvas));
      maskedDataUrl = maskedCanvas.toDataURL("image/png");
      ui.masked(maskedDataUrl, merged);
    } else ui.masked(null, merged);

    const payload = {
      session_id: this.sessionId,
      goal: textFields.goal,
      masked_image,
      strict_mode: strict,
      element_map: [...elementIndex.values()].map((e) => ({
        id: e.id,
        label: textFields[`label#${e.id}`] ?? e.sanitizedLabel,
        type: e.type ? `${e.tag}:${e.type}` : e.tag,
        state: e.maskType ? "masked" : e.state,
        masked_as: e.maskType || null,
        submit: e.isSubmit || undefined,
        required: e.required || undefined,
        disabled: e.disabled || undefined,
        options: e.options ? (textFields[`options#${e.id}`] ?? e.options.join(" | ")).split(" | ") : undefined,
      })),
      validator_flags: flags,
      mask_labels: merged.map((b) => `${b.type} at [${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)},${Math.round(b.h)}]`),
      page: { origin: dom.origin, path: dom.path, title: textFields.title },
      viewport: { width: shot.width, height: shot.height },
    };
    return { payload, imageBytes, maskedDataUrl, elementIndex, hash, maskCount: merged.length, origin: dom.origin, leakRate: verdict.leakRate || 0 };
  }

  // ------------------------------------------------------------------ DPDP audit log (enterprise tier)
  async audit(cycle, action, outcome) {
    if (!this.cfg.auditLog) return;
    const entry = { ts: new Date().toISOString(), domain: cycle.origin, action: action.action, outcome, mask_count: cycle.maskCount, leak_rate: cycle.leakRate };
    const { audit = [] } = await chrome.storage.local.get("audit");
    audit.push(entry);
    await chrome.storage.local.set({ audit: audit.slice(-5000) });
  }
}

function loadCanvas(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}
