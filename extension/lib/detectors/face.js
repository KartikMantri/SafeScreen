// Layer 4 - Face detector (SRS FR-003-05): BlazeFace short-range via MediaPipe
// Tasks Vision, model and WASM bundled in the extension.

import { FaceDetector, FilesetResolver } from "../../vendor/mediapipe/vision_bundle.mjs";

let detector = null;
let loading = null;
export const faceInfo = { status: "idle", delegate: null, error: null };

export async function loadFace() {
  if (detector) return detector;
  if (loading) return loading;
  faceInfo.status = "loading";
  loading = (async () => {
    const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL("vendor/mediapipe/wasm"));
    for (const delegate of ["GPU", "CPU"]) {
      try {
        detector = await FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: chrome.runtime.getURL("models/blaze_face_short_range.tflite"), delegate },
          runningMode: "IMAGE",
          minDetectionConfidence: 0.5,   // FR-003-05-03
        });
        faceInfo.status = "ready";
        faceInfo.delegate = delegate;
        return detector;
      } catch (e) {
        faceInfo.error = String(e?.message || e);
      }
    }
    faceInfo.status = "failed";
    throw new Error("BlazeFace failed to load: " + faceInfo.error);
  })();
  return loading;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Array<{x,y,w,h,score}>>} in canvas pixel coords
 */
export async function detectFaces(canvas) {
  const d = await loadFace();
  const res = d.detect(canvas);
  return (res.detections || []).map((det) => {
    const b = det.boundingBox;
    // BlazeFace boxes are tight on the face; pad to cover hair/ears/chin.
    const px = b.width * 0.25, py = b.height * 0.35;
    return { x: b.originX - px, y: b.originY - py, w: b.width + 2 * px, h: b.height + 1.6 * py, score: det.categories?.[0]?.score ?? 0 };
  });
}
