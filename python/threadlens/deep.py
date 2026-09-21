"""Optional deep models, run locally. Install with: pip install "threadlens[deep]".

- Detoxify (multilingual) for toxicity / insult scores per message
- Two open fallacy classifiers trained on the Logic dataset (Jin et al., 2022)

These models are English-first and noisy on chat text. They are reported side by side, per person, and never
used to label anyone.
"""
from __future__ import annotations

import re
from statistics import mean

FALLACY_MODELS = ("q3fer/distilbert-base-fallacy-classification",)
_cache = {}


def _models():
    if not _cache:
        from detoxify import Detoxify  # type: ignore
        from transformers import pipeline  # type: ignore

        _cache["tox"] = Detoxify("multilingual")
        _cache["fallacy"] = [pipeline("text-classification", model=m, truncation=True) for m in FALLACY_MODELS]
    return _cache


def run_deep(res, max_messages: int = 3000):
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
    return {
        "per_person": table,
        "columns": ["toxicity_mean", "toxic_messages(>0.5)", "insult_mean", "sentences_checked", "top_fallacy_labels"],
        "note": "Detoxify under-scores romanised Hindi and other code-mixed text. Fallacy classifiers are noisy on chat; read labels as prompts to re-read, not findings.",
    }
