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
RIGOR_MIN_CLAIM_WORDS = 5
OPENER_WINDOW = 30        # characters from the start of a sentence in which an opener still frames it
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


def _phrase_re(patterns):
    """One alternation from a list of phrase patterns, or None for an empty list.

    A single regex beats looping a hundred substring tests per sentence, and these
    run on every question and every candidate claim in the chat.
    """
    if not patterns:
        return None
    return re.compile("|".join(patterns), re.I)


def _opener_re(patterns):
    r"""An opener list as one regex, anchored at word boundaries.

    Plain `find` was silently rejecting real claims: the intent opener "id " matched
    inside "sa|id i|t was ninety minutes", and "ill " matched inside "st|ill s|ays".
    Any sentence with "said", "did" or "still" near its start was read as a statement
    of intent and dropped before it could be scored. Same class of bug as a bare
    month prefix matching "market".
    """
    if not patterns:
        return None
    alts = [re.escape(p.strip()) for p in patterns if p.strip()]
    return re.compile(r"\b(?:" + "|".join(alts) + r")\b", re.I)


def _framed_by(rx, lower):
    """Does an opener frame this sentence -- i.e. appear near enough to its start?"""
    if rx is None:
        return False
    m = rx.search(lower)
    return bool(m) and m.start() < OPENER_WINDOW


def compile_rigor(lex):
    """Compile the rigor lexicons once per Analyzer."""
    rg = lex.get("rigor") or {}
    fv = rg.get("factual_verb") or {}
    verbs_by = {"en": set(fv)} if isinstance(fv, list) else {c: set(w) for c, w in fv.items()}
    verbs_by.setdefault("en", set())
    # Stopwords moved out of `rigor` into their own per-language block. The fallback
    # keeps an older lexicons.json working rather than scoring it wrongly in silence.
    sw = lex.get("stopwords") or {"en": rg.get("stopwords", [])}
    by = {code: set(words) for code, words in sw.items()}
    by.setdefault("en", set())
    return {
        "stopwords_by": by,
        # The default set is English alone: the same words the scorer used before any
        # language detection existed, so a chat with no detected code-switching is
        # scored exactly as it was.
        "stopwords": by["en"],
        # Factual verbs are per-language for the same reason: the romanised Hindi past
        # copulas share spellings with English words, and scoping them means a verb can
        # only act as one where its language was actually detected.
        "factual_verb_by": verbs_by,
        "factual_verb": verbs_by["en"],
        "opinion_opener": _opener_re(rg.get("opinion_opener")),
        "intent_opener": _opener_re(rg.get("intent_opener")),
        "modality": _phrase_re(rg.get("modality")),
        "meta_talk": _phrase_re(rg.get("meta_talk")),
        "interior": _phrase_re(rg.get("interior")),
        "unmarked_question": _phrase_re(rg.get("unmarked_question")),
        "back_channel_exact": {s.lower() for s in rg.get("back_channel_exact", [])},
        "back_channel_phrase": _phrase_re(rg.get("back_channel_phrase")),
        "rhetorical_frame": _phrase_re(rg.get("rhetorical_frame")),
        "source_term": _List(rg.get("source_term", [])),
        "concession": _List(rg.get("concession", [])),
        "self_correction": _List(rg.get("self_correction", []), True),
    }


LANG_MIN_SHARE = 0.03   # share of messages a language must tag to count as present
LANG_MIN_MSGS = 5       # ...and this many messages, so a handful of words is not a language


def detect_languages(messages, by):
    """Which languages is this chat actually written in?

    Not a general language identifier -- it answers one question: whose function
    words should be treated as function words. That matters because everything
    downstream (topic vectors, drift, question/answer overlap) decides what is
    "distinctive" by what is left after the stoplist. On a Bengali-English chat
    scored with an English-only stoplist, `ami`, `kore` and `theke` look like rare,
    highly distinctive terms, and the topic of every conversation comes out as noise.

    Detection uses each language's DISTINCTIVE words -- the ones English does not
    already claim -- because the English list is long and common enough to win on
    any text otherwise. English is always present: it is the fallback alphabet here.
    """
    codes = [c for c in by if c != "en"]
    if not codes:
        return ["en"]
    distinct = {c: {w for w in by[c] if w not in by["en"]} for c in codes}
    hits = {c: 0 for c in codes}
    n = 0
    for m in messages:
        text = m.get("text") if isinstance(m, dict) else getattr(m, "text", "")
        if not text:
            continue
        n += 1
        toks = set(_tokens(text.lower()))
        for c in codes:
            if toks & distinct[c]:
                hits[c] += 1
    out = ["en"]
    for c in codes:
        if hits[c] >= LANG_MIN_MSGS and hits[c] / max(n, 1) >= LANG_MIN_SHARE:
            out.append(c)
    return out


def stop_set_for(codes, by):
    """The union of several languages' word sets."""
    out = set()
    for c in codes:
        out |= by.get(c, set())
    return out


def scope_rigor(R, languages):
    """A copy of the compiled lexicon narrowed to the languages this chat is in.

    Everything language-scoped is resolved here, once, so the gates themselves stay
    a straight yes/no on a sentence.
    """
    out = dict(R)
    out["stopwords"] = stop_set_for(languages, R["stopwords_by"])
    out["factual_verb"] = stop_set_for(languages, R["factual_verb_by"])
    out["languages"] = languages
    return out


RE_URL_G = re.compile(r"(?:https?://|www\.)\S+", re.I)
# Trailing punctuation, emoji and spacing, so a bare "Wbu?" can be compared to a list.
RE_BARE = re.compile(r"[^a-z' ]+")
# "it's", "that's", "there's" are the copula, but the tokeniser splits them into
# "it" + "s" and the verb gate then finds no verb at all.
RE_CONTRACTED_IS = re.compile(r"\b(it|that|this|there|he|she|what|who|here|one)['’]s\b", re.I)


def question_kind(sent, s_tok, stop, R=None):
    """Is this sentence a question, and of what kind? '' means it is not one.

    Three kinds, because they are three different things and only one of them is a
    debt. Counting them as one is why a chat full of "Wbu?" and "Mane?" reported
    dozens of questions nobody answered:

      phatic      -- asks for acknowledgement, not information.
      rhetorical  -- asked to score a point; no one owes a reply.
      substantive -- genuinely requests information. Only these count.
    """
    # A link's query string contains '?'. A shared map pin is not a question.
    bare = RE_URL_G.sub(" ", sent)
    if "?" not in bare:
        return ""
    lower = bare.lower()
    # Rhetorical first: a whataboutism is full of content words and would otherwise
    # pass for a real question.
    if R and R.get("rhetorical_frame") and R["rhetorical_frame"].search(lower):
        return "rhetorical"
    stripped = " ".join(RE_BARE.sub(" ", lower).split())
    if R and stripped in R.get("back_channel_exact", ()):
        return "phatic"
    if R and R.get("back_channel_phrase") and R["back_channel_phrase"].search(lower):
        return "phatic"
    # Nothing distinctive left after the stoplist: nothing was actually asked.
    if not _content_words(s_tok, stop):
        return "phatic"
    return "substantive"


def is_claim_sentence(lower, s_tok, R, evidence=None):
    """Does this declarative sentence assert something checkable?

    An opinion, an offer, a plan or a request is not a claim. Counting them inflates
    the Sourcing denominator and makes a careful speaker look vague, so they are
    rejected here rather than scored as vague.
    """
    if len(s_tok) < RIGOR_MIN_CLAIM_WORDS:
        return False
    expanded = RE_CONTRACTED_IS.sub(r"\1 is", lower)
    has_verb = any(t in R["factual_verb"] for t in s_tok) or expanded != lower
    # A bare citation -- "Section 3 of the same report, page 12" -- has no verb and is
    # still a claim about where something can be checked.
    if not has_verb and not (evidence and evidence["named"] and (evidence["stat"] or evidence["dated"])):
        return False
    # A question that lost its question mark -- chat writers drop it constantly.
    if R.get("unmarked_question") and R["unmarked_question"].search(lower):
        return False
    if _framed_by(R["opinion_opener"], lower):
        return False
    if _framed_by(R["intent_opener"], lower):
        return False
    # What the speaker feels, wants or minds. Nobody can check any of it.
    if R.get("interior") and R["interior"].search(lower):
        return False
    # Obligation, plan, advice and request. "The place has to be clean" states a
    # requirement, not a fact, wherever in the sentence the modal sits -- so unlike
    # an opener this is scanned throughout.
    if R.get("modality") and R["modality"].search(lower):
        return False
    # Talk about the conversation rather than about the world -- but only when that
    # is all it is. "I said ninety minutes was the ward office figure" reports what
    # was said AND names a checkable figure, so it stays a claim.
    if R.get("meta_talk") and R["meta_talk"].search(lower) and not (evidence and evidence["checkable"]):
        return False
    return True


def classify_sentence(sent, R, stop):
    """Both sentence-level decisions for one sentence, without running an analysis."""
    lower = sent.lower()
    s_tok = _tokens(lower)
    if not s_tok:
        return {"question": "", "claim": False}
    question = question_kind(sent, s_tok, stop, R)
    claim = False if question else is_claim_sentence(lower, s_tok, R, claim_evidence(sent, lower, s_tok, R))
    return {"question": question, "claim": claim}


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


ARGUE_MIN_MSGS = 8         # below this an episode is too short to read either way
ARGUE_CLAIM_RATE = 0.10    # claims per message
ARGUE_DISPUTE_RATE = 0.10  # share of messages carrying a disagreement marker
ARGUE_HEATED_RATE = 0.25   # ...or this much disagreement, when claims are thin
ARGUE_CLAIM_FLOOR = 0.05   # but never with no assertions at all


def argumentative_episodes(msgs, episode, episode_count, bounds, claims, questions):
    """Which conversations in this chat are arguments?

    Rigor is the only lens that scores people, and it is built for a disagreement:
    sourcing, answering and topic discipline all presuppose that something is being
    contested. Run over three years of small talk it reports a confident zero --
    every casual remark becomes an unsourced claim and every "Wbu?" an unanswered
    question. The applicability check existed but was computed once for the whole
    chat, so one real argument inside thirty conversations averaged into nothing.

    An episode qualifies when people are both ASSERTING and DISAGREEING. Either
    alone is not an argument: a stream of links is not, nor is a round of swearing.

    Mirrors argumentativeEpisodes() in core.js.
    """
    claims_in = [0] * episode_count
    for c in claims:
        claims_in[c["ep"]] += 1
    dispute_in = [0] * episode_count
    counted = set()
    for q in questions:
        # A rhetorical question is a move in an argument; a phatic one is not.
        if q["kind"] == "rhetorical" and q["i"] not in counted:
            counted.add(q["i"])
            dispute_in[q["ep"]] += 1
    for i, m in enumerate(msgs):
        if i in counted:
            continue
        c, rh = m["c"], m["rhet"]
        marks = (c.get("absolutist", 0) + c.get("insult", 0) + c.get("profanity", 0)
                 + c.get("political_label", 0) + c.get("status_hierarchy", 0) + c.get("evidence", 0)
                 + rh.get("evidence_request", 0) + rh.get("whataboutism", 0) + rh.get("personal_attack", 0)
                 + rh.get("unfalsifiable", 0) + rh.get("false_dilemma", 0) + rh.get("exit_or_concession", 0))
        if marks:
            counted.add(i)
            dispute_in[episode[i]] += 1
    out = []
    for e in range(episode_count):
        b = bounds.get(e)
        n = (b[1] - b[0]) if b else 0
        if n < ARGUE_MIN_MSGS:
            out.append(False)
            continue
        claim_rate = claims_in[e] / n
        dispute_rate = dispute_in[e] / n
        if claim_rate >= ARGUE_CLAIM_RATE and dispute_rate >= ARGUE_DISPUTE_RATE:
            out.append(True)
            continue
        # A heated exchange carried by short retorts rather than assertions is still
        # an argument. It needs far more disagreement to qualify on that basis alone.
        out.append(dispute_rate >= ARGUE_HEATED_RATE and claim_rate >= ARGUE_CLAIM_FLOOR)
    return out


def analyse_rigor(scored, people, R):
    """`scored` is a list of (who, message, score) triples from Analyzer.analyse."""
    msgs = [{"who": w, "date": m.date, "text": m.text, "words": s["words"], "c": s["c"], "rhet": s["rhet"]}
            for w, m, s in scored]
    # Score this chat with the function words of the languages it is actually in.
    languages = detect_languages(msgs, R["stopwords_by"])
    R = scope_rigor(R, languages)
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

    # --- pass 1: every sentence, tagged with the episode it belongs to ---
    all_claims, all_questions = [], []
    for i, m in enumerate(msgs):
        if m["who"] not in P:
            continue
        for sent in split_sentences(m["text"]):
            lower = sent.lower()
            s_tok = _tokens(lower)
            if not s_tok:
                continue
            kind = question_kind(sent, s_tok, stop, R)
            if kind:
                # All three kinds are kept, so the UI can say how many were small talk.
                # Only a substantive question is a debt somebody owes an answer to.
                all_questions.append({"who": m["who"], "i": i, "ep": episode[i], "date": m["date"],
                                      "text": sent, "kind": kind,
                                      "kw": set(_content_words(s_tok, stop)), "answered": False})
                continue
            evidence = claim_evidence(sent, lower, s_tok, R)
            if not is_claim_sentence(lower, s_tok, R, evidence):
                continue
            claim = {"who": m["who"], "i": i, "ep": episode[i], "date": m["date"], "text": sent,
                     "kw": set(_content_words(s_tok, stop)), "challenged": False,
                     "challenged_at": -1, "answered": False}
            claim.update(evidence)
            all_claims.append(claim)

    # --- which conversations are actually arguments? ---
    argues = argumentative_episodes(msgs, episode, episode_count, bounds, all_claims, all_questions)
    scored_episodes = [e for e in range(episode_count) if argues[e]]
    # A chat with no argument in it has nothing for this lens to weigh. Scoring it
    # anyway is what produced a confident ledger of flat-hunting and a list of
    # "unanswered questions" that were mostly "Wbu?". There is no fallback to
    # scoring everything: a caller that ignores `applies` still gets nothing.
    applies = len(scored_episodes) > 0

    def in_scope(i):
        return argues[episode[i]]

    # --- per person accumulators, over the argument only ---
    for i, m in enumerate(msgs):
        p = P.get(m["who"])
        if p is None or not in_scope(i):
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

    ledger = []
    for c in all_claims:
        if not in_scope(c["i"]):
            continue
        P[c["who"]]["claims"].append(c)
        ledger.append(c)
    questions = [q for q in all_questions if in_scope(q["i"])]
    for q in questions:
        if q["kind"] == "substantive":
            P[q["who"]]["questions_asked"] += 1

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
        # Nobody owes an answer to "Wbu?" or to a whataboutism. Scoring them as debts
        # made a friendly chat look evasive, which was most of what Responsiveness
        # was measuring before.
        if q["kind"] != "substantive":
            continue
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
    # A back-channel "really?" after a claim is not a challenge to it. Only a real
    # question, or an explicit ask for evidence, puts a claim under pressure.
    asked = {q["i"] for q in questions if q["kind"] != "phatic"}
    # Over the whole chat, not just the part that was scored: "most of what looked
    # like unanswered questions was small talk" is worth being able to say.
    question_mix = {"phatic": 0, "rhetorical": 0, "substantive": 0}
    for q in all_questions:
        question_mix[q["kind"]] = question_mix.get(q["kind"], 0) + 1
    for c in ledger:
        for j in range(c["i"] + 1, min(len(msgs) - 1, c["i"] + RIGOR_ANSWER_WINDOW) + 1):
            m = msgs[j]
            if m["who"] == c["who"]:
                continue
            is_challenge = m["rhet"].get("evidence_request", 0) > 0 or j in asked
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

    # Measured against the messages it actually scored, not against the whole chat:
    # otherwise a dense argument inside a long friendly chat reads as inapplicable
    # purely because of everything around it.
    scored_msgs = (sum(bounds[e][1] - bounds[e][0] for e in scored_episodes)
                   if applies else len(msgs))
    claims_per_message = (len(ledger) / scored_msgs) if scored_msgs else 0.0
    fit = _clamp01(claims_per_message / RIGOR_FIT_FULL)

    return {
        "people": out,
        "weights": RIGOR_WEIGHTS,
        "applicability": {
            "claims": len(ledger),
            "messages": scored_msgs,
            "claims_per_message": claims_per_message,
            "fit": fit,
            "weak": fit < RIGOR_FIT_WEAK,
        },
        "languages": languages,
        # What this lens actually looked at. `applies` false means the chat holds no
        # argument to score, and the caller should say so rather than print a ledger.
        "applies": applies,
        "episodes_scored": len(scored_episodes),
        "episode_argues": argues,
        "scored_messages": scored_msgs if applies else 0,
        "scored_range": ({"from": msgs[bounds[scored_episodes[0]][0]]["date"].isoformat(),
                          "to": msgs[bounds[scored_episodes[-1]][1] - 1]["date"].isoformat()}
                         if scored_episodes else None),
        "episodes": episode_count,
        "episode_topics": [[t for t, _ in e["terms"][:6]] for e in ep_topic[:12]],
        "topic_terms": [t for t, _ in topic],
        "ledger_total": len(ledger),
        "ledger": [{"who": c["who"], "date": c["date"].isoformat(), "text": c["text"][:240],
                    "status": c["status"], "checkable": c["checkable"],
                    "challenged": c["challenged"], "answered": c["answered"]} for c in ledger[:LEDGER_MAX]],
        "question_mix": question_mix,
        "unanswered_total": sum(1 for q in questions
                                if q["kind"] == "substantive" and not q["answered"]),
        "unanswered": [{"who": q["who"], "date": q["date"].isoformat(), "text": q["text"][:240]}
                       for q in questions
                       if q["kind"] == "substantive" and not q["answered"]][:UNANSWERED_MAX],
        "drift": _downsample([{"who": m["who"], "date": m["date"].isoformat(), "drift": drift[i]}
                              for i, m in enumerate(msgs)], DRIFT_POINTS),
    }
