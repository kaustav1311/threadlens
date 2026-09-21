"""Scoring. Mirrors web/src/core.js so the CLI, API and web app agree."""
from __future__ import annotations

import json
import math
import re
import statistics
from collections import defaultdict
from importlib import resources

GAP_HOURS_FOR_INITIATION = 6
MIN_WORDS_FOR_CLAIM = 150
NEGATORS = {"not", "no", "never", "nahi", "nahin", "na", "don't", "dont", "isn't", "isnt", "wasn't", "can't", "cant", "won't", "without"}


def load_lexicons():
    d = resources.files("threadlens") / "data"
    return json.loads((d / "lexicons.json").read_text("utf-8")), json.loads((d / "vader.json").read_text("utf-8"))


def _tokens(lower: str):
    return [t for t in re.findall(r"[\w']+", lower) if t.replace("_", "")]


class _List:
    def __init__(self, items, is_regex=False):
        self.words, self.phrases, self.emoji = set(), [], []
        for raw in items:
            w = raw.lower()
            if is_regex:
                self.phrases.append(re.compile(r"(?:^|[^\w])" + w + r"(?!\w)", re.I))
            elif not re.search(r"[\w']", w):
                self.emoji.append(w)
            elif re.search(r"[\s-]", w):
                self.phrases.append(re.compile(r"(?:^|[^\w])" + re.escape(w) + r"(?!\w)", re.I))
            else:
                self.words.add(w)

    def count(self, tokens, lower):
        n = sum(1 for t in tokens if t in self.words) if self.words else 0
        n += sum(len(p.findall(lower)) for p in self.phrases)
        n += sum(lower.count(e) for e in self.emoji)
        return n


def _list_of(v):
    """A lexicon entry is either a flat list or a dict of tagged lists (e.g. political_label)."""
    return v if isinstance(v, list) else [w for tag in v.values() for w in tag]


class Analyzer:
    def __init__(self, lex=None, vader=None):
        if lex is None:
            lex, vader = load_lexicons()
        self.vader = vader
        self.L = {k: _List(_list_of(v)) for k, v in lex.items()
                  if not k.startswith("_") and k not in ("moral", "rhetoric", "rigor")}
        self.MORAL = {k: _List(v) for k, v in lex["moral"].items()}
        self.RHET = {k: _List(v, True) for k, v in lex["rhetoric"].items()}
        # imported here, not at module level: rigor.py imports helpers from this module
        from .rigor import compile_rigor

        self.R = compile_rigor(lex)

    def sentiment(self, tokens):
        s = 0.0
        for i, t in enumerate(tokens):
            v = self.vader.get(t)
            if v is None:
                continue
            if any(x in NEGATORS for x in tokens[max(0, i - 3):i]):
                v *= -0.74
            s += v
        return s / math.sqrt(s * s + 15)

    def score_message(self, text: str):
        lower = text.lower()
        tokens = _tokens(lower)
        c = {k: l.count(tokens, lower) for k, l in self.L.items()}
        moral = {k: l.count(tokens, lower) for k, l in self.MORAL.items()}
        rhet = {k: l.count(tokens, lower) for k, l in self.RHET.items()}
        caps = len(re.findall(r"\b[A-Z]{3,}\b", text))
        raw = (c["profanity"] + c["insult"] + 0.6 * c["political_label"] + 0.4 * c["status_hierarchy"]
               + 1.2 * rhet["personal_attack"] + 0.3 * c["mock"]
               + (0.5 if len(tokens) > 3 and caps / len(tokens) > 0.5 else 0))
        heat = 1 - math.exp(-raw * 3 / math.sqrt(max(len(tokens), 6))) if raw else 0.0
        return {"words": len(tokens), "c": c, "moral": moral, "rhet": rhet, "caps": caps,
                "question": 1 if "?" in text else 0, "heat": heat, "sent": self.sentiment(tokens)}

    def analyse(self, parsed, anonymise=False, max_people=8):
        msgs = sorted(parsed["messages"], key=lambda m: m.date)
        if not msgs:
            raise ValueError("No messages found. Check that this is a WhatsApp chat export.")
        counts = defaultdict(int)
        for m in msgs:
            counts[m.author] += 1
        names = sorted(counts, key=lambda n: -counts[n])
        alias = {n: (f"Person {chr(65 + i)}" if anonymise else n) for i, n in enumerate(names)}
        label = lambda n: "Others" if names.index(n) >= max_people else alias[n]  # noqa: E731
        people = list(dict.fromkeys(label(n) for n in names))
        P = {p: {"messages": 0, "text": 0, "words": 0, "media": 0, "deleted": 0, "edited": 0, "c": defaultdict(int),
                 "moral": defaultdict(int), "rhet": defaultdict(int), "caps": 0, "q": 0, "heat": [], "sent": [],
                 "reply": [], "init": 0, "hours": [0] * 24, "examples": defaultdict(list), "last_exit": None, "reentries": []}
             for p in people}
        by_day = defaultdict(lambda: defaultdict(lambda: {"n": 0, "heat": [], "sent": []}))
        prev, scored = None, []
        for m in msgs:
            who = label(m.author)
            p = P[who]
            p["messages"] += 1
            p["hours"][m.date.hour] += 1
            p["media"] += m.kind == "media"
            p["deleted"] += m.kind == "deleted"
            p["edited"] += bool(m.edited)
            gap = (m.date - prev.date).total_seconds() / 3600 if prev else math.inf
            if gap >= GAP_HOURS_FOR_INITIATION:
                p["init"] += 1
            elif label(prev.author) != who:
                p["reply"].append((m.date - prev.date).total_seconds() / 60)
            prev = m
            day = by_day[m.date.strftime("%Y-%m-%d")][who]
            day["n"] += 1
            if m.kind != "text":
                continue
            s = self.score_message(m.text)
            scored.append((who, m, s))
            p["text"] += 1
            p["words"] += s["words"]
            p["caps"] += s["caps"]
            p["q"] += s["question"]
            p["heat"].append(s["heat"]); p["sent"].append(s["sent"])
            day["heat"].append(s["heat"]); day["sent"].append(s["sent"])
            for k, v in s["c"].items():
                p["c"][k] += v
            for k, v in s["moral"].items():
                p["moral"][k] += v
            for k, v in s["rhet"].items():
                if v:
                    p["rhet"][k] += v
                    if len(p["examples"][k]) < 3:
                        p["examples"][k].append({"date": m.date.isoformat(), "text": m.text[:220]})
            if s["rhet"]["exit_or_concession"]:
                p["last_exit"] = m.date
            elif p["last_exit"] and s["words"] >= 60 and (m.date - p["last_exit"]).total_seconds() > 3600:
                p["reentries"].append({"exit": p["last_exit"].isoformat(), "back": m.date.isoformat(), "words": s["words"]})
                p["last_exit"] = None

        mean = lambda a: sum(a) / len(a) if a else 0.0  # noqa: E731
        stats = []
        for n in people:
            p = P[n]
            per = lambda x: 100 * x / p["words"] if p["words"] else 0.0  # noqa: E731,B023
            third = max(1, len(p["heat"]) // 3)
            stats.append({
                "name": n, "messages": p["messages"], "text_messages": p["text"], "words": p["words"],
                "words_per_msg": p["words"] / p["text"] if p["text"] else 0.0,
                "share": p["messages"] / len(msgs),
                "question_rate": p["q"] / p["text"] if p["text"] else 0.0,
                **{k: per(p["c"][k]) for k in ("absolutist", "hedge", "self", "other", "we", "evidence", "politeness",
                                               "affection", "apology", "urgency", "action", "profanity", "insult")},
                "political_label": per(p["c"]["political_label"]), "status": per(p["c"]["status_hierarchy"]),
                "laugh": p["c"]["laugh"], "mock": p["c"]["mock"], "caps": per(p["caps"]),
                "moral": {k: per(v) for k, v in p["moral"].items()},
                "rhetoric": dict(p["rhet"]), "examples": dict(p["examples"]), "reentries": p["reentries"],
                "heat_mean": mean(p["heat"]), "heat_first": mean(p["heat"][:third]), "heat_last": mean(p["heat"][-third:]),
                "hot_messages": sum(h >= 0.5 for h in p["heat"]), "sentiment": mean(p["sent"]),
                "reply_median_min": statistics.median(p["reply"]) if p["reply"] else None, "reply_count": len(p["reply"]),
                "initiations": p["init"], "media": p["media"], "deleted": p["deleted"], "edited": p["edited"],
                "after_hours": sum(v for h, v in enumerate(p["hours"]) if h < 9 or h >= 21) / p["messages"],
                "hours": p["hours"],
            })
        series = [{"day": d, "per": {n: {"n": v[n]["n"] if n in v else 0,
                                          "heat": mean(v[n]["heat"]) if n in v and v[n]["heat"] else None,
                                          "sent": mean(v[n]["sent"]) if n in v and v[n]["sent"] else None} for n in people}}
                  for d, v in sorted(by_day.items())]
        hottest = sorted((x for x in scored if x[2]["heat"] >= 0.5), key=lambda x: -x[2]["heat"])[:6]
        from .rigor import analyse_rigor

        return {
            "people": people, "stats": stats, "series": series,
            "rigor": analyse_rigor(scored, people, self.R),
            "hottest": [{"who": w, "date": m.date.isoformat(), "heat": s["heat"], "text": m.text[:240]} for w, m, s in hottest],
            "range": {"from": msgs[0].date.isoformat(), "to": msgs[-1].date.isoformat(), "days": len(by_day)},
            "totals": {"messages": len(msgs), "words": sum(s["words"] for s in stats)},
            "date_order": parsed["date_order"],
            "_scored": scored,
        }
