"""The optional local-model backend. No server is required to run these."""
import os

import pytest

from threadlens.ollama import DEFAULT_HOST, OllamaUnavailable, rejudge_ledger, resolve_host, summarise


@pytest.mark.parametrize("value,expected", [
    ("", DEFAULT_HOST),
    # OLLAMA_HOST is a *bind* address, so these are the shapes it really takes.
    ("0.0.0.0", DEFAULT_HOST),
    ("0.0.0.0:11434", DEFAULT_HOST),
    ("::", DEFAULT_HOST),
    ("localhost:1234", "http://localhost:1234"),
    ("http://box:9", "http://box:9"),
])
def test_resolve_host(monkeypatch, value, expected):
    monkeypatch.setenv("OLLAMA_HOST", value)
    assert resolve_host() == expected


def test_resolve_host_never_leaves_the_machine_by_default(monkeypatch):
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    assert resolve_host().startswith("http://127.0.0.1")


def test_unreachable_server_raises_rather_than_hanging(monkeypatch):
    """A model that is not running must be a clean skip, not a crash or a stall."""
    res = {"rigor": {"ledger": [{"who": "A", "text": "the report says the backlog was 1,240 cases"}]}}
    # Port 1 is reserved and nothing listens there.
    with pytest.raises(OllamaUnavailable):
        rejudge_ledger(res, host="127.0.0.1:1")


def test_summarise_counts_agreement():
    rows = [{"agree": True}, {"agree": True}, {"agree": False}]
    s = summarise(rows)
    assert s == {"checked": 3, "agreed": 2, "disputed": 1, "agreement": 0.667}
    assert summarise([]) is None


def test_empty_ledger_needs_no_server():
    """Nothing to judge means nothing to ask, so this must not open a connection."""
    assert rejudge_ledger({"rigor": {"ledger": []}}, host="127.0.0.1:1") == []
