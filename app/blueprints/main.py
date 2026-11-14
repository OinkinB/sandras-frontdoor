"""Page routes."""
from flask import Blueprint, abort, current_app, render_template

from ..services import listings

bp = Blueprint("main", __name__)


@bp.route("/")
def index():
    return render_template("index.html", total=len(listings.HOMES))


@bp.route("/home/<int:home_id>")
def home(home_id):
    h = listings.HOMES.get(home_id)
    if not h:
        abort(404)
    return render_template("home.html", home=listings.public(h), photos=h["photos"],
                           features=h["features"], remarks=h["remarks"],
                           sdk_key=current_app.config["MATTERPORT_SDK_KEY"])
