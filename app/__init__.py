"""Sandra's FrontDoor: accessible home search with editable 3D tours."""
import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask

ROOT = Path(__file__).resolve().parent.parent          # homematch/
KIT = ROOT.parent                                      # costar-hackathon-kit/
load_dotenv(ROOT / ".env")


def create_app() -> Flask:
    app = Flask(__name__)
    app.config.update(
        KIT_DIR=KIT,
        CACHE_DIR=ROOT / "cache",
        BUNDLE_DIR=ROOT / "sdk-test" / "node_modules" / "@matterport" / "webcomponent" / "built-bundle",
        MATTERPORT_SDK_KEY=os.environ.get("MATTERPORT_SDK_KEY", ""),
    )
    app.config["CACHE_DIR"].mkdir(exist_ok=True)

    from .services import listings
    listings.load(KIT)

    from .blueprints.main import bp as main_bp
    from .blueprints.api import bp as api_bp
    from .blueprints.bundle import bp as bundle_bp
    app.register_blueprint(main_bp)
    app.register_blueprint(api_bp, url_prefix="/api")
    app.register_blueprint(bundle_bp, url_prefix="/bundle")
    return app
