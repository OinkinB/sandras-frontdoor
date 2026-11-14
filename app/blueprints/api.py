"""JSON API: search, home details, 3D selection analysis, chat, aerial view."""
import base64
import re

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
    m = re.search(r"\$?\s?(\d[\d,]*)\s*(k|m)?", ql.split("under")[-1]) if "under" in ql else None
    price = None
    if m:
        price = float(m.group(1).replace(",", "")) * {"k": 1e3, "m": 1e6}.get(m.group(2) or "", 1)
    city = "Houston" if "houston" in ql else "Los Angeles" if ("los angeles" in ql or " la" in ql) else None
    return {"needs": list(dict.fromkeys(needs)), "max_price": price, "city": city,
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
    needs = [n for n in filters.get("needs") or [] if n in listings.NEEDS]
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
        if filters.get("max_price") and h["price"] > filters["max_price"] * 1.08:
            continue
        if filters.get("min_beds") and (h["beds"] or 0) < filters["min_beds"]:
            continue
        s = listings.score(h, needs)
        out.append(listings.public(h, s))
    out.sort(key=lambda x: (-x["match"], x["mod_total"], x["true_cost"]))
    return jsonify({"filters": {**filters, "needs": needs}, "count": len(out), "results": out[:24],
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
    ref = None
    if b.get("ref") and re.fullmatch(r"[0-9a-f]{12}", b["ref"]):
        f = out_dir / f"{b['ref']}_ref.png"
        ref = f.read_bytes() if f.exists() else None
    try:
        meta = imaging.render(_b64img(b["image"]), b["rect"], b["task"], out_dir, ref, b.get("poly"))
    except Exception as e:
        current_app.logger.error("Render error on %s: %s", request.path, e)
        return jsonify({"error": f"Render failed: {e}"[:300]}), 502
    return jsonify(meta)


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


@bp.post("/home/<int:home_id>/agent/plan")
def agent_plan(home_id):
    """First pass: the agent looks at views from rooms that matter and proposes changes for this buyer."""
    _home(home_id)
    b = request.get_json(force=True)
    views = [_b64img(v["image"]) for v in b.get("views") or []][:8]
    try:
        res = ai.agent_plan(views, [v.get("room", "") for v in b.get("views") or []], b.get("needs") or [], b.get("persona", ""),
                           b.get("instruction", ""))
    except Exception as e:
        current_app.logger.error("AI error on %s: %s", request.path, e)
        return jsonify({"error": f"AI unavailable: {e}"[:300]}), 502
    for f in res.get("findings") or []:
        _price_options(f)
    return jsonify(res)


@bp.post("/home/<int:home_id>/chat")
def chat(home_id):
    h = _home(home_id)
    b = request.get_json(force=True)
    try:
        res = ai.chat(h, b.get("edits") or [], b.get("selection"), b.get("message", ""), b.get("history") or [])
    except Exception as e:
        return jsonify({"reply": f"Sorry, the assistant is unavailable right now ({str(e)[:120]})."})
    return jsonify({"reply": res.get("reply", "")})
