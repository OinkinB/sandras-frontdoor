"""Load CoStar/Homes.com residential listings and extract accessibility evidence.

Every listing kept here has a Matterport scan. Each accessibility need gets a
status: "yes" (stated), "likely" (strong hint), "no" (contradicted) or
"unknown", plus the text snippet that produced it.
"""
import csv
import json
import re
from pathlib import Path

from . import costs

HOMES: dict[int, dict] = {}

NEEDS = {
    "no_stairs": "No interior stairs",
    "step_free_entry": "Step-free entry",
    "wide_doorways": "Wide doorways (36 in+)",
    "walk_in_shower": "Walk-in shower",
    "roll_in_shower": "Roll-in / curbless shower",
    "grab_bars": "Grab bars",
    "first_floor_bedroom": "Bedroom + bath on main floor",
    "smooth_flooring": "Smooth hard flooring",
    "garage": "Garage / covered parking",
    "lever_handles": "Lever door handles",
    "visual_alerts": "Visual doorbell or alarms",
    "even_lighting": "Even, glare-controlled lighting",
    "quiet_space": "Quiet room or sound insulation",
}

# (need, status, regex) checked against remarks + feature lines, first match wins per need.
RULES = [
    ("roll_in_shower", "yes", r"roll[- ]in shower|curbless shower|zero[- ]threshold shower|barrier[- ]free shower"),
    ("roll_in_shower", "no", r"tub/shower combo|shower over tub|raised shower curb"),
    ("walk_in_shower", "yes", r"(walk|roll)[- ]in shower|curbless|zero[- ]threshold shower|barrier[- ]free shower"),
    ("walk_in_shower", "no", r"bathtub with shower|tub/shower|shower over tub|garden tub"),
    ("grab_bars", "yes", r"grab bars?"),
    ("step_free_entry", "yes", r"no[- ]step entry|zero[- ]step entry|step[- ]free entry|zero[- ]entry|level entry"),
    ("step_free_entry", "likely", r"\bramp(ed)?\b|wheelchair accessible"),
    ("wide_doorways", "yes", r"36[- ]?(in|inch|\")[^.]{0,15}door"),
    ("wide_doorways", "likely", r"wide(r|ned)? (door|hall)|wheelchair accessible"),
    ("first_floor_bedroom", "yes", r"(primary|master|owner'?s?) (bedroom|suite|retreat)[^.]{0,40}(down|first floor|1st floor|main (level|floor)|ground floor)|(first|1st|main)[- ](floor|level) (primary|master|bedroom)|bedroom on main"),
    ("smooth_flooring", "no", r"\bcarpet"),
    ("smooth_flooring", "yes", r"tile flooring|vinyl|laminate|hardwood|wood floor|luxury vinyl|polished concrete|engineered wood"),
    ("garage", "yes", r"garage|carport"),
    ("lever_handles", "yes", r"\blever (door handles?|handlesets?|hardware)\b"),
    ("visual_alerts", "yes", r"\b(visual (doorbell|alarm)|strobe (alarm|doorbell))\b"),
    ("even_lighting", "yes", r"\b(glare[- ]free lighting|diffused lighting|dimmable lighting)\b"),
    ("quiet_space", "yes", r"\b(soundproof(ed|ing)? room|acoustic insulation|sound attenuat\w+)\b"),
]


def _stories(text: str):
    m = re.search(r"(\d)[- ]stor(y|ies) (property|home)", text, re.I) or re.search(r"(\d)[- ]story", text, re.I)
    if m:
        return int(m.group(1))
    if re.search(r"\b(single|one)[- ]stor(y|ies)\b|\branch[- ]style\b", text, re.I):
        return 1
    if re.search(r"\b(two|2)[- ]stor(y|ies)\b", text, re.I):
        return 2
    return None


def _photo_urls(media):
    return [m["uri"] for m in sorted(media or [], key=lambda m: m.get("displayOrder", 999))
            if m.get("type") == 4 and m.get("uri")][:12]


def _matterport_id(rec, csv_map):
    for m in rec.get("media") or []:
        if m.get("externalReferenceType") in (36, 234) and m.get("videoKey"):
            return m["videoKey"]
    return csv_map.get(str(rec["id"]))


def _price(rec):
    for k in ("currentPrice", "closePrice", "originalPrice"):
        if rec.get(k):
            return float(rec[k])
    for v in (rec.get("displayPrice") or {}).get("values") or []:
        if v.get("value"):
            return float(v["value"])
    return None


def extract(text: str, stories, condo: bool, has_elevator: bool) -> dict:
    ev = {k: {"status": "unknown", "evidence": ""} for k in NEEDS}
    for need, status, pat in RULES:
        if ev[need]["status"] != "unknown":
            continue
        m = re.search(pat, text, re.I)
        if m:
            s, e = max(0, m.start() - 50), min(len(text), m.end() + 50)
            ev[need] = {"status": status, "evidence": "…" + text[s:e].strip() + "…"}
    if stories == 1:
        ev["no_stairs"] = {"status": "yes", "evidence": "Listed as 1-story"}
        if ev["first_floor_bedroom"]["status"] == "unknown":
            ev["first_floor_bedroom"] = {"status": "yes", "evidence": "Single-story home"}
    elif stories and stories > 1:
        if condo and has_elevator:
            ev["no_stairs"] = {"status": "likely", "evidence": f"Condo in elevator building ({stories} stories)"}
        else:
            ev["no_stairs"] = {"status": "no", "evidence": f"{stories}-story home"}
    return ev


def load(kit: Path):
    csv_map = {r["ListingId"]: r["MatterportModelId"]
               for r in csv.DictReader(open(kit / "residential-listings.csv", encoding="utf8"))
               if r["MatterportModelId"]}
    feats = {}
    for line in open(kit / "data" / "residential-listing-features.jsonl", encoding="utf8"):
        f = json.loads(line)
        lines = [ln for s in f.get("sections") or [] for ln in s.get("lines") or []]
        lines += [h["text"] for h in f.get("highlights") or []]
        feats[f["id"]] = lines

    seen_attempts = set()
    for line in open(kit / "data" / "residential-listings.jsonl", encoding="utf8"):
        r = json.loads(line)
        attempt = r.get("residentialListingId") or r["id"]
        if attempt in seen_attempts:
            continue
        mp = _matterport_id(r, csv_map)
        if not mp:
            continue
        p = r.get("property") or {}
        a = p.get("address") or {}
        if not a.get("latitude"):
            continue
        seen_attempts.add(attempt)
        flines = feats.get(r["id"], [])
        remarks = r.get("remarks") or ""
        text = remarks + " \n " + " | ".join(flines)
        stories = _stories(" | ".join(flines)) or _stories(remarks)
        ev = extract(text, stories, bool(r.get("isInCondoBuilding")), bool(r.get("hasElevator")))
        street = " ".join(x for x in [a.get("fullStreetAddress") or "", a.get("unitNumber") or ""] if x).strip()
        hood = next((x.get("name") for x in a.get("areas") or []
                     if x.get("enterpriseEntityType") == 5 and x.get("name")), None)
        HOMES[r["id"]] = {
            "id": r["id"],
            "matterport_id": mp,
            "rent": r.get("transactionType") == 2,
            "price": _price(r),
            "beds": p.get("bedsMin"),
            "baths": p.get("bathsMin") or p.get("bathsFull"),
            "sqft": p.get("sqftMin"),
            "lot_acres": p.get("lotSizeAcresMin"),
            "year_built": p.get("yearBuilt"),
            "stories": stories,
            "condo": bool(r.get("isInCondoBuilding")),
            "address": street or "Address withheld",
            "city": (a.get("city") or "").title(),
            "neighborhood": hood,
            "state": a.get("state"),
            "zip": a.get("zip") or a.get("postalCode"),
            "lat": a["latitude"], "lon": a["longitude"],
            "photos": _photo_urls(r.get("media")),
            "remarks": remarks,
            "features": flines,
            "evidence": ev,
            "status": r.get("listingStatus"),
        }


def score(home: dict, needs: list[str]) -> dict:
    """Score a home against requested needs and price the fixes."""
    needs = needs or ["no_stairs", "step_free_entry", "walk_in_shower", "wide_doorways"]
    pts, mods = 0.0, []
    for n in needs:
        st = home["evidence"].get(n, {}).get("status", "unknown")
        pts += {"yes": 1.0, "likely": 0.75, "unknown": 0.4, "no": 0.0}[st]
        if st != "yes":
            key = costs.NEED_TO_MOD.get(n)
            if key and not (n == "no_stairs" and st == "likely"):
                if n == "no_stairs" and home["stories"] == 1:
                    continue
                mods.append({"key": key, "label": costs.MODS[key]["label"], "cost": costs.mid(key),
                             "certain": st == "no"})
    pct = round(100 * pts / len(needs))
    mod_total = sum(m["cost"] for m in mods)
    return {"match": pct, "mods": mods, "mod_total": mod_total,
            "true_cost": (home["price"] or 0) + (0 if home["rent"] else mod_total)}


def public(home: dict, s: dict | None = None) -> dict:
    out = {k: home[k] for k in ("id", "matterport_id", "rent", "price", "beds", "baths", "sqft", "year_built",
                                "stories", "address", "city", "neighborhood", "state", "zip", "lat", "lon", "condo", "lot_acres")}
    out["photo"] = home["photos"][0] if home["photos"] else None
    out["evidence"] = {k: {**v, "label": NEEDS[k]} for k, v in home["evidence"].items()}
    if s:
        out.update(s)
    return out
