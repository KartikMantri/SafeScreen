// Copies the on-device ML runtimes from node_modules into extension/vendor.
// MV3 forbids remotely hosted code, so every script and .wasm the extension
// executes must ship inside the extension package.
import { cpSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const out = join(root, "extension", "vendor");

const files = [
  // Transformers.js (NER, Layer 3a) + the ONNX Runtime build it was compiled against
  ["@huggingface/transformers/dist/transformers.min.js", "transformers/transformers.min.js"],
  ["@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs", "transformers/ort-wasm-simd-threaded.jsep.mjs"],
  ["@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm", "transformers/ort-wasm-simd-threaded.jsep.wasm"],
  // ONNX Runtime Web (YOLO, Layer 5) - WebGPU with WASM fallback
  ["onnxruntime-web/dist/ort.webgpu.min.mjs", "ort/ort.webgpu.min.mjs"],
  ["onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs", "ort/ort-wasm-simd-threaded.asyncify.mjs"],
  ["onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm", "ort/ort-wasm-simd-threaded.asyncify.wasm"],
  ["onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs", "ort/ort-wasm-simd-threaded.jsep.mjs"],
  ["onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm", "ort/ort-wasm-simd-threaded.jsep.wasm"],
  // MediaPipe Tasks Vision (BlazeFace, Layer 4)
  ["@mediapipe/tasks-vision/vision_bundle.mjs", "mediapipe/vision_bundle.mjs"],
  ["@mediapipe/tasks-vision/wasm/vision_wasm_internal.js", "mediapipe/wasm/vision_wasm_internal.js"],
  ["@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm", "mediapipe/wasm/vision_wasm_internal.wasm"],
  ["@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.js", "mediapipe/wasm/vision_wasm_nosimd_internal.js"],
  ["@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm", "mediapipe/wasm/vision_wasm_nosimd_internal.wasm"],
  // Tesseract.js (OCR, Layer 3b)
  ["tesseract.js/dist/tesseract.esm.min.js", "tesseract/tesseract.esm.min.js"],
  ["tesseract.js/dist/worker.min.js", "tesseract/worker.min.js"],
  ["tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "tesseract-core/tesseract-core-simd-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-lstm.wasm.js", "tesseract-core/tesseract-core-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-simd-lstm.js", "tesseract-core/tesseract-core-simd-lstm.js"],
  ["tesseract.js-core/tesseract-core-simd-lstm.wasm", "tesseract-core/tesseract-core-simd-lstm.wasm"],
  ["tesseract.js-core/tesseract-core-lstm.js", "tesseract-core/tesseract-core-lstm.js"],
  ["tesseract.js-core/tesseract-core-lstm.wasm", "tesseract-core/tesseract-core-lstm.wasm"],
];

if (existsSync(out)) rmSync(out, { recursive: true });
for (const [src, dst] of files) {
  const from = join(nm, src);
  const to = join(out, dst);
  if (!existsSync(from)) {
    console.error(`missing: ${src} (run npm install)`);
    process.exit(1);
  }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
  console.log(`vendored ${dst}`);
}
