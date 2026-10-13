"""Import the Muri bei Bern school holidays (Ferienordnung 2026-27) into WREN and limit the
current bookings to the end of school year 2026/27. Idempotent; writes drafts, does not publish."""
import json, urllib.request, urllib.error
from pathlib import Path

BASE = "https://wren.aemwip.com/api/v1"
KEY = (Path(__file__).parent / ".wren-key").read_text().strip()
SOURCE = "Ferienordnung 2026-27, Gemeinde Muri bei Bern (Stand 14.07.2026)"
LAST_SCHOOL_DAY = "2027-07-02"  # Friday before the summer holidays 2027

ENTRIES = [
    ("schuljahr-2026-27", "schuljahr", "Schuljahr 2026/27", "", LAST_SCHOOL_DAY),
    ("herbstferien-2026", "ferien", "Herbstferien", "2026-09-19", "2026-10-11"),
    ("unterrichtsfrei-2026-11-20", "unterrichtsfrei", "Unterrichtsfrei (Weiterbildung Lehrpersonen)", "2026-11-20", "2026-11-20"),
    ("winterferien-2026", "ferien", "Winterferien", "2026-12-25", "2027-01-10"),
    ("februarferien-2027", "ferien", "Februar-Ferienwoche", "2027-02-06", "2027-02-14"),
    ("unterrichtsfrei-2027-03-24", "unterrichtsfrei", "Unterrichtsfrei", "2027-03-24", "2027-03-24"),
    ("fruehlingsferien-2027", "ferien", "Frühlingsferien", "2027-04-10", "2027-04-25"),
    ("sommerferien-2027", "ferien", "Sommerferien", "2027-07-03", "2027-08-15"),
    ("herbstferien-2027", "ferien", "Herbstferien", "2027-09-25", "2027-10-17"),
    ("unterrichtsfrei-2027-11-25", "unterrichtsfrei", "Unterrichtsfrei", "2027-11-25", "2027-11-26"),
    ("winterferien-2027", "ferien", "Winterferien", "2027-12-25", "2028-01-09"),
]


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json", "User-Agent": "hallenbelegung-import/1.0"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def list_all(coll):
    items, offset = [], 0
    while True:
        _, page = call("GET", f"/{coll}?limit=200&offset={offset}")
        items += page["items"]
        offset += 200
        if len(items) >= page["total"] or not page["items"]:
            return items


call("PATCH", "/calendar/_schema", {"naturalKey": "key", "displayName": "{name} {from}"})
created = 0
for key, kind, name, frm, to in ENTRIES:
    doc = {"key": key, "kind": kind, "name": name, "from": frm, "to": to, "effect": "school", "source": SOURCE}
    status, saved = call("PUT", f"/calendar/by-key/{key}", doc)
    assert status in (200, 201), (status, saved)
    if status == 201:
        created += 1
    call("PUT", f"/tree/plan/calendar/{key}", {"documentId": saved["id"]})

changed = 0
for item in list_all("bookings"):
    d = item["data"]
    if d.get("validUntil"):
        continue
    status, _ = call("PUT", f"/bookings/{item['id']}", {**d, "validUntil": LAST_SCHOOL_DAY})
    assert status == 200, status
    changed += 1

print(f"calendar: {len(ENTRIES)} entries ({created} new); bookings limited to {LAST_SCHOOL_DAY}: {changed}")


# Publish only what this import touched: the calendar entries and bookings that were already
# public. Other open drafts (e.g. an admin's test booking) stay drafts.
if __name__ == "__main__" and "--publish" in __import__("sys").argv:
    n = 0
    for item in list_all("calendar"):
        call("POST", f"/calendar/{item['id']}/labels", {"label": "published"}); n += 1
    for item in list_all("bookings"):
        if "published" in (item.get("labels") or []) and item["data"].get("validUntil") == LAST_SCHOOL_DAY:
            status, _ = call("POST", f"/bookings/{item['id']}/labels", {"label": "published"})
            assert status in (200, 201), status
            n += 1
    print(f"published {n} documents (calendar + already-public bookings)")
