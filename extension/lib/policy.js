// Step 9 - Policy Check, Safety Gate 2 (SRS FR-011). Pure module.
// Enforced locally: nothing in the VLM response can widen these rules (FR-011-03a).

import { tokenType } from "./pii_regex.js";

export const DEFAULT_ALLOW_LIST = ["click", "type", "scroll", "highlight", "explain", "done"];
export const LOW_RISK = new Set(["scroll", "highlight"]);
const PLACEHOLDER_ONLY = /^\{\{[A-Z_]+(?:_\d+)?\}\}$/;

/** FR-010-02 schema check. Returns list of problems (empty = valid). */
export function validateSchema(a) {
  const errs = [];
  if (!a || typeof a !== "object") return ["response is not an object"];
  if (typeof a.action !== "string") errs.push("action missing");
  if (a.element_id != null && !Number.isInteger(a.element_id)) errs.push("element_id must be integer or null");
  if (a.value != null && typeof a.value !== "string") errs.push("value must be string or null");
  if (typeof a.explanation !== "string") errs.push("explanation missing");
  if (typeof a.confidence !== "number" || a.confidence < 0 || a.confidence > 1) errs.push("confidence must be 0..1");
  const needsTarget = ["click", "type", "highlight"].includes(a.action);
  if (needsTarget && a.element_id == null) errs.push(`${a.action} requires element_id`);
  if (a.action === "type" && (a.value == null || a.value === "")) errs.push("type requires value");
  return errs;
}

/**
 * @param {object} action VLM JSON action
 * @param {object} ctx
 * @param {Map<number,object>} ctx.elements id -> {tag,type,label,maskType,sensitive,isSubmit}
 * @param {Set<string>} ctx.tokens placeholder tokens that exist in the Local Mask Map
 * @param {string[]} [ctx.allowList]
 * @returns {{verdict:'reject'|'auto'|'consent'|'finish', reasons:string[]}}
 */
export function checkPolicy(action, ctx) {
  const reasons = validateSchema(action);
  if (reasons.length) return { verdict: "reject", reasons };

  const allow = ctx.allowList || DEFAULT_ALLOW_LIST;
  if (!allow.includes(action.action)) return { verdict: "reject", reasons: [`action "${action.action}" not in allow-list`] };
  if (action.action === "done" || action.action === "explain") return { verdict: "finish", reasons: [] };

  // scroll may target the page (null) or an element
  const el = action.element_id != null ? ctx.elements.get(action.element_id) : null;
  if (action.element_id != null && !el) {
    return { verdict: "reject", reasons: [`element #${action.element_id} is not in the numbered element map`] };
  }

  const value = action.value ?? "";
  const tokensInValue = value.match(/\{\{[A-Z_]+(?:_\d+)?\}\}/g) || [];
  const unknown = tokensInValue.filter((t) => !ctx.tokens.has(t));
  if (unknown.length) return { verdict: "reject", reasons: [`unknown placeholder(s): ${unknown.join(", ")}`] };

  const protectedEl = el && (el.maskType || el.sensitive);
  if (protectedEl && !LOW_RISK.has(action.action)) {
    // Only exception: type exactly one placeholder of the matching type (SRS v1.1 FR-011-03)
    const isPlaceholder = action.action === "type" && PLACEHOLDER_ONLY.test(value.trim());
    const fieldType = el.maskType || el.fieldType;
    const tType = isPlaceholder ? tokenType(value.trim()) : null;
    if (!isPlaceholder) {
      return { verdict: "reject", reasons: [`element #${el.id} is protected (${el.maskType || el.sensitive}); only a matching placeholder may be typed`] };
    }
    if (el.sensitive === "password" || el.sensitive === "payment") {
      return { verdict: "reject", reasons: [`element #${el.id} is a ${el.sensitive} field - agent may never fill it`] };
    }
    if (fieldType && tType && fieldType !== tType) {
      return { verdict: "reject", reasons: [`placeholder type ${tType} does not match field type ${fieldType}`] };
    }
    return { verdict: "consent", reasons: ["placeholder into protected field"] };
  }

  if (LOW_RISK.has(action.action)) {
    if (action.confidence < 0.6) return { verdict: "consent", reasons: ["low confidence"] };
    return { verdict: "auto", reasons: [] };
  }
  // click / type are state-changing -> Consent + Change Guard (FR-011-04/05)
  return { verdict: "consent", reasons: [el?.isSubmit ? "submission" : "state-changing action"] };
}
