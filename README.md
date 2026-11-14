# Sandra's FrontDoor

**See any home the way you'd live in it.** Sandra's FrontDoor is an AI home-search and remodel-preview app for people
who need an accessible home: wheelchair users, older adults aging in place, families planning ahead. You describe
what you need, it finds homes that fit, and then a guide walks you through each home's real 3D tour and *shows* you,
photo-realistically and in place, what it would look like with the changes you need, with real prices.

Built at HackPrinceton 2026 for the CoStar track, using CoStar/Homes.com listing data, Matterport 3D tours and Vexcel
aerial imagery.

---

## The problem we're solving

- Fewer than 4% of US homes are wheelchair-friendly, and about 10% are "aging-ready".
- Listings rarely say. In our CoStar data, **0 of 2,120** listings fill in the official accessibility field.
- Buyers can't picture whether a home could *work* for them, or what it would cost to get there.

## What we're building (the vision)

1. **Search by need, not just by price.** "I use a wheelchair, need no stairs and a walk-in shower, Houston, under
   $400k." An AI agent turns that into needs and ranks homes by accessibility match **and true cost** (price +
   estimated changes).
2. **An agent that knows the home.** It reads the listing text, the Matterport scan (rooms, floors, sizes) and the
   aerial view to say what's already accessible and what isn't.
3. **A guided experience, not a toolbox.** The guide walks you room by room through the 3D tour, points at what gets
   in your way, explains why, and offers a fix with Budget / Standard / Premium options (item + labor).
4. **Reimagine any spot.** Circle anything, even loosely, and say what you want ("make this a walk-in shower with grey
   tile, no tub"). The agent figures out the whole object you meant and renders the change into the real photos.
5. **Believable results.** Every render is checked by an independent AI reviewer and redone if it isn't a clear,
   finished, realistic result. When ready, the guide tells you and takes you to it.
6. **Context aware.** The agent tracks everything you've changed or declined, doesn't repeat itself, and tells you when
   something is optional (e.g. one accessible bathroom may be enough).
7. **Your plan and your budget.** Every change has a price, can be turned on/off, swapped or undone, and the total
   cost is checked against your budget.

## What works today

| Area | What it does |
|---|---|
| Search | AI parses your request into needs, budget and city; 1,905 Houston/LA homes with 3D tours ranked by match and true cost |
| Listing evidence | Accessibility signals pulled from listing text + feature lists; scan findings (floors, stairs, hallway widths) from Matterport |
| Tour page | Full-screen Matterport tour; header with list price + planned changes = total cost; floating guide chat (minimizable) |
| Guided tour | Walks room to room through neighboring scan points (smooth steps), looks around, spotlights the exact item, proposes one need-based fix with prices; Show me / Skip / End; waits in the room until the fix is ready, then shows it and asks Keep / Undo |
| Change something | Draw (freehand) or box; menu: Make it accessible for me, Remove it, Replace with…, Add here…, free text |
| Smart targeting | Your outline only marks the spot; the agent returns a box around the whole object to change |
| Rendering | Masked photo edit (Gemini 2.5 Flash Image; OpenAI gpt-image-2 fallback), color-matched and feathered, projected back into the tour from the exact scan point; re-rendered when you view it from another nearby spot |
| Quality check | OpenAI reviews before/after (Gemini fallback); failures re-render with the reviewer's fix, up to 2 retries; score shown |
| Background jobs | Selections freeze the view, so you keep walking; processing cards show each step; "Show me" when ready |
| Chat alerts | Messages with a 📍 are clickable: they walk you to the spot and spotlight the item; seen ones grey out |
| Context | The agent gets the full list of done/declined changes; duplicate requests ask Replace / Keep / Add both |
| Plan | Changes drawer: Show toggle, product swap (re-renders), delete, Undo (Ctrl+Z), totals incl. labor, budget check |
| Compare | "Your changes on / Today" switch; hold **B** to peek at today |
| Outside | Vexcel aerial of the lot + footprint, lot, trees, pool, roof |
| Issue reports | **Report issue** button: screenshot + drawing + note + full app state saved to `logs/feedback/` |

## Not yet / ideas next

- Gaussian-splat or video "walkthroughs" of edited spaces (needs many views per change; we re-render per scan point instead).
- True measurements (door widths) from the scan mesh; turning-radius and step-free route overlays.
- Contractor quotes / financing; saving and sharing plans; accounts.
- The agent's room check takes ~30-60 s; caching per home would make return visits instant.

---

## How it works

```
Search ──► /api/search ──► AI parses needs ──► rank homes (listings.py)
Tour   ──► Matterport bundle (Showcase SDK) in an iframe
           ├─ select (draw/box) ──► freeze frame + camera pose
           ├─ /api/home/<id>/agent/plan   (Gemini vision: find the object, issue, fix, 3 priced options)
           ├─ /api/home/<id>/render       (mask + edit + color-match + feather → patch PNG)
           ├─ /api/home/<id>/verify       (OpenAI reviews before/after; retry with fix)
           └─ PhotoPatch: textured quad along the camera rays at that scan point
```

| Piece | File |
|---|---|
| App factory, logging | `app/__init__.py` |
| Pages / JSON API / SDK bundle / issue reports | `app/blueprints/main.py`, `api.py`, `bundle.py`, `feedback.py` |
| Listings + accessibility evidence | `app/services/listings.py` |
| Cost catalog | `app/services/costs.py` |
| LLM + image models (Gemini on Vertex, OpenAI fallback) | `app/services/ai.py` |
| Masked edit, color match, feather, quality-check crops | `app/services/imaging.py` |
| Matterport GraphQL (rooms, floors) | `app/services/matterport.py` |
| Vexcel parcel + aerial | `app/services/vexcel.py` |
| Search page | `app/templates/index.html`, `app/static/js/search.js` |
| Tour experience | `app/templates/home.html`, `app/static/js/tour.js` |
| Issue reporter | `app/static/js/report.js` |

## Run it

The app reads the CoStar kit from the folder **above** this repo (`../data`, `../residential-listings.csv`).

```bash
pip install -r requirements.txt
cd sdk-test && npm install && cd ..      # Matterport Showcase SDK bundle
cp .env.example .env                      # fill in keys
gcloud auth login                         # Gemini on Vertex AI uses this login
python run.py                             # http://localhost:5000 (PORT=5001 python run.py for another port)
```

Keys in `.env` (never commit it): `MATTERPORT_API_KEY`, `MATTERPORT_API_TOKEN`, `MATTERPORT_SDK_KEY`, `VEXCEL_API_KEY`,
`GCP_PROJECT`, `OPENAI_API_KEY`. Optional: `IMAGE_PROVIDER=auto|gemini|openai`, `OPENAI_IMAGE_MODEL` (default
`gpt-image-2`), `GEMINI_MODEL`, `GEMINI_THINKING`, `IMAGE_CONCURRENCY`.

Keep the browser window visible while testing: the Matterport tour pauses when hidden.

### Using it
1. Search: describe what you need. Open a home.
2. **Walk me through it** (or **✦ Guided tour**): the guide takes you room by room.
3. Or **✎ Change something**: circle anything and pick what should happen.
4. Click 📍 messages in the guide to jump to that spot. Open **Planned changes** for your plan.

## Cloud

Runs locally; nothing is always-on. `Dockerfile` builds a Cloud Run image (build from the kit folder so data is
included); it scales to zero. AI costs are per request (about $0.04-0.08 per rendered view plus review). The Matterport
SDK key only works on `localhost`; ask Matterport to add your domain before hosting.

## Notes
- Costs are planning estimates; accessibility notes are "likely" signals, not ADA compliance.
- Imagery © Vexcel Imaging; tours © Matterport; listing data © CoStar/Homes.com (hackathon license).
