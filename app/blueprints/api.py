"""JSON API: search, home details, 3D selection analysis, chat, aerial view."""
import base64
import hashlib
import json
import math
import re
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock
from uuid import uuid4
from functools import lru_cache

from flask import Blueprint, Response, abort, current_app, jsonify, request

from ..services import ai, costs, imaging, listings, matterport, vexcel

bp = Blueprint("api", __name__)


def _home(home_id):
    h = listings.HOMES.get(home_id)
    if not h:
        abort(404)
    return h


# Explicit requests run before the natural-language refinement returns.
_SEARCH_TERMS = {
    "no_stairs": r"\b(?:no (?:interior )?(?:stairs|steps)(?! (?:at|to)\b)|single[- ](?:level|story|storey)|one[- ](?:level|story|storey)|1[- ]story|one floor)\b",
    "step_free_entry": r"\b(?:step[- ]free(?: (?:entry|entrance))?|zero[- ](?:step|entry)|no steps (?:at|to) (?:the )?(?:door|entry|entrance)|ramped? entr(?:y|ance))\b",
    "wide_doorways": r"\b(?:wide(?:r)? (?:doors?|doorways?)|(?:3[6-9]|4[0-8])[- ]?(?:inches|in\b|\")[^,.]{0,14}door)",
    "walk_in_shower": r"\bwalk[- ]in shower\b",
    "roll_in_shower": r"\b(?:roll[- ]in|curbless|zero[- ]threshold|barrier[- ]free) shower\b",
    "grab_bars": r"\b(?:grab bars?|handrails?)\b",
    "first_floor_bedroom": r"\b(?:(?:main|first|ground)[- ]floor (?:bedroom|bath)|(?:bedroom|bath)(?: and (?:bath|bedroom))? on (?:the )?(?:main|first|ground) floor)\b",
    "smooth_flooring": r"\b(?:no carpet|hard floors?|smooth floor(?:ing)?)\b",
    "garage": r"\b(?:garage|covered parking)\b",
    "lever_handles": r"\b(?:lever (?:door )?handles?|lever hardware)\b",
    "visual_alerts": r"\b(?:visual (?:alert|doorbell|alarm)s?|flashing doorbell)\b",
    "even_lighting": r"\b(?:glare[- ]free|even|diffused) lighting\b",
    "quiet_space": r"\b(?:quiet (?:room|home|space)|soundproof\w*|acoustic insulation)\b",
}
_STRUCTURAL = {"no_stairs", "step_free_entry", "wide_doorways", "first_floor_bedroom", "roll_in_shower"}
_CITY = r"\b(?P<city>houston|los angeles|l\.?a\.?)\b"
_MONEY = r"(\d[\d,]*(?:\.\d+)?)\s*([km])?\b"


def _keyword_filters(q: str) -> dict:
    ql = q.casefold()
    explicit = [key for key, pattern in _SEARCH_TERMS.items() if re.search(pattern, ql)]
    required = set(explicit).intersection(_STRUCTURAL)
    for fragment in re.split(r"[,.;]", ql):
        if re.search(r"\b(?:must(?: have)?|need(?:s|ed)?|required|non[- ]negotiable)\b", fragment):
            required.update(key for key in explicit if re.search(_SEARCH_TERMS[key], fragment))
    needs = list(explicit)
    if re.search(r"\bwheel\s?chair\b", ql) and not re.search(r"\b(?:not|no)\s+(?:a\s+)?wheel\s?chair\b", ql):
        needs.extend(["no_stairs", "step_free_entry", "wide_doorways", "roll_in_shower"])
    if re.search(r"\b(?:walker|cane|balance|aging in place|senior)\b", ql):
        needs.extend(["step_free_entry", "grab_bars", "walk_in_shower"])
    for key, pattern in {
        "lever_handles": r"\b(arthritis|dexterity|weak grip)\b",
        "visual_alerts": r"\b(deaf|hard.of.hearing)\b",
        "even_lighting": r"\b(low vision|blind|glare)\b",
        "quiet_space": r"\b(sensory|noise sensitive)\b",
    }.items():
        if re.search(pattern, ql):
            needs.append(key)
    budget = re.search(r"(?:under|below|at most|up to|no more than|budget(?: of)?|max(?:imum)?)\s*\$?\s*" + _MONEY, ql)
    price = float(budget[1].replace(",", "")) * {"k": 1000, "m": 1000000}.get(budget[2], 1) if budget else None
    location = re.search(_CITY, ql)
    city = ("Houston" if location["city"] == "houston" else "Los Angeles") if location else None
    beds = re.search(r"\b(\d{1,2})\s*\+?\s*(?:bedrooms?|beds?|br)\b", ql)
    return {"needs": list(dict.fromkeys(needs)), "required": [key for key in explicit if key in required],
            "max_price": price, "city": city, "rent": True if re.search(r"\b(?:rent|rental|lease)\b", ql) else None,
            "min_beds": int(beds[1]) if beds else None, "summary": "", "persona": q}


@lru_cache(maxsize=160)
def _refine_query(q):
    result = ai.parse_query(q)
    if not isinstance(result, dict):
        raise ValueError("Search agent did not return filters")
    return result


def _keys(value):
    return [key for key in value if isinstance(key, str) and key in listings.NEEDS] if isinstance(value, list) else []


def _positive(value):
    try:
        number = float(value)
        return number if 0 < number < float("inf") else None
    except (ValueError, TypeError):
        return None


@lru_cache(maxsize=8)
def _scan_search_evidence(folder, cache_revision):
    index = {}
    for path in folder.glob("mp_*.json"):
        try:
            scan = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        findings = {}
        for row in scan.get("findings") or []:
            # Room counts and stairs support floor layout. Hall widths do not measure doorway clearance.
            if row.get("need") == "no_stairs" and row.get("status") in ("yes", "no"):
                findings["no_stairs"] = {**row, "source": "scan"}
        if findings:
            index[path.stem[3:]] = findings
    return index


@bp.post("/search")
def search():
    body = request.get_json(force=True)
    q = str(body.get("q") or "").strip()[:1000]
    filters = body.get("filters")
    fallback = _keyword_filters(q)
    phase = "quick" if body.get("quick") and q and not filters else "complete"
    if not isinstance(filters, dict):
        filters = fallback
        if q and phase != "quick":
            try:
                refined = _refine_query(q)
                filters = {**fallback, **refined}
                for key in ("max_price", "city", "min_beds", "rent"):
                    if fallback[key] is not None:
                        filters[key] = fallback[key]
                for key in ("needs", "required"):
                    filters[key] = list(dict.fromkeys(_keys(fallback[key]) + _keys(refined.get(key))))
            except Exception:
                current_app.logger.info("Natural-language search refinement unavailable")
    if body.get("rent") is True:
        filters = {**filters, "rent": True}
    required = list(dict.fromkeys(_keys(filters.get("required"))))
    needs = list(dict.fromkeys(_keys(filters.get("needs")) + required))
    rent = filters.get("rent") is True
    price, beds = _positive(filters.get("max_price")), _positive(filters.get("min_beds"))
    cache = current_app.config["CACHE_DIR"]
    scan_evidence = _scan_search_evidence(cache, cache.stat().st_mtime_ns)
    candidates = []
    city = filters.get("city") if filters.get("city") in ("Houston", "Los Angeles") else None
    for home in listings.HOMES.values():
        if (not home["price"] or home["rent"] != rent or (city and home["city"] != city)
                or (price and home["price"] > price) or (beds and (home["beds"] or 0) < beds)):
            continue
        scan = scan_evidence.get(home["matterport_id"], {})
        if scan and not home["condo"]:
            home = {**home, "evidence": {**home["evidence"], **scan}}
        states = {key: home["evidence"][key]["status"] for key in required}
        if "no" in states.values():
            continue
        unconfirmed = [key for key, status in states.items() if status != "yes"]
        unknown = sum(status == "unknown" for status in states.values())
        score = listings.score(home, needs)
        candidates.append(((len(unconfirmed), unknown, -score["match"], score["mod_total"], score["true_cost"]),
                           home, score, unconfirmed, unknown))
    candidates.sort(key=lambda row: row[0])
    results = [{**listings.public(home, score), "required_unconfirmed": unconfirmed, "required_unknown": unknown}
               for _, home, score, unconfirmed, unknown in candidates[:24]]
    return jsonify({"filters": {**filters, "needs": needs, "required": required, "max_price": price,
                                "min_beds": beds, "city": city, "rent": rent},
                    "count": len(candidates), "confirmed_count": sum(not row[3] for row in candidates) if required else None,
                    "results": results, "need_labels": listings.NEEDS, "phase": phase})


@bp.get("/home/<int:home_id>")
def home(home_id):
    h = _home(home_id)
    needs = request.args.get("needs", "")
    needs = [n for n in needs.split(",") if n in listings.NEEDS]
    data = listings.public(h, listings.score(h, needs))
    try:
        cache = current_app.config["CACHE_DIR"]
        if request.args.get("cached") == "1":
            data["scan"] = matterport.cached_info(h["matterport_id"], cache) or {}
        else:
            data["scan"] = matterport.model_info(h["matterport_id"], cache)
    except Exception as e:
        data["scan"] = {"error": str(e)[:200]}
    data["catalog"] = costs.MODS
    return jsonify(data)


@bp.get("/home/<int:home_id>/aerial")
def aerial(home_id):
    h = _home(home_id)
    try:
        p = vexcel.parcel(h, current_app.config["CACHE_DIR"])
        p.pop("wkt", None)
        p.pop("footprint_wkt", None)
        return jsonify(p)
    except Exception as e:
        return jsonify({"found": False, "error": str(e)[:200]})


@bp.get("/home/<int:home_id>/aerial.jpg")
def aerial_img(home_id):
    h = _home(home_id)
    try:
        return Response(vexcel.ortho(h, current_app.config["CACHE_DIR"]), mimetype="image/jpeg",
                        headers={"Cache-Control": "max-age=86400"})
    except Exception:
        abort(502)


def _b64img(s):
    if not s:
        return None
    return base64.b64decode(s.split(",", 1)[-1])


def _price_options(change):
    """Fill in labor and totals for each product option so the UI can show a real breakdown."""
    for o in change.get("options") or []:
        o["material"] = int(o.get("material") or 0)
        o["labor_hours"] = float(o.get("labor_hours") or 0)
        o["labor_rate"] = int(o.get("labor_rate") or 85)
        o["labor"] = int(round(o["labor_hours"] * o["labor_rate"]))
        o["total"] = o["material"] + o["labor"]
    return change


def _renders_dir(home_id):
    return current_app.config["CACHE_DIR"] / "renders" / str(home_id)


def _render_reference(out_dir, rid):
    if not isinstance(rid, str) or not re.fullmatch(r"[0-9a-f]{12}", rid):
        return None
    f = out_dir / f"{rid}_ref.png"
    return f.read_bytes() if f.is_file() else None


@bp.post("/home/<int:home_id>/analyze")
def analyze(home_id):
    _home(home_id)
    b = request.get_json(force=True)
    try:
        res = ai.analyze_selection(_b64img(b["crop"]), _b64img(b.get("full")), b.get("room", ""),
                                   b.get("instruction"), b.get("size"), b.get("needs"))
    except Exception as e:
        current_app.logger.error("AI error on %s: %s", request.path, e)
        return jsonify({"error": f"AI unavailable: {e}"[:300]}), 502
    for c in res.get("changes") or []:
        _price_options(c)
    return jsonify(res)


@bp.post("/home/<int:home_id>/render")
def render(home_id):
    """Photoreal edit of the current view. Body: image (data URL), rect [x0,y0,x1,y1] 0-1, task, ref (render id)."""
    _home(home_id)
    b = request.get_json(force=True)
    out_dir = _renders_dir(home_id)
    try:
        ref = _render_reference(out_dir, b.get("ref"))
        task = b["task"] + (f" IMPORTANT FIX from review of the previous attempt: {b['fix']}" if b.get("fix") else "")
        if b.get("scope") == "roll_under_sink":
            task += " " + ai.ROLL_UNDER
        meta = imaging.render(_b64img(b["image"]), b["rect"], task, out_dir, ref, b.get("poly"))
    except Exception as e:
        current_app.logger.error("Render error on %s: %s", request.path, e)
        return jsonify({"error": f"Render failed: {e}"[:300]}), 502
    return jsonify(meta)


_empty_render_lock = Lock()


def _empty_file(home_id, sweep):
    if not re.fullmatch(r"[0-9a-z]{6,40}", sweep or ""):
        abort(404)
    # Older captures did not verify that the originating scan point stayed active.
    return current_app.config["CACHE_DIR"] / "empty-registered" / str(home_id) / f"{sweep}.jpg"


def _empty_metadata(file, model, sweep):
    try:
        data = json.loads(file.with_suffix(".json").read_text(encoding="utf-8"))
        if data["model"] == model and data["sweep"] == sweep and math.isfinite(data["yaw"]):
            return data
    except (OSError, ValueError, KeyError, TypeError):
        return None


@bp.get("/home/<int:home_id>/empty/<sweep>")
def empty_get(home_id, sweep):
    """The de-furnished 360 panorama of one scan point, if Sandra already made it."""
    home = _home(home_id)
    f = _empty_file(home_id, sweep)
    registered = _empty_metadata(f, home["matterport_id"], sweep)
    if request.args.get("src"):
        f = f.with_name(f"{sweep}_src.jpg")
    if not f.is_file() or not registered:
        return jsonify({"ready": False}), 404
    yaw = registered["yaw"]
    if request.args.get("meta"):
        return jsonify({"ready": True, "yaw": yaw})
    return Response(f.read_bytes(), mimetype="image/jpeg",
                    headers={"Cache-Control": "max-age=604800", "X-Capture-Yaw": str(yaw)})


@bp.post("/home/<int:home_id>/empty/<sweep>")
def empty_make(home_id, sweep):
    """Body: image (equirectangular data URL of this scan point). Removes furniture and belongings, keeps the
    architecture pixel-aligned, caches the panorama per scan point."""
    home = _home(home_id)
    f = _empty_file(home_id, sweep)
    body = request.get_json(force=True)
    if not isinstance(body, dict) or body.get("sweep") != sweep or body.get("model") != home["matterport_id"]:
        return jsonify({"error": "The capture must belong to this property and scan point."}), 400
    try:
        with _empty_render_lock:
            if f.is_file() and _empty_metadata(f, home["matterport_id"], sweep):
                return jsonify({"ready": True, "cached": True})
            src = _b64img(body["image"])
            if not src:
                return jsonify({"error": "The capture is missing."}), 400
            fingerprint = hashlib.sha256(src).hexdigest()
            meta = {"sweep": sweep, "model": home["matterport_id"], "yaw": float(body["yaw"]), "source_sha256": fingerprint}
            if not math.isfinite(meta["yaw"]):
                return jsonify({"error": "The capture heading is invalid."}), 400
            for registered in f.parent.glob("*.json"):
                old = _empty_metadata(registered, home["matterport_id"], registered.stem)
                if old and old["sweep"] != sweep and old.get("source_sha256") == fingerprint:
                    return jsonify({"error": "The renderer returned a different scan point. Try again."}), 409
            jpeg, provider, change = imaging.empty_pano(src)
            f.parent.mkdir(parents=True, exist_ok=True)
            with TemporaryDirectory(dir=f.parent) as temp:
                source = f.with_name(f"{sweep}_src.jpg")
                output_meta = f.with_suffix(".json")
                files = [(source, src), (output_meta, json.dumps(meta).encode("utf-8")), (f, jpeg)]
                for destination, contents in files:
                    stored = Path(temp) / destination.name
                    stored.write_bytes(contents)
                    stored.replace(destination)
    except Exception as e:
        current_app.logger.error("Empty-room error on %s: %s", request.path, e)
        return jsonify({"error": f"Could not empty this room: {e}"[:300]}), 502
    current_app.logger.info("Emptied %s/%s via %s (change %.1f)", home_id, sweep, provider, change)
    return jsonify({"ready": True, "provider": provider, "change": round(change, 1)})


@bp.get("/home/<int:home_id>/render/<rid>/<kind>")
def render_file(home_id, rid, kind):
    if not re.fullmatch(r"[0-9a-f]{12}", rid) or kind not in ("patch", "after", "before", "ref"):
        abort(404)
    name = {"patch": f"{rid}.png", "after": f"{rid}_after.jpg", "before": f"{rid}_before.jpg", "ref": f"{rid}_ref.png"}[kind]
    f = _renders_dir(home_id) / name
    if not f.exists():
        abort(404)
    return Response(f.read_bytes(), mimetype="image/png" if name.endswith("png") else "image/jpeg",
                    headers={"Cache-Control": "max-age=604800"})


@bp.post("/home/<int:home_id>/verify")
def verify(home_id):
    """Quality check of a finished render: compares before/after around the edited area."""
    _home(home_id)
    b = request.get_json(force=True)
    rid = b.get("rid", "")
    if not re.fullmatch(r"[0-9a-f]{12}", rid):
        abort(400)
    d = _renders_dir(home_id)
    try:
        before, after = imaging.crop_pair(d, rid)
        task = b.get("task", "")
        if b.get("scope") == "roll_under_sink":
            task += " " + ai.ROLL_UNDER
        res = ai.verify_render(before, after, task, _render_reference(d, b.get("ref")))
    except Exception as e:
        current_app.logger.error("Verify error: %s", e)
        res = {"ok": False, "score": None, "issues": [], "fix": "", "error": str(e)[:200]}
    current_app.logger.info("verify %s -> %s", rid, res)
    return jsonify(res)


@bp.post("/home/<int:home_id>/agent/plan")
def agent_plan(home_id):
    """First pass: the agent looks at views from rooms that matter and proposes changes for this buyer."""
    _home(home_id)
    b = request.get_json(force=True)
    views = [_b64img(v["image"]) for v in b.get("views") or []][:8]
    try:
        res = ai.agent_plan(views, [v.get("room", "") for v in b.get("views") or []], b.get("needs") or [], b.get("persona", ""),
                           b.get("instruction", ""), bool(b.get("outlined")), b.get("existing") or [],
                           b.get("declined") or [], (b.get("inventory") or [])[:8], str(b.get("preferences", ""))[:1000])
    except Exception as e:
        current_app.logger.error("AI error on %s: %s", request.path, e)
        return jsonify({"error": f"AI unavailable: {e}"[:300]}), 502
    for f in res.get("findings") or []:
        _price_options(f)
    return jsonify(res)


@bp.post("/home/<int:home_id>/agent/locate-angles")
def locate_angles(home_id):
    """Locate the anchored target in a batch of unedited camera angles."""
    _home(home_id)
    b = request.get_json(force=True)
    try:
        views = [(_b64img(view["image"]), view["hint"]) for view in b["views"][:4]]
        if not views:
            return jsonify({"angles": []})
        observations = [[{k: obj.get(k) for k in ("kind", "box_2d", "object_id")} for obj in v.get("objects", [])[:40]]
                        for v in b["views"][:4]]
        return jsonify(ai.locate_angles(_b64img(b["source"]), views, b["item"], b.get("scope", "general"),
                                       observations, bool(b.get("clear_cabinet"))))
    except Exception as e:
        current_app.logger.warning("Angle localization failed: %s", e)
        return jsonify({"error": "Could not confirm the fixture in nearby views."}), 502


def _stable_objects(objects):
    results = []
    used = set()
    for obj in objects[:40]:
        if not isinstance(obj, dict):
            continue
        box = obj.get("box_2d")
        label = str(obj.get("label") or "").strip()[:90]
        kind = re.sub(r"[^a-z0-9]+", "_", str(obj.get("kind") or "").lower()).strip("_")[:45]
        ident = str(obj.get("id") or "")[:30]
        confidence = obj.get("confidence")
        if not (ident and ident not in used and kind and label and isinstance(confidence, (int, float))
                and 0.52 <= confidence <= 1 and isinstance(box, list) and len(box) == 4
                and all(isinstance(n, (int, float)) and 0 <= n <= 1000 for n in box)
                and box[0] < box[2] and box[1] < box[3]):
            continue
        used.add(ident)
        results.append(dict(id=ident, kind=kind, label=label, box_2d=box, confidence=confidence,
                            parent=str(obj.get("parent") or "")[:30] or None))
    return results


@bp.post("/home/<int:home_id>/agent/objects")
def objects(home_id):
    """Reuse detections for a registered camera angle. Store coordinates and labels only."""
    _home(home_id)
    body = request.get_json(force=True)
    folder = current_app.config["CACHE_DIR"] / "objects-v1" / str(home_id)
    folder.mkdir(exist_ok=True, parents=True)
    result, missing = [], []
    try:
        for i, view in enumerate(body["views"][:4]):
            key = str(view["key"])[:180]
            path = folder / (hashlib.sha256(key.encode()).hexdigest() + ".json")
            try:
                row = json.loads(path.read_text(encoding="utf8"))
                result.append({"view": i, "objects": row})
            except (FileNotFoundError, ValueError):
                missing.append((i, path, _b64img(view["image"])))
        if missing:
            detected = ai.identify_objects([entry[2] for entry in missing])
            for row in (detected.get("views") or []):
                index = row.get("view") if isinstance(row, dict) else None
                if not isinstance(index, int) or not 0 <= index < len(missing):
                    continue
                i, path, _ = missing[index]
                objects = _stable_objects(row.get("objects") or [])
                temp = path.with_suffix(f".{uuid4().hex}.tmp")
                try:
                    temp.write_text(json.dumps(objects), encoding="utf8")
                    temp.replace(path)
                finally:
                    temp.unlink(missing_ok=True)
                result.append({"view": i, "objects": objects})
    except Exception as e:
        current_app.logger.warning("Object indexing failed for home %s: %s", home_id, e)
        if not result:
            return jsonify({"error": "This view could not be indexed yet."}), 502
    return jsonify({"views": sorted(result, key=lambda row: row["view"])})


@bp.post("/home/<int:home_id>/chat")
def chat(home_id):
    h = _home(home_id)
    b = request.get_json(force=True)
    try:
        res = ai.chat(h, b.get("edits") or [], b.get("selection"), b.get("message", ""), b.get("history") or [])
    except Exception as e:
        return jsonify({"reply": f"Sorry, the assistant is unavailable right now ({str(e)[:120]})."})
    return jsonify({"reply": res.get("reply", "")})
