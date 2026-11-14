"""JSON API: search, home details, 3D selection analysis, chat, aerial view."""
import base64
import re

from flask import Blueprint, Response, abort, current_app, jsonify, request

from ..services import ai, costs, listings, matterport, vexcel

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


@bp.post("/home/<int:home_id>/analyze")
def analyze(home_id):
    _home(home_id)
    b = request.get_json(force=True)
    try:
        res = ai.analyze_selection(_b64img(b["crop"]), _b64img(b.get("full")), b.get("room", ""),
                                   b.get("instruction"), b.get("size"))
    except Exception as e:
        return jsonify({"error": f"AI unavailable: {e}"[:300]}), 502
    for c in res.get("changes") or []:
        m = costs.MODS.get(c.get("mod")) or {}
        c["model"] = m.get("model")
        c.setdefault("cost_low", m.get("low", 0))
        c.setdefault("cost_high", m.get("high", 0))
    return jsonify(res)


@bp.post("/home/<int:home_id>/chat")
def chat(home_id):
    h = _home(home_id)
    b = request.get_json(force=True)
    try:
        res = ai.chat(h, b.get("edits") or [], b.get("selection"), b.get("message", ""), b.get("history") or [])
    except Exception as e:
        return jsonify({"reply": f"Sorry, the assistant is unavailable right now ({str(e)[:120]}).", "actions": []})
    for a in res.get("actions") or []:
        m = costs.MODS.get(a.get("mod")) or {}
        a["model"] = m.get("model")
    return jsonify(res)
