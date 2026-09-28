"""Request/response contract for POST /v1/agent/action (SRS 7.2, FR-010-02)."""
from __future__ import annotations

import base64
import binascii
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


class ElementItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: int = Field(ge=1)
    label: str = Field(max_length=300)
    type: str = Field(max_length=40)
    state: Optional[str] = Field(default=None, max_length=20)
    masked_as: Optional[str] = Field(default=None, max_length=40)
    submit: Optional[bool] = None
    required: Optional[bool] = None
    disabled: Optional[bool] = None
    options: Optional[list[str]] = Field(default=None, max_length=50)


class PageInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")
    origin: str = Field(max_length=200)
    path: str = Field(max_length=500)
    title: str = Field(default="", max_length=300)


class Viewport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    width: int
    height: int


class AgentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: UUID
    goal: str = Field(min_length=1, max_length=2000)
    masked_image: Optional[str] = None            # base64 PNG; None in strict mode
    strict_mode: bool = False
    element_map: list[ElementItem] = Field(max_length=500)
    validator_flags: dict[str, Optional[bool]] = Field(default_factory=dict)
    mask_labels: list[str] = Field(default_factory=list, max_length=500)
    history: list[str] = Field(default_factory=list, max_length=60)
    page: Optional[PageInfo] = None
    viewport: Optional[Viewport] = None

    @field_validator("masked_image")
    @classmethod
    def must_be_png(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        try:
            head = base64.b64decode(v[:64], validate=True)
        except (binascii.Error, ValueError) as e:
            raise ValueError("masked_image must be base64") from e
        if not head.startswith(PNG_MAGIC):
            raise ValueError("masked_image must be a PNG")
        return v


class AgentAction(BaseModel):
    action: Literal["click", "type", "scroll", "highlight", "explain", "done"]
    element_id: Optional[int] = None
    value: Optional[str] = None
    explanation: str
    confidence: float = Field(ge=0.0, le=1.0)


# JSON schema handed to the VLM as a structured-output contract.
ACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["click", "type", "scroll", "highlight", "explain", "done"]},
        "element_id": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
        "value": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "explanation": {"type": "string"},
        "confidence": {"type": "number"},
    },
    "required": ["action", "element_id", "value", "explanation", "confidence"],
    "additionalProperties": False,
}
