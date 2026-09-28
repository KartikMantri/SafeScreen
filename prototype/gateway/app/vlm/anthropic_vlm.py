"""Claude as the cloud VLM (prototype default while Qwen2.5-VL hosting is set up)."""
from __future__ import annotations

import json

import anthropic

from ..prompt import SYSTEM_PROMPT, render_user_text
from ..schemas import ACTION_SCHEMA, AgentAction, AgentRequest
from . import VLMError


class AnthropicVLM:
    name = "anthropic"

    def __init__(self, model: str, effort: str) -> None:
        self.model = model
        self.effort = effort
        self.client = anthropic.AsyncAnthropic()   # ANTHROPIC_API_KEY from env / gateway/.env

    async def plan(self, req: AgentRequest) -> AgentAction:
        content: list[dict] = []
        if req.masked_image:
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": req.masked_image}})
        content.append({"type": "text", "text": render_user_text(req)})
        try:
            resp = await self.client.beta.messages.create(
                model=self.model,
                max_tokens=8000,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": content}],
                thinking={"type": "adaptive"},
                output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": ACTION_SCHEMA}},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
        except anthropic.AuthenticationError as e:
            raise VLMError("Anthropic API key missing or invalid (set ANTHROPIC_API_KEY in gateway/.env)") from e
        except anthropic.RateLimitError as e:
            raise VLMError("Anthropic rate limit reached - retry shortly") from e
        except anthropic.APIStatusError as e:
            raise VLMError(f"Anthropic API error {e.status_code}: {e.message}") from e
        except anthropic.APIConnectionError as e:
            raise VLMError("cannot reach Anthropic API") from e

        if resp.stop_reason == "refusal":
            raise VLMError("model declined this request")
        if resp.stop_reason == "max_tokens":
            raise VLMError("model output truncated")
        text = next((b.text for b in resp.content if b.type == "text"), None)
        if not text:
            raise VLMError("model returned no action")
        try:
            data = json.loads(text)
            data["confidence"] = max(0.0, min(1.0, float(data.get("confidence", 0))))
            return AgentAction.model_validate(data)
        except (ValueError, TypeError) as e:
            raise VLMError(f"model returned an invalid action: {text[:200]}") from e
