"""LLM access. Gemini on Vertex AI (pay per request, nothing runs while idle), OpenAI as a text fallback.

Auth: on Google Cloud (Cloud Run / App Engine) the service account is used through Application
Default Credentials; locally it falls back to the `gcloud auth login` session.
"""
import base64
import json
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


def edit_image(images: list[tuple[str, bytes]], prompt: str) -> bytes:
    """Photoreal image edit with Gemini's image model. Returns image bytes."""
    parts = [_img_part(m, b) for m, b in images] + [{"text": prompt}]
    last = None
    for attempt in range(3):          # image models occasionally return an empty candidate; retry
        try:
            out = _gemini_raw(IMAGE_MODEL, parts, {"responseModalities": ["IMAGE"], "temperature": 0.4 + 0.15 * attempt}, timeout=240)
            for p in out:
                if p.get("inlineData", {}).get("data"):
                    return base64.b64decode(p["inlineData"]["data"])
            last = RuntimeError("image model returned text only")
        except Exception as e:
            last = e
    raise RuntimeError(f"image model failed: {last}")


def _as_obj(res, list_key):
    """Models occasionally return a bare list or a one-item list; normalize to a dict."""
    if isinstance(res, list):
        if len(res) == 1 and isinstance(res[0], dict) and (list_key in res[0] or "reply" in res[0] or "summary" in res[0]):
            return res[0]
        return {list_key: res}
    return res if isinstance(res, dict) else {}


# ---------- task prompts ----------

NEED_KEYS = ["no_stairs", "step_free_entry", "wide_doorways", "walk_in_shower", "grab_bars",
             "first_floor_bedroom", "smooth_flooring", "garage"]

OPTIONS_SPEC = """"options": exactly 3 real, buyable choices from budget to premium, each
  {"tier":"Budget"|"Standard"|"Premium","name": product-style name (generic or common brand line),
   "spec": a precise VISUAL description used to render it photorealistically (material, color, finish, size in inches),
   "material": int USD for the item, "labor_hours": number, "labor_rate": int USD/hour for the right trade in Houston/LA,
   "notes": short install note (permits, plumbing, blocking in wall, etc.)}"""


def parse_query(text: str) -> dict:
    prompt = f"""Turn a home-seeker's request into search filters for an accessible-home search.
Request: "{text}"
Return JSON: needs: subset of {NEED_KEYS} (wheelchair -> no_stairs, step_free_entry, wide_doorways, walk_in_shower, smooth_flooring;
elderly/aging in place -> no_stairs, first_floor_bedroom, grab_bars, walk_in_shower); max_price: number|null; min_beds: number|null;
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


def agent_plan(views: list[bytes], rooms: list[str], needs: list, persona: str, instruction: str = "") -> dict:
    """First-pass agent: look at a few views of the home and pick the changes this user needs."""
    prompt = f"""You are an accessibility agent touring a home for a buyer. Buyer: {persona or 'not described'}; needs: {needs}.
You get {len(views)} photos from the home's 3D tour (image i is view i; rooms: {rooms}).
{('THE USER ASKED: "' + instruction + '". Find the existing object in the photo they mean and propose exactly that change (follow their wishes on details).') if instruction else ''}
Find the concrete EXISTING barriers for THIS buyer and the change that fixes each: bathtub or curbed shower -> curbless
roll-in shower, toilet without support -> grab bars beside it, stairs -> stairlift, narrow door -> wider door, step at
entry -> ramp, carpet -> hard floor, high counters/cabinets -> roll-under. Always fix an existing object you can see;
never invent a new fixture in empty floor space. Ignore reflections in mirrors, glass and windows: only real objects. box_2d must tightly enclose that existing object (for a tub: the whole
tub and its surround), large enough to show the result.
Return JSON {{"findings":[{{"view": int, "box_2d":[ymin,xmin,ymax,xmax] on a 0-1000 scale tightly around the thing to change,
  "item": str, "issue": str, "action":"remove"|"add"|"replace","title":str,"reason":str, {OPTIONS_SPEC}}}]}}
At most one finding per view; skip views with nothing important. At most {min(4, len(views))} findings, most important first."""
    return _as_obj(ask(prompt, [("image/jpeg", v) for v in views]), "findings")


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
Answer concisely and concretely (costs, trade-offs). Never claim legal ADA compliance; say "likely" and suggest verifying.
Return JSON {{"reply": str}}"""
    return _as_obj(ask(prompt), "reply")
