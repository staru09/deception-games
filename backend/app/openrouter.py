import json
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from .config import Settings, get_settings


@dataclass(slots=True)
class Completion:
    content: str
    reasoning: str | None = None
    reasoning_details: list[dict[str, Any]] | None = None
    reasoning_state: str = "unavailable"
    prompt_tokens: int = 0
    completion_tokens: int = 0
    reasoning_tokens: int = 0
    cost: float = 0
    latency_ms: int = 0
    finish_reason: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


class OpenRouterError(RuntimeError):
    pass


class OpenRouterClient:
    def __init__(
        self,
        settings: Settings | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self._client = httpx.AsyncClient(
            base_url=self.settings.openrouter_base_url,
            headers={
                "Authorization": f"Bearer {self.settings.openrouter_api_key}",
                "HTTP-Referer": self.settings.app_url,
                "X-OpenRouter-Title": self.settings.app_name,
            },
            transport=transport,
        )

    async def close(self) -> None:
        await self._client.aclose()

    def _require_key(self) -> None:
        if not self.settings.openrouter_api_key:
            raise OpenRouterError(
                "OPENROUTER_API_KEY is not configured. Copy .env.example to .env."
            )

    async def list_models(self) -> list[dict[str, Any]]:
        self._require_key()
        response = await self._client.get("/models", timeout=30)
        if response.is_error:
            raise OpenRouterError(f"OpenRouter models request failed: {response.text}")
        models = response.json().get("data", [])
        return sorted(
            (
                {
                    "id": model["id"],
                    "name": model.get("name", model["id"]),
                    "context_length": model.get("context_length"),
                    "supported_parameters": model.get("supported_parameters", []),
                }
                for model in models
                if model.get("id")
            ),
            key=lambda model: model["id"],
        )

    async def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        max_tokens: int,
        timeout_seconds: int,
        reasoning_effort: str = "medium",
        json_mode: bool = False,
    ) -> Completion:
        self._require_key()
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "reasoning": {"effort": reasoning_effort, "exclude": False},
            "usage": {"include": True},
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        started = time.perf_counter()
        try:
            response = await self._client.post(
                "/chat/completions",
                json=payload,
                timeout=timeout_seconds,
            )
        except httpx.TimeoutException as exc:
            raise OpenRouterError(
                f"OpenRouter request timed out after {timeout_seconds}s"
            ) from exc
        if response.is_error:
            raise OpenRouterError(
                f"OpenRouter completion failed ({response.status_code}): {response.text}"
            )

        body = response.json()
        try:
            choice = body["choices"][0]
            message = choice["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise OpenRouterError(f"Malformed OpenRouter response: {body}") from exc

        usage = body.get("usage") or {}
        details = usage.get("completion_tokens_details") or {}
        reasoning_details = message.get("reasoning_details")
        reasoning = message.get("reasoning") or message.get("reasoning_content")
        reasoning_state = self._reasoning_state(reasoning, reasoning_details)
        return Completion(
            content=message.get("content") or "",
            reasoning=reasoning,
            reasoning_details=reasoning_details,
            reasoning_state=reasoning_state,
            prompt_tokens=usage.get("prompt_tokens") or 0,
            completion_tokens=usage.get("completion_tokens") or 0,
            reasoning_tokens=details.get("reasoning_tokens") or 0,
            cost=float(usage.get("cost") or 0),
            latency_ms=int((time.perf_counter() - started) * 1000),
            finish_reason=choice.get("finish_reason"),
            raw=body,
        )

    @staticmethod
    def _reasoning_state(
        reasoning: str | None, details: list[dict[str, Any]] | None
    ) -> str:
        if reasoning and reasoning.strip() and reasoning.strip() != "[REDACTED]":
            return "available"
        if details:
            serialized = json.dumps(details)
            if "[REDACTED]" in serialized or any(
                item.get("type") == "reasoning.encrypted" for item in details
            ):
                return "redacted"
            return "available"
        return "unavailable"
