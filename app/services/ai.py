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


def edit_image(ctx_jpeg: bytes, mask_l, prompt: str, ref_png: bytes | None = None) -> tuple[bytes, str]:
    """Photoreal masked edit. Gemini first (with backoff on rate limits), OpenAI as fallback. Returns (image, provider)."""
    order = {"gemini": ["gemini"], "openai": ["openai"]}.get(IMAGE_PROVIDER, ["gemini", "openai"])
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


def agent_plan(views: list[bytes], rooms: list[str], needs: list, persona: str, instruction: str = "",
               outlined: bool = False, existing: list | None = None, declined: list | None = None) -> dict:
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
WHAT HAS ALREADY BEEN DONE IN THIS HOME (the photos may still show the original, but treat these as done):
{json.dumps(existing or [])}
Suggestions the buyer already declined (never suggest again): {json.dumps(declined or [])}
Be context aware: never propose something already done or declined. Also judge redundancy across the home: e.g. if one
bathroom already has (or is planned to get) a roll-in shower, a second bathroom's tub is a lower priority; then set
fits_needs false or say in "advice" that it's optional and why. Prefer the barriers that matter most for daily life.
Find the concrete EXISTING barriers for THIS buyer and the change that fixes each: bathtub or curbed shower -> curbless
roll-in shower, toilet without support -> grab bars beside it, stairs -> stairlift, narrow door -> wider door, step at
entry -> ramp, carpet -> hard floor, high counters/cabinets -> roll-under. Always fix an existing object you can see;
never invent a new fixture in empty floor space. Ignore reflections in mirrors, glass and windows: only real objects.
box_2d must enclose that existing object (for a tub: the whole tub and its surround) with a little margin.
Return JSON {{"findings":[{{"view": int, "box_2d":[ymin,xmin,ymax,xmax] on a 0-1000 scale,
  "item": str, "issue": str, "action":"remove"|"add"|"replace","title":str,"reason":str,
  "fits_needs": true|false (does this help the buyer's stated needs?),
  "advice": str (one friendly sentence: why it matters, or a gentle warning if it is an extra that adds cost without helping their needs),
  {OPTIONS_SPEC}}}]}}
At most one finding per view; skip views with nothing important. At most {min(4, len(views))} findings, most important first."""
    return _as_obj(ask(prompt, [("image/jpeg", v) for v in views]), "findings")


def verify_render(before: bytes, after: bytes, task: str) -> dict:
    """Quality gate: does the edited photo really show the requested change, finished and believable?"""
    prompt = f"""You are a strict reviewer of photo edits for a home-remodel visualizer.
Image 1 = the original photo region, image 2 = the edited region. The requested change was:
"{task}"
Judge only what a home buyer would see. Fail it if: the requested change is missing or only partly done, the old item
is still clearly there when it should be gone, it looks like a construction site, there are smears, warped geometry,
floating objects, duplicated fixtures, cut-off items at the edges, or obvious seams.
Return JSON {{"ok": true|false, "score": 0-10, "issues": [str], "fix": str (one concrete instruction to fix it, or "")}}.
ok must be true only if score >= 7."""
    imgs = [("image/jpeg", before), ("image/jpeg", after)]
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
    return {"ok": True, "score": None, "issues": [], "fix": "", "reviewer": "unavailable", "error": "; ".join(errors)[:300]}


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
