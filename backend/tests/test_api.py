from fastapi.testclient import TestClient

from app.main import app


def persona(identity: str) -> dict:
    return {
        "identity": identity,
        "background": f"Background for {identity}",
        "traits": ["careful"],
        "secrets": [f"{identity}-secret"],
        "deception_strategy": "Offer a plausible alternative biography.",
    }


def test_create_paired_experiment_masks_personas_in_regular_response() -> None:
    payload = {
        "name": "API isolation test",
        "participant_a": {
            "name": "Claude",
            "model": "anthropic/test",
            "persona": persona("claude-private"),
        },
        "participant_b": {
            "name": "GPT",
            "model": "openai/test",
            "persona": persona("gpt-private"),
        },
        "judge_model": "judge/test",
        "paired": True,
        "budget": {"max_turns": 4},
    }
    with TestClient(app) as client:
        response = client.post("/api/experiments", json=payload)
        assert response.status_code == 201
        experiment = response.json()
        assert len(experiment["runs"]) == 2
        assert "persona" not in str(experiment["config"])
        assert "claude-private" not in response.text

        run_id = experiment["runs"][0]["id"]
        reveal = client.get(
            f"/api/experiments/{experiment['id']}/runs/{run_id}/personas"
        )
        assert reveal.status_code == 200
        assert "gpt-private" in reveal.text

        deleted = client.delete(f"/api/experiments/{experiment['id']}")
        assert deleted.status_code == 204
        assert client.get(f"/api/experiments/{experiment['id']}").status_code == 404
