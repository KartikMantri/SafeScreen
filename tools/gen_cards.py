"""Synthetic identity-document generator for SafeScreen.

Two jobs:
  1. `python tools/gen_cards.py demo`        -> demo images for the mock ISRO portal
  2. `python tools/gen_cards.py yolo --n 2000` -> YOLO-format training set for Layer 5

Every card is fully synthetic: random names, checksum-valid but fabricated
numbers, AI-generated faces (thispersondoesnotexist / StyleGAN), and a
"SYNTHETIC SPECIMEN" watermark. No real identity documents are used
(SRS FR-003-06-06, constraint 10.1.2).
"""
from __future__ import annotations

import argparse
import random
import string
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FACES = [ROOT / "assets_src" / "tpdne.jpeg", ROOT / "assets_src" / "tpdne2.jpeg"]
PORTAL_IMG = ROOT / "portal" / "img"

# Class ids must match extension/lib/detectors/yolo.js
CLASSES = [
    "PAN_NUMBER", "NAME", "FATHERS_NAME", "DOB", "PHOTO", "SIGNATURE", "QR_CODE",
    "AADHAAR_CARD", "DRIVING_LICENSE", "PASSPORT", "CREDIT_CARD", "DEBIT_CARD", "AADHAAR_NUMBER",
]
CID = {c: i for i, c in enumerate(CLASSES)}

FIRST = ["ANANYA", "MEERA", "RAHUL", "KAVYA", "ARJUN", "PRIYA", "VIKRAM", "LAKSHMI", "SURESH",
         "DIVYA", "KARTHIK", "NEHA", "ROHAN", "SNEHA", "ADITYA", "POOJA", "HARISH", "SWATHI"]
LAST = ["RAO", "IYER", "SHARMA", "NAIR", "REDDY", "MENON", "PILLAI", "GUPTA", "VERMA",
        "KULKARNI", "BHAT", "DAS", "JOSHI", "PATEL", "SINGH", "HEGDE"]


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    names = ["arialbd.ttf", "DejaVuSans-Bold.ttf"] if bold else ["arial.ttf", "DejaVuSans.ttf"]
    for n in names:
        for base in ["C:/Windows/Fonts", "/usr/share/fonts/truetype/dejavu", ""]:
            try:
                return ImageFont.truetype(str(Path(base) / n) if base else n, size)
            except OSError:
                continue
    return ImageFont.load_default()


# ---------- checksums ----------
_V_D = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
        [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
        [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
        [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]]
_V_P = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
        [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
        [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]]
_V_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9]


def verhoeff_digit(num: str) -> str:
    c = 0
    for i, d in enumerate(reversed(num)):
        c = _V_D[c][_V_P[(i + 1) % 8][int(d)]]
    return str(_V_INV[c])


def fake_aadhaar(rng: random.Random) -> str:
    body = str(rng.randint(2, 9)) + "".join(rng.choice(string.digits) for _ in range(10))
    return body + verhoeff_digit(body)


def fake_pan(rng: random.Random, surname: str) -> str:
    return ("".join(rng.choice(string.ascii_uppercase) for _ in range(3)) + "P" + surname[0]
            + "".join(rng.choice(string.digits) for _ in range(4)) + rng.choice(string.ascii_uppercase))


def fake_dob(rng: random.Random) -> str:
    return f"{rng.randint(1, 28):02d}/{rng.randint(1, 12):02d}/{rng.randint(1965, 2003)}"


# ---------- drawing helpers ----------
def face_img(rng: random.Random, size: tuple[int, int], idx: int | None = None) -> Image.Image:
    src = Image.open(FACES[rng.randrange(len(FACES)) if idx is None else idx]).convert("RGB")
    w, h = src.size
    crop = src.crop((int(w * 0.12), int(h * 0.05), int(w * 0.88), int(h * 0.98)))
    return crop.resize(size)


def qr_block(rng: random.Random, size: int) -> Image.Image:
    n = 25
    cell = size // n
    img = Image.new("RGB", (cell * n, cell * n), "white")
    d = ImageDraw.Draw(img)
    for y in range(n):
        for x in range(n):
            if rng.random() < 0.5:
                d.rectangle([x * cell, y * cell, (x + 1) * cell - 1, (y + 1) * cell - 1], fill="black")
    for ox, oy in [(0, 0), (n - 7, 0), (0, n - 7)]:  # finder patterns
        d.rectangle([ox * cell, oy * cell, (ox + 7) * cell - 1, (oy + 7) * cell - 1], fill="black")
        d.rectangle([(ox + 1) * cell, (oy + 1) * cell, (ox + 6) * cell - 1, (oy + 6) * cell - 1], fill="white")
        d.rectangle([(ox + 2) * cell, (oy + 2) * cell, (ox + 5) * cell - 1, (oy + 5) * cell - 1], fill="black")
    return img.resize((size, size), Image.NEAREST)


def signature(d: ImageDraw.ImageDraw, rng: random.Random, box: tuple[int, int, int, int]) -> None:
    x0, y0, x1, y1 = box
    pts = []
    x = x0 + 4
    while x < x1 - 4:
        pts.append((x, rng.randint(y0 + 6, y1 - 6)))
        x += rng.randint(6, 14)
    d.line(pts, fill=(20, 30, 90), width=2)


def text_box(d: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, f) -> tuple[int, int, int, int]:
    d.text(xy, text, font=f, fill=(15, 15, 15))
    return d.textbbox(xy, text, font=f)


def watermark(img: Image.Image) -> Image.Image:
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    f = font(26, bold=True)
    d.text((40, img.height // 2 - 20), "SYNTHETIC SPECIMEN - NOT A VALID DOCUMENT", font=f, fill=(200, 0, 0, 70))
    layer = layer.rotate(12, center=(img.width // 2, img.height // 2))
    return Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")


# ---------- cards ----------
def pan_card(rng: random.Random, name: str | None = None, father: str | None = None,
             dob: str | None = None, pan: str | None = None, face_idx: int | None = None):
    W, H = 856, 540
    img = Image.new("RGB", (W, H), (214, 232, 244))
    d = ImageDraw.Draw(img)
    for i in range(0, W, 6):  # guilloche-ish background
        d.line([(i, 0), (i + 120, H)], fill=(200, 222, 238), width=1)
    d.rectangle([0, 0, W, 70], fill=(24, 62, 120))
    d.text((24, 20), "INCOME TAX DEPARTMENT", font=font(28, True), fill="white")
    d.text((W - 250, 20), "GOVT. OF INDIA", font=font(28, True), fill="white")

    last = rng.choice(LAST)
    name = name or f"{rng.choice(FIRST)} {last}"
    father = father or f"{rng.choice(FIRST)} {name.split()[-1]}"
    dob = dob or fake_dob(rng)
    pan = pan or fake_pan(rng, name.split()[-1])
    labels = []

    photo = face_img(rng, (170, 205), face_idx)
    img.paste(photo, (40, 95))
    labels.append(("PHOTO", (40, 95, 210, 300)))
    qr = qr_block(rng, 150)
    img.paste(qr, (W - 190, 110))
    labels.append(("QR_CODE", (W - 190, 110, W - 40, 260)))

    d.text((250, 95), "Permanent Account Number Card", font=font(22, True), fill=(24, 62, 120))
    labels.append(("PAN_NUMBER", text_box(d, (250, 130), pan, font(40, True))))
    d.text((250, 190), "Name", font=font(16), fill=(60, 60, 60))
    labels.append(("NAME", text_box(d, (250, 210), name, font(26, True))))
    d.text((250, 255), "Father's Name", font=font(16), fill=(60, 60, 60))
    labels.append(("FATHERS_NAME", text_box(d, (250, 275), father, font(26, True))))
    d.text((250, 320), "Date of Birth", font=font(16), fill=(60, 60, 60))
    labels.append(("DOB", text_box(d, (250, 340), dob, font(26, True))))
    sig = (250, 400, 520, 470)
    signature(d, rng, sig)
    d.text((250, 475), "Signature", font=font(16), fill=(60, 60, 60))
    labels.append(("SIGNATURE", sig))
    return watermark(img), labels, {"name": name, "father": father, "dob": dob, "pan": pan}


def aadhaar_card(rng: random.Random, name: str | None = None, dob: str | None = None,
                 number: str | None = None, face_idx: int | None = None):
    W, H = 856, 540
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 60], fill=(255, 153, 51))
    d.rectangle([0, 60, W, 75], fill="white")
    d.rectangle([0, 75, W, 90], fill=(19, 136, 8))
    d.text((24, 14), "Government of India", font=font(28, True), fill="white")
    name = name or f"{rng.choice(FIRST)} {rng.choice(LAST)}"
    dob = dob or fake_dob(rng)
    number = number or fake_aadhaar(rng)
    spaced = f"{number[:4]} {number[4:8]} {number[8:]}"
    labels = [("AADHAAR_CARD", (0, 0, W, H))]

    photo = face_img(rng, (170, 205), face_idx)
    img.paste(photo, (40, 120))
    labels.append(("PHOTO", (40, 120, 210, 325)))
    labels.append(("NAME", text_box(d, (250, 130), name, font(28, True))))
    labels.append(("DOB", text_box(d, (250, 180), f"DOB: {dob}", font(24))))
    d.text((250, 225), rng.choice(["FEMALE", "MALE"]), font=font(24), fill=(15, 15, 15))
    qr = qr_block(rng, 160)
    img.paste(qr, (W - 200, 120))
    labels.append(("QR_CODE", (W - 200, 120, W - 40, 280)))
    d.line([(0, 420), (W, 420)], fill=(200, 0, 0), width=3)
    labels.append(("AADHAAR_NUMBER", text_box(d, (W // 2 - 170, 440), spaced, font(44, True))))
    return watermark(img), labels, {"name": name, "dob": dob, "aadhaar": number}


# ---------- outputs ----------
def make_demo() -> None:
    PORTAL_IMG.mkdir(parents=True, exist_ok=True)
    rng = random.Random(26171)
    face_img(rng, (300, 360), 0).save(PORTAL_IMG / "employee_photo.jpg", quality=92)
    face_img(rng, (300, 360), 1).save(PORTAL_IMG / "visitor_photo.jpg", quality=92)
    pan, _, pan_meta = pan_card(rng, name="MEERA IYER", father="SUBRAMANIAN IYER", dob="14/08/1996",
                                pan="BQJPI4821K", face_idx=1)
    pan.save(PORTAL_IMG / "pan_card_synthetic.png")
    aad, _, aad_meta = aadhaar_card(rng, name="MEERA IYER", dob="14/08/1996", face_idx=1)
    aad.save(PORTAL_IMG / "aadhaar_synthetic.png")
    print("demo assets written to", PORTAL_IMG)
    print("PAN card:", pan_meta)
    print("Aadhaar card:", aad_meta)


def make_yolo(n: int, out: Path) -> None:
    rng = random.Random(7)
    for split in ("train", "val"):
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)
    for i in range(n):
        split = "val" if i % 10 == 0 else "train"
        card, labels, _ = (pan_card if rng.random() < 0.55 else aadhaar_card)(rng)
        # random web-page-like canvas, random scale/offset, mild blur/jpeg noise
        cw, ch = 960, 720
        bg = Image.new("RGB", (cw, ch), tuple(rng.randint(225, 255) for _ in range(3)))
        bd = ImageDraw.Draw(bg)
        for _ in range(rng.randint(3, 12)):
            y = rng.randint(0, ch)
            bd.rectangle([rng.randint(0, cw // 2), y, rng.randint(cw // 2, cw), y + rng.randint(8, 20)],
                         fill=tuple(rng.randint(150, 235) for _ in range(3)))
        scale = rng.uniform(0.35, 1.0)
        cwid, chei = int(card.width * scale), int(card.height * scale)
        card_s = card.resize((cwid, chei))
        if rng.random() < 0.3:
            card_s = card_s.filter(ImageFilter.GaussianBlur(rng.uniform(0.3, 1.2)))
        ox, oy = rng.randint(0, cw - cwid), rng.randint(0, ch - chei)
        bg.paste(card_s, (ox, oy))
        lines = []
        for cls, (x0, y0, x1, y1) in labels:
            x0, x1 = ox + x0 * scale, ox + x1 * scale
            y0, y1 = oy + y0 * scale, oy + y1 * scale
            lines.append(f"{CID[cls]} {(x0 + x1) / 2 / cw:.6f} {(y0 + y1) / 2 / ch:.6f} "
                         f"{(x1 - x0) / cw:.6f} {(y1 - y0) / ch:.6f}")
        bg.save(out / "images" / split / f"{i:05d}.jpg", quality=rng.randint(70, 95))
        (out / "labels" / split / f"{i:05d}.txt").write_text("\n".join(lines))
    (out / "data.yaml").write_text(
        f"path: {out.as_posix()}\ntrain: images/train\nval: images/val\n"
        f"names:\n" + "".join(f"  {i}: {c}\n" for i, c in enumerate(CLASSES)))
    print(f"wrote {n} synthetic samples to {out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["demo", "yolo"])
    ap.add_argument("--n", type=int, default=2000)
    ap.add_argument("--out", type=Path, default=ROOT / "training" / "yolo_dataset")
    a = ap.parse_args()
    make_demo() if a.mode == "demo" else make_yolo(a.n, a.out)
