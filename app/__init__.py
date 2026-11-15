"""Sandra's FrontDoor: accessible home search with editable 3D tours."""
import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask

ROOT = Path(__file__).resolve().parent.parent          # homematch/
load_dotenv(ROOT / ".env")
# The CoStar kit (data/, residential-listings.csv). Defaults to the folder above this repo.
KIT = Path(os.environ.get("KIT_DIR", ROOT.parent))


def create_app() -> Flask:
    app = Flask(__name__)
    app.config.update(
        KIT_DIR=KIT,
        # On Cloud Run point CACHE_DIR at /tmp (or a mounted Cloud Storage bucket to keep renders).
        CACHE_DIR=Path(os.environ.get("CACHE_DIR", ROOT / "cache")),
        BUNDLE_DIR=Path(os.environ.get("BUNDLE_DIR", ROOT / "sdk-test" / "node_modules" / "@matterport" / "webcomponent" / "built-bundle")),
        MATTERPORT_SDK_KEY=os.environ.get("MATTERPORT_SDK_KEY", ""),
        LOG_DIR=Path(os.environ.get("LOG_DIR", ROOT / "logs")),
    )
    app.config["CACHE_DIR"].mkdir(parents=True, exist_ok=True)
    app.config["LOG_DIR"].mkdir(parents=True, exist_ok=True)
    # server log: every API error and issue report lands in logs/server.log
    fh = RotatingFileHandler(app.config["LOG_DIR"] / "server.log", maxBytes=2_000_000, backupCount=3, encoding="utf8")
    fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    fh.setLevel(logging.INFO)
    app.logger.addHandler(fh)
    app.logger.setLevel(logging.INFO)

    from .services import listings
    listings.load(KIT)

    from .blueprints.main import bp as main_bp
    from .blueprints.api import bp as api_bp
    from .blueprints.bundle import bp as bundle_bp
    from .blueprints.feedback import bp as feedback_bp
    app.register_blueprint(main_bp)
    app.register_blueprint(api_bp, url_prefix="/api")
    app.register_blueprint(bundle_bp, url_prefix="/bundle")
    app.register_blueprint(feedback_bp, url_prefix="/api")
    if os.environ.get("GCP_PROJECT") and not app.testing:
        # Fetch the Google Cloud token now, in the background, so the first search or AI call isn't slow.
        import threading
        from .services import ai
        threading.Thread(target=lambda: _quiet(ai._access_token), daemon=True).start()
    return app


def _quiet(fn):
    try:
        fn()
    except Exception:
        pass
