"""Gateway settings, read from environment (and gateway/.env if present)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def _load_env_file() -> None:
    if not _ENV_FILE.exists():
        return
    for line in _ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_file()


@dataclass(frozen=True)
class Settings:
    # anthropic | openai_compat | mock
    provider: str = os.getenv("VLM_PROVIDER", "anthropic")
    model: str = os.getenv("VLM_MODEL", "claude-opus-5")
    # Anthropic effort: low keeps per-step planning latency down; raise for harder portals
    effort: str = os.getenv("VLM_EFFORT", "low")
    # OpenAI-compatible endpoint for Qwen2.5-VL (vLLM, DashScope, OpenRouter, ...)
    openai_base_url: str = os.getenv("OPENAI_COMPAT_BASE_URL", "http://localhost:8001/v1")
    openai_api_key: str = os.getenv("OPENAI_COMPAT_API_KEY", "EMPTY")
    # installation keys accepted by the gateway (comma separated)
    api_keys: frozenset[str] = field(
        default_factory=lambda: frozenset(k.strip() for k in os.getenv("SAFESCREEN_API_KEYS", "isro-demo-key").split(",") if k.strip())
    )
    max_payload_bytes: int = int(os.getenv("MAX_PAYLOAD_BYTES", str(5 * 1024 * 1024)))   # FR-009-04
    rate_limit_per_min: int = int(os.getenv("RATE_LIMIT_PER_MIN", "60"))                 # FR-009-05


settings = Settings()
