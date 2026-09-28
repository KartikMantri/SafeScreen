import base64
import io
import os
import sys
import uuid
from pathlib import Path

os.environ["VLM_PROVIDER"] = "mock"
os.environ["SAFESCREEN_API_KEYS"] = "test-key"
os.environ["RATE_LIMIT_PER_MIN"] = "1000"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

client = TestClient(app)
AUTH = {"Authorization": "Bearer test-key"}


def png_b64() -> str:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), "black").save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def payload(**over):
    body = {
        "session_id": str(uuid.uuid4()),
        "goal": "Register me. My PAN is {{USER_PAN}} and mobile {{USER_PHONE}}",
        "masked_image": png_b64(),
        "element_map": [
            {"id": 1, "label": "Mobile number *", "type": "input:tel", "state": "empty"},
            {"id": 2, "label": "PAN number *", "type": "input", "state": "masked", "masked_as": "PAN_NO"},
            {"id": 3, "label": "Submit registration", "type": "button:submit", "submit": True},
        ],
        "validator_flags": {"required_fields_complete": False},
        "mask_labels": ["PAN_NO at [10,10,100,20]"],
    }
    body.update(over)
    return body


def test_requires_key():
    assert client.post("/v1/agent/action", json=payload()).status_code == 401
    assert client.post("/v1/agent/action", json=payload(), headers={"Authorization": "Bearer nope"}).status_code == 401


def test_returns_structured_action_with_placeholder():
    r = client.post("/v1/agent/action", json=payload(), headers=AUTH)
    assert r.status_code == 200
    a = r.json()
    assert a["action"] == "type" and a["element_id"] == 1 and a["value"] == "{{USER_PHONE}}"
    assert r.headers["x-vlm-model"] == "mock:mock-planner"


def test_malformed_is_400_and_does_not_echo_input():
    r = client.post("/v1/agent/action", json=payload(masked_image="bm90IGEgcG5n", extra_field=1), headers=AUTH)
    assert r.status_code == 400
    assert "bm90IGEgcG5n" not in r.text


def test_strict_mode_without_image():
    r = client.post("/v1/agent/action", json=payload(masked_image=None, strict_mode=True), headers=AUTH)
    assert r.status_code == 200


def test_payload_limit():
    r = client.post("/v1/agent/action", content=b"x" * (6 * 1024 * 1024), headers={**AUTH, "Content-Type": "application/json"})
    assert r.status_code == 413


def test_portal_is_served():
    assert client.get("/portal/lvg.html").status_code == 200
    assert client.get("/healthz").json()["retention"] == "zero"
