"""Deterministic offline planner for tests and demos without an API key.
It is intentionally simple: fill empty fields whose label matches a placeholder
in the goal, tick required checkboxes, scroll down until the submit button is
visible, then click it."""
from __future__ import annotations

import re

from ..schemas import AgentAction, AgentRequest

HINTS = {
    "USER_NAME": ("name",), "USER_PHONE": ("mobile", "phone"), "USER_EMAIL": ("email", "e-mail"),
    "USER_PAN": ("pan",), "USER_AADHAAR": ("aadhaar", "aadhar"), "USER_ACCOUNT": ("account",),
    "USER_IFSC": ("ifsc",), "USER_DOB": ("birth", "dob"), "USER_EMPLOYEE_ID": ("employee id",),
}
MAX_SCROLLS = 4
# history lines look like: type #7 "PAN number *" value={{USER_PAN}} → approved by user, executed
DONE_RE = re.compile(r'^(?:type|click) #\d+ "(.*?)".*executed')


class MockVLM:
    name = "mock"
    model = "mock-planner"

    async def plan(self, req: AgentRequest) -> AgentAction:
        if any(h.startswith("click") and "executed" in h for h in req.history):
            return AgentAction(action="done", explanation="The form has been submitted.", confidence=0.9)
        # element ids change when the page scrolls, so remember finished fields by label
        done_labels = {m.group(1) for h in req.history if (m := DONE_RE.match(h))}
        scrolls = sum(1 for h in req.history if h.startswith("scroll"))
        tokens = re.findall(r"\{\{([A-Z_]+(?:_\d+)?)\}\}", req.goal)

        for el in req.element_map:
            if el.label in done_labels or el.disabled or not el.type.startswith(("input", "textarea")):
                continue
            label = el.label.lower()
            for tok in tokens:
                stem = re.sub(r"_\d+$", "", tok)
                if el.state in ("empty", "masked") and any(h in label for h in HINTS.get(stem, ())):
                    if stem == "USER_NAME" and "father" in label:
                        continue
                    return AgentAction(action="type", element_id=el.id, value="{{" + tok + "}}",
                                       explanation=f"Filling '{el.label}' with the value you provided.", confidence=0.9)
        for el in req.element_map:
            if el.label not in done_labels and el.type == "input:checkbox" and el.required and el.state == "unchecked":
                return AgentAction(action="type", element_id=el.id, value="true",
                                   explanation=f"Ticking the required declaration '{el.label}'.", confidence=0.85)
        # like the real system prompt: password / OTP fields are always left to the user
        if any(el.masked_as in ("PASSWORD", "OTP") for el in req.element_map):
            return AgentAction(action="done", confidence=0.9, explanation=(
                "This sign-in page needs your password and one-time password. SafeScreen never fills "
                "these - please enter them yourself and click Sign in."))
        for el in req.element_map:
            if el.submit and not el.disabled:
                return AgentAction(action="click", element_id=el.id,
                                   explanation=f"All fields are filled - submitting via '{el.label}'.", confidence=0.8)
        if scrolls < MAX_SCROLLS:
            return AgentAction(action="scroll", element_id=None, value="down",
                               explanation="The submit button is not visible yet - scrolling down.", confidence=0.9)
        return AgentAction(action="done", explanation="Nothing left to do on this page.", confidence=0.7)
