// Layer 2 - Regex + Checksum engine (SRS FR-003-02). Pure module: runs in the
// side panel and in Node tests. Also used by Step 1 (prompt PII check) and by
// the Leak Verifier (Safety Gate 1) on OCR text of the masked screenshot.

const V_D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const V_P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];

export function verhoeffValid(digits) {
  let c = 0;
  const s = String(digits).replace(/\D/g, "");
  for (let i = 0; i < s.length; i++) c = V_D[c][V_P[i % 8][+s[s.length - 1 - i]]];
  return c === 0;
}

export function luhnValid(digits) {
  const s = String(digits).replace(/\D/g, "");
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let d = +s[s.length - 1 - i];
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return s.length > 0 && sum % 10 === 0;
}

// Higher number wins when two matches overlap.
const PRIORITY = {
  CREDIT_CARD: 9, AADHAAR: 8, PAN_NO: 8, BANK_ACCOUNT: 7, IFSC: 7, EMAIL: 7,
  EMPLOYEE_ID: 6, PHONE: 5, DOB: 4, OTP: 3,
};

const OTP_CONTEXT = /\b(otp|one[\s-]?time|verification code|passcode|security code)\b/i;
const DOB_CONTEXT = /\b(dob|date of birth|birth)\b/i;
const ACCOUNT_CONTEXT = /\b(a\/c|account|acct)\b/i;

function near(text, start, end, re, span = 40) {
  return re.test(text.slice(Math.max(0, start - span), Math.min(text.length, end + span)));
}

/**
 * Find PII in a string.
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.otpField]  text is the value of an OTP-flagged field
 * @param {boolean} [opts.lenient]   Leak Verifier mode: skip checksums (fail-closed)
 * @param {boolean} [opts.idImage]   text was OCR'd from an image region (ID card)
 * @param {Array<{type:string, pattern:string, flags?:string}>} [opts.customRules]
 * @returns {Array<{type:string,start:number,end:number,value:string}>}
 */
export function findPII(text, opts = {}) {
  if (!text) return [];
  const hits = [];
  const add = (type, m, start = m.index, value = m[0]) =>
    hits.push({ type, start, end: start + value.length, value });
  const scan = (re, fn) => { re.lastIndex = 0; let m; while ((m = re.exec(text))) fn(m); };

  scan(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, (m) => add("PAN_NO", m));
  scan(/(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g, (m) => {
    if (opts.lenient || verhoeffValid(m[0])) add("AADHAAR", m);
  });
  scan(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, (m) => {
    const n = m[0].replace(/\D/g, "");
    if (n.length >= 13 && n.length <= 19 && (opts.lenient || luhnValid(n))) add("CREDIT_CARD", m);
  });
  scan(/(?<![\w+])(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, (m) => add("PHONE", m));
  scan(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (m) => add("EMAIL", m));
  scan(/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, (m) => add("IFSC", m));
  scan(/(?<!\d)\d{9,18}(?!\d)/g, (m) => {
    if (near(text, m.index, m.index + m[0].length, ACCOUNT_CONTEXT)) add("BANK_ACCOUNT", m);
  });
  scan(/\b\d{2}[\/.-]\d{2}[\/.-]\d{4}\b/g, (m) => {
    // on ID-card images every date is treated as DOB (labels are often unreadable)
    if (opts.idImage || near(text, m.index, m.index + m[0].length, DOB_CONTEXT, 30)) add("DOB", m);
  });
  // OTP: only inside an OTP field or next to an OTP keyword (SRS v1.1 FR-003-02-01)
  scan(/(?<![\d.,₹$])\d{4,8}(?![\d.,])/g, (m) => {
    if (opts.otpField || near(text, m.index, m.index + m[0].length, OTP_CONTEXT)) add("OTP", m);
  });
  for (const rule of opts.customRules || []) {
    try { scan(new RegExp(rule.pattern, (rule.flags || "") + "g"), (m) => add(rule.type, m)); } catch { /* bad rule */ }
  }

  // Resolve overlaps: keep higher priority, then longer match.
  hits.sort((a, b) => (PRIORITY[b.type] ?? 5) - (PRIORITY[a.type] ?? 5) || (b.end - b.start) - (a.end - a.start));
  const kept = [];
  for (const h of hits) if (!kept.some((k) => h.start < k.end && k.start < h.end)) kept.push(h);
  return kept.sort((a, b) => a.start - b.start);
}

// Step 1 placeholder names. Type label -> token stem.
export const TOKEN_STEM = {
  PAN_NO: "USER_PAN", AADHAAR: "USER_AADHAAR", PHONE: "USER_PHONE", EMAIL: "USER_EMAIL",
  CREDIT_CARD: "USER_CARD", OTP: "USER_OTP", IFSC: "USER_IFSC", BANK_ACCOUNT: "USER_ACCOUNT",
  DOB: "USER_DOB", NAME: "USER_NAME", EMPLOYEE_ID: "USER_EMPLOYEE_ID",
};

export function tokenType(token) {
  const stem = token.replace(/^\{\{|\}\}$/g, "").replace(/_\d+$/, "");
  return Object.keys(TOKEN_STEM).find((t) => TOKEN_STEM[t] === stem) || null;
}

/**
 * Replace PII spans in `text` with typed placeholders.
 * @param {string} text
 * @param {Array<{type,start,end,value}>} spans non-overlapping
 * @returns {{sanitized:string, tokens:Array<{token,type,value}>}}
 */
export function applyPlaceholders(text, spans) {
  const counts = {};
  const tokens = [];
  let out = "";
  let cursor = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const stem = TOKEN_STEM[s.type] || "USER_PII";
    const existing = tokens.find((t) => t.value === s.value && t.type === s.type);
    let token = existing?.token;
    if (!token) {
      counts[stem] = (counts[stem] || 0) + 1;
      token = `{{${stem}${counts[stem] > 1 ? "_" + counts[stem] : ""}}}`;
      tokens.push({ token, type: s.type, value: s.value });
    }
    out += text.slice(cursor, s.start) + token;
    cursor = s.end;
  }
  return { sanitized: out + text.slice(cursor), tokens };
}
