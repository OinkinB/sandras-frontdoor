"""Serve the Matterport Showcase SDK bundle (needed for 3D objects in the scan)."""
from flask import Blueprint, current_app, send_from_directory

bp = Blueprint("bundle", __name__)


@bp.route("/<path:filename>")
def asset(filename):
    return send_from_directory(current_app.config["BUNDLE_DIR"], filename)
