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
