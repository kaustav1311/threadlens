"""threadlens CLI.

    threadlens analyse chat.zip --lens debate --anon --md report.md --json report.json [--deep]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .metrics import Analyzer
from .parser import parse_chat, read_export
from .report import LENSES, to_markdown


def _json_default(o):
    return o.isoformat() if hasattr(o, "isoformat") else str(o)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="threadlens", description="Private analysis of WhatsApp chat exports. Runs locally.")
    ap.add_argument("--version", action="version", version=__version__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("analyse", aliases=["analyze"], help="Analyse an export (.txt, .zip, .docx)")
    a.add_argument("file", type=Path)
    a.add_argument("--lens", choices=list(LENSES), default="overview")
    a.add_argument("--anon", action="store_true", help="Replace names with Person A, B…")
    a.add_argument("--date-order", choices=["auto", "DMY", "MDY", "YMD"], default="auto")
    a.add_argument("--deep", action="store_true", help="Add local ML models (needs: pip install 'threadlens[deep]')")
    a.add_argument("--backend", choices=["hf", "ollama"], default="hf",
                   help="Which local models --deep should use. 'hf' is Detoxify + the fallacy and NLI "
                        "models; 'ollama' asks a model already running on this machine to re-judge the "
                        "claim ledger. Both are offline; neither decides whether a claim is true.")
    a.add_argument("--model", default=None, help="Model name for --backend ollama (default: qwen2.5:3b)")
    a.add_argument("--ollama-host", default=None,
                   help="Where the local ollama server is (default: $OLLAMA_HOST, else http://127.0.0.1:11434)")
    a.add_argument("--md", type=Path, help="Write Markdown report here")
    a.add_argument("--json", type=Path, help="Write JSON results here")
    a.add_argument("--ledger", type=Path, help="Write the Rigor claim ledger as JSON, for a human or an LLM to verify. "
                                               "Threadlens never labels a claim true or false itself.")
    s = sub.add_parser("serve", help="Run the self-hosted API (needs: pip install 'threadlens[server]')")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)
    args = ap.parse_args(argv)

    if args.cmd == "serve":
        import uvicorn  # type: ignore

        uvicorn.run("threadlens.server:app", host=args.host, port=args.port, access_log=False)
        return 0

    text = read_export(args.file.read_bytes(), args.file.name)
    res = Analyzer().analyse(parse_chat(text, args.date_order), anonymise=args.anon)
    deep = None
    if args.deep and args.backend == "ollama":
        # A second opinion from a model already running on this machine, on the one
        # judgement a word list cannot make: assertion versus strongly-worded opinion.
        from .ollama import DEFAULT_MODEL, OllamaUnavailable, rejudge_ledger, summarise

        model = args.model or DEFAULT_MODEL
        try:
            rejudged = rejudge_ledger(res, model=model, host=args.ollama_host)
        except OllamaUnavailable as e:
            # A model that is not running must not cost you the rest of the report.
            sys.stderr.write(f"ollama backend skipped: {e}\n")
        else:
            deep = {"backend": "ollama", "model": model,
                    "ledger_review": rejudged, "agreement": summarise(rejudged)}
    elif args.deep:
        from .deep import run_deep

        deep = run_deep(res)
    md = to_markdown(res, args.lens, deep)
    if args.md:
        args.md.write_text(md, "utf-8")
    if args.json:
        out = {k: v for k, v in res.items() if not k.startswith("_")}
        if deep:
            out["deep"] = deep
        args.json.write_text(json.dumps(out, default=_json_default, indent=1), "utf-8")
    if args.ledger:
        args.ledger.write_text(json.dumps(
            {"topic_terms": res["rigor"]["topic_terms"], "ledger": res["rigor"]["ledger"],
             "unanswered": res["rigor"]["unanswered"]},
            default=_json_default, indent=1), "utf-8")
    if not args.md:
        sys.stdout.write(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
