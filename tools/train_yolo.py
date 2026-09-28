"""Fine-tune YOLO-nano on synthetic ID cards (Layer 5) and export it for the browser.

    python tools/gen_cards.py yolo --n 1500
    python tools/train_yolo.py --epochs 15

Writes extension/models/yolo_idcard.onnx, which extension/lib/detectors/yolo.js
loads with ONNX Runtime Web (WebGPU, WASM fallback).
"""
import argparse
import shutil
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=15)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--base", default="yolo11n.pt")
    a = ap.parse_args()

    data = ROOT / "training" / "yolo_dataset" / "data.yaml"
    model = YOLO(a.base)
    model.train(data=str(data), epochs=a.epochs, imgsz=a.imgsz, batch=16, workers=4,
                project=str(ROOT / "training" / "runs"), name="idcard", exist_ok=True,
                fliplr=0.0, mosaic=0.5, device="cpu", patience=5, plots=False)
    best = ROOT / "training" / "runs" / "idcard" / "weights" / "best.pt"
    onnx_path = YOLO(str(best)).export(format="onnx", imgsz=a.imgsz, opset=17, simplify=True, dynamic=False)
    dst = ROOT / "extension" / "models" / "yolo_idcard.onnx"
    shutil.copy(onnx_path, dst)
    print("exported", dst, f"{dst.stat().st_size / 1e6:.1f} MB")
