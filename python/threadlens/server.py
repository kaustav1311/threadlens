"""Self-hosted Threadlens API with per-IP rate limits and no persistence.

    pip install "threadlens[server]"      # add [deep] for ML models
    threadlens serve --host 0.0.0.0 --port 8000

Privacy: uploads are read into memory, analysed, and discarded. Nothing is written to disk and request bodies
are never logged. Put it behind HTTPS if it leaves localhost.
"""
from __future__ import annotations

import os
import threading
import time
from collections import defaultdict, deque

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

from . import __version__
from .metrics import Analyzer
from .parser import parse_chat, read_export
from .report import LENSES, findings, to_markdown

MAX_UPLOAD = int(os.getenv("THREADLENS_MAX_UPLOAD_MB", "10")) * 1024 * 1024
LIMITS = [  # (requests, seconds)
    (int(os.getenv("THREADLENS_RATE_PER_MIN", "5")), 60),
    (int(os.getenv("THREADLENS_RATE_PER_DAY", "100")), 86400),
]
DEEP_ENABLED = os.getenv("THREADLENS_DEEP", "0") == "1"
TRUST_PROXY = os.getenv("THREADLENS_TRUST_PROXY", "0") == "1"

app = FastAPI(title="Threadlens API", version=__version__, docs_url="/docs", redoc_url=None)
_analyzer = Analyzer()
_hits: dict[str, deque] = defaultdict(deque)
_lock = threading.Lock()


def _client_ip(req: Request) -> str:
    if TRUST_PROXY:
        fwd = req.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
    return req.client.host if req.client else "unknown"


def _rate_limit(ip: str):
    now = time.monotonic()
    longest = max(w for _, w in LIMITS)
    with _lock:
        q = _hits[ip]
        while q and now - q[0] > longest:
            q.popleft()
        for limit, window in LIMITS:
            recent = sum(1 for t in q if now - t <= window)
            if recent >= limit:
                oldest = next(t for t in q if now - t <= window)
                retry = int(window - (now - oldest)) + 1
                raise HTTPException(429, f"Rate limit: {limit} requests per {window}s. Retry in {retry}s.", headers={"Retry-After": str(retry)})
        q.append(now)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    return resp


@app.get("/healthz")
def healthz():
    return {"ok": True, "version": __version__, "deep": DEEP_ENABLED}


@app.post("/v1/analyse")
async def analyse(request: Request, file: UploadFile = File(...), lens: str = Form("overview"),
                  anonymise: bool = Form(True), deep: bool = Form(False)):
    _rate_limit(_client_ip(request))
    if lens not in LENSES:
        raise HTTPException(422, f"lens must be one of {list(LENSES)}")
    data = await file.read(MAX_UPLOAD + 1)
    await file.close()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, f"File too large. Limit is {MAX_UPLOAD // 1048576} MB; export without media.")
    try:
        res = _analyzer.analyse(parse_chat(read_export(data, file.filename or "")), anonymise=anonymise)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    finally:
        del data
    extra = None
    if deep:
        if not DEEP_ENABLED:
            raise HTTPException(400, "Deep models are disabled on this server (set THREADLENS_DEEP=1).")
        from .deep import run_deep

        extra = run_deep(res)
    out = {k: v for k, v in res.items() if not k.startswith("_")}
    return JSONResponse({"lens": lens, "findings": findings(res, lens), "markdown": to_markdown(res, lens, extra),
                         "result": _jsonable(out), "deep": extra})


def _jsonable(o):
    if isinstance(o, dict):
        return {k: _jsonable(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_jsonable(v) for v in o]
    return o.isoformat() if hasattr(o, "isoformat") else o
