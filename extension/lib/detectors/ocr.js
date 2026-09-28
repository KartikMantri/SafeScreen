// Layer 3b - OCR engine (SRS FR-003-04). Tesseract.js (WASM, LSTM) shipped
// inside the extension. Runs on screenshot crops of <img>/<canvas>/<video>,
// and on the whole masked screenshot inside the Leak Verifier.

import Tesseract from "../../vendor/tesseract/tesseract.esm.min.js";

let worker = null;
let loading = null;
export const ocrInfo = { status: "idle", error: null };

export async function loadOCR() {
  if (worker) return worker;
  if (loading) return loading;
  ocrInfo.status = "loading";
  loading = (async () => {
    try {
      worker = await Tesseract.createWorker("eng", 1, {
        workerPath: chrome.runtime.getURL("vendor/tesseract/worker.min.js"),
        corePath: chrome.runtime.getURL("vendor/tesseract-core/"),
        langPath: chrome.runtime.getURL("models/"),
        gzip: true,
        workerBlobURL: false,
        cacheMethod: "none",
      });
      ocrInfo.status = "ready";
      return worker;
    } catch (e) {
      ocrInfo.status = "failed";
      ocrInfo.error = String(e?.message || e);
      throw e;
    }
  })();
  return loading;
}

/**
 * OCR a canvas. Returns lines with per-word character offsets so regex/NER
 * spans on the line text can be mapped back to pixel boxes.
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {number} [scale] canvas was upscaled by this factor; boxes are divided back
 */
export async function ocrCanvas(canvas, scale = 1) {
  const w = await loadOCR();
  const { data } = await w.recognize(canvas);
  const lines = [];
  for (const line of data.lines || []) {
    let text = "";
    const words = [];
    for (const word of line.words || []) {
      if (!word.text.trim()) continue;
      if (text) text += " ";
      const start = text.length;
      text += word.text;
      const b = word.bbox;
      words.push({ start, end: text.length, box: { x: b.x0 / scale, y: b.y0 / scale, w: (b.x1 - b.x0) / scale, h: (b.y1 - b.y0) / scale } });
    }
    if (text) lines.push({ text, words });
  }
  return lines;
}

const MASK_LABEL = /\[[A-Z_]{2,}\]?/;

/**
 * Key-value rule for ID cards and forms: the line directly under a "Name" /
 * "Father's Name" label holds that value. Deterministic, so it still works when
 * OCR noise ("MEERA IYER Oo yin Ix") leaves NER without enough context.
 * @returns {Array<{line:number, type:string}>}
 */
export function labelledNameLines(lines) {
  const found = [];
  for (let i = 1; i < lines.length; i++) {
    const label = lines[i - 1].text.trim().toLowerCase();
    const value = lines[i].text.trim();
    if (MASK_LABEL.test(value) || (value.match(/[A-Za-z]{2,}/g) || []).length < 2) continue;
    // the label line must be a bare label, not a row that already holds a (masked) value
    if (MASK_LABEL.test(lines[i - 1].text) || label.split(/\s+/).length > 6) continue;
    if (/^(father'?s?|husband'?s?)\s*name/.test(label)) found.push({ line: i, type: "FATHERS_NAME" });
    else if (/^(full\s+)?name\b|नाम/.test(label)) found.push({ line: i, type: "NAME" });
  }
  return found;
}

const CARD_HEADERS = /\b(INCOME|TAX|DEPARTMENT|GOVT|GOVERNMENT|INDIA|PERMANENT|ACCOUNT|NUMBER|CARD|UNIQUE|IDENTIFICATION|AUTHORITY|REPUBLIC|ELECTION|COMMISSION|DRIVING|LICEN[CS]E|PASSPORT|SPECIMEN|SYNTHETIC|VALID|DOCUMENT|FEMALE|MALE|SIGNATURE)\b/g;

/**
 * On ID-card images, a line of two or more ALL-CAPS words (after dropping known
 * card headers and OCR junk) is a person's name. Used for image regions only,
 * where small field labels are too blurry for OCR to read reliably.
 * @returns {Array<{line:number, type:string}>}
 */
export function capsNameLines(lines) {
  const found = [];
  lines.forEach((l, i) => {
    if (MASK_LABEL.test(l.text)) return;
    const words = l.text.replace(CARD_HEADERS, " ").match(/\b[A-Z]{3,}\b/g) || [];
    if (words.length >= 2) found.push({ line: i, type: "NAME" });
  });
  return found;
}

/**
 * Drop OCR words whose centre lies inside one of `boxes` (our own masks - OCR
 * reads the burned-in labels imperfectly, e.g. "[PAN_NO]" -> "PAN NOT [pre").
 * Rebuilds line text and offsets from the remaining words.
 */
export function dropWordsInside(lines, boxes) {
  const inside = (b) => {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    return boxes.some((m) => cx >= m.x && cx <= m.x + m.w && cy >= m.y && cy <= m.y + m.h);
  };
  const out = [];
  for (const line of lines) {
    let text = "";
    const words = [];
    for (const w of line.words) {
      if (inside(w.box)) continue;
      const src = line.text.slice(w.start, w.end);
      if (text) text += " ";
      const start = text.length;
      text += src;
      words.push({ start, end: text.length, box: w.box });
    }
    if (text) out.push({ text, words });
  }
  return out;
}

/** Union of word boxes covered by [start,end) of a line. */
export function spanBox(line, start, end) {
  const ws = line.words.filter((w) => w.start < end && start < w.end);
  if (!ws.length) return null;
  const x0 = Math.min(...ws.map((w) => w.box.x)), y0 = Math.min(...ws.map((w) => w.box.y));
  const x1 = Math.max(...ws.map((w) => w.box.x + w.box.w)), y1 = Math.max(...ws.map((w) => w.box.y + w.box.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
