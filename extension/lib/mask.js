// Step 5a - Draw solid masks (SRS FR-005). Opaque fillRect only - blur,
// pixelation and mosaic are never used (they can be partially reversed).

export const MASK_COLOR = "#1A1D21";

export function drawMasks(source, boxes) {
  const c = document.createElement("canvas");
  c.width = source.width;
  c.height = source.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(source, 0, 0);
  for (const b of boxes) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = MASK_COLOR;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    const label = `[${b.type}]`;
    const size = Math.max(9, Math.min(16, Math.floor(b.h * 0.6)));
    ctx.font = `bold ${size}px Segoe UI, Arial, sans-serif`;
    ctx.fillStyle = "#FFFFFF";
    ctx.textBaseline = "middle";
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.clip();
    ctx.fillText(label, b.x + 4, b.y + b.h / 2);
    ctx.restore();
  }
  return c;
}

/** Re-encode to PNG. A fresh canvas encode carries no EXIF/metadata (FR-005-05). */
export async function toPngBase64(canvas) {
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { base64: btoa(bin), bytes: buf.length };
}

export function cropCanvas(source, box, minWidth = 0) {
  const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
  const w = Math.min(source.width - x, Math.ceil(box.w)), h = Math.min(source.height - y, Math.ceil(box.h));
  const scale = minWidth && w < minWidth ? Math.min(3, minWidth / w) : 1;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext("2d").drawImage(source, x, y, w, h, 0, 0, c.width, c.height);
  return { canvas: c, scale, offset: { x, y } };
}
