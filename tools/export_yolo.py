"""Export the best YOLO checkpoint (even from an interrupted run) to ONNX for the extension.

    training/.venv/Scripts/python tools/export_yolo.py
"""
import shutil
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent

if __name__ == "__main__":
    best = ROOT / "training" / "runs" / "idcard" / "weights" / "best.pt"
    onnx_path = YOLO(str(best)).export(format="onnx", imgsz=640, opset=17, simplify=True, dynamic=False)
    dst = ROOT / "extension" / "models" / "yolo_idcard.onnx"
    shutil.copy(onnx_path, dst)
    print("exported", dst, f"{dst.stat().st_size / 1e6:.1f} MB")
