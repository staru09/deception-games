import json
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from .config import get_settings
from .db import Experiment, Run, SessionLocal, get_session, init_db
from .openrouter import OpenRouterClient, OpenRouterError
from .orchestrator import EventBroker, ExperimentOrchestrator
from .schemas import (
    ExperimentCreate,
    ExperimentRead,
    ExperimentSummary,
    PersonaReveal,
)

settings = get_settings()
broker = EventBroker()
openrouter = OpenRouterClient(settings)
orchestrator = ExperimentOrchestrator(openrouter, broker)
SessionDep = Annotated[AsyncSession, Depends(get_session)]


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    async with SessionLocal() as session:
        await session.execute(
            update(Run)
            .where(Run.status == "running")
            .values(status="stopped", stop_reason="server_restart")
        )
        await session.execute(
            update(Experiment)
            .where(Experiment.status.in_(("running", "stopping")))
            .values(status="stopped")
        )
        await session.commit()
    yield
    await orchestrator.shutdown()
    await openrouter.close()


app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.app_url, "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict[str, str | bool]:
    return {
        "status": "ok",
        "openrouter_configured": bool(settings.openrouter_api_key),
    }


@app.get("/api/models")
async def models() -> list[dict]:
    try:
        return await openrouter.list_models()
    except OpenRouterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/api/experiments", response_model=ExperimentRead, status_code=201)
async def create_experiment(
    payload: ExperimentCreate,
    session: SessionDep,
) -> Experiment:
    safe_config = {
        "budget": payload.budget.model_dump(),
        "judge_model": payload.judge_model,
        "paired": payload.paired,
        "participants": [
            {"name": payload.participant_a.name, "model": payload.participant_a.model},
            {"name": payload.participant_b.name, "model": payload.participant_b.model},
        ],
    }
    experiment = Experiment(name=payload.name, status="draft", config=safe_config)
    session.add(experiment)
    await session.flush()
    pairs = [(payload.participant_a, payload.participant_b)]
    if payload.paired:
        pairs.append((payload.participant_b, payload.participant_a))
    for investigator, target in pairs:
        session.add(
            Run(
                experiment_id=experiment.id,
                direction=f"{investigator.name} → {target.name}",
                investigator_name=investigator.name,
                investigator_model=investigator.model,
                investigator_persona=investigator.persona.model_dump(),
                target_name=target.name,
                target_model=target.model,
                target_persona=target.persona.model_dump(),
            )
        )
    await session.commit()
    result = await session.execute(
        select(Experiment)
        .options(selectinload(Experiment.runs).selectinload(Run.messages))
        .where(Experiment.id == experiment.id)
    )
    return result.scalar_one()


@app.get("/api/experiments", response_model=list[ExperimentSummary])
async def list_experiments(
    session: SessionDep,
) -> list[ExperimentSummary]:
    result = await session.execute(
        select(
            Experiment.id,
            Experiment.name,
            Experiment.status,
            Experiment.created_at,
            func.count(Run.id).label("run_count"),
        )
        .outerjoin(Run)
        .group_by(Experiment.id)
        .order_by(Experiment.created_at.desc())
    )
    return [ExperimentSummary.model_validate(row._mapping) for row in result]


@app.get("/api/experiments/{experiment_id}", response_model=ExperimentRead)
async def get_experiment(
    experiment_id: int,
    session: SessionDep,
) -> Experiment:
    result = await session.execute(
        select(Experiment)
        .options(selectinload(Experiment.runs).selectinload(Run.messages))
        .where(Experiment.id == experiment_id)
    )
    experiment = result.scalar_one_or_none()
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    return experiment


@app.delete("/api/experiments/{experiment_id}", status_code=204)
async def delete_experiment(
    experiment_id: int,
    session: SessionDep,
) -> Response:
    experiment = await session.get(Experiment, experiment_id)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    if experiment.status in {"queued", "running", "stopping"}:
        raise HTTPException(
            status_code=409,
            detail="Stop the experiment before deleting it.",
        )
    await session.delete(experiment)
    await session.commit()
    return Response(status_code=204)


@app.post("/api/experiments/{experiment_id}/start", status_code=202)
async def start_experiment(
    experiment_id: int,
    session: SessionDep,
) -> dict[str, str]:
    experiment = await session.get(Experiment, experiment_id)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    if experiment.status not in {"draft", "stopped", "failed"}:
        raise HTTPException(
            status_code=409, detail=f"Cannot start experiment in {experiment.status} state"
        )
    if experiment.status != "draft":
        raise HTTPException(
            status_code=409,
            detail="Historical experiments are immutable; create a new experiment to rerun.",
        )
    experiment.status = "queued"
    await session.commit()
    orchestrator.start(experiment_id)
    return {"status": "queued"}


@app.post("/api/experiments/{experiment_id}/stop", status_code=202)
async def stop_experiment(experiment_id: int) -> dict[str, str]:
    await orchestrator.stop(experiment_id)
    return {"status": "stopping"}


@app.get(
    "/api/experiments/{experiment_id}/runs/{run_id}/personas",
    response_model=PersonaReveal,
)
async def reveal_personas(
    experiment_id: int,
    run_id: int,
    session: SessionDep,
) -> PersonaReveal:
    run = await session.get(Run, run_id)
    if not run or run.experiment_id != experiment_id:
        raise HTTPException(status_code=404, detail="Run not found")
    return PersonaReveal(
        run_id=run.id,
        investigator_persona=run.investigator_persona,
        target_persona=run.target_persona,
    )


@app.get("/api/experiments/{experiment_id}/events")
async def experiment_events(experiment_id: int) -> EventSourceResponse:
    async def events():
        async for event in broker.subscribe(experiment_id):
            yield {"event": event["type"], "data": json.dumps(event)}

    return EventSourceResponse(events(), ping=15)
