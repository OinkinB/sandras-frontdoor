# Sandra's FrontDoor: accessible home search with editable 3D tours

HackPrinceton 2026 · CoStar track. Describe what you need ("I use a wheelchair, no stairs, walk-in shower, Houston, under $400K"). An AI agent ranks 1,905 Homes.com listings that have Matterport scans by accessibility match and **true cost** (price + estimated modifications). In each home's live 3D tour you drag-select anything; the AI identifies it and proposes changes, and applying a change edits the walkthrough itself: old fixtures are erased and new models are placed, and they stay put as you walk.

## Run

The app reads the CoStar hackathon kit from the folder **above** this repo (`../data`, `../residential-listings.csv`), so clone it inside the unzipped `costar-hackathon-kit/` folder.

```bash
pip install -r requirements.txt
cd sdk-test && npm install && cd ..      # Matterport Showcase SDK bundle
cp .env.example .env                      # fill in keys
gcloud auth login                         # Gemini on Vertex AI uses this login
python run.py
```

Open http://localhost:5000. It must be `localhost` because the Matterport SDK key only works there.

Needs `homematch/.env` (never commit it) with `MATTERPORT_API_KEY`, `MATTERPORT_API_TOKEN`, `MATTERPORT_SDK_KEY`, `VEXCEL_API_KEY`, `GCP_PROJECT` (Gemini on Vertex AI via your `gcloud` login) and optionally `OPENAI_API_KEY` (fallback). One-time: `cd sdk-test && npm install @matterport/webcomponent` provides the Showcase SDK bundle.

## How it works

| Piece | Where |
|---|---|
| Listing load + accessibility evidence (regex over remarks + feature text) | `app/services/listings.py` |
| Modification cost catalog (planning estimates) | `app/services/costs.py` |
| Gemini (Vertex, pay per request) with OpenAI fallback: query parsing, vision on selections, chat | `app/services/ai.py` |
| Matterport GraphQL: rooms, sizes, floors, scan points | `app/services/matterport.py` |
| Vexcel parcel + aerial image | `app/services/vexcel.py` |
| Blueprints: pages, `/api/*`, `/bundle/*` (SDK bundle) | `app/blueprints/` |
| 3D tour: drag-select, 3D measurement by raycast grid, erase patches, model placement | `app/static/js/tour.js` |
| Realistic fixtures built procedurally in Blender (GLB) | `blender/build_assets.py` |

Rebuild models: `"C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" --background --factory-startup --python blender/build_assets.py` (previews land in `blender/renders/`).

### Generative edits
Changes are not limited to a fixed catalog:
- **Stairlift** is generated to fit the staircase you select: the rail follows the measured slope (clamped to 33-40°), extends to the real floor levels from the scan, and turns at a winder/landing (a curved stairlift) in whichever direction stays inside the house.
- **Anything else** (a roll-under sink, a lowered counter, a bench): the AI designs it as true-size parts from the measured size of your selection, and the tour builds it in 3D on the spot.

### Tour controls
- **W / S**: walk or select mode. Drag a box; **Shift+drag** adds to the selection; **Esc** clears it.
- Type "make this a walk-in shower" with a selection to get targeted changes.
- **Plan / After**: red/green planning volumes, or the after view (removed items erased).
- Room switcher (top-left) jumps between rooms from the scan.

Costs are estimates and accessibility scores are "likely" signals, not ADA compliance.
