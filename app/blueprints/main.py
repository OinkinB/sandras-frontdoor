"""Page routes."""
from flask import Blueprint, abort, current_app, render_template

from ..services import listings, matterport, showcase

bp = Blueprint("main", __name__)


@bp.route("/")
def index():
    return render_template("index.html", total=len(listings.HOMES))


@bp.route("/home/<int:home_id>")
def home(home_id):
    h = listings.HOMES.get(home_id)
    if not h:
        abort(404)
    scan = matterport.cached_info(h["matterport_id"], current_app.config["CACHE_DIR"])
    return render_template("home.html", home=listings.public(h), photos=h["photos"],
                           features=h["features"], remarks=h["remarks"],
                           tour_plan=showcase.tour_plan(h, scan),
                           sdk_key=current_app.config["MATTERPORT_SDK_KEY"])
