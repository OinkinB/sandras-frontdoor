"""Accessibility modification catalog: rough installed-cost ranges (USD).

Ranges are planning estimates drawn from typical published remodeling cost
guides; the UI always labels them as estimates to verify with a contractor.
"""

MODS = {
    "ramp": {
        "label": "Entry ramp", "low": 1500, "high": 6000,
        "need": "step_free_entry", "model": "ramp",
        "why": "Removes steps at the entrance for wheelchairs and walkers.",
    },
    "walk_in_shower": {
        "label": "Curbless walk-in shower", "low": 6000, "high": 15000,
        "need": "walk_in_shower", "model": "walk_in_shower",
        "why": "Replaces a tub or curbed shower with a zero-threshold roll-in shower.",
    },
    "grab_bars": {
        "label": "Grab bars (set of 3)", "low": 300, "high": 900,
        "need": "grab_bars", "model": "grab_bar",
        "why": "Support for transfers at the toilet, shower and tub.",
    },
    "widen_doors": {
        "label": "Widen doorways to 36 in (x3)", "low": 3000, "high": 10500,
        "need": "wide_doorways", "model": "door_frame",
        "why": "Standard 30-32 in doors are tight for wheelchairs; 36 in clears most.",
    },
    "stairlift": {
        "label": "Stairlift", "low": 3000, "high": 8000,
        "need": "no_stairs", "model": "stairlift",
        "why": "Gives access to upper floors without climbing.",
    },
    "shower_chair": {
        "label": "Shower bench / chair", "low": 80, "high": 400,
        "need": None, "model": "shower_chair",
        "why": "Seated bathing reduces fall risk.",
    },
    "raised_toilet": {
        "label": "Comfort-height toilet", "low": 350, "high": 900,
        "need": None, "model": "raised_toilet",
        "why": "17-19 in seat height makes sitting and standing easier.",
    },
    "lever_handles": {
        "label": "Lever door handles", "low": 150, "high": 600,
        "need": None, "model": "lever_handle",
        "why": "Easier than round knobs for limited grip strength.",
    },
    "smooth_flooring": {
        "label": "Replace carpet with smooth flooring", "low": 3000, "high": 9000,
        "need": "smooth_flooring", "model": None,
        "why": "Hard surfaces roll far easier than carpet.",
    },
    "remove_item": {
        "label": "Remove obstacle", "low": 100, "high": 1500,
        "need": None, "model": None,
        "why": "Clears a path or turning space.",
    },
}

# Which mod fixes a missing need (for "true cost" ranking).
NEED_TO_MOD = {m["need"]: key for key, m in MODS.items() if m["need"]}


def mid(key: str) -> int:
    m = MODS[key]
    return int(round((m["low"] + m["high"]) / 2, -2))
