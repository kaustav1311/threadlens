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
    a.add_argument("--md", type=Path, help="Write Markdown report here")
    a.add_argument("--json", type=Path, help="Write JSON results here")
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
    if args.deep:
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
    if not args.md:
        sys.stdout.write(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
