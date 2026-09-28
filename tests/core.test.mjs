import { test } from "node:test";
import assert from "node:assert/strict";
import { findPII, verhoeffValid, luhnValid, applyPlaceholders, tokenType } from "../extension/lib/pii_regex.js";
import { mergeBoxes, iou } from "../extension/lib/merge.js";
import { checkPolicy } from "../extension/lib/policy.js";
import { classifyElement, domLayer } from "../extension/lib/detectors/dom_layer.js";
import { isWorkspaceUrl, DEFAULTS } from "../extension/lib/config.js";

const types = (s, o) => findPII(s, o).map((h) => h.type);

test("checksums", () => {
  assert.ok(verhoeffValid("872133201214"));      // synthetic Aadhaar from gen_cards.py
  assert.ok(!verhoeffValid("872133201215"));
  assert.ok(luhnValid("4111 1111 1111 1111"));
  assert.ok(!luhnValid("4111 1111 1111 1112"));
});

test("Layer 2 finds Indian PII", () => {
  assert.deepEqual(types("PAN BQJPI4821K"), ["PAN_NO"]);
  assert.deepEqual(types("Aadhaar 8721 3320 1214"), ["AADHAAR"]);
  assert.deepEqual(types("Aadhaar 8721 3320 1215"), []);                  // fails Verhoeff
  assert.deepEqual(types("call 9812345670 now"), ["PHONE"]);
  assert.deepEqual(types("call +91 98123 45670"), ["PHONE"]);
  assert.deepEqual(types("mail meera.iyer@example.in"), ["EMAIL"]);
  assert.deepEqual(types("card 4111 1111 1111 1111"), ["CREDIT_CARD"]);
  assert.deepEqual(types("IFSC SBIN0001234"), ["IFSC"]);
  assert.deepEqual(types("account number 50100234567812"), ["BANK_ACCOUNT"]);
  assert.deepEqual(types("Date of Birth 14/08/1996"), ["DOB"]);
});

test("OTP only with context, bare numbers are not masked", () => {
  assert.deepEqual(types("Your OTP is 482913"), ["OTP"]);
  assert.deepEqual(types("Launch in 2027, budget 3850"), []);
  assert.deepEqual(types("482913", { otpField: true }), ["OTP"]);
});

test("lenient mode (Leak Verifier) skips checksums", () => {
  assert.deepEqual(types("8721 3320 1215", { lenient: true }), ["AADHAAR"]);
});

test("custom ISRO employee id rule", () => {
  assert.deepEqual(types("ID ISRO-SAC-20417", { customRules: DEFAULTS.customRules }), ["EMPLOYEE_ID"]);
});

test("Step 1 placeholders", () => {
  const goal = "My PAN is BQJPI4821K and mobile 9812345670";
  const { sanitized, tokens } = applyPlaceholders(goal, findPII(goal));
  assert.equal(sanitized, "My PAN is {{USER_PAN}} and mobile {{USER_PHONE}}");
  assert.equal(tokens.length, 2);
  assert.equal(tokenType("{{USER_PAN}}"), "PAN_NO");
  assert.equal(tokenType("{{USER_PHONE_2}}"), "PHONE");
});

test("Step 4 merge: IoU union, most specific label, 8px dilation", () => {
  const a = { x: 100, y: 100, w: 100, h: 20, type: "GENERIC_PII", source: "L3a" };
  const b = { x: 110, y: 100, w: 100, h: 20, type: "PAN_NO", source: "L2" };
  const c = { x: 500, y: 500, w: 10, h: 10, type: "FACE", source: "L4" };
  assert.ok(iou(a, b) > 0.3);
  const m = mergeBoxes([a, b, c], { width: 1000, height: 1000 });
  assert.equal(m.length, 2);
  const pan = m.find((x) => x.type === "PAN_NO");
  assert.deepEqual([pan.x, pan.y, pan.w, pan.h], [92, 92, 126, 36]);
  assert.deepEqual(pan.sources.sort(), ["L2", "L3a"]);
});

test("Step 4 merge drops boxes outside the screenshot (no negative sizes)", () => {
  const bounds = { width: 1000, height: 600 };
  const m = mergeBoxes([
    { x: 100, y: 900, w: 50, h: 20, type: "NAME", source: "L2" },     // below the viewport
    { x: 100, y: -80, w: 50, h: 20, type: "NAME", source: "L2" },     // above the viewport
    { x: 990, y: 590, w: 50, h: 50, type: "FACE", source: "L4" },     // partly visible -> clamped
  ], bounds);
  assert.equal(m.length, 1);
  assert.ok(m[0].w > 0 && m[0].h > 0 && m[0].x + m[0].w <= 1000 && m[0].y + m[0].h <= 600);
});

test("Layer 1 DOM rules", () => {
  assert.equal(classifyElement({ type: "password" }).maskType, "PASSWORD");
  assert.equal(classifyElement({ name: "pan_number" }).maskType, "PAN_NO");
  assert.equal(classifyElement({ name: "company" }), null);                 // "pan" inside a word is not PAN
  assert.equal(classifyElement({ idAttr: "applicantPAN" }).maskType, "PAN_NO");
  assert.equal(classifyElement({ autocomplete: "one-time-code" }).maskType, "OTP");
  assert.equal(classifyElement({ autocomplete: "cc-number" }).sensitive, "payment");
  assert.equal(classifyElement({ name: "account_number" }).maskType, "BANK_ACCOUNT");
  const { boxes } = domLayer([{ id: 3, type: "password", box: { x: 1, y: 2, w: 3, h: 4 } }]);
  assert.equal(boxes[0].elementId, 3);
});

test("Gate 2 policy", () => {
  const elements = new Map([
    [1, { id: 1, tag: "input", maskType: "PAN_NO" }],
    [2, { id: 2, tag: "input", maskType: "PASSWORD", sensitive: "password" }],
    [3, { id: 3, tag: "button", isSubmit: true }],
    [4, { id: 4, tag: "input" }],
  ]);
  const tokens = new Set(["{{USER_PAN}}", "{{USER_PHONE}}"]);
  const P = (a) => checkPolicy({ explanation: "x", confidence: 0.9, element_id: null, value: null, ...a }, { elements, tokens });
  assert.equal(P({ action: "type", element_id: 1, value: "{{USER_PAN}}" }).verdict, "consent");
  assert.equal(P({ action: "type", element_id: 1, value: "{{USER_PHONE}}" }).verdict, "reject");   // type mismatch
  assert.equal(P({ action: "type", element_id: 1, value: "ABCDE1234F" }).verdict, "reject");       // literal into masked field
  assert.equal(P({ action: "type", element_id: 2, value: "{{USER_PAN}}" }).verdict, "reject");     // password never
  assert.equal(P({ action: "type", element_id: 4, value: "{{USER_AADHAAR}}" }).verdict, "reject"); // unknown token
  assert.equal(P({ action: "click", element_id: 3 }).verdict, "consent");
  assert.equal(P({ action: "click", element_id: 99 }).verdict, "reject");                          // not in element map
  assert.equal(P({ action: "scroll", element_id: null, value: "down" }).verdict, "auto");
  assert.equal(P({ action: "scroll", element_id: null, value: "down", confidence: 0.4 }).verdict, "consent");
  assert.equal(P({ action: "delete_account", element_id: 3 }).verdict, "reject");                  // not allow-listed
  assert.equal(P({ action: "done" }).verdict, "finish");
  assert.equal(P({ action: "click", element_id: 3, confidence: 7 }).verdict, "reject");            // schema
});

test("ISRO workspace allow-list", () => {
  const o = DEFAULTS.workspaceOrigins;
  assert.ok(isWorkspaceUrl("http://localhost:8000/portal/lvg.html", o));
  assert.ok(isWorkspaceUrl("https://www.isro.gov.in/", o));
  assert.ok(isWorkspaceUrl("https://bhuvan.nrsc.gov.in/home", o));
  assert.ok(!isWorkspaceUrl("https://isro.gov.in.evil.com/", o));
  assert.ok(!isWorkspaceUrl("http://www.isro.gov.in/", o));              // https only
  assert.ok(!isWorkspaceUrl("https://example.com/", o));
});
