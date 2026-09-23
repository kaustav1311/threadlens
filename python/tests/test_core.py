import json
from pathlib import Path

from threadlens import Analyzer, parse_chat
from threadlens.report import findings, to_markdown

ROOT = Path(__file__).resolve().parents[2]
SAMPLE = (ROOT / "samples/sample_debate_android.txt").read_text("utf-8")


def test_lexicons_in_sync():
    for name in ("lexicons.json", "vader.json"):
        a = json.loads((ROOT / "lexicons" / name).read_text("utf-8"))
        b = json.loads((ROOT / "python/threadlens/data" / name).read_text("utf-8"))
        assert a == b, f"python/threadlens/data/{name} is stale: run `make sync`"


def test_parse_android():
    p = parse_chat(SAMPLE)
    assert p["date_order"] == "DMY" and p["system_lines"] == 1
    assert {m.author for m in p["messages"]} == {"Asha", "Ravi"}


def test_parse_ios_12h():
    t = "‎[3/14/26, 9:05:11 PM] Sam: first\nsecond\n[3/14/26, 9:06:00 PM] Kai: ‎image omitted"
    p = parse_chat(t)
    assert p["date_order"] == "MDY"
    assert p["messages"][0].text == "first\nsecond" and p["messages"][0].date.hour == 21
    assert p["messages"][1].kind == "media"


def test_analysis_matches_expectations():
    res = Analyzer().analyse(parse_chat(SAMPLE))
    s = {x["name"]: x for x in res["stats"]}
    assert s["Ravi"]["absolutist"] > s["Asha"]["absolutist"]
    assert s["Asha"]["question_rate"] > s["Ravi"]["question_rate"]
    assert s["Ravi"]["reentries"]
    for lens in ("overview", "debate", "personal", "work"):
        assert findings(res, lens)
        assert "Threadlens report" in to_markdown(res, lens)


def test_anonymise():
    res = Analyzer().analyse(parse_chat(SAMPLE), anonymise=True)
    assert sorted(res["people"]) == ["Person A", "Person B"]


def test_undated_transcript_is_read_in_order():
    """Copying the message bubbles instead of exporting gives names and text but no
    clock. That used to produce "none of them carry a timestamp"."""
    t = "\n".join([
        "Riya: Hiii", "Sourav: Yooo", "Riya: Kmn achis?", "Sourav: cholche cholche",
        "Riya: the report says the backlog was 1,240 cases", "Sourav: thats not true at all",
        "Riya: you people always do this", "Sourav: the audit from October put it at 1,240",
    ])
    p = parse_chat(t)
    assert p["undated"] is True
    assert len(p["messages"]) == 8
    assert {m.author for m in p["messages"]} == {"Riya", "Sourav"}
    dates = [m.date for m in p["messages"]]
    assert dates == sorted(dates) and len(set(dates)) == len(dates)
    res = Analyzer().analyse(p)
    assert res["undated"] is True


def test_real_export_is_never_undated():
    p = parse_chat((ROOT / "samples/rigor_left_vs_right.txt").read_text("utf-8"))
    assert p["undated"] is False
    assert len(p["messages"]) > 20


def test_prose_with_a_colon_is_not_a_speaker():
    p = parse_chat("Here is the thing: it was never about the money.\nAnd another line.")
    assert p["messages"] == []
