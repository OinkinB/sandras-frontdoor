"""LLM access. Gemini on Vertex AI (pay per request, nothing runs while idle), OpenAI as a text fallback.

Auth: on Google Cloud (Cloud Run / App Engine) the service account is used through Application
Default Credentials; locally it falls back to the `gcloud auth login` session.
"""
import base64
import json
import re
import os
import shutil
import subprocess
import time

import requests

from . import costs

_token = {"value": None, "exp": 0}
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3-flash-preview")
IMAGE_MODEL = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")


def _access_token():
    if _token["value"] and time.time() < _token["exp"]:
        return _token["value"]
    tok = None
    try:  # Application Default Credentials (service account on Cloud Run, or `gcloud auth application-default login`)
        import google.auth
        import google.auth.transport.requests
        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        creds.refresh(google.auth.transport.requests.Request())
        tok = creds.token
    except Exception:
        exe = shutil.which("gcloud") or "gcloud"
        out = subprocess.run(f'"{exe}" auth print-access-token', shell=True, capture_output=True, text=True, timeout=60)
        tok = out.stdout.strip()
    if not tok:
        raise RuntimeError("No Google Cloud credentials (run `gcloud auth login`)")
    _token.update(value=tok, exp=time.time() + 40 * 60)
    return tok


def _gemini_raw(model, parts, gen_config, timeout=180):
    proj = os.environ["GCP_PROJECT"]
    url = f"https://aiplatform.googleapis.com/v1/projects/{proj}/locations/global/publishers/google/models/{model}:generateContent"
    r = requests.post(url, json={"contents": [{"role": "user", "parts": parts}], "generationConfig": gen_config},
                      timeout=timeout, headers={"Authorization": f"Bearer {_access_token()}"})
    r.raise_for_status()
    cand = (r.json().get("candidates") or [{}])[0]
    parts = (cand.get("content") or {}).get("parts")
    if not parts:
        raise RuntimeError(f"model returned nothing (finishReason={cand.get('finishReason')})")
    return parts


def _img_part(mime, data):
    return {"inlineData": {"mimeType": mime, "data": base64.b64encode(data).decode()}}


def _gemini(prompt, images, want_json):
    parts = [_img_part(m, b) for m, b in images] + [{"text": prompt}]
    cfg = {"temperature": 0.3}
    if GEMINI_MODEL.startswith("gemini-3"):     # these tasks need quick judgement, not long deliberation
        cfg["thinkingConfig"] = {"thinkingLevel": os.environ.get("GEMINI_THINKING", "low")}
    if want_json:
        cfg["responseMimeType"] = "application/json"
    out = _gemini_raw(GEMINI_MODEL, parts, cfg)
    return "".join(p.get("text", "") for p in out if not p.get("thought"))


def _openai(prompt, images, want_json):
    content = [{"type": "text", "text": prompt}]
    for m, b in images:
        content.append({"type": "image_url", "image_url": {"url": f"data:{m};base64,{base64.b64encode(b).decode()}"}})
    body = {"model": OPENAI_MODEL, "messages": [{"role": "user", "content": content}], "temperature": 0.3}
    if want_json:
        body["response_format"] = {"type": "json_object"}
    r = requests.post("https://api.openai.com/v1/chat/completions", json=body, timeout=120,
                      headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"})
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def ask(prompt, images=(), want_json=True):
    errors = []
    for fn, ok in ((_gemini, os.environ.get("GCP_PROJECT")), (_openai, os.environ.get("OPENAI_API_KEY"))):
        if not ok:
            continue
        try:
            text = fn(prompt, list(images), want_json)
            if want_json:
                text = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```")
                return json.loads(text)
            return text
        except Exception as e:  # try the next provider
            errors.append(f"{fn.__name__}: {e}")
    raise RuntimeError("; ".join(errors) or "no AI provider configured")


import io as _io
import threading as _threading

_image_lock = _threading.Semaphore(int(os.environ.get("IMAGE_CONCURRENCY", "1")))   # one image job at a time avoids 429 bursts
IMAGE_PROVIDER = os.environ.get("IMAGE_PROVIDER", "auto")          # auto | gemini | openai
OPENAI_IMAGE_MODEL = os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-2")


def _gemini_edit(images, prompt):
    parts = [_img_part(m, b) for m, b in images] + [{"text": prompt}]
    last = None
    for attempt in range(3):
        try:
            out = _gemini_raw(IMAGE_MODEL, parts, {"responseModalities": ["IMAGE"], "temperature": 0.4 + 0.15 * attempt}, timeout=240)
            for p in out:
                if p.get("inlineData", {}).get("data"):
                    return base64.b64decode(p["inlineData"]["data"])
            last = RuntimeError("returned text only")
        except requests.HTTPError as e:
            last = e
            if e.response is not None and e.response.status_code == 429:   # rate limited: back off, then retry
                time.sleep(4 * (attempt + 1) ** 2)
                continue
        except Exception as e:
            last = e
    raise RuntimeError(f"Gemini image failed: {last}")


def _openai_edit(ctx_jpeg, mask_l, prompt, ref_png=None):
    """OpenAI image edit with a real mask (transparent = edit here)."""
    from PIL import Image
    ctx = Image.open(_io.BytesIO(ctx_jpeg)).convert("RGB")
    w, h = ctx.size
    size = (1536, 1024) if w / h > 1.25 else (1024, 1536) if h / w > 1.25 else (1024, 1024)
    img = ctx.resize(size, Image.LANCZOS)
    alpha = mask_l.resize(size).point(lambda v: 0 if v > 127 else 255)
    mask = Image.new("RGBA", size, (0, 0, 0, 255)); mask.putalpha(alpha)
    def png(im):
        b = _io.BytesIO(); im.save(b, "PNG"); return b.getvalue()
    files = [("image[]", ("scene.png", png(img), "image/png"))]
    if ref_png:
        files.append(("image[]", ("reference.png", ref_png, "image/png")))
    files.append(("mask", ("mask.png", png(mask), "image/png")))
    r = requests.post("https://api.openai.com/v1/images/edits", timeout=300, files=files,
                      headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
                      data={"model": OPENAI_IMAGE_MODEL, "prompt": prompt, "size": f"{size[0]}x{size[1]}", "quality": "medium", "n": "1"})
    if r.status_code != 200:
        raise RuntimeError(f"OpenAI image failed: {r.status_code} {r.text[:200]}")
    return base64.b64decode(r.json()["data"][0]["b64_json"])


def edit_image(ctx_jpeg: bytes, mask_l, prompt: str, ref_png: bytes | None = None,
               prefer: str | None = None) -> tuple[bytes, str]:
    """Photoreal masked edit. Gemini first (with backoff on rate limits), OpenAI as fallback. Returns (image, provider).
    prefer="openai" flips the order (OpenAI's masked edit is better at real shape changes)."""
    order = {"gemini": ["gemini"], "openai": ["openai"]}.get(IMAGE_PROVIDER, ["gemini", "openai"])
    if prefer in order:
        order = [prefer] + [o for o in order if o != prefer]
    errors = []
    with _image_lock:
        for prov in order:
            try:
                if prov == "gemini" and os.environ.get("GCP_PROJECT"):
                    def png(im):
                        b = _io.BytesIO(); im.convert("RGB").save(b, "PNG"); return b.getvalue()
                    imgs = [("image/jpeg", ctx_jpeg), ("image/png", png(mask_l))] + ([("image/png", ref_png)] if ref_png else [])
                    return _gemini_edit(imgs, prompt), "gemini"
                if prov == "openai" and os.environ.get("OPENAI_API_KEY"):
                    return _openai_edit(ctx_jpeg, mask_l, prompt, ref_png), "openai"
            except Exception as e:
                errors.append(str(e)[:200])
    raise RuntimeError("; ".join(errors) or "no image provider configured")


def _as_obj(res, list_key):
    """Models occasionally return a bare list or a one-item list; normalize to a dict."""
    if isinstance(res, list):
        if len(res) == 1 and isinstance(res[0], dict) and (list_key in res[0] or "reply" in res[0] or "summary" in res[0]):
            return res[0]
        return {list_key: res}
    return res if isinstance(res, dict) else {}


# ---------- task prompts ----------

NEED_KEYS = ["no_stairs", "step_free_entry", "wide_doorways", "walk_in_shower", "grab_bars",
             "first_floor_bedroom", "smooth_flooring", "garage", "lever_handles", "visual_alerts",
             "even_lighting", "quiet_space"]

OPTIONS_SPEC = """"options": exactly 3 real, buyable choices from budget to premium, each
  {"tier":"Budget"|"Standard"|"Premium","name": product-style name (generic or common brand line),
   "spec": a precise VISUAL description used to render it photorealistically (material, color, finish, size in inches),
   "material": int USD for the item, "labor_hours": number, "labor_rate": int USD/hour for the right trade in Houston/LA,
   "notes": short install note (permits, plumbing, blocking in wall, etc.)}"""


ROLL_UNDER = (
    "Make this exact sink roll-under by opening the cabinet below the basin for clear forward knee and toe space. "
    "Remove doors, shelving, plinth and other obstructions in that opening, with a finished floor underneath "
    "and protected plumbing set back out of knee space. Keep the basin, faucet, countertop, wall, height, "
    "footprint and orientation in their original positions. Preserve adjacent cabinetry and fixtures."
)


def parse_query(text: str) -> dict:
    prompt = f"""Turn a home-seeker's request into search filters for an accessible-home search.
Request: "{text}"
Return JSON: needs: subset of {NEED_KEYS} (wheelchair -> no_stairs, step_free_entry, wide_doorways, walk_in_shower, smooth_flooring;
elderly/aging in place -> no_stairs, first_floor_bedroom, grab_bars, walk_in_shower; dexterity -> lever_handles;
hearing access -> visual_alerts; low vision -> even_lighting; noise sensitivity -> quiet_space).
required: subset of needs representing explicitly stated must-haves or structural constraints clearly necessary to the buyer.
Keep unspecified preferences flexible. Do not infer wheelchair use for other accessibility needs.
max_price: number|null; min_beds: number|null;
city: "Houston"|"Los Angeles"|null; rent: true|false|null; persona: one sentence about the user's situation; summary: short phrase."""
    return ask(prompt)


def analyze_selection(crop: bytes, full: bytes, room: str, instruction: str | None, size: dict | None,
                      needs: list | None = None) -> dict:
    dims = (f"Measured in the 3D scan: selection is {size['w']:.2f} m wide, {size['h']:.2f} m tall, {size['d']:.2f} m deep;"
            f" vertical span {size.get('rise', 0):.2f} m.") if size else ""
    prompt = f"""You are an accessibility specialist and remodeling estimator looking at a photo from a 3D tour of a real home.
Image 1 = what the user selected; image 2 = the full view. Room: {room or 'unknown'}. {dims}
User's accessibility needs: {needs or 'not stated'}.
{'User request: ' + instruction if instruction else 'No request: propose the most useful accessibility change for what is selected.'}
Anything can be removed, added or replaced (fixtures, furniture, flooring, doors, stairs equipment, lighting, counters...).
Return JSON:
{{"items":[{{"name":str,"observation":str concrete}}],
 "changes":[{{"action":"remove"|"add"|"replace","title":str,"reason":str, {OPTIONS_SPEC}}}],
 "summary": str (1-2 plain sentences)}}
Reference installed-cost ranges: {json.dumps({v['label']: [v['low'], v['high']] for v in costs.MODS.values()})}
At most 2 changes. Costs must be realistic for 2026. Never claim ADA compliance; say "more accessible"."""
    imgs = [("image/jpeg", crop)] + ([("image/jpeg", full)] if full else [])
    return _as_obj(ask(prompt, imgs), "changes")


def agent_plan(views: list[bytes], rooms: list[str], needs: list, persona: str, instruction: str = "",
               outlined: bool = False, existing: list | None = None, declined: list | None = None,
               inventory: list | None = None, preferences: str = "") -> dict:
    """Agent: find what to change. With an instruction it targets the object the user means (the magenta outline,
    if present, only marks roughly where they pointed)."""
    target = ""
    if instruction:
        target = (f'THE USER ASKED: "{instruction}". Find the existing object they mean and propose exactly that change, '
                  "following their wishes on details. ")
        if outlined:
            target += ("A magenta outline in the photo marks roughly where they pointed; it may be loose or partial. "
                       "box_2d must enclose the WHOLE object to change (e.g. the entire tub and its surround), not the outline. ")
    prompt = f"""You are an accessibility agent touring a home for a buyer. Buyer: {persona or 'not described'}; needs: {needs}.
You get {len(views)} photos from the home's 3D tour (image i is view i; rooms: {rooms}).
{target}
Recognized fixtures and parts, keyed by zero-based image index: {json.dumps(inventory or [])}
Use the corresponding object_id when one accurately matches. A door, its handle, a basin, its faucet and
the cabinet below a basin are distinct targets. For suggestions touching several parts, choose one actionable part.
Buyer's renovation preferences: {preferences or 'Start with small changes and avoid structural work.'}
WHAT HAS ALREADY BEEN DONE IN THIS HOME (the photos may still show the original, but treat these as done):
{json.dumps(existing or [])}
Suggestions the buyer already declined (never suggest again): {json.dumps(declined or [])}
Avoid unsolicited duplicates. An explicit request to revise an existing change overrides a previous decision.
Do not treat fixtures of the same type in different rooms, or separate parts of one fixture, as the same object.
Also judge redundancy across the home: e.g. if one
bathroom already has (or is planned to get) a roll-in shower, a second bathroom's tub is a lower priority; then set
fits_needs false or say in "advice" that it's optional and why. Prefer the barriers that matter most for daily life.
Find the concrete EXISTING barriers for THIS buyer and the change that fixes each: bathtub or curbed shower -> curbless
roll-in shower, toilet without support -> grab bars beside it, stairs -> stairlift, narrow door -> wider door, step at
entry -> ramp, carpet -> hard floor, high counters/cabinets -> roll-under. Always fix an existing object you can see;
never invent a new fixture in empty floor space. Ignore reflections in mirrors, glass and windows: only real objects.
Prioritize modest relevant changes: lever hardware for dexterity, lighting or contrast for low vision,
visual alerts for hearing access, quiet-room or soft-close changes for sensory needs, and simple supports for balance.
Never infer one kind of disability from another. NEVER assume a wheelchair: wheelchair-specific changes (roll-under
sinks, roll-in showers, wider doors, ramps, lowered counters) only if the buyer says they use a wheelchair. Older age
alone means aging in place: grab bars, lever handles, better lighting, non-slip floors, a seat or handheld shower,
fewer trip hazards, not wheelchair work. If needs are not described, suggest only small universal improvements. Flag required width, stair and approach conflicts as fit concerns to
confirm. Do not offer to widen, move, or demolish a doorway by default. If the buyer requests structural work,
label it structural, explain the impact briefly and let them choose. Never claim compliance or unverified dimensions.
If a sink or vanity is described as wheelchair inaccessible, first address forward approach and knee/toe clearance.
Pick scope "roll_under_sink" for that change. {ROLL_UNDER}
If the buyer wants all cabinets removed, design an open counter and basin with discreet supports, fully clear
below. Do not add side cabinets, doors, shelves, plinths or furniture-style frames.
box_2d must enclose the real fixture AND everything the change touches: for a tub or shower the whole enclosure and
its surround from the floor up to the top of the surround/tile, plus the threshold; for a vanity its countertop and
cabinet. Do not include unrelated neighboring fixtures.
For a roll-under sink also give edit_box_2d covering only the cabinet below the basin and the immediate floor
inside the opening. Exclude the basin, faucet, mirror and countertop.
Use edit_polygon_2d for irregular cabinet silhouettes. Trace the cabinet edges and immediately exposed floor
with 4–12 [y,x] points in the same coordinate scale as the box. Keep adjacent walls and existing floor outside.
Return JSON {{"findings":[{{"view": int, "box_2d":[ymin,xmin,ymax,xmax] on a 0-1000 scale,
  "scope":"roll_under_sink"|"general", "edit_box_2d":[ymin,xmin,ymax,xmax] on the same scale or null,
  "edit_polygon_2d":[[y,x], [y,x], ...] on the same scale or null,
  "clear_cabinet": true|false (whether the buyer specifically requested clearing the entire base),
  "object_id": str|null, "kind": str, "effort": "simple"|"installation"|"structural",
  "item": str, "issue": str, "action":"remove"|"add"|"replace","title":str,"reason":str,
  "fits_needs": true|false (does this help the buyer's stated needs?),
  "advice": str (one friendly sentence: why it matters, or a gentle warning if it is an extra that adds cost without helping their needs),
  {OPTIONS_SPEC}}}]}}
At most one finding per view; skip views with nothing important. At most {min(4, len(views))} findings, most important first."""
    return _as_obj(ask(prompt, [("image/jpeg", v) for v in views]), "findings")


def identify_objects(views: list[bytes]) -> dict:
    prompt = """Inventory the visible physical objects in each room photo for an accessibility tour.
Include fixtures, furniture, thresholds, controls, lights, passageways and structural features.
Record independent parts separately: vanity, countertop, basin, faucet, cabinet below the basin;
door, door handle, threshold; shower, controls, shower head, seat, grab bar; switches, outlets and rails.
Return a parent id when the part belongs to another detected object. Record separate instances of the
same kind. Use tight boxes and skip uncertain detections, occluders, drawings, and reflections.
Kinds should be short snake_case names (faucet, door_handle, vanity_cabinet, sink_basin, countertop,
shower, shower_control, threshold, light_switch).
Return JSON {"views":[{"view":0,"objects":[{"id":"a","kind":"faucet","label":"Sink faucet",
"parent":null,"box_2d":[130,210,260,340],"confidence":0.92}]}]}. Index images from zero.
Boxes use [ymin,xmin,ymax,xmax] from 0 to 1000. Up to 40 useful objects per view."""
    return _as_obj(ask(prompt, [("image/jpeg", image) for image in views]), "views")


def locate_angles(source: bytes, views: list[tuple[bytes, list]], item: str, scope: str,
                  observations: list | None = None, clear_cabinet: bool = False) -> dict:
    prompt = f"""Locate the exact same physical {item} across photographs of one 3D scan.
Image 1 is the original view with a magenta outline around the target. Images 2 onwards are unedited
photographs from different camera positions. The scan's rough projected target boxes for those images,
in order, are {json.dumps([box for _, box in views])}. All boxes use [ymin,xmin,ymax,xmax] from 0 to 1000.
Use wall/floor junctions, countertops, fixtures and the projected position to confirm identity. The box
is a hint and may overlap a wall, doorway or mirror. Never target a mirror reflection, another fixture,
or anything behind a wall. Skip an angle if the real fixture is cut off, blocked, or uncertain.
Recognized components in candidate views: {json.dumps(observations or [])}
Return one entry per usable angle, with zero-based view indexing among the candidate images (image 2 = 0).
Use a tight box_2d around the existing physical item. Scope is {scope}. For roll_under_sink, edit_box_2d must
cover only the visible cabinet below the basin and the immediate floor inside that opening. Exclude the
countertop, faucet, surrounding walls and foreground door frames. Skip side views with no visible cabinet
face to modify. For other scopes set edit_box_2d to null.
Entire base cabinet removal under the countertop requested: {clear_cabinet}. If true, include the entire
visible base and no pixels above the underside of the original countertop in edit_box_2d.
Include edit_polygon_2d as 4–12 [y,x] points tracing the cabinet and immediately revealed floor when the
base has angled sides. Exclude neighboring walls and floor already visible. Use null if unsure.
Return JSON {{"angles":[{{"view":0,"box_2d":[0,0,0,0],"edit_box_2d":null,"edit_polygon_2d":null}}]}}."""
    return _as_obj(ask(prompt, [("image/jpeg", source)] + [("image/jpeg", image) for image, _ in views]), "angles")


KEEP_RULES = """Image 1 is authoritative for camera angle, layout, and original fixture position. If supplied, image 3
is a design reference from another angle. Compare the design only, never its position in the photograph.
Fail if the fixture is duplicated, moved along a wall, moved to a different wall, rotated, resized,
or moved vertically without the task asking for that. Compare the edges of the counter, position of
the faucet, wall/floor junctions, vanishing points and foreground doorframes between before and after.
"""
RESHAPE_RULES = """This request CHANGES GEOMETRY, so the edited part is supposed to look different in shape.
Judge: is the requested shape change clearly done, finished (painted, trimmed, baseboard continued) and believable
from this viewpoint, at the same camera angle and vanishing points? Things that were hidden behind the old shape
(e.g. a sink and faucet behind a raised bar ledge) correctly become visible once it is lowered or removed; that is
NOT a moved fixture. Small shifts of fixtures attached to the rebuilt part are fine. Fail only if the old shape is
still there, the room around it was redesigned (new islands, walls, appliances), or it looks fake or unfinished.
Calibrate: when the shape change is clearly done and the room is intact, score 7-9 even with minor texture, trim or
sharpness nitpicks (list them in issues). Below 7 only for a real failure a homeowner would notice at a glance.
"""
RESHAPE_WORDS = re.compile(r"\b(lower|lowered|raise|raised to|remove|removing|widen|widened|shorten|lengthen|extend|level|"
                           r"flatten|take out|demolish|open up|enlarge|narrow|ramp|roll-under|roll under|curbless|walk-in)\b", re.I)


def verify_render(before: bytes, after: bytes, task: str, reference: bytes | None = None) -> dict:
    """Quality gate: does the edited photo really show the requested change, finished and believable?"""
    rules = RESHAPE_RULES if RESHAPE_WORDS.search(task) else KEEP_RULES
    special = ""
    if re.search(r"roll.?under|knee", task, re.I):
        special += ("For roll-under sinks, require a clear, finished opening for forward knee and toe approach under the actual basin,\n"
                    "with protected plumbing set back. The basin and countertop stay fixed. A dark cubby, intact bottom shelf,\n"
                    "obstructing pipe, or an opening off to the side does not solve this request.\n")
    if re.search(r"cabinet", task, re.I) and re.search(r"remov", task, re.I):
        special += "If all base cabinets were to be removed, fail a partial opening or remaining furniture frame.\n"
    prompt = f"""You are a strict reviewer of photo edits for a home-remodel visualizer.
Image 1 = the original photo region, image 2 = the edited region. The requested change was:
"{task}"
{rules}{special}Fail if the requested change is missing or only partly done, the old item
is still clearly there when it should be gone, it looks like a construction site, there are smears, warped geometry,
floating objects, duplicated fixtures, cut-off items at the edges, or obvious seams.
Fail new smeared or blurred floor bands, broken plank or tile lines, or steps introduced by the edit.
Ignore scan artifacts already in the original that are outside the edited region.
Return JSON {{"ok": true|false, "score": 0-10, "issues": [str], "fix": str (one concrete instruction to fix it, or "")}}.
ok must be true only if score >= 7."""
    imgs = [("image/jpeg", before), ("image/jpeg", after)]
    if reference:
        imgs.append(("image/png", reference))
    errors = []
    # OpenAI reviews first (an independent model from the one that drew it); Gemini as fallback
    for fn, ok in ((_openai, os.environ.get("OPENAI_API_KEY")), (_gemini, os.environ.get("GCP_PROJECT"))):
        if not ok:
            continue
        try:
            text = fn(prompt, imgs, True).strip().removeprefix("```json").removeprefix("```").removesuffix("```")
            res = _as_obj(json.loads(text), "issues")
            res["reviewer"] = fn.__name__.strip("_")
            return res
        except Exception as e:
            errors.append(f"{fn.__name__}: {e}")
    return {"ok": False, "score": None, "issues": [], "fix": "", "reviewer": "unavailable", "error": "; ".join(errors)[:300]}


def chat(home: dict, edits: list, selection: dict | None, message: str, history: list) -> dict:
    ctx = {k: home.get(k) for k in ("address", "city", "price", "beds", "baths", "sqft", "stories", "year_built")}
    ctx["evidence"] = {k: v["status"] for k, v in home["evidence"].items()}
    prompt = f"""You are Sandra's FrontDoor's accessibility agent, embedded in a live 3D tour of this home.
Home: {json.dumps(ctx)}
Listing remarks: {home.get('remarks', '')[:1200]}
Planned changes: {json.dumps(edits)}
Current selection: {json.dumps(selection) if selection else 'none'}
Conversation: {json.dumps(history[-8:])}
User: {message}
Your name is Sandra. Answer concisely and concretely. If the buyer says a suggestion is too expensive,
invasive or complex, ask one focused question about the budget or which part they want to keep. Do not
pretend an edit has been requested or completed. Prefer reversible hardware and equipment when they fit
the stated need. Never claim legal ADA compliance; say "likely" and suggest verifying.
Return JSON {{"reply": str}}"""
    return _as_obj(ask(prompt), "reply")
