"""Import the Muri-Gümligen Fixbelegungsplan (belegung_bloecke.csv) into WREN.

Idempotent: collections declare a naturalKey and documents are written with
PUT /by-key, so re-running only adds versions where data changed.
Nothing is made public here.
"""
import csv, json, re, sys, unicodedata, urllib.request, urllib.error
from pathlib import Path

BASE = "https://wren.aemwip.com/api/v1"
HERE = Path(__file__).parent
KEY = (HERE / ".wren-key").read_text().strip()
SOURCE = "2026_Fixbelegungsplaene_Sportanlagen.pdf (Stand 17.09.2026)"


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json",
                 # Cloudflare rejects urllib's default User-Agent
                 "User-Agent": "hallenbelegung-import/1.0"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} -> {e.code}: {e.read().decode()}")


def slug(s):
    s = s.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def split_hall(name):
    m = re.match(r"(.*?)\s*\((.*)\)$", name)
    full, size = (m.group(1), m.group(2)) if m else (name, None)
    short = full.removeprefix("Sporthalle ").strip()
    return full, short, size


bookings = list(csv.DictReader(open(HERE / "belegung_bloecke.csv", encoding="utf-8-sig"), delimiter=";"))

call("PATCH", "/halls/_schema", {
    "naturalKey": "key", "displayName": "{name}",
    "schema": {"type": "object", "required": ["key", "name"], "properties": {
        "key": {"type": "string"}, "name": {"type": "string"},
        "size": {"type": ["string", "null"]}, "source": {"type": "string"}}}})
call("PATCH", "/bookings/_schema", {
    "naturalKey": "key", "displayName": "{hall} {day} {from}-{to}",
    "schema": {"type": "object", "required": ["key", "hall", "day", "from", "to", "category"], "properties": {
        "key": {"type": "string"}, "hall": {"type": "string"}, "hallKey": {"type": "string"},
        "day": {"enum": ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]},
        "season": {"type": "string"}, "from": {"type": "string"}, "to": {"type": "string"},
        "category": {"type": "string"}, "note": {"type": "string"}, "source": {"type": "string"}}}})

halls = {}
for b in bookings:
    full, short, size = split_hall(b["Halle"])
    halls[slug(short)] = {"key": slug(short), "name": full, "size": size, "source": SOURCE}

stats = {}
for doc in halls.values():
    status, _ = call("PUT", f"/halls/by-key/{doc['key']}", doc)
    stats[status] = stats.get(status, 0) + 1

for b in bookings:
    full, short, _ = split_hall(b["Halle"])
    hk = slug(short)
    key = "-".join([hk, slug(b["Tag"]), slug(b["Saison"]), b["Von"].replace(".", "")])
    doc = {"key": key, "hall": full, "hallKey": hk, "day": b["Tag"], "season": b["Saison"],
           "from": b["Von"].replace(".", ":"), "to": b["Bis"].replace(".", ":"),
           "category": b["Kategorie"], "note": b["Notiz"], "source": SOURCE}
    status, _ = call("PUT", f"/bookings/by-key/{key}", doc)
    stats[status] = stats.get(status, 0) + 1

print(f"{len(halls)} halls, {len(bookings)} bookings; HTTP status counts: {stats}")
