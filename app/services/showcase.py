"""Prepared tour cues and optional authored previews in Matterport model coordinates."""
from . import listings


# Measured in the Showcase player against the original model. These points are specific to this scan.
_AUTHORED = {
    "vwDtYGo2VUz": {
        "sweep": "nmycc7kb55a26y76uazi6qrzd",
        "kind": "wall_rail",
        "title": "Bathroom support rail",
        "detail": "An example of adding a handhold while keeping the room layout.",
        "needs": ["grab_bars", "roll_in_shower", "step_free_entry"],
        "rotation": {"x": -23, "y": -17},
        "anchors": [
            {"x": -1.55, "y": 0.82, "z": -7.130},
            {"x": -0.82, "y": 0.82, "z": -7.129},
        ],
        "normal": {"x": 0, "y": 0, "z": 1},
    }
}

_ROOMS = {
    "step_free_entry": "entry|foyer|hall|porch",
    "no_stairs": "entry|foyer|hall|living|kitchen",
    "wide_doorways": "hall|entry|foyer",
    "walk_in_shower": "bath",
    "roll_in_shower": "bath",
    "grab_bars": "bath",
    "first_floor_bedroom": "bedroom",
    "smooth_flooring": "living|kitchen|hall",
    "garage": "garage|carport",
    "lever_handles": "entry|foyer|hall|bedroom",
    "visual_alerts": "entry|foyer",
    "even_lighting": "living|kitchen",
    "quiet_space": "bedroom|study|office",
}


def tour_plan(home, scan=None):
    cues = []
    floor = next((f for f in (scan or {}).get("findings", []) if f.get("need") == "no_stairs"), None)
    for key, room in _ROOMS.items():
        record = home["evidence"][key]
        status = record["status"]
        label = listings.NEEDS[key]
        source = "listing" if status in ("yes", "likely") else "check"
        if key == "no_stairs" and floor and floor.get("status") == "yes" and not home["condo"]:
            status, source = "yes", "scan"
            detail = "The Matterport scan has a single level. Check the entrance threshold separately."
        elif status == "yes":
            detail = "The listing reports this feature. Here’s where to take a closer look."
        elif status == "likely":
            detail = "The listing suggests this may be available. Check the exact layout in the tour."
        else:
            detail = "Use this room to check whether the home meets this requirement."
        cues.append({"need": key, "title": label, "detail": detail, "status": status, "source": source, "room": room})
    return {"features": cues, "preview": _AUTHORED.get(home["matterport_id"])}
