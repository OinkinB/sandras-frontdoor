"""Vexcel aerial imagery + parcel attributes for the outside of a home, cached on disk."""
import json
import math
import os
import random
import time
from pathlib import Path

import requests
from shapely import wkt as shp_wkt
from shapely.geometry import shape

API = "https://api.vexcelgroup.com/v2"
LAYERS = "urban,urban-r,wide-area,urban-g"


def _send(method, path, **kw):
    for attempt in range(5):
        r = requests.request(method, f"{API}/{path}", headers={"X-API-KEY": os.environ["VEXCEL_API_KEY"]}, **kw)
        if r.status_code != 429:
            return r
        time.sleep(min(2 ** attempt, 20) + random.random())
    return r


def _to_wkt(g):
    return shp_wkt.loads(g).wkt if isinstance(g, str) else shape(g).wkt


def _square(lat, lon, half_m=35):
    dlat = half_m / 111_320
    dlon = half_m / (111_320 * math.cos(math.radians(lat)))
    return f"POLYGON(({lon-dlon} {lat-dlat},{lon+dlon} {lat-dlat},{lon+dlon} {lat+dlat},{lon-dlon} {lat+dlat},{lon-dlon} {lat-dlat}))"


def parcel(home: dict, cache: Path) -> dict:
    f = cache / f"vx_{home['id']}.json"
    if f.exists():
        return json.loads(f.read_text())
    r = _send("GET", "property/extract", timeout=120, params={
        "wkt": f"POINT({home['lon']} {home['lat']})", "srid": 4326, "layer": LAYERS,
        "latest": "true", "include": "precomputed", "unit-system": "imperial"})
    if r.status_code == 404:
        out = {"found": False, "wkt": _square(home["lat"], home["lon"])}
    else:
        r.raise_for_status()
        feat = r.json()["features"][0]
        a = feat["properties"]
        prim = next((s for s in a.get("structures", []) if s.get("primary-structure")), {})
        out = {
            "found": True, "wkt": _to_wkt(feat["geometry"]),
            "collection": a.get("metadata.collection"),
            "structures": a.get("structure.count"),
            "tree_cover_pct": a.get("parcel-tree-cover.percent"),
            "hardscape_pct": a.get("hardscapes.percent"),
            "pool": a.get("pool.detected"),
            "deck": a.get("deck.detected"),
            "vehicles": a.get("vehicles.count"),
            "footprint_sqft": prim.get("footprint.area"),
            "roof": prim.get("roof-characteristics.material.class"),
            "footprint_wkt": prim.get("footprint-wkt") or prim.get("footprint.wkt"),
        }
    f.write_text(json.dumps(out))
    return out


def ortho(home: dict, cache: Path) -> bytes:
    f = cache / f"vx_{home['id']}.jpg"
    if f.exists():
        return f.read_bytes()
    p = parcel(home, cache)
    area = p["wkt"]
    if (p.get("structures") or 0) > 3:      # shared parcel (townhomes/condos): frame the home itself
        area = _square(home["lat"], home["lon"], 30)
        outline = _square(home["lat"], home["lon"], 7)
    else:
        outline = p["wkt"]
    drawing = [{"wkt": outline, "outline-width": 4, "outline-color": "rgb(255,204,0)"}]
    r = _send("POST", "ortho/extract", timeout=300, json={
        "wkt": area, "srid": 4326, "layer": LAYERS, "buffer-meter": 12, "crop": "bounding_box",
        "image-format": "jpeg", "drawing": drawing})
    r.raise_for_status()
    f.write_bytes(r.content)
    return r.content
