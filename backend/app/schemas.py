from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class Persona(BaseModel):
    identity: str = Field(min_length=1, max_length=120)
    background: str = Field(min_length=1, max_length=1000)
    traits: list[str] = Field(default_factory=list, max_length=12)
    secrets: list[str] = Field(default_factory=list, min_length=1, max_length=12)
    deception_strategy: str = Field(min_length=1, max_length=1000)


class Participant(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    model: str = Field(min_length=1, max_length=160)
    persona: Persona


class Budget(BaseModel):
    max_turns: int | None = Field(default=None, ge=2, le=500)
    max_tokens_per_turn: int = Field(default=1200, ge=64, le=16000)
    total_token_budget: int = Field(default=16000, ge=256, le=500000)
    request_timeout_seconds: int = Field(default=90, ge=5, le=600)
    wall_clock_seconds: int = Field(default=900, ge=30, le=86400)
    reasoning_effort: Literal[
        "none", "minimal", "low", "medium", "high", "xhigh", "max"
    ] = "medium"

    @field_validator("max_turns")
    @classmethod
    def require_even_turns(cls, value: int | None) -> int | None:
        if value is not None and value % 2:
            raise ValueError("max_turns must be even so each prompt receives a response")
        return value


class ExperimentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    participant_a: Participant
    participant_b: Participant
    judge_model: str = Field(min_length=1, max_length=160)
    budget: Budget = Field(default_factory=Budget)
    paired: bool = True

    @model_validator(mode="after")
    def distinct_models(self) -> "ExperimentCreate":
        if self.participant_a.name == self.participant_b.name:
            raise ValueError("Participant names must be distinct")
        return self


class MessageRead(BaseModel):
    id: int
    sequence: int
    role: str
    speaker_name: str
    model: str
    content: str
    reasoning: str | None
    reasoning_details: list[dict[str, Any]] | None
    reasoning_state: str
    prompt_tokens: int
    completion_tokens: int
    reasoning_tokens: int
    cost: float
    latency_ms: int
    finish_reason: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class RunRead(BaseModel):
    id: int
    experiment_id: int
    direction: str
    investigator_name: str
    investigator_model: str
    target_name: str
    target_model: str
    status: str
    stop_reason: str | None
    total_tokens: int
    total_cost: float
    final_guess: dict[str, Any] | None
    evaluation: dict[str, Any] | None
    error: str | None
    started_at: datetime | None
    finished_at: datetime | None
    messages: list[MessageRead] = []

    model_config = {"from_attributes": True}


class ExperimentRead(BaseModel):
    id: int
    name: str
    status: str
    config: dict[str, Any]
    created_at: datetime
    runs: list[RunRead] = []

    model_config = {"from_attributes": True}


class ExperimentSummary(BaseModel):
    id: int
    name: str
    status: str
    created_at: datetime
    run_count: int


class PersonaReveal(BaseModel):
    run_id: int
    investigator_persona: dict[str, Any]
    target_persona: dict[str, Any]
