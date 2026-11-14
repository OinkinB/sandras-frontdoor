"""Issue reports from inside the app: annotated screenshot + note + app state, saved under logs/feedback/."""
import base64
import json
import time
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request

bp = Blueprint("feedback", __name__)


def _log_dir() -> Path:
    d = current_app.config["LOG_DIR"] / "feedback"
    d.mkdir(parents=True, exist_ok=True)
    return d


@bp.post("/feedback")
def create():
    b = request.get_json(force=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    folder = _log_dir() / f"{stamp}-{(b.get('page') or 'page').strip('/').replace('/', '_')[:40] or 'home'}"
    folder.mkdir(parents=True, exist_ok=True)
    for key, name in (("image", "screenshot.png"), ("raw", "screenshot_raw.png")):
        if b.get(key):
            (folder / name).write_bytes(base64.b64decode(b[key].split(",", 1)[-1]))
    ctx = b.get("context") or {}
    (folder / "context.json").write_text(json.dumps(ctx, indent=2))
    (folder / "report.md").write_text(
        f"# Issue {stamp}\n\n**Page:** {b.get('url', '')}\n\n**What went wrong:**\n\n{b.get('note', '').strip()}\n\n"
        f"**Highlights drawn:** {b.get('marks', 0)}\n\n"
        f"Screenshot: `screenshot.png` (with highlights), `screenshot_raw.png`. App state: `context.json`.\n")
    current_app.logger.warning("Issue report saved: %s", folder)
    return jsonify({"ok": True, "id": folder.name})


@bp.get("/feedback")
def index():
    """List reports (newest first) so they're easy to review."""
    items = []
    for f in sorted(_log_dir().iterdir(), reverse=True)[:100]:
        md = f / "report.md"
        items.append({"id": f.name, "note": md.read_text()[:400] if md.exists() else ""})
    return jsonify(items)
