"""WhatsApp export parsing (Android + iOS, 12h/24h). Mirrors web/src/core.js."""
from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass
from datetime import datetime, timedelta

INVISIBLE = re.compile("[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]")
# The year is optional: selecting messages on a phone and copying them yields a
# bare 22/09 with no year at all.
_D = r"(\d{1,4})[./-](\d{1,2})(?:[./-](\d{1,4}))?"
_T = r"(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?"
# Hyphen, en dash or em dash, and the space after the separator is optional.
_SEP = r"\s*[-–—]\s*"
ANDROID = re.compile(r"^" + _D + r",?\s+" + _T + _SEP + r"(.*)$")
IOS = re.compile(r"^\[" + _D + r",?\s+" + _T + r"\]\s?(.*)$")
# Clock first: [10:07, 22/09/2026] Ravi: hello. WhatsApp writes the timestamp this
# way round on a number of locales, and it is the shape people paste most often.
IOS_TF = re.compile(r"^\[" + _T + r",?\s+" + _D + r"\]\s?(.*)$")
ANDROID_TF = re.compile(r"^" + _T + r",?\s+" + _D + _SEP + r"(.*)$")


def _head(probe):
    """Canonical head: ((d1, d2, d3, hh, mm, ss, am/pm), rest)."""
    m = IOS.match(probe) or ANDROID.match(probe)
    if m:
        return m.groups()[:7], m.group(8)
    m = IOS_TF.match(probe) or ANDROID_TF.match(probe)
    if not m:
        return None
    g = m.groups()
    return (g[4], g[5], g[6], g[0], g[1], g[2], g[3]), g[7]
MEDIA = re.compile(r"^(<media omitted>|<attached:.*>|(image|video|audio|sticker|gif|document|contact card) omitted|null)$", re.I)
DELETED = re.compile(r"^(this message was deleted|you deleted this message|message deleted)$", re.I)
EDITED = re.compile(r"\s*<this message was edited>\s*$", re.I)

MAX_BYTES = 25 * 1024 * 1024


@dataclass
class Message:
    date: datetime
    author: str
    text: str
    kind: str  # text | media | deleted
    edited: bool


def _clean(line: str) -> str:
    return INVISIBLE.sub("", line).replace("\u202f", " ").replace("\u00a0", " ").rstrip("\r")


def _order(heads) -> str:
    dmy = mdy = ymd = 0
    for h in heads:
        a, b = int(h[0]), int(h[1])
        if len(h[0]) == 4:
            ymd += 1
        elif a > 12:
            dmy += 1
        elif b > 12:
            mdy += 1
    if ymd > len(heads) / 2:
        return "YMD"
    return "MDY" if mdy > dmy else "DMY"


def _date(h, order, ctx):
    """`ctx` carries the last year seen and the previous timestamp, so a
    year-less line copied off a phone can be placed. Mutated as we go."""
    y = None
    if not h[2]:
        # No year in the line at all. YMD cannot apply to two components.
        if order == "MDY":
            mo, d = int(h[0]), int(h[1])
        else:
            d, mo = int(h[0]), int(h[1])
    elif order == "YMD":
        y, mo, d = int(h[0]), int(h[1]), int(h[2])
    elif order == "MDY":
        mo, d, y = int(h[0]), int(h[1]), int(h[2])
    else:
        d, mo, y = int(h[0]), int(h[1]), int(h[2])
    if y is not None and y < 100:
        y += 2000
    hr, mi, se = int(h[3]), int(h[4]), int(h[5] or 0)
    ap = re.sub(r"[.\s]", "", h[6] or "").lower()
    if ap == "pm" and hr < 12:
        hr += 12
    if ap == "am" and hr == 12:
        hr = 0
    if y is None:
        # Inherit the last year we saw, or assume this year. An export runs
        # forwards, so if that lands before the previous message the chat has
        # crossed a new year and the year goes up by one.
        y = ctx["year"] or datetime.now().year
        try:
            dt = datetime(y, mo, d, hr, mi, se)
        except ValueError:
            return None
        if ctx["prev"] and dt < ctx["prev"]:
            dt = datetime(y + 1, mo, d, hr, mi, se)
        ctx["prev"] = dt
        return dt
    try:
        dt = datetime(y, mo, d, hr, mi, se)
    except ValueError:
        return None
    ctx["year"] = y
    ctx["prev"] = dt
    return dt


def _as_dt(v, end_of_day=False):
    """Accept a date, a datetime or an ISO string. A bare date as `to` means the
    whole of that day, which is what a person picking a date in a UI means."""
    if v is None or isinstance(v, datetime):
        return v
    if isinstance(v, str):
        # Test the ORIGINAL string for date-only, not the parsed value: a parsed
        # datetime always renders with a time, so this check never fired and a
        # bare `to` date silently excluded that entire day.
        date_only = len(v.strip()) == 10
        dt = datetime.fromisoformat(v)
        if end_of_day and date_only:
            return dt.replace(hour=23, minute=59, second=59, microsecond=999999)
        return dt
    # a datetime.date
    dt = datetime(v.year, v.month, v.day)
    return dt.replace(hour=23, minute=59, second=59, microsecond=999999) if end_of_day else dt


# "Ravi: hello" -- a transcript with no timestamps at all. A name is short and has
# no sentence punctuation in it, which is what separates this from an ordinary line
# of prose that happens to contain a colon.
UNDATED = re.compile(r"^([^:\n]{1,40}):\s+(\S.*)$")
UNDATED_MIN_ROWS = 3   # fewer than this is a stray colon, not a transcript
UNDATED_EPOCH = datetime(2000, 1, 1)
UNDATED_STEP = timedelta(minutes=1)


def _tokenize_undated(text):
    """Parse a transcript that carries an order but no times: copied message bubbles,
    a pasted screenshot transcription, notes from a call.

    Messages are given a synthetic timeline one minute apart. That keeps every
    downstream pass -- episodes, reply gaps, the day series -- working on real
    datetimes instead of spreading None checks through the whole scorer. It also
    makes those particular numbers meaningless, which is why `undated` is set:
    callers must HIDE anything time-derived rather than print an invented hour.

    Mirrors tokenizeUndated() in core.js.
    """
    out = []
    seen = 0
    for line in str(text or "").split("\n"):
        line = _clean(line)
        probe = line.lstrip()
        if probe:
            seen += 1
        m = UNDATED.match(probe)
        # A speaker is a name, not a clause: at most a few words and no sentence
        # punctuation. Without that, "Here is the thing: it was never about the money"
        # reads as a person called "Here is the thing".
        name = m.group(1).strip() if m else ""
        if m and not re.search(r"[.!?,;]", name) and len(name.split()) <= 4:
            out.append([UNDATED_EPOCH + len(out) * UNDATED_STEP, name, m.group(2)])
        elif out and probe:
            out[-1][2] += "\n" + line
    # A transcript reuses a small cast of speakers; prose that happens to contain
    # colons invents a new "name" every time. That ratio is the reliable signal.
    authors = {r[1] for r in out}
    if len(out) < UNDATED_MIN_ROWS or len(authors) > -(-len(out) // 2):
        return [], seen
    return out, seen


def parse_chat(text: str, date_order: str = "auto", frm=None, to=None):
    """Parse an export. `frm`/`to` clip the conversation before anything is scored,
    so rates, episodes, drift and the ledger are all computed on the clip."""
    rows = []
    seen, first = 0, ""
    for line in str(text or "").split("\n"):
        line = _clean(line)
        # Match on a left-trimmed copy but keep the original for continuation
        # text: pasted exports almost always pick up an indent somewhere, and a
        # single leading space used to drop the line entirely.
        probe = line.lstrip()
        if probe:
            seen += 1
            if not first:
                first = probe[:120]
        m = _head(probe)
        if m:
            rows.append([m[0], m[1]])
        elif rows:
            rows[-1][1] += "\n" + line
    # Not one timestamp anywhere: this is a transcript, not an export. Fall back
    # rather than returning nothing, which is what "paste doesn't work" looked like
    # when someone copied the bubbles instead of exporting the chat.
    undated = not rows
    undated_rows = []
    if undated:
        undated_rows, undated_seen = _tokenize_undated(text)
        seen = seen or undated_seen
    order = "DMY" if undated else (_order([r[0] for r in rows]) if date_order == "auto" else date_order)
    frm = _as_dt(frm)
    to = _as_dt(to, end_of_day=True)
    messages, system, clipped = [], 0, 0
    ctx = {"year": None, "prev": None}
    source = ([(d, who + ": " + body) for d, who, body in undated_rows] if undated
              else [(None, r[1]) for r in rows])
    for pos, (fixed, rest) in enumerate(source):
        if undated:
            date = fixed
        else:
            date = _date(rows[pos][0], order, ctx)
        if not date:
            continue
        # A clip is a date range, and an undated transcript has no dates to clip by.
        if not undated and ((frm and date < frm) or (to and date > to)):
            clipped += 1
            continue
        idx = rest.find(": ")
        name = rest[:idx] if idx > 0 else ""
        if idx <= 0 or len(name) > 60 or "\n" in name:
            system += 1
            continue
        body = rest[idx + 2:].strip()
        edited = bool(EDITED.search(body))
        body = EDITED.sub("", body).strip()
        kind = "media" if MEDIA.match(body) else "deleted" if DELETED.match(body) else "text"
        messages.append(Message(date, name.strip(), body if kind == "text" else "", kind, edited))
    return {"messages": messages, "date_order": order, "system_lines": system,
            # `undated` means the timeline is synthetic. Every time-derived number --
            # hours of day, reply gaps, the day series, the clip -- is an artefact of
            # that and must be hidden rather than shown.
            "undated": undated,
            "line_count": seen, "first_line": first, "clipped": clipped}


def read_export(data: bytes, filename: str = "") -> str:
    """Return chat text from .txt, WhatsApp .zip or .docx bytes."""
    if len(data) > MAX_BYTES:
        raise ValueError("File larger than 25 MB. Export the chat without media.")
    if data[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = z.namelist()
            if "word/document.xml" in names:
                xml = z.read("word/document.xml").decode("utf-8", "replace")
                xml = re.sub(r"<w:tab/>", "\t", xml)
                xml = re.sub(r"<w:br[^>]*/>", "\n", xml).replace("</w:p>", "\n")
                txt = re.sub(r"<[^>]+>", "", xml)
                for a, b in (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&apos;", "'"), ("&amp;", "&")):
                    txt = txt.replace(a, b)
                return txt
            txts = sorted([n for n in names if n.lower().endswith(".txt")], key=lambda n: "chat" not in n.lower())
            if not txts:
                raise ValueError("Zip has no .txt chat inside.")
            return z.read(txts[0]).decode("utf-8", "replace")
    return data.decode("utf-8", "replace")
