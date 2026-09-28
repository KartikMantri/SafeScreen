// Layer 1 - DOM structural analysis (SRS FR-003-01). Pure module.
// Input: the element list produced by the content-script DOM walk (Step 2).

const CARD_AUTOCOMPLETE = new Set(["cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-name"]);

function tokens(s) {
  return String(s || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Classify one element. Returns {maskType, sensitive} or null. */
export function classifyElement(el) {
  const ac = (el.autocomplete || "").toLowerCase();
  const t = new Set([...tokens(el.name), ...tokens(el.idAttr)]);
  const has = (...w) => w.some((x) => t.has(x));
  const starts = (p) => [...t].some((x) => x.startsWith(p));

  if (el.type === "password") return { maskType: "PASSWORD", sensitive: "password" };
  if (CARD_AUTOCOMPLETE.has(ac) || has("cvv", "cvc", "ccnumber", "cardnumber")) return { maskType: "CREDIT_CARD", sensitive: "payment" };
  if (ac === "one-time-code" || has("otp") || starts("otp")) return { maskType: "OTP", sensitive: null };
  if (has("pan", "panno", "pannumber", "pancard")) return { maskType: "PAN_NO", sensitive: null };
  if (starts("aadhaar") || starts("aadhar") || has("uid", "uidai")) return { maskType: "AADHAAR", sensitive: null };
  if (starts("passport")) return { maskType: "ID_DOCUMENT", sensitive: null };
  if (has("pin", "mpin", "upipin")) return { maskType: "OTP", sensitive: "password" };
  if (has("ssn")) return { maskType: "GENERIC_PII", sensitive: null };
  if (has("ifsc")) return { maskType: "IFSC", sensitive: null };
  if ((has("account", "acct") && has("no", "number", "num")) || has("accountno", "accountnumber")) return { maskType: "BANK_ACCOUNT", sensitive: null };
  if (el.type === "file") return { maskType: "FILE_UPLOAD", sensitive: null };
  return null;
}

/**
 * @param {Array} elements DOM walk elements (rects already in screenshot px)
 * @returns {{boxes:Array, flags:Map<number,{maskType,sensitive}>}}
 */
export function domLayer(elements) {
  const boxes = [];
  const flags = new Map();
  for (const el of elements) {
    const c = classifyElement(el);
    if (!c) continue;
    flags.set(el.id, c);
    const r = el.box;
    if (r && r.w > 0 && r.h > 0) boxes.push({ ...r, type: c.maskType, source: "L1-DOM", elementId: el.id });
  }
  return { boxes, flags };
}
