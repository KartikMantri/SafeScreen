"""SafeScreen gateway - Step 7 (SRS FR-009).

Authenticates the extension, validates the payload, applies the redaction-aware
system prompt and forwards to the VLM (Step 8). Zero retention: the masked image
is never written to disk, database or log.

Also serves the mock ISRO Employee Services Portal at /portal for the demo.
"""
from __future__ import annotations

import hashlib
import logging
import time
from collections import defaultdict, deque
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .schemas import AgentAction, AgentRequest
from .vlm import VLMError, get_provider

log = logging.getLogger("safescreen.gateway")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = FastAPI(title="SafeScreen Gateway", version="0.1.0", docs_url="/docs", redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension|moz-extension)://.*$",
    allow_methods=["POST", "GET"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["X-VLM-Ms", "X-VLM-Model"],
)

provider = get_provider()
_hits: dict[str, deque] = defaultdict(deque)


@app.middleware("http")
async def limit_payload(request: Request, call_next):
    size = request.headers.get("content-length")
    if size and int(size) > settings.max_payload_bytes:
        return JSONResponse({"detail": f"payload exceeds {settings.max_payload_bytes} bytes"}, status_code=413)
    return await call_next(request)


@app.exception_handler(RequestValidationError)
async def malformed(_request: Request, exc: RequestValidationError):
    # FR-009-02: 400 on malformed payloads. Never echo the input back (it may hold the image).
    errors = [{"loc": e.get("loc"), "msg": e.get("msg")} for e in exc.errors()]
    return JSONResponse({"detail": errors}, status_code=400)


def installation(authorization: str = Header(default="")) -> str:
    token = authorization.removeprefix("Bearer ").strip()
    if token not in settings.api_keys:
        raise HTTPException(status_code=401, detail="invalid installation key")
    install_id = hashlib.sha256(token.encode()).hexdigest()[:12]
    window = _hits[install_id]
    now = time.monotonic()
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= settings.rate_limit_per_min:
        raise HTTPException(status_code=429, detail="rate limit exceeded")
    window.append(now)
    return install_id


@app.post("/v1/agent/action", response_model=AgentAction)
async def agent_action(req: AgentRequest, install_id: str = Depends(installation)):
    t0 = time.perf_counter()
    try:
        action = await provider.plan(req)
    except VLMError as e:
        log.warning("install=%s vlm_error=%s", install_id, e)
        raise HTTPException(status_code=502, detail=str(e)) from e
    vlm_ms = int((time.perf_counter() - t0) * 1000)
    # FR-009-07: timestamp, hashed installation id, action type, latency. Nothing else.
    log.info("install=%s action=%s strict=%s latency_ms=%d", install_id, action.action, req.strict_mode, vlm_ms)
    return JSONResponse(
        action.model_dump(),
        headers={"X-VLM-Ms": str(vlm_ms), "X-VLM-Model": f"{provider.name}:{provider.model}", "Cache-Control": "no-store"},
    )


@app.get("/healthz")
async def health():
    return {"status": "ok", "provider": provider.name, "model": provider.model, "retention": "zero"}


_portal = Path(__file__).resolve().parents[2] / "portal"
if _portal.exists():
    app.mount("/portal", StaticFiles(directory=_portal, html=True), name="portal")


@app.get("/", include_in_schema=False)
async def root():
    return RedirectResponse("/portal/")
