"""LLM access: Gemini on Vertex AI (pay-per-request, no idle cost), OpenAI as fallback."""
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
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")


def _gcloud_token():
    if _token["value"] and time.time() < _token["exp"]:
        return _token["value"]
    exe = shutil.which("gcloud") or "gcloud"
    out = subprocess.run(f'"{exe}" auth print-access-token', shell=True, capture_output=True, text=True, timeout=60)
    tok = out.stdout.strip()
    if not tok:
        raise RuntimeError("gcloud token unavailable: " + out.stderr[:200])
    _token.update(value=tok, exp=time.time() + 45 * 60)
    return tok


def _gemini(prompt, images, want_json):
    proj = os.environ["GCP_PROJECT"]
    url = (f"https://aiplatform.googleapis.com/v1/projects/{proj}/locations/global/"
           f"publishers/google/models/{GEMINI_MODEL}:generateContent")
    parts = [{"inlineData": {"mimeType": m, "data": base64.b64encode(b).decode()}} for m, b in images]
    parts.append({"text": prompt})
    body = {"contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"temperature": 0.3}}
    if want_json:
        body["generationConfig"]["responseMimeType"] = "application/json"
    r = requests.post(url, json=body, timeout=120, headers={"Authorization": f"Bearer {_gcloud_token()}"})
    r.raise_for_status()
    parts = r.json()["candidates"][0]["content"]["parts"]
    return "".join(p.get("text", "") for p in parts if not p.get("thought"))


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


# ---------- task prompts ----------

NEED_KEYS = ["no_stairs", "step_free_entry", "wide_doorways", "walk_in_shower", "grab_bars",
             "first_floor_bedroom", "smooth_flooring", "garage"]


def parse_query(text: str) -> dict:
    prompt = f"""You turn a home-seeker's request into search filters for an accessible-home search.
Request: "{text}"
Return JSON with keys:
 needs: array, subset of {NEED_KEYS} (infer: wheelchair -> no_stairs, step_free_entry, wide_doorways, walk_in_shower, smooth_flooring; elderly/aging in place -> no_stairs, first_floor_bedroom, grab_bars, walk_in_shower)
 max_price: number or null; min_beds: number or null
 city: "Houston" | "Los Angeles" | null
 rent: true if they want to rent, false if buy, null if unclear
 persona: one short sentence describing the user's situation
 summary: short phrase listing what you will search for"""
    return ask(prompt)


PARTS_SPEC = """"parts": [{"shape":"box"|"cylinder","size":[x,y,z] meters (cylinder: [diameter,height,diameter]),
  "offset":[x,y,z] meters from the floor point under the center of the selection (x = right, y = up, z = toward the viewer),
  "rotate":[rx,ry,rz] degrees (optional),"color":"#rrggbb","metal":0-1,"rough":0-1,"opacity":0-1 (optional, glass ~0.25)}]
  Design it realistically at true size from simple parts (max 16), e.g. a roll-under sink, a lowered counter, a bench, a handrail."""


def analyze_selection(crop: bytes, full: bytes, room: str, instruction: str | None, size: dict | None = None) -> dict:
    catalog = {k: v["label"] for k, v in costs.MODS.items()}
    dims = (f"Measured size of the selected region in the 3D scan: {size['w']:.2f} m wide, {size['h']:.2f} m tall, "
            f"{size['d']:.2f} m deep; vertical span of the selected surfaces {size.get('rise', 0):.2f} m.") if size else ""
    prompt = f"""You are an accessibility specialist (occupational therapist + contractor) looking at a 3D tour of a home.
Image 1 is the region the user selected; image 2 is the full view for context. Room: {room or 'unknown'}. {dims}
{'User instruction: ' + instruction if instruction else 'No instruction; propose the most useful accessibility changes for what is selected.'}
Identify the objects in the selection and assess accessibility for a wheelchair user / older adult.
Return JSON:
{{"items":[{{"name":str,"observation":str (concrete, e.g. 'alcove bathtub, ~15 in wall to step over')}}],
 "changes":[{{"action":"remove"|"add"|"replace","mod":one of {list(catalog) + ['custom']},"title":str,"reason":str,
             "cost_low":int,"cost_high":int, (only for mod "custom") {PARTS_SPEC}}}],
 "summary": str (1-2 sentences, plain language)}}
Catalog with typical costs: {json.dumps({k: [v['label'], v['low'], v['high']] for k, v in costs.MODS.items()})}
Rules: use "replace" when an existing item is swapped (tub -> walk_in_shower). For a staircase propose "stairlift" (it is
fitted to the measured stairs automatically). If what is needed is NOT in the catalog, use mod "custom" and design it with
"parts" sized to the measurements above. Keep costs realistic. At most 3 changes."""
    imgs = [("image/jpeg", crop)] + ([("image/jpeg", full)] if full else [])
    return _as_obj(ask(prompt, imgs), "changes")


def _as_obj(res, list_key):
    """Models occasionally return a bare list or a one-item list; normalize to a dict."""
    if isinstance(res, list):
        if len(res) == 1 and isinstance(res[0], dict) and (list_key in res[0] or "reply" in res[0] or "summary" in res[0]):
            return res[0]
        return {list_key: res}
    return res if isinstance(res, dict) else {}


def chat(home: dict, edits: list, selection: dict | None, message: str, history: list) -> dict:
    ctx = {k: home.get(k) for k in ("address", "city", "price", "beds", "baths", "sqft", "stories", "year_built")}
    ctx["evidence"] = {k: v["status"] for k, v in home["evidence"].items()}
    prompt = f"""You are Sandra's FrontDoor's home accessibility assistant, embedded in a live 3D tour.
Home: {json.dumps(ctx)}
Listing remarks: {home.get('remarks','')[:1200]}
Edits already planned in the 3D model: {json.dumps(edits)}
Current selection in the 3D view: {json.dumps(selection) if selection else 'none'}
Conversation so far: {json.dumps(history[-8:])}
User: {message}
Answer concisely and concretely. Never claim legal ADA compliance; say "likely" and suggest verifying.
If the user asks to change something they selected, include an action.
Return JSON: {{"reply": str, "actions": [{{"action":"remove"|"add"|"replace","mod": one of {list(costs.MODS) + ['custom']},"title":str,"cost_low":int,"cost_high":int, (only for "custom") {PARTS_SPEC}}}]}}"""
    return _as_obj(ask(prompt), "actions")
