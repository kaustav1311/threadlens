"""Findings and Markdown report. Mirrors findings()/toMarkdown() in web/src/core.js."""
from __future__ import annotations

from datetime import datetime

from .metrics import MIN_WORDS_FOR_CLAIM
from .rigor import RIGOR_ANSWER_WINDOW, RIGOR_LABELS, RIGOR_WEIGHTS

LENSES = {"overview": "Overview", "debate": "Debate", "personal": "Personal", "work": "Work", "rigor": "Rigor"}
METRICS = [
    ("share", "Share of messages", "pct", {"overview", "personal", "work"}),
    ("words_per_msg", "Words per message", "num1", {"overview", "debate"}),
    ("question_rate", "Messages that ask a question", "pct", {"overview", "debate", "personal", "work", "rigor"}),
    ("absolutist", "Absolutist words /100w", "rate", {"debate", "rigor"}),
    ("hedge", "Hedging words /100w", "rate", {"debate", "rigor"}),
    ("evidence", "Evidence words /100w", "rate", {"debate", "work", "rigor"}),
    ("self", "I/me/my /100w", "rate", {"debate", "personal"}),
    ("other", "You/your /100w", "rate", {"debate", "personal"}),
    ("we", "We/us /100w", "rate", {"personal", "work"}),
    ("political_label", "Group labels /100w", "rate", {"debate", "rigor"}),
    ("status", "Status put-downs /100w", "rate", {"debate", "rigor"}),
    ("profanity", "Profanity /100w", "rate", {"overview", "debate"}),
    ("insult", "Insults /100w", "rate", {"debate", "personal", "rigor"}),
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


def rigor_findings(res):
    """Conduct only: never a verdict on the position argued. Mirrors rigorFindings() in core.js."""
    out = []
    G = res.get("rigor")
    if not G:
        return out
    ranked = sorted((p for p in G["people"].values() if p["score"] is not None and p["name"] != "Others"),
                    key=lambda p: -p["score"])
    if len(ranked) < 2:
        return ["Rigor needs at least two people with enough text to compare."]
    hi, lo = ranked[0], ranked[1]
    out.append(f"{hi['name']} scores {round(hi['score'])}/100 against {lo['name']}'s {round(lo['score'])}. "
               "This measures how the case was made \u2014 sourcing, answering, staying on topic, conduct \u2014 "
               "not whether either position is correct.")
    worst, gap = None, 0.0
    for k in RIGOR_WEIGHTS:
        a, b = hi["components"][k], lo["components"][k]
        if a is None or b is None:
            continue
        if abs(a - b) > gap:
            gap, worst = abs(a - b), k
    if worst and gap >= 0.15:
        a, b = hi["components"][worst], lo["components"][worst]
        lead, trail = (hi, lo) if a > b else (lo, hi)
        out.append(f"The widest gap is {RIGOR_LABELS[worst].lower()}: {lead['name']} {max(a, b):.2f} "
                   f"against {trail['name']}'s {min(a, b):.2f}.")
    for p in ranked[:2]:
        missed = p["questions_put_to_them"] - p["questions_answered"]
        if p["questions_put_to_them"] >= 3 and missed >= 2:
            out.append(f"{missed} of the {p['questions_put_to_them']} direct questions put to {p['name']} "
                       f"were never engaged with in the following {RIGOR_ANSWER_WINDOW} messages.")
        if p["claims"] >= 4 and p["vague_claims"] / p["claims"] >= 0.6:
            out.append(f"{p['vague_claims']} of {p['name']}'s {p['claims']} factual claims carry no link, "
                       "date, number or named source.")
        if p["goalposts"]:
            out.append(f"{p['name']} swerved off the opening topic right after being challenged "
                       f"{len(p['goalposts'])} time{'' if len(p['goalposts']) == 1 else 's'}.")
        if p["self_corrections"]:
            out.append(f"{p['name']} explicitly corrected an earlier claim {p['self_corrections']} "
                       f"time{'' if p['self_corrections'] == 1 else 's'}.")
    out.append("Rigor scores how an argument was made, never which side is right. The same word lists "
               "and thresholds run against everyone.")
    return out


def findings(res, lens):
    out = []
    if lens == "rigor":
        return rigor_findings(res)
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
    if lens == "rigor" and res.get("rigor"):
        G = res["rigor"]
        ns = [n for n in names if G["people"].get(n, {}).get("score") is not None]
        md += ["", "## Rigor scores", "", "| Component | Weight | " + " | ".join(ns) + " |",
               "|---|---|" + "|".join("---" for _ in ns) + "|",
               "| **Score /100** | 100 | " + " | ".join(str(round(G["people"][n]["score"])) for n in ns) + " |"]
        for k, w in RIGOR_WEIGHTS.items():
            md.append(f"| {RIGOR_LABELS[k]} | {w} | " + " | ".join(
                ("n/a" if G["people"][n]["components"][k] is None else f"{G['people'][n]['components'][k]:.2f}")
                for n in ns) + " |")
        md += ["", "Components that do not apply are marked n/a and drop out of the weighted average.",
               "", "Opening topic: " + ", ".join(G["topic_terms"])]
        if G["ledger"]:
            md += ["", "## Claim ledger", "", "| Who | When | Claim | Status | Challenged | Answered |",
                   "|---|---|---|---|---|---|"]
            for cl in G["ledger"][:40]:
                md.append(f"| {cl['who']} | {_d(cl['date'])} | {cl['text'].replace('|', chr(92) + '|')[:120]} | "
                          f"{cl['status']} | {'yes' if cl['challenged'] else '-'} | {'yes' if cl['answered'] else '-'} |")
        if G["unanswered"]:
            md += ["", "## Questions that never got an answer", ""]
            md += [f"- **{q['who']}**, {_d(q['date'])}: {q['text']}" for q in G["unanswered"][:20]]
    if deep:
        md += ["", "## Deep models (local)", "", "| Measure | " + " | ".join(names) + " |", "|---|" + "|".join("---" for _ in names) + "|"]
        for key in deep["columns"]:
            md.append(f"| {key} | " + " | ".join(str(deep["per_person"].get(n, {}).get(key, "—")) for n in names) + " |")
        md += ["", "_" + deep["note"] + "_"]
    md += ["", "---", "Generated locally by Threadlens. Word-list heuristics, not a diagnosis."]
    return "\n".join(md) + "\n"
