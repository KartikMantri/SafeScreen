// Layer 3a - NER model (SRS FR-003-03): DistilBERT-NER, quantised ONNX, run by
// Transformers.js on WebGPU with WASM fallback. Runs on visible DOM text, on
// form-field values, on the user's prompt and on OCR text from Layer 3b.

import { env, pipeline } from "../../vendor/transformers/transformers.min.js";

export const NER_MODEL = "onnx-community/distilbert-NER-ONNX";
const LABELS = { PER: "NAME", LOC: "LOCATION", ORG: "ORGANIZATION" };
// NER runs on WASM/int8: int8 weights return empty output on WebGPU, and a failed
// WebGPU session leaves the shared ORT WASM runtime unusable for the fallback.
// Text NER is cheap, so WebGPU is kept for the image model (Layer 5).
// The model must still pass a self-test before it is accepted.
const CANDIDATES = { webgpu: [["wasm", "q8"]], wasm: [["wasm", "q8"]] };
const SELF_TEST = "My name is Meera Iyer and I work at the Space Applications Centre.";

let ner = null;
let loading = null;
export const nerInfo = { status: "idle", device: null, error: null };

export async function loadNER(device = "wasm") {
  if (ner) return ner;
  if (loading) return loading;
  env.allowLocalModels = false;
  env.allowRemoteModels = true;          // weights are data, cached by the browser after first run
  env.useBrowserCache = true;
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/transformers/");
  env.backends.onnx.wasm.numThreads = 1; // extension pages are not cross-origin isolated
  nerInfo.status = "loading";
  loading = (async () => {
    for (const [dev, dtype] of CANDIDATES[device] || CANDIDATES.wasm) {
      try {
        const candidate = await pipeline("token-classification", NER_MODEL, { device: dev, dtype });
        const probe = await candidate(SELF_TEST);
        if (!probe.some((t) => t.entity.endsWith("PER"))) {
          nerInfo.error = `${dev}/${dtype} failed self-test`;
          continue;
        }
        ner = candidate;
        nerInfo.status = "ready";
        nerInfo.device = `${dev}/${dtype}`;
        return ner;
      } catch (e) {
        nerInfo.error = String(e?.message || e);
      }
    }
    nerInfo.status = "failed";
    loading = null;
    throw new Error("NER model failed to load: " + nerInfo.error);
  })();
  return loading;
}

// The model is cased; ALL-CAPS text (ID cards, OCR) is title-cased first.
// Title-casing keeps string length, so character offsets stay valid.
function normaliseCase(text) {
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length < 3 || letters !== letters.toUpperCase()) return text;
  return text.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// Transformers.js returns per-token entities without character offsets;
// rebuild entity strings from tokens and locate them in the source text.
function groupTokens(tokens) {
  const groups = [];
  let cur = null;
  for (const t of tokens) {
    const [bio, lab] = t.entity.includes("-") ? t.entity.split("-") : ["I", t.entity];
    const sub = t.word.startsWith("##");
    const word = sub ? t.word.slice(2) : t.word;
    const contiguous = cur && t.index === cur.lastIndex + 1 && cur.label === lab;
    if (cur && contiguous && (sub || bio === "I")) {
      cur.text += sub ? word : " " + word;
      cur.scores.push(t.score);
      cur.lastIndex = t.index;
    } else {
      cur = { label: lab, text: word, scores: [t.score], lastIndex: t.index };
      groups.push(cur);
    }
  }
  return groups.map((g) => ({ label: g.label, text: g.text, score: g.scores.reduce((a, b) => a + b, 0) / g.scores.length }));
}

function locate(text, needle, from) {
  let i = text.indexOf(needle, from);
  if (i >= 0) return [i, i + needle.length];
  i = text.toLowerCase().indexOf(needle.toLowerCase(), from);
  if (i >= 0) return [i, i + needle.length];
  // tokenizer may have dropped spaces around punctuation
  const loose = new RegExp(needle.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"), "i");
  const m = loose.exec(text.slice(from));
  return m ? [from + m.index, from + m.index + m[0].length] : null;
}

// ISRO workspace vocabulary the cased model sometimes tags as a person (e.g. a lone "ISRO")
const NOT_A_NAME = new Set(["isro", "shar", "sdsc", "nrsc", "sac", "vssc", "ursc", "iirs", "lpsc", "istrac",
  "respond", "bhuvan", "pslv", "gslv", "lvm3", "dos", "antrix", "nsil", "in-space"]);
const CHUNK = 1200;
const BATCH = 8;

/**
 * Batched NER. Each text keeps its own context (packing texts together into one
 * string measurably lowers name confidence), but up to BATCH texts share one
 * padded forward pass.
 * @param {string[]} texts
 * @param {{minScore?:number}} [opts]
 * @returns {Promise<Array<Array<{type,start,end,value,score}>>>}
 */
export async function nerSpans(texts, opts = {}) {
  const minScore = opts.minScore ?? 0.8;
  const model = await loadNER();
  const out = texts.map(() => []);

  const items = [];   // {idx, off, text}
  const pending = new Set();
  texts.forEach((raw, idx) => {
    if (!/[A-Za-z]{2,}/.test(raw)) return;
    const hit = cache.get(`${minScore}|${raw}`);
    if (hit) { out[idx] = hit.map((s) => ({ ...s })); return; }   // labels/goal repeat every cycle
    pending.add(idx);
    for (let off = 0; off < raw.length; off += CHUNK) items.push({ idx, off, text: normaliseCase(raw.slice(off, off + CHUNK)) });
  });

  for (let b = 0; b < items.length; b += BATCH) {
    const batch = items.slice(b, b + BATCH);
    const res = await model(batch.map((it) => it.text));   // array input -> one token list per text
    batch.forEach((it, k) => {
      let cursor = 0;
      for (const g of groupTokens(res[k] || [])) {
        const type = LABELS[g.label];
        if (!type || g.score < minScore || g.text.replace(/\W/g, "").length < 2) continue;
        if (type === "NAME" && g.text.toLowerCase().split(/\s+/).every((w) => NOT_A_NAME.has(w))) continue;
        const at = locate(it.text, g.text, cursor);
        if (!at) continue;
        cursor = at[1];
        const start = it.off + at[0], end = it.off + at[1];
        out[it.idx].push({ type, start, end, value: texts[it.idx].slice(start, end), score: g.score });
      }
    });
  }
  for (const idx of pending) {
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    cache.set(`${minScore}|${texts[idx]}`, out[idx]);   // in-memory only, cleared with the panel
  }
  return out;
}

const cache = new Map();
export function clearNERCache() { cache.clear(); }
