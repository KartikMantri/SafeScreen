"""VLM providers. The extension is model-agnostic (FR-010-05): any provider that
returns an AgentAction for an AgentRequest can sit behind the gateway."""
from __future__ import annotations

from typing import Protocol

from ..config import settings
from ..schemas import AgentAction, AgentRequest


class VLMError(Exception):
    """Upstream model failed or returned something unusable."""


class VLMProvider(Protocol):
    name: str
    model: str

    async def plan(self, req: AgentRequest) -> AgentAction: ...


def get_provider() -> VLMProvider:
    if settings.provider == "anthropic":
        from .anthropic_vlm import AnthropicVLM
        return AnthropicVLM(settings.model, settings.effort)
    if settings.provider == "openai_compat":
        from .openai_compat_vlm import OpenAICompatVLM
        return OpenAICompatVLM(settings.model, settings.openai_base_url, settings.openai_api_key)
    if settings.provider == "mock":
        from .mock_vlm import MockVLM
        return MockVLM()
    raise ValueError(f"unknown VLM_PROVIDER {settings.provider!r}")
