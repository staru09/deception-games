import time

import pytest

from app.db import Experiment, Message, Run, SessionLocal, init_db
from app.openrouter import Completion, OpenRouterClient
from app.orchestrator import EventBroker, ExperimentOrchestrator
from app.schemas import Budget


def make_run() -> Run:
    run = Run(
        experiment_id=1,
        direction="A → B",
        investigator_name="A",
        investigator_model="a/model",
        investigator_persona={"identity": "private-a", "secrets": ["alpha"]},
        target_name="B",
        target_model="b/model",
        target_persona={"identity": "private-b", "secrets": ["beta"]},
    )
    run.messages = [
        Message(
            sequence=1,
            role="investigator",
            speaker_name="A",
            model="a/model",
            content="Visible question",
            reasoning="must-never-cross",
        )
    ]
    return run


def test_prompt_isolation_uses_only_speakers_own_persona_and_visible_content() -> None:
    run = make_run()
    messages = ExperimentOrchestrator._model_messages(
        run, "B", run.target_persona, is_investigator=False
    )
    serialized = str(messages)
    assert "private-b" in serialized
    assert "private-a" not in serialized
    assert "Visible question" in serialized
    assert "must-never-cross" not in serialized


def test_judge_schema_validation_rejects_out_of_range_scores() -> None:
    with pytest.raises(ValueError, match="concealment"):
        ExperimentOrchestrator._validate_evaluation({
            "extraction_success": 10,
            "concealment": 101,
            "misdirection": 50,
            "judge_confidence": 80,
        })


@pytest.mark.asyncio
async def test_total_token_budget_stops_a_run() -> None:
    await init_db()
    async with SessionLocal() as session:
        experiment = Experiment(
            name="budget-test",
            status="running",
            config={"budget": Budget().model_dump(), "judge_model": "judge/model"},
        )
        session.add(experiment)
        await session.flush()
        run = Run(
            experiment_id=experiment.id,
            direction="A → B",
            investigator_name="A",
            investigator_model="a/model",
            investigator_persona={},
            target_name="B",
            target_model="b/model",
            target_persona={},
            status="running",
            total_tokens=500,
        )
        session.add(run)
        await session.commit()
        run_id = run.id

    client = OpenRouterClient()
    orchestrator = ExperimentOrchestrator(client, EventBroker())
    reason = await orchestrator._budget_stop_reason(
        run_id,
        Budget(total_token_budget=256),
        time.monotonic(),
    )
    await client.close()
    assert reason == "token_budget"


@pytest.mark.asyncio
async def test_run_orders_turns_persists_guess_and_validates_judge() -> None:
    class FakeClient:
        def __init__(self) -> None:
            self.dialogue_calls = 0

        async def complete(self, **kwargs) -> Completion:
            prompt = str(kwargs["messages"])
            if kwargs.get("json_mode") and "impartial evaluator" in prompt:
                return Completion(
                    content=(
                        '{"extraction_success": 20, "concealment": 80, '
                        '"misdirection": 70, "judge_confidence": 90, '
                        '"rationale": "The target held.", "evidence_message_ids": []}'
                    ),
                    prompt_tokens=10,
                    completion_tokens=10,
                )
            if kwargs.get("json_mode"):
                return Completion(
                    content=(
                        '{"identity": "guess", "background": "guess", "traits": [], '
                        '"secrets": [], "confidence": 0.2, "evidence_message_ids": []}'
                    ),
                    prompt_tokens=10,
                    completion_tokens=10,
                )
            self.dialogue_calls += 1
            return Completion(
                content=f"visible turn {self.dialogue_calls}",
                prompt_tokens=10,
                completion_tokens=10,
            )

    await init_db()
    budget = Budget(max_turns=2, total_token_budget=10000)
    async with SessionLocal() as session:
        experiment = Experiment(
            name="full-run-test",
            status="running",
            config={"budget": budget.model_dump(), "judge_model": "judge/model"},
        )
        session.add(experiment)
        await session.flush()
        run = Run(
            experiment_id=experiment.id,
            direction="A → B",
            investigator_name="A",
            investigator_model="a/model",
            investigator_persona={"identity": "A"},
            target_name="B",
            target_model="b/model",
            target_persona={"identity": "B"},
        )
        session.add(run)
        await session.commit()
        run_id = run.id

    fake = FakeClient()
    orchestrator = ExperimentOrchestrator(fake, EventBroker())  # type: ignore[arg-type]
    await orchestrator._execute_run(run_id)

    async with SessionLocal() as session:
        saved = await session.get(Run, run_id)
        assert saved is not None
        await session.refresh(saved, ["messages"])
        assert [message.role for message in saved.messages] == [
            "investigator",
            "target",
            "final_guess",
        ]
        assert saved.status == "completed"
        assert saved.final_guess["identity"] == "guess"
        assert saved.evaluation["concealment"] == 80
