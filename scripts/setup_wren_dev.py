"""Bootstrap a developer's own WREN *test* org with the Hallenbelegung data and publish it.

Usage (from the repo root):  python scripts/setup_wren_dev.py
Reads WREN_API_KEY (and optional WREN_PREFIX, e.g. "anna-") from .dev.vars; with a prefix,
several test environments can live side by side in one WREN account. Creates collections, public read rules, halls (Moos as a
three-part hall), the bookings from belegung_bloecke.csv, the school holidays, and publishes
everything (label "published" on the plan tree). Idempotent. Refuses the production org.
"""
import csv, json, re, sys, unicodedata, urllib.request, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from wren_calendar_import import ENTRIES, LAST_SCHOOL_DAY, SOURCE as CAL_SOURCE  # noqa: E402

PRODUCTION_ORG = "hallenbelegung-muri-guemligen"
BASE = "https://wren.aemwip.com/api/v1"
DEV_VARS = dict(re.findall(r"^(\w+)=(.*)$", (ROOT / ".dev.vars").read_text(encoding="utf-8"), re.M))
KEY = DEV_VARS.get("WREN_API_KEY", "").strip()
PREFIX = DEV_VARS.get("WREN_PREFIX", "").strip()
if PREFIX and not re.fullmatch(r"[a-z0-9][a-z0-9-]*-", PREFIX):
    sys.exit("WREN_PREFIX must look like 'name-' (lowercase letters, digits, hyphens, ending with '-')")
SOURCE = "2026_Fixbelegungsplaene_Sportanlagen.pdf (Stand 17.09.2026)"


def prefixed(path):
    """Collections and trees get the prefix; /me and /permissions do not."""
    if not PREFIX or path.startswith(("/me", "/permissions")):
        return path
    if path.startswith("/tree/"):
        return "/tree/" + PREFIX + path[len("/tree/"):]
    return "/" + PREFIX + path[1:]


def call(method, path, body=None):
    req = urllib.request.Request(BASE + prefixed(path), method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json", "User-Agent": "hallenbelegung-dev-setup/1.0"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def ok(status, data, what):
    if status not in (200, 201):
        sys.exit(f"{what} failed: {status} {data}")
    return data


def slug(s):
    s = s.lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def upsert(coll, key, doc):
    """Create or update by natural key and make sure the document is in the plan tree."""
    saved = ok(*call("PUT", f"/{coll}/by-key/{key}", doc), f"{coll}/{key}")
    ok(*call("PUT", f"/tree/plan/{coll}/{key}", {"documentId": saved["id"]}), f"tree {coll}/{key}")


def main():
    if not KEY:
        sys.exit("WREN_API_KEY missing in .dev.vars")
    me = ok(*call("GET", "/me"), "GET /me")
    org = me["org"]["slug"]
    if org == PRODUCTION_ORG:
        sys.exit(f"Refusing to run against the production org '{org}'. Use your own WREN test account.")
    if DEV_VARS.get("WREN_ORG") and DEV_VARS["WREN_ORG"].strip() != org:
        print(f"Note: .dev.vars has WREN_ORG={DEV_VARS['WREN_ORG']}, but the key belongs to '{org}'. Set WREN_ORG={org}.")
    print(f"Setting up WREN org '{org}'" + (f" with prefix '{PREFIX}'" if PREFIX else "") + " …")

    for coll in ("halls", "bookings", "calendar", "booking_holders"):
        call("PATCH", f"/{coll}/_schema", {"naturalKey": "key"})

    # Public read rules (published versions only); requests and booking_holders stay private.
    have = {p["resource"] for p in ok(*call("GET", "/permissions"), "permissions")["permissions"] if p["principal"] == "*"}
    for coll in ("halls", "bookings", "calendar"):
        if f"collection:{PREFIX}{coll}" not in have:
            ok(*call("POST", "/permissions", {"principal": "*", "resource": f"collection:{PREFIX}{coll}", "access": "read", "labelFilter": "published"}), f"rule {coll}")

    rows = list(csv.DictReader(open(ROOT / "belegung_bloecke.csv", encoding="utf-8-sig"), delimiter=";"))
    halls = {}
    for r in rows:
        m = re.match(r"(.*?)\s*\((.*)\)$", r["Halle"])
        full, size = (m.group(1), m.group(2)) if m else (r["Halle"], None)
        key = slug(full.removeprefix("Sporthalle "))
        halls[key] = {"key": key, "name": full, "size": size, "type": "Sporthalle", "holidays": "closed", "source": SOURCE}
    halls["moos"].update({
        "type": "Dreifachhalle",
        "units": [{"key": "A", "name": "Drittel A"}, {"key": "B", "name": "Drittel B"}, {"key": "C", "name": "Drittel C"}],
        "spaces": [{"key": "ganz", "name": "Ganze Halle", "units": ["A", "B", "C"]}, {"key": "gross", "name": "2/3 (A+B)", "units": ["A", "B"]},
                   {"key": "a", "name": "1/3 A", "units": ["A"]}, {"key": "b", "name": "1/3 B", "units": ["B"]}, {"key": "c", "name": "1/3 C", "units": ["C"]}],
    })
    for key, h in halls.items():
        upsert("halls", key, h)
    print(f"  halls: {len(halls)}")

    for r in rows:
        m = re.match(r"(.*?)\s*\((.*)\)$", r["Halle"])
        full = m.group(1) if m else r["Halle"]
        hk = slug(full.removeprefix("Sporthalle "))
        key = "-".join([hk, slug(r["Tag"]), slug(r["Saison"]), r["Von"].replace(".", "")])
        upsert("bookings", key, {
            "key": key, "hall": full, "hallKey": hk, "day": r["Tag"], "season": r["Saison"],
            "from": r["Von"].replace(".", ":"), "to": r["Bis"].replace(".", ":"), "category": r["Kategorie"],
            "note": r["Notiz"], "validUntil": LAST_SCHOOL_DAY, "source": SOURCE,
        })
    print(f"  bookings: {len(rows)}")

    for key, kind, name, frm, to in ENTRIES:
        upsert("calendar", key, {"key": key, "kind": kind, "name": name, "from": frm, "to": to, "effect": "school", "source": CAL_SOURCE})
    print(f"  calendar: {len(ENTRIES)}")

    promoted = ok(*call("POST", "/tree/plan/_promote", {"label": "published"}), "publish")
    print(f"Published {len(promoted.get('promoted', []))} documents. Set WREN_ORG={org}" + (f" and WREN_PREFIX={PREFIX}" if PREFIX else "") + " in .dev.vars and run: npm run dev")


if __name__ == "__main__":
    main()
