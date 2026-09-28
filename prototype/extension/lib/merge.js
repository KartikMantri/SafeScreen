// Step 4 - Merge boxes (SRS FR-004). Pure module.

// Most specific label wins when several layers flag the same region (FR-004-05).
export const SPECIFICITY = {
  PASSWORD: 100, CREDIT_CARD: 95, AADHAAR: 94, AADHAAR_NUMBER: 94, PAN_NO: 93, OTP: 92,
  BANK_ACCOUNT: 90, IFSC: 89, FACE: 88, SIGNATURE: 87, QR_CODE: 86, DOB: 85,
  FATHERS_NAME: 84, NAME: 83, EMAIL: 82, PHONE: 81, EMPLOYEE_ID: 80,
  ID_DOCUMENT: 60, LOCATION: 40, ORGANIZATION: 39, FILE_UPLOAD: 30, GENERIC_PII: 10,
};

export function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function union(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const w = Math.max(a.x + a.w, b.x + b.w) - x, h = Math.max(a.y + a.h, b.y + b.h) - y;
  const winner = (SPECIFICITY[b.type] ?? 0) > (SPECIFICITY[a.type] ?? 0) ? b : a;
  return {
    ...winner, x, y, w, h,
    sources: [...new Set([...(a.sources || [a.source]), ...(b.sources || [b.source])])],
    elementId: a.elementId ?? b.elementId,
    spans: [...(a.spans || []), ...(b.spans || [])],
  };
}

/**
 * @param {Array<{x,y,w,h,type,source,elementId?,spans?}>} boxes screenshot pixel coords
 * @param {{width:number,height:number}} bounds screenshot size
 * @param {{iouThreshold?:number, dilation?:number}} [opts]
 */
export function mergeBoxes(boxes, bounds, opts = {}) {
  const thr = opts.iouThreshold ?? 0.3;
  const dil = opts.dilation ?? 8;
  let list = boxes
    // drop empty boxes and boxes entirely outside the screenshot (e.g. a text span on an
    // off-screen line) - there is nothing to mask and clamping would give negative sizes
    .filter((b) => b.w > 0 && b.h > 0 && b.x < bounds.width && b.y < bounds.height && b.x + b.w > 0 && b.y + b.h > 0)
    .map((b) => ({ ...b, sources: b.sources || [b.source], spans: b.spans || [] }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (iou(list[i], list[j]) >= thr) {
          const m = union(list[i], list[j]);
          list = list.filter((_, k) => k !== i && k !== j);
          list.push(m);
          changed = true;
          break outer;
        }
      }
    }
  }
  return list
    .map((b) => {
      const x = Math.max(0, Math.floor(b.x - dil)), y = Math.max(0, Math.floor(b.y - dil));
      return {
        ...b,
        x, y,
        w: Math.min(bounds.width, Math.ceil(b.x + b.w + dil)) - x,
        h: Math.min(bounds.height, Math.ceil(b.y + b.h + dil)) - y,
      };
    })
    .filter((b) => b.w > 0 && b.h > 0)
    .map((b, i) => ({ ...b, id: i + 1 }));
}
