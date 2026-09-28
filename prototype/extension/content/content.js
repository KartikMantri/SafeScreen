// SafeScreen content script - the on-page half of the pipeline.
//   Step 2   DOM walk + numbered element map
//   Step 5b  Local Mask Map (real values live here and never leave the device)
//   LFV      Local Form Validator (only pass/fail flags leave this script)
//   Step 10  Consent + Change Guard (Safety Gate 3)
//   Step 11  Act: direct submit
//   Step 12  change hash for the low-risk loop
(() => {
  if (window.__safescreen) return;
  window.__safescreen = true;

  const HOST_ID = "safescreen-host";
  const INTERACTIVE = "input, select, textarea, button, a[href], [role=button], [role=link], [role=checkbox], [contenteditable=true]";

  const state = {
    elements: new Map(),     // element id -> Element   (current capture only)
    texts: new Map(),        // text id -> Text node
    maskMap: new Map(),      // mask id -> {elementId, realValue, box, type}
    vault: new Map(),        // placeholder token -> {value, type}  (prompt PII)
    consent: null,
  };

  // ---------------------------------------------------------------- helpers
  function isVisible(el, r) {
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity > 0.05;
  }

  function labelFor(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return l.innerText.trim();
    }
    const wrap = el.closest("label");
    if (wrap) return wrap.innerText.trim();
    if (el.placeholder) return el.placeholder.trim();
    if (el.tagName === "INPUT" && ["submit", "button"].includes(el.type)) return el.value;
    const t = (el.innerText || el.textContent || "").trim();
    if (t) return t;
    return el.getAttribute("title") || el.name || el.tagName.toLowerCase();
  }

  function isSubmit(el) {
    if (el.tagName === "BUTTON") return (el.getAttribute("type") || "submit") === "submit" && !!el.form;
    return el.tagName === "INPUT" && el.type === "submit";
  }

  function valueOf(el) {
    if (el.tagName === "SELECT") return el.options[el.selectedIndex]?.text || "";
    if (el.type === "checkbox" || el.type === "radio") return el.checked ? "checked" : "";
    if (el.type === "file") return Array.from(el.files || []).map((f) => f.name).join(", ");
    if (el.isContentEditable) return el.innerText;
    return el.value ?? "";
  }

  // ---------------------------------------------------------------- Step 2
  function walk() {
    state.elements.clear();
    state.texts.clear();
    const elements = [];
    let n = 0;
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (el.closest("#" + HOST_ID)) continue;
      if (el.tagName === "INPUT" && el.type === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (!isVisible(el, r)) continue;
      const id = ++n;
      state.elements.set(id, el);
      elements.push({
        id,
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute("type") || "").toLowerCase() || null,
        role: el.getAttribute("role"),
        name: el.getAttribute("name"),
        idAttr: el.id || null,
        autocomplete: el.getAttribute("autocomplete"),
        label: labelFor(el).slice(0, 120),
        required: !!el.required,
        disabled: !!el.disabled,
        checked: el.type === "checkbox" || el.type === "radio" ? el.checked : undefined,
        value: valueOf(el),   // on-device only: scanned by Layers 2/3a, never serialised to the cloud
        options: el.tagName === "SELECT" ? Array.from(el.options).slice(0, 20).map((o) => o.text) : undefined,
        isSubmit: isSubmit(el),
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      });
    }

    const texts = [];
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || !node.data.trim()) return NodeFilter.FILTER_REJECT;
        if (p.closest("script,style,noscript,template,#" + HOST_ID)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let t = 0;
    const range = document.createRange();
    for (let node = tw.nextNode(); node; node = tw.nextNode()) {
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (!isVisible(node.parentElement, r)) continue;
      const id = ++t;
      state.texts.set(id, node);
      texts.push({ id, text: node.data });
    }

    const media = [];
    for (const el of document.querySelectorAll("img, canvas, video, embed, object, iframe")) {
      if (el.closest("#" + HOST_ID)) continue;
      const r = el.getBoundingClientRect();
      if (!isVisible(el, r) || r.width < 50 || r.height < 50) continue;
      media.push({ kind: el.tagName.toLowerCase(), rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
    }

    return {
      url: location.href,
      origin: location.origin,
      path: location.pathname,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, scrollX, scrollY },
      elements,
      texts,
      media,
      pageFlags: {
        hasPassword: !!document.querySelector("input[type=password]"),
        hasCardField: !!document.querySelector("[autocomplete^=cc-]"),
      },
    };
  }

  function rectsForSpans(spans) {
    const range = document.createRange();
    return spans.map(({ textId, start, end }) => {
      const node = state.texts.get(textId);
      if (!node) return [];
      range.setStart(node, Math.min(start, node.length));
      range.setEnd(node, Math.min(end, node.length));
      return Array.from(range.getClientRects()).map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }));
    });
  }

  // ---------------------------------------------------------------- Step 5b
  function storeMaskMap({ entries, promptTokens }) {
    state.maskMap.clear();
    for (const e of entries) {
      let realValue = null;
      if (e.elementId != null && state.elements.has(e.elementId)) realValue = valueOf(state.elements.get(e.elementId));
      else if (e.spans?.length) {
        realValue = e.spans.map((s) => state.texts.get(s.textId)?.data.slice(s.start, s.end) ?? "").join(" ");
      }
      state.maskMap.set(e.id, { elementId: e.elementId ?? null, realValue, box: e.box, type: e.type });
    }
    for (const t of promptTokens || []) state.vault.set(t.token, { value: t.value, type: t.type });
    return { stored: state.maskMap.size, tokens: state.vault.size };
  }

  // ---------------------------------------------------------------- Local Form Validator
  const RX = {
    pan: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
    phone: /^(\+91[\s-]?)?[6-9]\d{9}$/,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
    ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/,
  };
  const V_D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
  const V_P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
  const verhoeff = (s) => { let c = 0; for (let i = 0; i < s.length; i++) c = V_D[c][V_P[i % 8][+s[s.length - 1 - i]]]; return c === 0; };

  function fieldKind(el) {
    const k = `${el.name || ""} ${el.id || ""} ${el.getAttribute("autocomplete") || ""} ${labelFor(el)}`.toLowerCase();
    if (/\bpan\b|pan[_\s-]?(no|number|card)/.test(k)) return "pan";
    if (/aadha+r|\buid\b/.test(k)) return "aadhaar";
    if (el.type === "email" || /e-?mail/.test(k)) return "email";
    if (el.type === "tel" || /mobile|phone/.test(k)) return "phone";
    if (/ifsc/.test(k)) return "ifsc";
    if (/full.?name|\bname\b/.test(k) && el.type !== "file") return "name";
    return null;
  }

  function validateForm({ cardNames = [] } = {}) {
    const flags = {};
    const fields = Array.from(document.querySelectorAll("input, select, textarea")).filter((el) => !el.closest("#" + HOST_ID) && el.type !== "hidden");
    const required = fields.filter((f) => f.required && !["checkbox", "radio", "submit", "button"].includes(f.type));
    flags.required_fields_complete = required.length ? required.every((f) => valueOf(f).trim() !== "") : null;
    const boxes = fields.filter((f) => f.type === "checkbox" && f.required);
    flags.required_checkboxes_ticked = boxes.length ? boxes.every((f) => f.checked) : null;

    const check = (kind, test) => {
      const els = fields.filter((f) => fieldKind(f) === kind);
      if (!els.length) return;
      const vals = els.map((f) => valueOf(f).trim()).filter(Boolean);
      flags[`${kind}_format_valid`] = vals.length ? vals.every(test) : null;   // null = empty, not yet checkable
    };
    check("pan", (v) => RX.pan.test(v.toUpperCase()));
    check("aadhaar", (v) => /^\d{12}$/.test(v.replace(/\s/g, "")) && verhoeff(v.replace(/\s/g, "")));
    check("phone", (v) => RX.phone.test(v.replace(/\s/g, "")));
    check("email", (v) => RX.email.test(v));
    check("ifsc", (v) => RX.ifsc.test(v.toUpperCase()));

    const files = fields.filter((f) => f.type === "file");
    if (files.length) {
      flags.file_uploads_ok = files.every((f) => {
        const max = +(f.dataset.maxBytes || 5 * 1024 * 1024);
        const accept = (f.accept || "").split(",").map((s) => s.trim()).filter(Boolean);
        return Array.from(f.files || []).every((file) => file.size <= max && (!accept.length || accept.some((a) => file.type.match(a.replace("*", ".*")) || file.name.endsWith(a))));
      });
      flags.file_uploaded = files.some((f) => (f.files || []).length > 0) || !!document.querySelector("[data-safescreen-uploaded]");
    }

    // Name on form vs name read (on-device) from the uploaded ID card
    const nameEl = fields.find((f) => fieldKind(f) === "name" && valueOf(f).trim());
    if (nameEl && cardNames.length) {
      const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
      flags.name_matches_id_card = cardNames.some((c) => norm(c) === norm(valueOf(nameEl)));
    } else flags.name_matches_id_card = null;
    return flags;   // booleans only - FR-008-04
  }

  // ---------------------------------------------------------------- overlay host
  function host() {
    let h = document.getElementById(HOST_ID);
    if (!h) {
      h = document.createElement("div");
      h.id = HOST_ID;
      h.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
      h.attachShadow({ mode: "open" });
      document.documentElement.appendChild(h);
    }
    return h.shadowRoot;
  }

  function highlight(elementId, ms = 1600) {
    const el = state.elements.get(elementId);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const box = document.createElement("div");
    box.style.cssText = `position:fixed;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;border:3px solid #FF9933;border-radius:6px;box-shadow:0 0 0 4px rgba(255,153,51,.25);transition:opacity .4s;`;
    host().appendChild(box);
    setTimeout(() => { box.style.opacity = "0"; setTimeout(() => box.remove(), 400); }, ms);
    return true;
  }

  // ---------------------------------------------------------------- Step 10
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function resolvePlaceholders(value) {
    return String(value ?? "").replace(/\{\{[A-Z_]+(?:_\d+)?\}\}/g, (tok) => state.vault.get(tok)?.value ?? tok);
  }

  function formPreview(target) {
    const form = target?.form || target?.closest?.("form");
    if (!form) return [];
    return Array.from(form.elements)
      .filter((f) => f.tagName !== "BUTTON" && !["submit", "button", "hidden"].includes(f.type))
      .map((f) => {
        const masked = Array.from(state.maskMap.values()).some((m) => m.elementId != null && state.elements.get(m.elementId) === f)
          || f.type === "password" || !!fieldKind(f) && ["pan", "aadhaar"].includes(fieldKind(f));
        return { label: labelFor(f).slice(0, 60), value: valueOf(f), masked };
      });
  }

  function requestConsent(req) {
    return new Promise((resolve) => {
      const root = host();
      const target = state.elements.get(req.action.element_id);
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:fixed;inset:0;background:rgba(10,20,40,.45);display:flex;align-items:flex-start;justify-content:flex-end;padding:16px;pointer-events:auto;font-family:Segoe UI,Arial,sans-serif;";
      const typed = req.action.action === "type" ? req.action.value : null;
      const typedIsToken = typed && /^\{\{[A-Z_]+(?:_\d+)?\}\}$/.test(typed.trim());
      const preview = formPreview(target);
      wrap.innerHTML = `
        <style>
          .card{width:380px;max-height:calc(100vh - 32px);overflow:auto;background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.35);color:#0B1F3A;font-size:13px}
          .hd{background:#0B3D91;color:#fff;padding:12px 14px;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center}
          .hd b{font-size:14px}.chip{background:#FF9933;color:#0B1F3A;border-radius:10px;padding:2px 8px;font-size:11px;font-weight:700}
          .bd{padding:12px 14px}.row{margin:6px 0}.k{color:#51607A;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
          .v{font-weight:600}.expl{background:#F2F6FC;border-left:3px solid #0B3D91;padding:8px;border-radius:4px;margin:8px 0}
          table{width:100%;border-collapse:collapse;margin-top:4px}td{border-bottom:1px solid #E6EBF2;padding:4px 2px;vertical-align:top}
          td.m{color:#fff;background:#1A1D21;font-size:11px;border-radius:3px;padding:2px 6px}
          img{width:100%;border:1px solid #D5DCE6;border-radius:6px;margin-top:4px}
          .guard{font-size:12px;padding:6px 8px;border-radius:6px;background:#E8F5E9;color:#1B5E20;margin-top:8px}
          .guard.void{background:#FDECEA;color:#B71C1C;font-weight:700}
          .btns{display:flex;gap:8px;padding:12px 14px;border-top:1px solid #E6EBF2}
          button{flex:1;padding:9px;border-radius:8px;border:0;font-weight:700;cursor:pointer;font-size:13px}
          .ok{background:#138808;color:#fff}.ok:disabled{background:#A5B3A7;cursor:not-allowed}.no{background:#E6EBF2;color:#0B1F3A}
          .reveal{font-size:11px;color:#0B3D91;cursor:pointer;text-decoration:underline;background:none;padding:0;flex:none}
        </style>
        <div class="card" role="dialog" aria-label="SafeScreen consent">
          <div class="hd"><b>SafeScreen - Approve action</b><span class="chip">GATE 3</span></div>
          <div class="bd">
            <div class="row"><span class="k">Action</span><div class="v">${esc(req.action.action.toUpperCase())} → #${esc(req.action.element_id)} "${esc(req.targetLabel)}"</div></div>
            ${typed != null ? `<div class="row"><span class="k">Value</span><div class="v">${esc(typed)}${typedIsToken ? ` <span style="color:#51607A;font-weight:400">(resolved on this device from your prompt)</span>` : ""}</div></div>` : ""}
            <div class="expl">${esc(req.action.explanation)}</div>
            <div class="row"><span class="k">Why consent is required</span><div>${esc(req.reasons.join("; "))} · confidence ${(req.action.confidence * 100).toFixed(0)}%</div></div>
            ${preview.length ? `<div class="row"><span class="k">What will be submitted</span> <button class="reveal" id="rv">reveal on this device</button>
              <table>${preview.map((p) => `<tr><td>${esc(p.label)}</td>${p.masked ? `<td class="m" data-real="${esc(p.value)}">[MASKED]</td>` : `<td>${esc(p.value) || "<i>empty</i>"}</td>`}</tr>`).join("")}</table></div>` : ""}
            ${req.maskedPreview ? `<div class="row"><span class="k">What the cloud saw</span><img src="${req.maskedPreview}" alt="masked screenshot"></div>` : ""}
            <div class="guard" id="guard">Change guard active - editing any field voids this approval.</div>
          </div>
          <div class="btns"><button class="no" id="no">Dismiss</button><button class="ok" id="ok">Approve</button></div>
        </div>`;
      root.appendChild(wrap);
      const $ = (id) => wrap.querySelector("#" + id);
      if (target) {
        const r = target.getBoundingClientRect();
        const ring = document.createElement("div");
        ring.style.cssText = `position:fixed;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;border:3px solid #FF9933;border-radius:6px;pointer-events:none;`;
        wrap.appendChild(ring);
      }
      let voided = false;
      const voidConsent = () => {
        if (voided) return;
        voided = true;
        $("ok").disabled = true;
        $("guard").className = "guard void";
        $("guard").textContent = "Form changed - please review and re-approve. Dismiss to let the agent re-read the page.";
      };
      // Change guard: MutationObserver + input/change listeners (FR-012-03/04)
      const mo = new MutationObserver((records) => {
        if (records.some((r) => !(r.target === document.getElementById(HOST_ID) || document.getElementById(HOST_ID)?.contains(r.target)) && r.target.closest?.("form, input, select, textarea"))) voidConsent();
      });
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true, attributeFilter: ["value", "checked", "disabled", "selected"] });
      const onEdit = (e) => { if (!e.composedPath().includes(document.getElementById(HOST_ID))) voidConsent(); };
      document.addEventListener("input", onEdit, true);
      document.addEventListener("change", onEdit, true);

      const done = (result) => {
        mo.disconnect();
        document.removeEventListener("input", onEdit, true);
        document.removeEventListener("change", onEdit, true);
        wrap.remove();
        state.consent = null;
        resolve(result);
      };
      $("ok").addEventListener("click", () => done(voided ? "voided" : "approved"));
      $("no").addEventListener("click", () => done(voided ? "voided" : "dismissed"));
      $("rv")?.addEventListener("click", () => {
        wrap.querySelectorAll("td.m").forEach((td) => { td.textContent = td.textContent === "[MASKED]" ? td.dataset.real || "(empty)" : "[MASKED]"; });
      });
      state.consent = { cancel: () => done("dismissed") };
    });
  }

  // ---------------------------------------------------------------- Step 11
  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter ? setter.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function execute(action) {
    const el = action.element_id != null ? state.elements.get(action.element_id) : null;
    if (action.element_id != null && (!el || !el.isConnected)) return { ok: false, error: "element no longer on page" };
    switch (action.action) {
      case "click":
        el.scrollIntoView({ block: "center" });
        el.focus?.();
        el.click();
        return { ok: true };
      case "type": {
        const real = resolvePlaceholders(action.value);   // placeholder -> real value, on device only
        el.focus?.();
        if (el.tagName === "SELECT") {
          const opt = Array.from(el.options).find((o) => o.value === real || o.text.trim().toLowerCase() === real.trim().toLowerCase())
            || Array.from(el.options).find((o) => o.text.toLowerCase().includes(real.trim().toLowerCase()));
          if (!opt) return { ok: false, error: "no matching option" };
          el.value = opt.value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (el.type === "checkbox" || el.type === "radio") {
          const want = !/^(false|no|0|unchecked)$/i.test(real.trim());
          if (el.checked !== want) el.click();
        } else if (el.isContentEditable) {
          el.innerText = real;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          setNativeValue(el, real);
        }
        el.blur?.();
        return { ok: true };
      }
      case "scroll":
        if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
        else window.scrollBy({ top: (/up/i.test(action.value || "") ? -1 : 1) * innerHeight * 0.8, behavior: "instant" });
        return { ok: true };
      case "highlight":
        return { ok: highlight(action.element_id) };
      default:
        return { ok: false, error: "unsupported action" };
    }
  }

  // ---------------------------------------------------------------- Step 12 change hash
  function changeHash() {
    let h = 0x811c9dc5;
    const mix = (s) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } };
    mix(`${location.href}|${scrollX}|${scrollY}|${innerWidth}x${innerHeight}|`);   // viewport state (SRS v1.1 FR-014-02)
    mix(String(document.body.innerText.length));
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (el.closest("#" + HOST_ID)) continue;
      mix(el.tagName + valueOf(el) + (el.disabled ? "d" : ""));
    }
    return h.toString(16);
  }

  // ---------------------------------------------------------------- messaging
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const reply = (fn) => { try { sendResponse({ ok: true, data: fn() }); } catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); } };
    switch (msg.type) {
      case "ping": reply(() => "pong"); break;
      case "walk": reply(walk); break;
      case "rects": reply(() => rectsForSpans(msg.spans)); break;
      case "maskmap:store": reply(() => storeMaskMap(msg)); break;
      case "validator:run": reply(() => validateForm(msg)); break;
      case "hash": reply(changeHash); break;
      case "execute": reply(() => execute(msg.action)); break;
      case "overlay:hide": reply(() => { const h = document.getElementById(HOST_ID); if (h) h.style.display = msg.hide ? "none" : ""; return true; }); break;
      case "consent":
        requestConsent(msg).then((result) => sendResponse({ ok: true, data: result }));
        return true;   // async
      case "session:end":
        reply(() => { state.maskMap.clear(); state.vault.clear(); state.consent?.cancel(); return true; });
        break;
      default: return false;
    }
    return false;
  });

  addEventListener("pagehide", () => { state.maskMap.clear(); state.vault.clear(); });
})();
