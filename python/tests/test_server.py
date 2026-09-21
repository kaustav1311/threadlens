from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from threadlens import server  # noqa: E402

SAMPLE = (Path(__file__).resolve().parents[2] / "samples/sample_debate_android.txt").read_bytes()


def test_analyse_and_rate_limit():
    server._hits.clear()
    c = TestClient(server.app)
    ok = c.post("/v1/analyse", files={"file": ("chat.txt", SAMPLE)}, data={"lens": "debate"})
    assert ok.status_code == 200
    body = ok.json()
    assert body["findings"] and "Person A" in body["result"]["people"]
    codes = [c.post("/v1/analyse", files={"file": ("chat.txt", SAMPLE)}).status_code for _ in range(6)]
    assert 429 in codes


def test_rejects_large_upload():
    server._hits.clear()
    c = TestClient(server.app)
    big = b"x" * (server.MAX_UPLOAD + 10)
    assert c.post("/v1/analyse", files={"file": ("chat.txt", big)}).status_code == 413
