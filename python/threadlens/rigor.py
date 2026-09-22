"""Rigor scoring: how well each person argued, never who was right.

Mirrors the rigor section of web/src/core.js exactly -- same constants, same
regexes, same formulas, same rounding. test_rigor_parity.py pins the two
implementations to each other on the shared samples, so a change here without
the matching change in core.js fails the build.
"""
from __future__ import annotations

import math
import re

from .metrics import _List, _tokens

RIGOR_WEIGHTS = {
    "sourcing": 25, "specificity": 10, "responsiveness": 20,
    "topic": 15, "conduct": 15, "calibration": 10, "selfCorrection": 5,
}
RIGOR_LABELS = {
    "sourcing": "Sourcing", "specificity": "Specificity", "responsiveness": "Answering",
    "topic": "Topic discipline", "conduct": "Conduct", "calibration": "Calibration",
    "selfCorrection": "Self-correction",
}

EPISODE_GAP_HOURS = 6      # the same gap that defines "started a conversation"
EPISODE_OPENING = 6        # messages of an episode that define its topic
CONDUCT_ZERO = 0.3         # share of messages carrying hostility at which Conduct hits 0
RIGOR_FIT_FULL = 0.35      # claims per message at which Rigor is fully applicable
RIGOR_FIT_WEAK = 0.4       # below this fit, callers should warn rather than assert
CALIBRATION_SPAN = 1.5     # how far incidence must move to swing Calibration end to end
RIGOR_ANSWER_WINDOW = 6
RIGOR_MIN_CLAIM_WORDS = 6
RIGOR_KEYWORD_MIN = 3
RIGOR_ANSWER_SIM = 0.2
RIGOR_OVERLAP = 2
TOPIC_OPENING_MSGS = 10
TOPIC_TERMS = 12
LEDGER_MAX = 500
UNANSWERED_MAX = 200
DRIFT_POINTS = 400
TOPIC_FULL_MATCH = 0.25
DRIFT_HIGH = 0.8
DRIFT_JUMP = 0.3
GOALPOST_PENALTY = 0.1

RE_URL = re.compile(r"(?:https?://|www\.)\S+", re.I)
RE_YEAR = re.compile(r"\b(?:19|20)\d{2}\b")
_MONTH = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*"
RE_DATE = re.compile(
    r"\b\d{1,2}(?:st|nd|rd|th)?\s+" + _MONTH + r"\b"
    r"|\b" + _MONTH + r"\.?\s+\d{1,2}\b"
    r"|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b", re.I)
# "%" is not a word character, so a trailing \b after it never matches: the old
# pattern failed on "6% a year" and only caught "40%" via the \b\d{2,}\b branch.
# Keep \b for the spelled-out units, where it belongs.
RE_STAT = re.compile(
    r"\b\d+(?:[.,]\d+)?\s*%"
    r"|\b\d+(?:[.,]\d+)?\s*(?:percent|per cent|crore|lakh|lakhs|million|billion|km|kg|tonnes?|rs\.?|inr|usd)\b"
    r"|[₹$£€]\s?\d|\b\d{2,}\b", re.I)
RE_PROPER = re.compile(r"^[A-Z][a-z]{2,}")
RE_SENTENCE = re.compile(r"(?<=[.!?…])\s+|\n+")


def _clamp01(v):
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def _mean(a):
    return sum(a) / len(a) if a else 0.0


def split_sentences(text):
    """Split a message into sentences. A newline ends one too: chat writers rarely punctuate."""
    return [s.strip() for s in RE_SENTENCE.split(str(text)) if s.strip()]


def _downsample(arr, max_points):
    """Keep at most `max_points` evenly spaced items. Mirrors downsample() in core.js."""
    if len(arr) <= max_points:
        return arr
    step = len(arr) / max_points
    return [arr[int(i * step)] for i in range(max_points)]


def _episode_of(msgs):
    """Split a chat into episodes at the same six-hour gap that defines "started a
    conversation". Mirrors episodeOf() in core.js."""
    out, ep = [], 0
    for i, m in enumerate(msgs):
        if i and (m["date"] - msgs[i - 1]["date"]).total_seconds() / 3600 >= EPISODE_GAP_HOURS:
            ep += 1
        out.append(ep)
    return out


def _content_words(tokens, stop):
    return [t for t in tokens if len(t) >= RIGOR_KEYWORD_MIN and t not in stop]


def compile_rigor(lex):
    """Compile the rigor lexicons once per Analyzer."""
    rg = lex.get("rigor") or {}
    return {
        "stopwords": set(rg.get("stopwords", [])),
        "factual_verb": set(rg.get("factual_verb", [])),
        "opinion_opener": [s.lower() for s in rg.get("opinion_opener", [])],
        "intent_opener": [s.lower() for s in rg.get("intent_opener", [])],
        "source_term": _List(rg.get("source_term", [])),
        "concession": _List(rg.get("concession", [])),
        "self_correction": _List(rg.get("self_correction", []), True),
    }


def claim_evidence(sentence, lower, tokens, R):
    """Does this sentence point at anything a reader could go and check?"""
    url = bool(RE_URL.search(sentence))
    named = R["source_term"].count(tokens, lower) > 0
    dated = bool(RE_YEAR.search(sentence)) or bool(RE_DATE.search(sentence))
    stat = bool(RE_STAT.search(sentence))
    proper = sum(1 for w in sentence.split()[1:] if RE_PROPER.match(w))
    sourced = url or named
    specific = dated or stat or proper > 0
    return {
        "url": url, "named": named, "dated": dated, "stat": stat, "proper": proper,
        "sourced": sourced, "specific": specific,
        "checkable": url or named or dated or stat,
        "status": "sourced" if sourced else "specific" if specific else "vague",
        "specificity": min(1.0, ((1 if dated else 0) + (1 if stat else 0) + min(proper, 2) * 0.5) / 2),
    }


def analyse_rigor(scored, people, R):
    """`scored` is a list of (who, message, score) triples from Analyzer.analyse."""
    msgs = [{"who": w, "date": m.date, "text": m.text, "words": s["words"], "c": s["c"], "rhet": s["rhet"]}
            for w, m, s in scored]
    stop = R["stopwords"]
    toks = [_tokens(m["text"].lower()) for m in msgs]

    # --- topic and drift, scoped to a conversation episode ---
    episode = _episode_of(msgs)
    episode_count = (episode[-1] + 1) if msgs else 0
    df = {}
    per_msg_words = []
    for i, m in enumerate(msgs):
        w = _content_words(toks[i], stop)
        per_msg_words.append(w)
        for t in set(w):
            df[t] = df.get(t, 0) + 1
    # One set per message, built once: the scans below revisit the same messages.
    content_sets = [set(w) for w in per_msg_words]
    n_msgs = max(len(msgs), 1)

    def idf(t):
        return math.log(1 + n_msgs / (1 + df.get(t, 0)))

    def topic_of(frm, to, k):
        """Top terms of a slice of messages, by TF-IDF against the whole chat."""
        tf = {}
        for i in range(frm, to):
            for t in per_msg_words[i]:
                tf[t] = tf.get(t, 0) + 1
        return sorted(((t, n * idf(t)) for t, n in tf.items()), key=lambda x: (-x[1], x[0]))[:k]

    bounds = {}
    for i in range(len(msgs)):
        e = episode[i]
        if e not in bounds:
            bounds[e] = [i, i + 1]
        else:
            bounds[e][1] = i + 1
    ep_topic = []
    for e in range(episode_count):
        frm, to = bounds[e]
        terms = topic_of(frm, min(to, frm + EPISODE_OPENING), TOPIC_TERMS)
        ep_topic.append({"terms": terms, "total": sum(w for _, w in terms), "index": dict(terms)})

    # Each message is measured against the opening of ITS OWN episode.
    drift = []
    for i, w in enumerate(per_msg_words):
        T = ep_topic[episode[i]] if episode[i] < len(ep_topic) else None
        if not T or not T["total"]:
            drift.append(0.0)
            continue
        hit = sum(T["index"][t] for t in set(w) if t in T["index"])
        drift.append(1 - _clamp01(hit / (TOPIC_FULL_MATCH * T["total"])))

    # "The opening topic" in the UI means what the chat started as: episode one.
    topic = ep_topic[0]["terms"] if ep_topic else []

    P = {p: {"claims": [], "questions_asked": 0, "answered": 0, "put_to_them": 0,
             "drifts": [], "goalposts": [], "concession": 0, "self_correction": 0,
             "hostile": 0, "words": 0, "hedge": 0, "absolutist": 0,
             # incidence: how many of their MESSAGES carried the thing, not how many words
             "msgs": 0, "hostile_msgs": 0, "hedge_msgs": 0, "concession_msgs": 0,
             "absolutist_msgs": 0} for p in people}

    ledger, questions = [], []
    for i, m in enumerate(msgs):
        p = P.get(m["who"])
        if p is None:
            continue
        p["drifts"].append(drift[i])
        p["words"] += m["words"]
        p["msgs"] += 1
        hostile = (m["c"].get("profanity", 0) + m["c"].get("insult", 0)
                   + m["c"].get("political_label", 0) + m["c"].get("status_hierarchy", 0)
                   + m["rhet"].get("personal_attack", 0))
        p["hostile"] += hostile
        if hostile:
            p["hostile_msgs"] += 1
        p["hedge"] += m["c"].get("hedge", 0)
        if m["c"].get("hedge", 0):
            p["hedge_msgs"] += 1
        p["absolutist"] += m["c"].get("absolutist", 0)
        if m["c"].get("absolutist", 0):
            p["absolutist_msgs"] += 1
        lower_msg = m["text"].lower()
        conc = R["concession"].count(toks[i], lower_msg)
        p["concession"] += conc
        if conc:
            p["concession_msgs"] += 1
        p["self_correction"] += R["self_correction"].count(toks[i], lower_msg)

        for sent in split_sentences(m["text"]):
            lower = sent.lower()
            s_tok = _tokens(lower)
            if not s_tok:
                continue
            if "?" in sent:
                kw = _content_words(s_tok, stop)
                if kw:
                    questions.append({"who": m["who"], "i": i, "date": m["date"], "text": sent,
                                      "kw": set(kw), "answered": False})
                    p["questions_asked"] += 1
                continue
            if len(s_tok) < RIGOR_MIN_CLAIM_WORDS:
                continue
            if not any(t in R["factual_verb"] for t in s_tok):
                continue
            # An opinion, an offer, a plan or a request is not a checkable claim.
            skip = any(0 <= lower.find(o) < 30 for o in R["opinion_opener"])
            if not skip:
                skip = any(0 <= lower.find(o) < 30 for o in R["intent_opener"])
            if skip:
                continue
            claim = {"who": m["who"], "i": i, "date": m["date"], "text": sent,
                     "kw": set(_content_words(s_tok, stop)), "challenged": False,
                     "challenged_at": -1, "answered": False}
            claim.update(claim_evidence(sent, lower, s_tok, R))
            p["claims"].append(claim)
            ledger.append(claim)

    # --- responsiveness: did the other person engage with the question? ---
    def echo_score(qkw, have):
        total = hit = 0.0
        for t in qkw:
            w = idf(t)
            total += w
            if t in have:
                hit += w
        return hit / total if total else 0.0

    for q in questions:
        for name in people:
            if name != q["who"]:
                P[name]["put_to_them"] += 1
        for j in range(q["i"] + 1, min(len(msgs) - 1, q["i"] + RIGOR_ANSWER_WINDOW) + 1):
            m = msgs[j]
            if m["who"] == q["who"] or m["who"] not in P:
                continue
            if echo_score(q["kw"], content_sets[j]) >= RIGOR_ANSWER_SIM:
                P[m["who"]]["answered"] += 1
                q["answered"] = True
                break

    # --- was a claim challenged, and did its author then back it up? ---
    for c in ledger:
        for j in range(c["i"] + 1, min(len(msgs) - 1, c["i"] + RIGOR_ANSWER_WINDOW) + 1):
            m = msgs[j]
            if m["who"] == c["who"]:
                continue
            is_challenge = m["rhet"].get("evidence_request", 0) > 0 or "?" in m["text"]
            if is_challenge and len(c["kw"] & content_sets[j]) >= RIGOR_OVERLAP:
                c["challenged"] = True
                c["challenged_at"] = j
                break
        if not c["challenged"]:
            continue
        for j in range(c["challenged_at"] + 1, min(len(msgs) - 1, c["challenged_at"] + RIGOR_ANSWER_WINDOW) + 1):
            if c["answered"]:
                break
            m = msgs[j]
            if m["who"] != c["who"]:
                continue
            for sent in split_sentences(m["text"]):
                lower = sent.lower()
                s_tok = _tokens(lower)
                if (len(c["kw"] & set(_content_words(s_tok, stop))) >= RIGOR_OVERLAP
                        and claim_evidence(sent, lower, s_tok, R)["checkable"]):
                    c["answered"] = True
                    break

    # --- goalpost shifts: challenged, then an off-topic swerve ---
    for i, m in enumerate(msgs):
        p = P.get(m["who"])
        if p is None or i == 0:
            continue
        prev = msgs[i - 1]
        if prev["who"] == m["who"]:
            continue
        # A six-hour gap starts a new conversation, so a challenge cannot be
        # "dodged" by a message three days later.
        if episode[i] != episode[i - 1]:
            continue
        if not (prev["rhet"].get("evidence_request", 0) > 0 or "?" in prev["text"]):
            continue
        last_own = next((j for j in range(i - 1, -1, -1)
                         if msgs[j]["who"] == m["who"] and episode[j] == episode[i]), -1)
        if last_own < 0:
            continue
        if drift[i] >= DRIFT_HIGH and drift[i] - drift[last_own] >= DRIFT_JUMP:
            p["goalposts"].append({"date": m["date"].isoformat(), "from": drift[last_own],
                                   "to": drift[i], "text": m["text"][:160]})

    out = {}
    for name in people:
        p = P[name]
        n = len(p["claims"])

        def per100(k, _p=p):
            return 100 * k / _p["words"] if _p["words"] else 0.0

        # Conduct and Calibration use INCIDENCE -- the share of this person's
        # messages that carried the thing -- not a per-100-word rate. See the
        # matching note in core.js: per 100 words punished brevity.
        def share(k, _p=p):
            return k / _p["msgs"] if _p["msgs"] else 0.0

        components = {
            "sourcing": (sum(1 for c in p["claims"] if c["checkable"]) / n) if n else None,
            "specificity": _mean([c["specificity"] for c in p["claims"]]) if n else None,
            "responsiveness": min(1.0, p["answered"] / p["put_to_them"]) if p["put_to_them"] else None,
            "topic": _clamp01(1 - _mean(p["drifts"]) - GOALPOST_PENALTY * len(p["goalposts"])) if p["drifts"] else None,
            "conduct": _clamp01(1 - share(p["hostile_msgs"]) / CONDUCT_ZERO) if p["msgs"] else None,
            "calibration": _clamp01(
                0.5 + (share(p["hedge_msgs"]) + 2 * share(p["concession_msgs"]) - share(p["absolutist_msgs"]))
                / CALIBRATION_SPAN) if p["msgs"] else None,
            "selfCorrection": min(1.0, p["self_correction"] / 2),
        }
        num = den = 0.0
        for k, w in RIGOR_WEIGHTS.items():
            if components[k] is not None:
                num += w * components[k]
                den += w
        out[name] = {
            "name": name, "score": (100 * num / den) if den else None, "components": components,
            "claims": n,
            "sourced_claims": sum(1 for c in p["claims"] if c["sourced"]),
            "checkable_claims": sum(1 for c in p["claims"] if c["checkable"]),
            "vague_claims": sum(1 for c in p["claims"] if c["status"] == "vague"),
            "questions_asked": p["questions_asked"], "questions_put_to_them": p["put_to_them"],
            "questions_answered": p["answered"],
            "concessions": p["concession"], "self_corrections": p["self_correction"],
            "goalposts": p["goalposts"],
            "mean_drift": _mean(p["drifts"]) if p["drifts"] else None,
            "hostile_messages": p["hostile_msgs"], "scored_messages": p["msgs"],
            "hostile_share": (p["hostile_msgs"] / p["msgs"]) if p["msgs"] else None,
        }

    return {
        "people": out,
        "weights": RIGOR_WEIGHTS,
        "applicability": {
            "claims": len(ledger),
            "messages": len(msgs),
            "claims_per_message": (len(ledger) / len(msgs)) if msgs else 0.0,
            "fit": _clamp01((len(ledger) / len(msgs)) / RIGOR_FIT_FULL) if msgs else 0.0,
            "weak": (_clamp01((len(ledger) / len(msgs)) / RIGOR_FIT_FULL) if msgs else 0.0) < RIGOR_FIT_WEAK,
        },
        "episodes": episode_count,
        "episode_topics": [[t for t, _ in e["terms"][:6]] for e in ep_topic[:12]],
        "topic_terms": [t for t, _ in topic],
        "ledger_total": len(ledger),
        "ledger": [{"who": c["who"], "date": c["date"].isoformat(), "text": c["text"][:240],
                    "status": c["status"], "checkable": c["checkable"],
                    "challenged": c["challenged"], "answered": c["answered"]} for c in ledger[:LEDGER_MAX]],
        "unanswered_total": sum(1 for q in questions if not q["answered"]),
        "unanswered": [{"who": q["who"], "date": q["date"].isoformat(), "text": q["text"][:240]}
                       for q in questions if not q["answered"]][:UNANSWERED_MAX],
        "drift": _downsample([{"who": m["who"], "date": m["date"].isoformat(), "drift": drift[i]}
                              for i, m in enumerate(msgs)], DRIFT_POINTS),
    }
