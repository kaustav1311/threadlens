"""WhatsApp export parsing (Android + iOS, 12h/24h). Mirrors web/src/core.js."""
from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass
from datetime import datetime

INVISIBLE = re.compile("[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]")
_DT = r"(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?"
ANDROID = re.compile(r"^" + _DT + r"\s*[-–]\s(.*)$")
IOS = re.compile(r"^\[" + _DT + r"\]\s?(.*)$")
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


def _date(h, order):
    if order == "YMD":
        y, mo, d = int(h[0]), int(h[1]), int(h[2])
    elif order == "MDY":
        mo, d, y = int(h[0]), int(h[1]), int(h[2])
    else:
        d, mo, y = int(h[0]), int(h[1]), int(h[2])
    if y < 100:
        y += 2000
    hr, mi, se = int(h[3]), int(h[4]), int(h[5] or 0)
    ap = re.sub(r"[.\s]", "", h[6] or "").lower()
    if ap == "pm" and hr < 12:
        hr += 12
    if ap == "am" and hr == 12:
        hr = 0
    try:
        return datetime(y, mo, d, hr, mi, se)
    except ValueError:
        return None


def parse_chat(text: str, date_order: str = "auto"):
    rows = []
    for line in str(text or "").split("\n"):
        line = _clean(line)
        m = IOS.match(line) or ANDROID.match(line)
        if m:
            rows.append([m.groups()[:7], m.group(8)])
        elif rows:
            rows[-1][1] += "\n" + line
    order = _order([r[0] for r in rows]) if date_order == "auto" else date_order
    messages, system = [], 0
    for head, rest in rows:
        date = _date(head, order)
        if not date:
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
    return {"messages": messages, "date_order": order, "system_lines": system}


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
