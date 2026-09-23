"""Optional second opinion from a model running on this machine.

The heuristics in rigor.py can tell an assertion from a plan or a piece of advice
most of the time. What they cannot do is tell an assertion from a strongly-worded
opinion -- "it was violence for a political cause" is a claim, "it is political in
every way" is not, and no word list sees the difference. That gap is what this is
for, and it is the only thing it is for.

Rules this file keeps to:

* **Local only.** It talks to an ollama server on the loopback interface. There is
  no cloud backend and no API key, and the default host is 127.0.0.1.
* **Off by default.** Nothing calls this unless `--backend ollama` was asked for.
* **It never decides whether a claim is TRUE.** It re-judges what *kind* of
  sentence something is. Truth stays the reader's job, which is the whole premise
  of the claim ledger.
* **The web app never reaches this.** dist/index.html has `connect-src 'none'` and
  cannot call anything, by construction.

Model output is advisory: every re-judged item keeps the heuristic's verdict
alongside, so a reader can see where the two disagreed rather than being handed a
single answer with no provenance.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

DEFAULT_MODEL = "qwen2.5:3b"
DEFAULT_HOST = "http://127.0.0.1:11434"
BATCH = 8
TIMEOUT_S = 180


def resolve_host(host: str | None = None) -> str:
    """Normalise an ollama host into something a client can actually fetch.

    OLLAMA_HOST is a *bind* address for the server and is commonly `0.0.0.0` or a
    bare `host:port`, neither of which is a URL.
    """
    h = (host or os.environ.get("OLLAMA_HOST") or "").strip()
    if not h:
        return DEFAULT_HOST
    if "://" not in h:
        h = "http://" + h
    from urllib.parse import urlsplit, urlunsplit

    try:
        parts = urlsplit(h)
        hostname = parts.hostname or "127.0.0.1"
        port = parts.port or 11434
        scheme = parts.scheme or "http"
    except ValueError:
        # A bind address like "::" is not a URL at all. Loopback is the safe read.
        return DEFAULT_HOST
    if hostname in ("0.0.0.0", "::", ""):
        hostname = "127.0.0.1"
    return urlunsplit((scheme, f"{hostname}:{port}", "", "", ""))


class OllamaUnavailable(RuntimeError):
    """The local server is not reachable. Callers fall back to the heuristics."""


def _chat(host: str, model: str, system: str, user: str) -> dict:
    body = json.dumps({
        "model": model,
        "stream": False,
        "format": "json",
        # Temperature 0 so the same ledger judged twice gives the same answer.
        "options": {"temperature": 0, "num_ctx": 4096},
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }).encode()
    req = urllib.request.Request(host + "/api/chat", data=body,
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            out = json.loads(r.read().decode())
    except (urllib.error.URLError, OSError) as e:
        raise OllamaUnavailable(f"could not reach ollama at {host}: {e}") from e
    if out.get("error"):
        raise OllamaUnavailable(str(out["error"]))
    return json.loads(out["message"]["content"])


CLAIM_SYSTEM = """You label sentences from a private chat for a linguistics dataset.
The chat may mix English with romanised Bengali or Hindi.
You label discourse function ONLY. Never judge the people, their politics, or whether anything is true.

For each numbered sentence answer ONE question: does it ASSERT A FACT ABOUT THE WORLD that a third party could in principle go and verify?

"yes" -- a statement about the world, outside these two people's own arrangements.
"no"  -- plans, intentions, advice, requests, opinions, feelings, evaluations,
         talk about the conversation itself, or the speakers' own arrangements.

Reply with JSON only: {"labels":[{"i":0,"v":"yes"},{"i":1,"v":"no"}]}
One object per input sentence, matching "i"."""


def rejudge_ledger(res, model: str = DEFAULT_MODEL, host: str | None = None, limit: int = 400):
    """Ask a local model whether each ledger entry really is a claim.

    Returns a list of {who, text, heuristic, model, agree}. Nothing is overwritten:
    the point is to show where a word list and a language model part company, which
    is where the ledger is least trustworthy.
    """
    host = resolve_host(host)
    ledger = (res.get("rigor") or {}).get("ledger") or []
    items = ledger[:limit]
    out = []
    for start in range(0, len(items), BATCH):
        batch = items[start:start + BATCH]
        numbered = "\n".join(f"{i}. {c['text'][:300]}" for i, c in enumerate(batch))
        try:
            parsed = _chat(host, model, CLAIM_SYSTEM, numbered)
        except OllamaUnavailable:
            raise
        except Exception:
            continue
        rows = parsed if isinstance(parsed, list) else parsed.get("labels", [])
        got = {}
        for r in rows:
            try:
                i = int(r["i"])
            except (KeyError, TypeError, ValueError):
                continue
            if 0 <= i < len(batch) and r.get("v") in ("yes", "no"):
                got[i] = r["v"]
        for i, c in enumerate(batch):
            v = got.get(i)
            if v is None:
                continue
            out.append({
                "who": c["who"],
                "text": c["text"],
                # The heuristic put it in the ledger, so its verdict is always "yes".
                "heuristic": "yes",
                "model": v,
                "agree": v == "yes",
            })
    return out


def summarise(rejudged):
    """A one-line read on how far the two tiers agree, for the report."""
    if not rejudged:
        return None
    agreed = sum(1 for r in rejudged if r["agree"])
    return {
        "checked": len(rejudged),
        "agreed": agreed,
        "disputed": len(rejudged) - agreed,
        "agreement": round(agreed / len(rejudged), 3),
    }
