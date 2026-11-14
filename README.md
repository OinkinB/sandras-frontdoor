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

**Photoreal edits, not 3D mockups.** When you apply a change, the current view of the Matterport tour is sent to
Gemini's image model (`gemini-2.5-flash-image` on Vertex AI) with a mask of your selection. Only the masked region is
kept, color-matched to the untouched photo and feathered at the edges, then projected back into the tour as a
textured quad along the camera's own rays from that scan point. Looking around from that spot it lines up with the
real photo. When you walk to another scan point that can see the change, it is re-rendered from there, with the first
render passed as a reference so it stays the same product.

**Priced options.** Every proposed change comes with Budget / Standard / Premium products: item cost plus labor
(hours × trade rate). You can also type exactly what you want. The plan sums items and labor into a true cost.

**Agent first pass.** With needs from the search, the agent walks the key rooms on its own (bathrooms, halls,
bedrooms), finds existing barriers, picks a product and renders the fix before you start exploring.

| Piece | Where |
|---|---|
| Listing load + accessibility evidence | `app/services/listings.py` |
| Gemini text/vision + image editing, OpenAI text fallback | `app/services/ai.py` |
| Mask, edit, color-match, feather, save patch | `app/services/imaging.py` |
| Matterport GraphQL rooms/floors, Vexcel parcel + aerial | `app/services/matterport.py`, `vexcel.py` |
| Blueprints: pages, `/api/*`, `/bundle/*` | `app/blueprints/` |
| Tour: drag-select, 3D measurement, photo patches, re-render on move, agent | `app/static/js/tour.js` |

### Reporting issues
Click **Report issue** (top right) on any page: it screenshots what you see (the live 3D view on tour pages), lets you
box or draw on what's wrong, and saves the note, screenshots and the app's state (camera position, room, selections,
changes, recent API calls and errors) to `logs/feedback/<time>/`. Server errors go to `logs/server.log`.

### Making changes (the experience)
- **Guided tour**: the agent walks you room by room, points out what gets in the way of your needs, prices a fix
  (item + labor) and asks **Show me this fix / Skip / End tour**. It skips extras and changes you already have.
- **Change something**: circle anything, loosely is fine. A menu offers *Make it accessible for me*, *Remove it*,
  *Replace with…*, *Add here…*, or free text. The agent finds the whole object you meant, so a sloppy outline still works.
- Each change runs in the background with a **processing card**: understanding → pricing → rendering → quality check
  → ready. An independent reviewer (OpenAI, Gemini fallback) compares before/after and the render is redone with its
  fix if it isn't a clear, finished result. When ready: **Show me** takes you to it.
- Asking for something you already have prompts *Replace / Keep / Add both* instead of redoing it.
- **Your changes on / Today** switch (hold **B** to peek), **Changes** drawer with Show toggles, product swap,
  Undo (Ctrl+Z) and totals, and a budget check against the price you searched with.

### Tour controls
- **W / S**: walk or select. Drag a box; **Shift+drag** adds more; **Esc** clears.
- **Today / Plan / After**: the home as it is, outlines of planned changes, or the home with your changes.
- **Run walkthrough** re-runs the agent. The room switcher (top-left) jumps between rooms.

## Cloud

Nothing has to run in the cloud. To host it, `homematch/Dockerfile` builds a Cloud Run image (build from the kit
folder so the data is included). It scales to zero, so idle cost is $0; you pay per request for Gemini
(about $0.04 per rendered view). The Matterport SDK key only works on `localhost`, so ask Matterport/the organizers to
add the hosted domain before deploying. Renders go to `CACHE_DIR` (`/tmp` on Cloud Run; mount a Cloud Storage bucket
to keep them).

Costs are estimates and accessibility notes are "likely" signals, not ADA compliance.
