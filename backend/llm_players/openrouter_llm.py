"""OpenRouter chat-completions client with the same generate() interface as LLMWrapper."""
import os
import re
import time

import requests

from llm_players.llm_constants import MODEL_NAME_KEY, MAX_TOKENS_KEY, TEMPERATURE_KEY, \
    REASONING_KEY, PROVIDER_KEY, OPENROUTER_API_KEY_KEYWORD

# overridable for proxies, and for selfcheck.py, which points it at a local fake server
BASE_URL = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
REQUEST_TIMEOUT = (10, 180)  # seconds to connect, seconds to answer (reasoning models are slow)
MAX_ATTEMPTS = 5
# a wrong key, no credits or an unknown model: no retry will fix these
MISCONFIGURED_STATUS_CODES = (401, 402, 404)
RETRYABLE_STATUS_CODES = (408, 429, 500, 502, 503, 504)
# After this many calls in a row with no answer, stop the process. The launcher then aborts
# the game instead of letting it run on, and cost money, with a seat that can't play.
MAX_CONSECUTIVE_FAILURES = 3
# OpenAI models reject a smaller output limit, and the scheduler asks for just a few tokens
MIN_MAX_TOKENS = 16
PER_SEAT_PARAMETERS = (TEMPERATURE_KEY, MAX_TOKENS_KEY, PROVIDER_KEY)
THINK_BLOCK_PATTERN = r"<think>(.*?)</think>"


class OpenRouterLLM:

    def __init__(self, logger, should_stop=lambda: False, **llm_config):
        self.logger = logger
        self.should_stop = should_stop  # the arena's Stop: no further attempts, no backoff wait
        self.model_name = llm_config[MODEL_NAME_KEY]
        self.api_key = os.environ.get(OPENROUTER_API_KEY_KEYWORD)
        if not self.api_key:
            raise RuntimeError(f"{OPENROUTER_API_KEY_KEYWORD} is not set")
        self.reasoning = llm_config.get(REASONING_KEY)
        # sent only when the seat's config sets them, so every model keeps its own defaults
        self.parameters = {key: llm_config[key] for key in PER_SEAT_PARAMETERS
                           if llm_config.get(key) is not None}
        # Reasoning tokens count against max_tokens, so a small limit leaves no room for the
        # answer. Never send one to a seat that reasons (see also the check in generate).
        self.send_max_tokens = self.reasoning is None
        self.consecutive_failures = 0

    def generate(self, input_text, system_info="", generation_parameters=None, kind=""):
        messages = [{"role": "system", "content": system_info}] if system_info else []
        messages.append({"role": "user", "content": input_text})
        body = {"model": self.model_name, "messages": messages, "usage": {"include": True},
                **self.parameters, **(generation_parameters or {})}
        if self.reasoning is not None:
            body[REASONING_KEY] = self.reasoning
        if not self.send_max_tokens:
            body.pop(MAX_TOKENS_KEY, None)
        elif MAX_TOKENS_KEY in body:
            body[MAX_TOKENS_KEY] = max(body[MAX_TOKENS_KEY], MIN_MAX_TOKENS)
        data = self._post_with_retries(body)
        if data is None:
            self.consecutive_failures += 1
            if self.consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                raise RuntimeError(f"{self.model_name}: {self.consecutive_failures} calls in a "
                                   f"row got no answer, see the log file")
            return ""  # the caller treats it as "wait" when scheduling and votes randomly
        self.consecutive_failures = 0
        choice = data["choices"][0]
        message = choice.get("message") or {}
        output = message.get("content") or ""
        reasoning = message.get("reasoning") or ""
        # some providers leave the reasoning inline; it must never reach the public chat
        inline_reasoning = " ".join(re.findall(THINK_BLOCK_PATTERN, output, flags=re.DOTALL))
        output = re.sub(THINK_BLOCK_PATTERN, "", output, flags=re.DOTALL)
        output = " ".join(output.split())  # the chat files hold one message per line
        if not output and choice.get("finish_reason") == "length" and MAX_TOKENS_KEY in body:
            # a model that reasons without being asked to has used up the limit on that
            self.logger.log("openrouter", "empty output at max_tokens: this model reasons by "
                                          "default, so this seat gets no max_tokens from now on")
            self.send_max_tokens = False
            return self.generate(input_text, system_info, generation_parameters, kind)
        self.logger.log_call(kind, output, reasoning or inline_reasoning.strip(),
                             data.get("usage"))
        return output

    def _post_with_retries(self, body):
        """Returns the response json, or None when every attempt failed."""
        headers = {"Authorization": f"Bearer {self.api_key}", "X-Title": "LLMafia"}
        for attempt in range(MAX_ATTEMPTS):
            if self.should_stop():
                break
            try:
                response = requests.post(f"{BASE_URL}/chat/completions", json=body,
                                         headers=headers, timeout=REQUEST_TIMEOUT)
                if response.status_code in MISCONFIGURED_STATUS_CODES:
                    raise RuntimeError(f"OpenRouter refused the request for {self.model_name} "
                                       f"({response.status_code}): {response.text[:500]}")
                data = response.json() if response.ok else {}
                if data.get("choices"):  # an error can also arrive inside a 200 response
                    return data
                error = f"{response.status_code}: {response.text[:500]}"
                is_retryable = response.ok or response.status_code in RETRYABLE_STATUS_CODES
            except (requests.RequestException, ValueError) as e:  # ValueError: body isn't json
                error, is_retryable = repr(e), True
            self.logger.log("error generating with OpenRouter", error)
            print(f"OpenRouter error for {self.model_name}: {error}", flush=True)
            if not is_retryable:
                break
            for _ in range(2 ** attempt * 10):  # in small steps, so a Stop ends the wait
                if self.should_stop():
                    return None
                time.sleep(0.1)
        return None
