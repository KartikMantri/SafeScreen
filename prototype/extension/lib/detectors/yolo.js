// Layer 5 - Region detector (SRS FR-003-06): YOLO-nano fine-tuned on synthetic
// PAN/Aadhaar cards (tools/gen_cards.py + tools/train_yolo.py), exported to
// ONNX and run with ONNX Runtime Web (WebGPU primary, WASM fallback).

import * as ort from "../../vendor/ort/ort.webgpu.min.mjs";

// Must match CLASSES in tools/gen_cards.py
export const CLASSES = [
  "PAN_NUMBER", "NAME", "FATHERS_NAME", "DOB", "PHOTO", "SIGNATURE", "QR_CODE",
  "AADHAAR_CARD", "DRIVING_LICENSE", "PASSPORT", "CREDIT_CARD", "DEBIT_CARD", "AADHAAR_NUMBER",
];
const TO_MASK_TYPE = {
  PAN_NUMBER: "PAN_NO", PHOTO: "FACE", AADHAAR_NUMBER: "AADHAAR",
  AADHAAR_CARD: "ID_DOCUMENT", DRIVING_LICENSE: "ID_DOCUMENT", PASSPORT: "ID_DOCUMENT",
  CREDIT_CARD: "CREDIT_CARD", DEBIT_CARD: "CREDIT_CARD",
};
const SIZE = 640;
const MODEL_URL = () => chrome.runtime.getURL("models/yolo_idcard.onnx");

let session = null;
let loading = null;
export const yoloInfo = { status: "idle", ep: null, error: null };

export async function loadYOLO(device) {
  if (session) return session;
  if (loading) return loading;
  yoloInfo.status = "loading";
  loading = (async () => {
    const head = await fetch(MODEL_URL()).catch(() => null);
    if (!head || !head.ok) {
      yoloInfo.status = "not-trained";
      yoloInfo.error = "models/yolo_idcard.onnx missing - run tools/train_yolo.py";
      return null;
    }
    const bytes = new Uint8Array(await head.arrayBuffer());
    ort.env.wasm.wasmPaths = chrome.runtime.getURL("vendor/ort/");
    ort.env.wasm.numThreads = 1;
    for (const ep of device === "webgpu" ? ["webgpu", "wasm"] : ["wasm"]) {
      try {
        session = await ort.InferenceSession.create(bytes, { executionProviders: [ep] });
        yoloInfo.status = "ready";
        yoloInfo.ep = ep;
        return session;
      } catch (e) {
        yoloInfo.error = String(e?.message || e);
      }
    }
    yoloInfo.status = "failed";
    return null;
  })();
  return loading;
}

function nms(dets, thr = 0.45) {
  dets.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const d of dets) {
    if (keep.every((k) => k.cls !== d.cls || iou(k, d) < thr)) keep.push(d);
  }
  return keep;
}
function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / (a.w * a.h + b.w * b.h - i || 1);
}

/**
 * @param {HTMLCanvasElement} canvas crop of an image region
 * @returns {Promise<Array<{x,y,w,h,type,cls,score}>>} canvas pixel coords
 */
export async function detectRegions(canvas, minScore = 0.5) {
  const s = await loadYOLO();
  if (!s) return [];
  // letterbox into 640x640
  const r = Math.min(SIZE / canvas.width, SIZE / canvas.height);
  const nw = Math.round(canvas.width * r), nh = Math.round(canvas.height * r);
  const px = (SIZE - nw) / 2, py = (SIZE - nh) / 2;
  const lb = new OffscreenCanvas(SIZE, SIZE);
  const ctx = lb.getContext("2d");
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(canvas, px, py, nw, nh);
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
  const input = new Float32Array(3 * SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    input[i] = data[i * 4] / 255;
    input[i + SIZE * SIZE] = data[i * 4 + 1] / 255;
    input[i + 2 * SIZE * SIZE] = data[i * 4 + 2] / 255;
  }
  const feeds = { [s.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, SIZE, SIZE]) };
  const out = (await s.run(feeds))[s.outputNames[0]];
  const [, ch, n] = out.dims;            // [1, 4 + nc, N]
  const nc = ch - 4;
  const o = out.data;
  const dets = [];
  for (let i = 0; i < n; i++) {
    let best = 0, cls = -1;
    for (let c = 0; c < nc; c++) {
      const v = o[(4 + c) * n + i];
      if (v > best) { best = v; cls = c; }
    }
    if (best < minScore) continue;
    const cx = o[i], cy = o[n + i], w = o[2 * n + i], h = o[3 * n + i];
    dets.push({ x: (cx - w / 2 - px) / r, y: (cy - h / 2 - py) / r, w: w / r, h: h / r, score: best, cls });
  }
  return nms(dets).map((d) => {
    const name = CLASSES[d.cls] || "GENERIC_PII";
    return { ...d, type: TO_MASK_TYPE[name] || name, className: name };
  });
}
