"""Rigor mode: neutrality, bounds, and byte-for-byte parity with core.js."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from threadlens import Analyzer, parse_chat
from threadlens.report import findings, to_markdown
from threadlens.rigor import RIGOR_LABELS, RIGOR_WEIGHTS

ROOT = Path(__file__).resolve().parents[2]
LEX = json.loads((ROOT / "lexicons/lexicons.json").read_text("utf-8"))
MIRRORS = ("rigor_left_vs_right.txt", "rigor_right_vs_left.txt")


def run(name):
    return Analyzer().analyse(parse_chat((ROOT / "samples" / name).read_text("utf-8")))


# ----------------------------------------------------------------- neutrality

def test_political_label_is_balanced():
    pl = LEX["political_label"]
    assert {"left_coded", "right_coded", "neutral"} <= set(pl)
    left, right = len(pl["left_coded"]), len(pl["right_coded"])
    skew = abs(left - right) / max(left, right)
    assert skew <= 0.2, f"left={left} right={right} skew={skew:.1%} exceeds 20%"
    flat = pl["left_coded"] + pl["right_coded"] + pl["neutral"]
    assert len(set(flat)) == len(flat), "an entry appears under two tags"


def test_no_party_leader_or_topic_in_any_list():
    banned = {"congress", "bjp", "labour", "tory", "tories", "republican", "democrat",
              "modi", "trump", "biden", "gandhi", "maga", "brexit", "abortion", "vaccine"}

    def walk(v, where):
        if isinstance(v, str):
            assert not (set(v.lower().split()) & banned), f"banned token in {where}: {v}"
        elif isinstance(v, list):
            for x in v:
                walk(x, where)
        elif isinstance(v, dict):
            for k, x in v.items():
                walk(x, f"{where}.{k}")

    for k, v in LEX.items():
        if k != "_about":
            walk(v, k)


def test_mirrored_samples_swap_scores():
    """Same argument, opposite sides. A political lean would stop the scores swapping."""
    a = run(MIRRORS[0])["rigor"]["people"]
    b = run(MIRRORS[1])["rigor"]["people"]
    assert abs(a["Priya"]["score"] - b["Arjun"]["score"]) <= 3
    assert abs(a["Arjun"]["score"] - b["Priya"]["score"]) <= 3
    assert a["Priya"]["score"] > a["Arjun"]["score"] + 10
    for k in RIGOR_WEIGHTS:
        x, y = a["Priya"]["components"][k], b["Arjun"]["components"][k]
        if x is None or y is None:
            continue
        assert abs(x - y) <= 0.05, f"component {k} did not mirror: {x} vs {y}"


# -------------------------------------------------------------------- scoring

def test_components_in_range_and_weights_sum_to_100():
    assert sum(RIGOR_WEIGHTS.values()) == 100
    res = run(MIRRORS[0])
    for name, p in res["rigor"]["people"].items():
        assert 0 <= p["score"] <= 100, name
        for k in RIGOR_WEIGHTS:
            v = p["components"][k]
            assert v is None or 0 <= v <= 1, f"{name}.{k}={v}"
            assert RIGOR_LABELS[k]


def test_ledger_excludes_questions_and_offers():
    for c in run(MIRRORS[0])["rigor"]["ledger"]:
        assert "?" not in c["text"]
        assert not c["text"].lower().startswith(("if ", "let's ", "happy to", "i think", "can you"))
        assert c["status"] in ("sourced", "specific", "vague")


def test_month_prefix_is_not_a_date():
    text = ("01/02/2026, 10:01 - A: the market was busy and maybe it stays busy for everyone there\n"
            "01/02/2026, 10:02 - A: the report was published on 12 March 2026 and it says the opposite\n")
    ledger = Analyzer().analyse(parse_chat(text))["rigor"]["ledger"]
    market = next(c for c in ledger if "market" in c["text"])
    dated = next(c for c in ledger if "March" in c["text"])
    assert not market["checkable"], '"market" must not read as a date'
    assert dated["checkable"]


def test_rigor_report():
    res = run(MIRRORS[0])
    f = findings(res, "rigor")
    assert len(f) >= 2
    assert any("not whether either position is correct" in x or "never which side is right" in x for x in f)
    md = to_markdown(res, "rigor")
    assert "## Rigor scores" in md and "## Claim ledger" in md


# --------------------------------------------------------------------- parity

@pytest.mark.parametrize("sample", MIRRORS + ("sample_debate_android.txt",))
def test_matches_javascript(sample):
    """Invariant 4: core.js and rigor.py must agree, not merely look similar."""
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    out = subprocess.run([node, str(ROOT / "scripts/rigor-dump.mjs"), str(ROOT / "samples" / sample)],
                         capture_output=True, text=True, encoding="utf-8", cwd=ROOT)
    assert out.returncode == 0, out.stderr
    js = json.loads(out.stdout)
    py = run(sample)["rigor"]

    assert js["topicTerms"] == py["topic_terms"]
    for name, jp in js["people"].items():
        pp = py["people"][name]
        assert jp["score"] == pytest.approx(pp["score"], abs=1e-9), name
        for k, v in jp["components"].items():
            assert v == pytest.approx(pp["components"][k], abs=1e-9), f"{name}.{k}"
        assert jp["claims"] == pp["claims"]
        assert jp["checkableClaims"] == pp["checkable_claims"]
        assert jp["vagueClaims"] == pp["vague_claims"]
        assert jp["questionsPutToThem"] == pp["questions_put_to_them"]
        assert jp["questionsAnswered"] == pp["questions_answered"]
        assert jp["concessions"] == pp["concessions"]
        assert jp["selfCorrections"] == pp["self_corrections"]
        assert jp["goalposts"] == len(pp["goalposts"])

    assert [(c["who"], c["text"], c["status"], c["challenged"], c["answered"]) for c in js["ledger"]] == \
           [(c["who"], c["text"], c["status"], c["challenged"], c["answered"]) for c in py["ledger"]]
    assert [(q["who"], q["text"]) for q in js["unanswered"]] == \
           [(q["who"], q["text"]) for q in py["unanswered"]]
