"""Qwen2.5-VL (or any vision model) behind an OpenAI-compatible endpoint:
self-hosted vLLM on an Indian / on-prem GPU server, DashScope, OpenRouter, etc.

    VLM_PROVIDER=openai_compat
    VLM_MODEL=Qwen/Qwen2.5-VL-7B-Instruct
    OPENAI_COMPAT_BASE_URL=http://gpu-server:8001/v1
"""
from __future__ import annotations

import json

from openai import AsyncOpenAI, OpenAIError

from ..prompt import SYSTEM_PROMPT, render_user_text
from ..schemas import ACTION_SCHEMA, AgentAction, AgentRequest
from . import VLMError


class OpenAICompatVLM:
    name = "openai_compat"

    def __init__(self, model: str, base_url: str, api_key: str) -> None:
        self.model = model
        self.client = AsyncOpenAI(base_url=base_url, api_key=api_key)

    async def plan(self, req: AgentRequest) -> AgentAction:
        user: list[dict] = []
        if req.masked_image:
            user.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{req.masked_image}"}})
        user.append({"type": "text", "text": render_user_text(req)})
        try:
            resp = await self.client.chat.completions.create(
                model=self.model,
                messages=[{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}],
                response_format={"type": "json_schema", "json_schema": {"name": "agent_action", "schema": ACTION_SCHEMA, "strict": True}},
                temperature=0,
                max_tokens=600,
            )
        except OpenAIError as e:
            raise VLMError(f"VLM endpoint error: {e}") from e
        text = resp.choices[0].message.content or ""
        try:
            start, end = text.find("{"), text.rfind("}")
            data = json.loads(text[start : end + 1])
            data["confidence"] = max(0.0, min(1.0, float(data.get("confidence", 0))))
            return AgentAction.model_validate(data)
        except (ValueError, TypeError) as e:
            raise VLMError(f"model returned an invalid action: {text[:200]}") from e
