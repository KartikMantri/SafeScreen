// Step 7 client - the only code path that crosses the Privacy Line.

export class GatewayError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function requestAction(cfg, payload, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(`${cfg.gatewayUrl.replace(/\/$/, "")}/v1/agent/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
      cache: "no-store",
    });
  } catch (e) {
    // NFR-REL-04: fail gracefully, never queue data for later transmission
    throw new GatewayError(e.name === "AbortError" ? "gateway timed out" : `gateway unreachable (${cfg.gatewayUrl})`, 0);
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new GatewayError(body.detail ? JSON.stringify(body.detail) : `HTTP ${res.status}`, res.status);
  return {
    action: body,
    roundTripMs: Math.round(performance.now() - t0),
    vlmMs: +res.headers.get("x-vlm-ms") || null,
    model: res.headers.get("x-vlm-model"),
  };
}
