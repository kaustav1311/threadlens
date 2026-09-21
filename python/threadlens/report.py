"""Findings and Markdown report. Mirrors findings()/toMarkdown() in web/src/core.js."""
from __future__ import annotations

from datetime import datetime

from .metrics import MIN_WORDS_FOR_CLAIM

LENSES = {"overview": "Overview", "debate": "Debate", "personal": "Personal", "work": "Work"}
METRICS = [
    ("share", "Share of messages", "pct", {"overview", "personal", "work"}),
    ("words_per_msg", "Words per message", "num1", {"overview", "debate"}),
    ("question_rate", "Messages that ask a question", "pct", {"overview", "debate", "personal", "work"}),
    ("absolutist", "Absolutist words /100w", "rate", {"debate"}),
    ("hedge", "Hedging words /100w", "rate", {"debate"}),
    ("evidence", "Evidence words /100w", "rate", {"debate", "work"}),
    ("self", "I/me/my /100w", "rate", {"debate", "personal"}),
    ("other", "You/your /100w", "rate", {"debate", "personal"}),
    ("we", "We/us /100w", "rate", {"personal", "work"}),
    ("political_label", "Group labels /100w", "rate", {"debate"}),
    ("status", "Status put-downs /100w", "rate", {"debate"}),
    ("profanity", "Profanity /100w", "rate", {"overview", "debate"}),
    ("insult", "Insults /100w", "rate", {"debate", "personal"}),
    ("laugh", "Laughing emoji / lol", "int", {"overview", "debate"}),
    ("mock", "Mocking emoji / phrases", "int", {"debate"}),
    ("heat_mean", "Heat (hostility heuristic)", "num2", {"overview", "debate", "personal"}),
    ("sentiment", "Average tone (VADER)", "signed2", {"overview", "personal"}),
    ("affection", "Affection /100w", "rate", {"personal"}),
    ("apology", "Apologies /100w", "rate", {"personal", "work"}),
    ("politeness", "Please/thanks /100w", "rate", {"work", "personal"}),
    ("action", "Action words /100w", "rate", {"work"}),
    ("urgency", "Urgency words /100w", "rate", {"work"}),
    ("initiations", "Conversations started", "int", {"overview", "personal", "work"}),
    ("reply_median_min", "Median reply time", "mins", {"overview", "personal", "work"}),
    ("after_hours", "Sent before 9am / after 9pm", "pct", {"work", "personal"}),
]
MORAL = {"care": "Care / harm", "fairness": "Fairness / justice", "loyalty": "Loyalty / nation", "authority": "Authority / respect", "purity": "Purity / disgust"}
RHET = {"whataboutism": "Whataboutism", "false_dilemma": "False choice", "exit_or_concession": "Exit or concession",
        "unfalsifiable": "Unfalsifiable certainty", "evidence_request": "Asks for evidence", "personal_attack": "Personal attack"}


def fmt_mins(m):
    if m is None:
        return "—"
    if m < 1:
        return "<1 min"
    if m < 60:
        return f"{round(m)} min"
    if m < 1440:
        return f"{m / 60:.1f} h"
    return f"{m / 1440:.1f} d"


def fmt(v, f):
    if v is None:
        return "—"
    return {"pct": lambda: f"{round(v * 100)}%", "rate": lambda: f"{v:.2f}", "num1": lambda: f"{v:.1f}",
            "num2": lambda: f"{v:.2f}", "signed2": lambda: f"{v:+.2f}", "int": lambda: str(round(v)),
            "mins": lambda: fmt_mins(v)}[f]()


def _d(iso):
    return datetime.fromisoformat(iso).strftime("%d %b %Y")


def findings(res, lens):
    out = []
    S = [s for s in res["stats"] if s["name"] != "Others" and s["words"] >= MIN_WORDS_FOR_CLAIM]
    if len(S) < 2:
        return [f"Fewer than two people wrote {MIN_WORDS_FOR_CLAIM}+ words; comparisons are switched off."]
    a, b = S[:2]

    def cmp(key, phrase, floor=0.3):
        va, vb = a[key], b[key]
        if max(va, vb) < floor:
            return
        hi, lo = (a, b) if va > vb else (b, a)
        r = hi[key] / lo[key] if lo[key] else float("inf")
        if r < 1.4:
            return
        out.append(f"{hi['name']} {phrase} " + (f"where {lo['name']} uses none." if r == float("inf") else f"{r:.1f}× as often as {lo['name']}."))

    table = {
        "overview": [("question_rate", "asks questions", 0.05), ("profanity", "swears", 0.3), ("words_per_msg", "writes long messages", 3)],
        "debate": [("question_rate", "asks questions", 0.05), ("absolutist", "uses absolutist words", 0.3), ("evidence", "uses evidence words", 0.3),
                   ("political_label", "uses group labels", 0.1), ("status", "uses status put-downs", 0.1), ("insult", "uses insults", 0.1), ("profanity", "swears", 0.1)],
        "personal": [("affection", "uses affectionate words", 0.2), ("apology", "apologises", 0.1), ("question_rate", "asks questions", 0.05)],
        "work": [("politeness", "says please/thanks", 0.3), ("action", "uses action words", 0.3), ("urgency", "uses urgency words", 0.2)],
    }
    for k, ph, fl in table.get(lens, []):
        cmp(k, ph, fl)
    if lens in ("debate", "overview", "personal"):
        for s in (a, b):
            if s["heat_last"] > 0.12 and s["heat_last"] >= 2 * max(s["heat_first"], 0.03):
                out.append(f"{s['name']}'s heat rose from {s['heat_first']:.2f} (first third) to {s['heat_last']:.2f} (last third).")
    if lens == "debate":
        for s in (a, b):
            for r in s["reentries"][:2]:
                out.append(f"{s['name']} signalled an exit on {_d(r['exit'])}, then returned with a {r['words']}-word message on {_d(r['back'])}.")
    return out or ["No large differences in this lens."]


def to_markdown(res, lens, deep=None):
    names = [s["name"] for s in res["stats"]]
    md = [f"# Threadlens report: {LENSES[lens]} lens", "",
          f"{res['totals']['messages']} messages · {len(res['people'])} people · {_d(res['range']['from'])} to {_d(res['range']['to'])}", "",
          "## Findings", ""]
    md += [f"- {f}" for f in findings(res, lens)]
    md += ["", "## Measures", "", "| Measure | " + " | ".join(names) + " |", "|---|" + "|".join("---" for _ in names) + "|"]
    for key, label, f, lenses in METRICS:
        if lens in lenses:
            md.append(f"| {label} | " + " | ".join(fmt(s[key], f) for s in res["stats"]) + " |")
    if lens == "debate":
        md += ["", "## Moral vocabulary (/100 words)", "", "| Foundation | " + " | ".join(names) + " |", "|---|" + "|".join("---" for _ in names) + "|"]
        md += [f"| {v} | " + " | ".join(f"{s['moral'].get(k, 0):.2f}" for s in res["stats"]) + " |" for k, v in MORAL.items()]
        md += ["", "## Rhetorical cues", "", "| Cue | " + " | ".join(names) + " |", "|---|" + "|".join("---" for _ in names) + "|"]
        md += [f"| {v} | " + " | ".join(str(s["rhetoric"].get(k, 0)) for s in res["stats"]) + " |" for k, v in RHET.items()]
    if deep:
        md += ["", "## Deep models (local)", "", "| Measure | " + " | ".join(names) + " |", "|---|" + "|".join("---" for _ in names) + "|"]
        for key in deep["columns"]:
            md.append(f"| {key} | " + " | ".join(str(deep["per_person"].get(n, {}).get(key, "—")) for n in names) + " |")
        md += ["", "_" + deep["note"] + "_"]
    md += ["", "---", "Generated locally by Threadlens. Word-list heuristics, not a diagnosis."]
    return "\n".join(md) + "\n"
