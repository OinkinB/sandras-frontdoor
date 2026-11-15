"""JSON API: search, home details, 3D selection analysis, chat, aerial view."""
import base64
import hashlib
import json
import re
from uuid import uuid4

from flask import Blueprint, Response, abort, current_app, jsonify, request

from ..services import ai, costs, imaging, listings, matterport, vexcel

bp = Blueprint("api", __name__)


def _home(home_id):
    h = listings.HOMES.get(home_id)
    if not h:
        abort(404)
    return h


def _keyword_filters(q: str) -> dict:
    ql = q.lower()
    needs = []
    if re.search(r"wheelchair|stairs|single[- ]level|one[- ]story", ql):
        needs += ["no_stairs"]
    if re.search(r"wheelchair|step[- ]free|no steps|ramp", ql):
        needs += ["step_free_entry"]
    if re.search(r"wheelchair|wide door", ql):
        needs += ["wide_doorways"]
    if re.search(r"shower|wheelchair|elderly|senior|aging", ql):
        needs += ["walk_in_shower"]
    if re.search(r"elderly|senior|aging|grab", ql):
        needs += ["grab_bars", "first_floor_bedroom"]
    for key, pattern in {
        "lever_handles": r"lever handle|arthritis|dexterity",
        "visual_alerts": r"deaf|hard.of.hearing|visual alarm|flashing doorbell",
        "even_lighting": r"low vision|glare|even lighting",
        "quiet_space": r"sensory|noise sensitive|quiet room|soundproof",
    }.items():
        if re.search(pattern, ql):
            needs.append(key)
    m = re.search(r"\$?\s?(\d[\d,]*)\s*(k|m)?", ql.split("under")[-1]) if "under" in ql else None
    price = None
    if m:
        price = float(m.group(1).replace(",", "")) * {"k": 1e3, "m": 1e6}.get(m.group(2) or "", 1)
    city = "Houston" if "houston" in ql else "Los Angeles" if ("los angeles" in ql or " la" in ql) else None
    required = []
    for key, pattern in {"no_stairs": r"no stairs|no interior steps|single.level|one.story",
                         "wide_doorways": r"wide door", "step_free_entry": r"step.free entry|no steps to (?:the )?(?:door|entrance)",
                         "first_floor_bedroom": r"(?:main|first)[- ]floor bedroom"}.items():
        if re.search(pattern, ql):
            required.append(key)
            needs.append(key)
    return {"needs": list(dict.fromkeys(needs)), "required": required, "max_price": price, "city": city,
            "rent": True if "rent" in ql else None, "min_beds": None,
            "summary": "keyword search", "persona": ""}


@bp.post("/search")
def search():
    body = request.get_json(force=True)
    q = (body.get("q") or "").strip()
    filters = body.get("filters")
    if not filters:
        try:
            filters = ai.parse_query(q) if q else _keyword_filters("")
        except Exception as e:
            current_app.logger.warning("AI parse failed, using keywords: %s", e)
            filters = _keyword_filters(q)
    if body.get("rent") is True:
        filters = {**filters, "rent": True}
    needs = [n for n in filters.get("needs") or [] if n in listings.NEEDS]
    required = [n for n in dict.fromkeys(filters.get("required") or []) if n in listings.NEEDS]
    needs = list(dict.fromkeys(needs + required))
    rent = filters.get("rent")
    out = []
    for h in listings.HOMES.values():
        if not h["price"]:
            continue
        if rent is not None and h["rent"] != rent:
            continue
        if rent is None and h["rent"]:
            continue  # default to homes for sale
        if filters.get("city") and h["city"] != filters["city"]:
            continue
        if filters.get("max_price") and h["price"] > filters["max_price"]:
            continue
        if filters.get("min_beds") and (h["beds"] or 0) < filters["min_beds"]:
            continue
        states = {key: h["evidence"].get(key, {}).get("status", "unknown") for key in required}
        if "no" in states.values():
            continue
        row = listings.public(h, listings.score(h, needs))
        row["required_unconfirmed"] = [key for key, status in states.items() if status != "yes"]
        row["required_unknown"] = sum(status == "unknown" for status in states.values())
        out.append(row)
    out.sort(key=lambda x: (len(x["required_unconfirmed"]), x["required_unknown"], -x["match"], x["mod_total"], x["true_cost"]))
    return jsonify({"filters": {**filters, "needs": needs, "required": required}, "count": len(out), "results": out[:24],
                    "need_labels": listings.NEEDS})


@bp.get("/home/<int:home_id>")
def home(home_id):
    h = _home(home_id)
    needs = request.args.get("needs", "")
    needs = [n for n in needs.split(",") if n in listings.NEEDS]
    data = listings.public(h, listings.score(h, needs))
    try:
        data["scan"] = matterport.model_info(h["matterport_id"], current_app.config["CACHE_DIR"])
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


def _empty_file(home_id, sweep):
    if not re.fullmatch(r"[0-9a-z]{6,40}", sweep or ""):
        abort(404)
    d = current_app.config["CACHE_DIR"] / "empty" / str(home_id)
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{sweep}.jpg"


@bp.get("/home/<int:home_id>/empty/<sweep>")
def empty_get(home_id, sweep):
    """The de-furnished 360 panorama of one scan point, if Sandra already made it."""
    _home(home_id)
    f = _empty_file(home_id, sweep)
    if request.args.get("src"):
        f = f.with_name(f"{sweep}_src.jpg")
    if not f.exists():
        return jsonify({"ready": False}), 404
    meta = f.parent / f"{sweep}.json"
    yaw = json.loads(meta.read_text()).get("yaw", 0) if meta.exists() else 0
    if request.args.get("meta"):
        return jsonify({"ready": True, "yaw": yaw})
    return Response(f.read_bytes(), mimetype="image/jpeg",
                    headers={"Cache-Control": "max-age=604800", "X-Capture-Yaw": str(yaw)})


@bp.post("/home/<int:home_id>/empty/<sweep>")
def empty_make(home_id, sweep):
    """Body: image (equirectangular data URL of this scan point). Removes furniture and belongings, keeps the
    architecture pixel-aligned, caches the panorama per scan point."""
    _home(home_id)
    f = _empty_file(home_id, sweep)
    if f.exists():
        return jsonify({"ready": True, "cached": True})
    try:
        body = request.get_json(force=True)
        src = _b64img(body["image"])
        # the panorama is centered on the camera heading at capture time; the tour needs it to line the sphere up
        (f.parent / f"{sweep}.json").write_text(json.dumps({"yaw": float(body.get("yaw") or 0)}))
        f.with_name(f"{sweep}_src.jpg").write_bytes(src)
        jpeg, provider, change = imaging.empty_pano(src)
    except Exception as e:
        current_app.logger.error("Empty-room error on %s: %s", request.path, e)
        return jsonify({"error": f"Could not empty this room: {e}"[:300]}), 502
    f.write_bytes(jpeg)
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
