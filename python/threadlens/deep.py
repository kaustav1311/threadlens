"""Optional deep models, run locally. Install with: pip install "threadlens[deep]".

- Detoxify (multilingual) for toxicity / insult scores per message
- An open fallacy classifier trained on the Logic dataset (Jin et al., 2022)
- A local NLI model that flags a person contradicting their own earlier claim

These models are English-first and noisy on chat text. They are reported side by side, per person, and never
used to label anyone. Nothing here decides whether a claim is true -- only whether two of someone's own claims
sit badly together, with both quotes shown so a reader can judge.
"""
from __future__ import annotations

import re
from statistics import mean

FALLACY_MODELS = ("q3fer/distilbert-base-fallacy-classification",)
NLI_MODEL = "cross-encoder/nli-deberta-v3-small"

CONTRADICTION_MIN = 0.8   # probability below which a pair is not worth showing
CONTRADICTION_KEYWORDS = 2  # two claims must share this many content words to be about the same thing
MAX_CLAIMS_PER_PERSON = 60  # pairs grow quadratically, and this runs on a laptop CPU
MAX_PAIRS_PER_PERSON = 400

_cache = {}


def _models():
    if not _cache:
        from detoxify import Detoxify  # type: ignore
        from transformers import pipeline  # type: ignore

        _cache["tox"] = Detoxify("multilingual")
        _cache["fallacy"] = [pipeline("text-classification", model=m, truncation=True) for m in FALLACY_MODELS]
    return _cache


def _nli():
    if "nli" not in _cache:
        from transformers import pipeline  # type: ignore

        _cache["nli"] = pipeline("text-classification", model=NLI_MODEL, truncation=True, top_k=None)
    return _cache["nli"]


def find_contradictions(res, threshold: float = CONTRADICTION_MIN):
    """Pairs of claims by the SAME person that a local NLI model reads as contradictory.

    Only claims that share vocabulary are compared: two sentences about different
    things cannot contradict each other, and skipping them keeps this tractable.
    The model is wrong often enough that both quotes are always shown.
    """
    from .metrics import load_lexicons
    from .rigor import _content_words

    stop = set((load_lexicons()[0].get("rigor") or {}).get("stopwords", []))
    clf = _nli()
    by_person = {}
    for c in res.get("rigor", {}).get("ledger", []):
        by_person.setdefault(c["who"], []).append(c)

    out = []
    for who, claims in by_person.items():
        claims = claims[:MAX_CLAIMS_PER_PERSON]
        keys = [set(_content_words(re.findall(r"[\w']+", c["text"].lower()), stop)) for c in claims]
        pairs = 0
        for i in range(len(claims)):
            for j in range(i + 1, len(claims)):
                if pairs >= MAX_PAIRS_PER_PERSON:
                    break
                if len(keys[i] & keys[j]) < CONTRADICTION_KEYWORDS:
                    continue
                pairs += 1
                scores = {d["label"].lower(): d["score"] for d in clf({"text": claims[i]["text"], "text_pair": claims[j]["text"]})[0]}
                p = scores.get("contradiction", 0.0)
                if p >= threshold:
                    out.append({"who": who, "probability": round(float(p), 3),
                                "first": {"date": claims[i]["date"], "text": claims[i]["text"]},
                                "second": {"date": claims[j]["date"], "text": claims[j]["text"]}})
    out.sort(key=lambda x: -x["probability"])
    return out


def run_deep(res, max_messages: int = 3000, contradictions: bool = True):
    m = _models()
    per = {}
    for who, msg, _s in res["_scored"][:max_messages]:
        d = per.setdefault(who, {"tox": [], "insult": [], "fallacies": {}, "sentences": 0})
        p = m["tox"].predict(msg.text[:2000])
        d["tox"].append(float(p["toxicity"]))
        d["insult"].append(float(p["insult"]))
        for sent in [s for s in re.split(r"(?<=[.?!\n])\s+", msg.text) if len(s.split()) >= 6]:
            d["sentences"] += 1
            for clf in m["fallacy"]:
                out = clf(sent)[0]
                if out["score"] >= 0.6:
                    d["fallacies"][out["label"]] = d["fallacies"].get(out["label"], 0) + 1
    table = {}
    for who, d in per.items():
        top = sorted(d["fallacies"].items(), key=lambda x: -x[1])[:3]
        table[who] = {
            "toxicity_mean": round(mean(d["tox"]), 3) if d["tox"] else 0,
            "toxic_messages(>0.5)": sum(t > 0.5 for t in d["tox"]),
            "insult_mean": round(mean(d["insult"]), 3) if d["insult"] else 0,
            "sentences_checked": d["sentences"],
            "top_fallacy_labels": ", ".join(f"{k} ({v})" for k, v in top) or "—",
        }
    found = []
    if contradictions:
        try:
            found = find_contradictions(res)
        except Exception as e:  # a missing model should not lose the rest of the report
            found = []
            print(f"self-contradiction check skipped: {e}")
    return {
        "per_person": table,
        "columns": ["toxicity_mean", "toxic_messages(>0.5)", "insult_mean", "sentences_checked", "top_fallacy_labels"],
        "contradictions": found,
        "note": "Detoxify under-scores romanised Hindi and other code-mixed text. Fallacy classifiers are noisy on chat; "
                "read labels as prompts to re-read, not findings. Contradiction pairs are a model's guess: read both quotes.",
    }
