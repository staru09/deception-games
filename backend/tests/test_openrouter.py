import json

import httpx
import pytest

from app.config import Settings
from app.openrouter import OpenRouterClient


@pytest.mark.asyncio
async def test_completion_captures_provider_reasoning_and_usage() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        assert payload["reasoning"]["exclude"] is False
        return httpx.Response(
            200,
            json={
                "choices": [{
                    "message": {
                        "content": "A careful answer",
                        "reasoning": "Provider-visible reasoning",
                        "reasoning_details": [{"type": "reasoning.text", "text": "step"}],
                    },
                    "finish_reason": "stop",
                }],
                "usage": {
                    "prompt_tokens": 12,
                    "completion_tokens": 9,
                    "completion_tokens_details": {"reasoning_tokens": 4},
                    "cost": 0.002,
                },
            },
        )

    client = OpenRouterClient(
        Settings(openrouter_api_key="test", openrouter_base_url="https://example.test"),
        transport=httpx.MockTransport(handler),
    )
    result = await client.complete(
        model="provider/model",
        messages=[{"role": "user", "content": "hello"}],
        max_tokens=100,
        timeout_seconds=10,
    )
    await client.close()

    assert result.reasoning_state == "available"
    assert result.reasoning_tokens == 4
    assert result.prompt_tokens + result.completion_tokens == 21


def test_encrypted_reasoning_is_labeled_redacted() -> None:
    assert OpenRouterClient._reasoning_state(
        None, [{"type": "reasoning.encrypted", "data": "ciphertext"}]
    ) == "redacted"
