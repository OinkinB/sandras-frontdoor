"""Matterport GraphQL: rooms, floors and scan locations, cached on disk."""
import json
import os
from pathlib import Path

import requests

API = "https://api.matterport.com/api/models/graph"
QUERY = """query($id: ID!) { model(id: $id) {
  id name
  floors { id label }
  rooms { id label classifications { label } floor { label }
          dimensions { width depth height areaFloor units } }
  locations { id floor { label } position { x y z } neighbors }
}}"""


def cached_info(model_id: str, cache_dir: Path) -> dict | None:
    try:
        return json.loads((cache_dir / f"mp_{model_id}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def model_info(model_id: str, cache_dir: Path) -> dict:
    if (cached := cached_info(model_id, cache_dir)) is not None:
        return cached
    f = cache_dir / f"mp_{model_id}.json"
    r = requests.post(API, json={"query": QUERY, "variables": {"id": model_id}}, timeout=60,
                      auth=(os.environ["MATTERPORT_API_KEY"], os.environ["MATTERPORT_API_TOKEN"]))
    r.raise_for_status()
    m = (r.json().get("data") or {}).get("model") or {}
    rooms = []
    for rm in m.get("rooms") or []:
        labels = [c["label"] for c in rm.get("classifications") or [] if c.get("label") not in (None, "Void", "Other")]
        if not labels:
            continue
        d = rm.get("dimensions") or {}
        rooms.append({"id": rm["id"], "type": " / ".join(labels), "floor": (rm.get("floor") or {}).get("label"),
                      "width_ft": d.get("width"), "depth_ft": d.get("depth"), "area_sqft": d.get("areaFloor")})
    floors = [x["label"] for x in m.get("floors") or []]
    stair = any("Stair" in r["type"] for r in rooms)
    halls = [r for r in rooms if "Hallway" in r["type"] and r.get("width_ft")]
    baths = [r for r in rooms if "Bathroom" in r["type"]]
    findings = []
    if len(floors) > 1 or stair:
        findings.append({"need": "no_stairs", "status": "no", "evidence": f"3D scan: {len(floors)} floors" + (", staircase detected" if stair else "")})
    elif floors:
        findings.append({"need": "no_stairs", "status": "yes", "evidence": "3D scan: single floor, no staircase"})
    for h in halls:
        w = min(h["width_ft"], h.get("depth_ft") or 99)
        if w < 3.5:
            findings.append({"need": "wide_doorways", "status": "no",
                             "evidence": f"3D scan: hallway on {h['floor']} only {w*12:.0f} in wide (wheelchairs need ~36 in+)"})
    for b in baths:
        if b.get("area_sqft") and b["area_sqft"] < 40:
            findings.append({"need": "walk_in_shower", "status": "info",
                             "evidence": f"3D scan: {b['floor']} bathroom is {b['area_sqft']:.0f} sq ft (60 in turning circle needs ~5x5 ft clear)"})
    out = {"name": m.get("name"), "floors": floors, "rooms": rooms, "findings": findings,
           "sweeps": len(m.get("locations") or [])}
    f.write_text(json.dumps(out), encoding="utf-8")
    return out
