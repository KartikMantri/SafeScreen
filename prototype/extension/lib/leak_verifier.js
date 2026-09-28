// Step 6 - Leak Verifier, Safety Gate 1 (SRS FR-007). Fail-closed.
// Re-runs OCR + regex and BlazeFace on the MASKED screenshot, and regex on
// every outgoing text field. Nothing crosses the Privacy Line until clean.

import { findPII } from "./pii_regex.js";
import { ocrCanvas, spanBox, labelledNameLines, capsNameLines, dropWordsInside } from "./detectors/ocr.js";
import { detectFaces } from "./detectors/face.js";

/**
 * @param {HTMLCanvasElement|null} masked  null in strict mode (no image sent)
 * @param {Record<string,string>} textFields outgoing text, keyed by field name
 * @param {{customRules?:Array}} cfg
 * @param {(texts:string[]) => Promise<Array<Array<{type,start,end}>>>} [nameCheck]
 *        NER over outgoing text - defence in depth so a missed name in the
 *        goal or a label cannot cross the Privacy Line
 * @returns {Promise<{clean:boolean, imageFindings:Array, textFindings:Array}>}
 */
export async function verifyLeaks(masked, textFields, cfg = {}, nameCheck = null, mediaBoxes = [], maskBoxes = []) {
  const imageFindings = [];
  const textFindings = [];

  const entries = Object.entries(textFields);
  for (const [field, text] of entries) {
    for (const hit of findPII(text, { customRules: cfg.customRules })) {
      textFindings.push({ field, type: hit.type, start: hit.start, end: hit.end });
    }
  }
  if (nameCheck) {
    const spans = await nameCheck(entries.map(([, t]) => t));   // throws -> caller fails closed
    entries.forEach(([field], i) => {
      for (const s of spans[i]) {
        if (s.type === "NAME" && !textFindings.some((f) => f.field === field && s.start < f.end && f.start < s.end)) {
          textFindings.push({ field, type: "NAME", start: s.start, end: s.end });
        }
      }
    });
  }

  if (masked) {
    // Mask integrity: every mask must really be opaque fill (+ white label text).
    // A transparent / missing mask is itself a leak (AC-04).
    const intact = [];
    const ctx = masked.getContext("2d", { willReadFrequently: true });
    for (const m of maskBoxes) {
      // sample only the part of the mask that lies on the canvas
      const x0 = Math.max(0, Math.floor(m.x)), y0 = Math.max(0, Math.floor(m.y));
      const x1 = Math.min(masked.width, Math.ceil(m.x + m.w)), y1 = Math.min(masked.height, Math.ceil(m.y + m.h));
      if (x1 - x0 < 2 || y1 - y0 < 2) continue;
      const px = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let dark = 0, labelish = 0, total = 0;
      for (let i = 0; i < px.length; i += 4 * 7) {
        total++;
        const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
        if (Math.abs(r - 26) < 6 && Math.abs(g - 29) < 6 && Math.abs(b - 33) < 6) dark++;
        else if (Math.abs(r - g) < 14 && Math.abs(g - b) < 14) labelish++;   // white / anti-aliased label text
      }
      // mostly mask colour, and everything else neutral grey/white (the label)
      if (dark / total >= 0.5 && (dark + labelish) / total >= 0.98) intact.push(m);
      else imageFindings.push({ type: "MASK_INTEGRITY", box: m, source: "G1-MASK" });
    }
    const [rawLines, faces] = await Promise.all([ocrCanvas(masked), detectFaces(masked)]);
    const lines = dropWordsInside(rawLines, intact);   // text inside intact masks is our own burned-in label
    // is this OCR line inside an image region (ID card, photo)?
    const inMedia = (line) => {
      const b = spanBox(line, 0, line.text.length);
      if (!b) return false;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      return mediaBoxes.some((m) => cx >= m.x && cx <= m.x + m.w && cy >= m.y && cy <= m.y + m.h);
    };
    for (const line of lines) {
      // lenient: checksums skipped - a near-miss number is still a leak
      for (const hit of findPII(line.text, { lenient: true, idImage: inMedia(line), customRules: cfg.customRules })) {
        const box = spanBox(line, hit.start, hit.end);
        if (box) imageFindings.push({ type: hit.type, box, source: "G1-OCR" });
      }
    }
    // all-caps names on ID-card images
    for (const kv of capsNameLines(lines)) {
      if (!inMedia(lines[kv.line])) continue;
      const box = spanBox(lines[kv.line], 0, lines[kv.line].text.length);
      if (box) imageFindings.push({ type: kv.type, box, source: "G1-OCR-CAPS" });
    }
    // readable names in the masked image: key-value rule + NER on OCR text
    for (const kv of labelledNameLines(lines)) {
      const box = spanBox(lines[kv.line], 0, lines[kv.line].text.length);
      if (box) imageFindings.push({ type: kv.type, box, source: "G1-OCR" });
    }
    // NER only on lines that look like they contain a name (two capitalised words)
    const candidates = lines
      .map((l, i) => ({ i, text: l.text.replace(/\[[A-Z_]+\]?/g, (m) => " ".repeat(m.length)) }))
      .filter((c) => /\b[A-Z][a-z]+\s+[A-Z][a-z]+|\b[A-Z]{3,}\s+[A-Z]{3,}/.test(c.text));
    if (nameCheck && candidates.length) {
      const spans = await nameCheck(candidates.map((c) => c.text));
      candidates.forEach((c, k) => {
        for (const s of spans[k]) {
          if (s.type !== "NAME") continue;
          const box = spanBox(lines[c.i], s.start, s.end);
          if (box) imageFindings.push({ type: "NAME", box, source: "G1-OCR-NER", text: s.value });
        }
      });
    }
    // A detection sitting mostly on intact masks is BlazeFace firing on our own
    // black boxes - the face pixels are already hidden. Faces on real pixels still block.
    for (const f of faces) {
      if (maskedFraction(f, intact) >= 0.5) continue;
      imageFindings.push({ type: "FACE", box: f, source: "G1-FACE" });
    }
  }
  return { clean: !imageFindings.length && !textFindings.length, imageFindings, textFindings };
}

/** Share of box `b` covered by the union of `masks` (sampled on a 12x12 grid). */
export function maskedFraction(b, masks) {
  let hit = 0;
  const N = 12;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = b.x + ((i + 0.5) / N) * b.w, y = b.y + ((j + 0.5) / N) * b.h;
      if (masks.some((m) => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h)) hit++;
    }
  }
  return hit / (N * N);
}

/** Redact findings from text fields in place (used before the second verifier pass). */
export function redactText(textFields, findings) {
  const out = { ...textFields };
  const byField = {};
  for (const f of findings) (byField[f.field] ||= []).push(f);
  for (const [field, fs] of Object.entries(byField)) {
    let s = out[field];
    for (const f of fs.sort((a, b) => b.start - a.start)) s = s.slice(0, f.start) + `[${f.type}]` + s.slice(f.end);
    out[field] = s;
  }
  return out;
}
