# Sandra's FrontDoor

**See any home the way you'd live in it.** Sandra's FrontDoor is an AI home-search and remodel-preview app for people
who need an accessible home: wheelchair users, older adults aging in place, families planning ahead. You describe
what you need, it finds homes that fit, and then a guide walks you through each home's real 3D tour and *shows* you,
photo-realistically and in place, what it would look like with the changes you need, with real prices.

Built at HackPrinceton 2026 for the CoStar track, using CoStar/Homes.com listing data, Matterport 3D tours and Vexcel
aerial imagery.

## Sandra experience and implementation notes

### Search and fit

- The search starts with an empty prompt and editable examples for mobility, hearing, vision and dexterity.
  The same interface works for buying and renting. The buyer can mark any access preference as a must-have.
- `app/blueprints/api.py` applies the stated listing-price ceiling directly. For must-haves, it excludes
  listings with contradictory evidence, ranks with supporting evidence first, and labels the remaining
  candidates with exactly what still needs confirmation. This keeps major structural problems in search
  rather than presenting them as routine remodels during the tour.
- `app/services/listings.py` and `app/services/ai.py` recognize lever hardware, visual alerts, even lighting
  and quiet spaces alongside the existing movement and aging-in-place signals. An imprecise listing claim
  is treated as a clue and measured door width still needs confirmation.

### Fixture recognition and previews

- `/api/home/<id>/agent/objects` inventories up to four original photos at a time. Vision returns individual
  objects, tight normalized boxes, confidence and parent relationships. A vanity cabinet, basin, countertop
  and faucet can each be selected. A door and its handle are separate. Reflections and uncertain detections
  are excluded. The endpoint validates results and atomically caches labels and boxes per home and registered
  camera angle, without storing the submitted photos in the object cache.
- `app/static/js/inventory.js` keeps a bounded per-listing index in the browser. It links observations by the
  same view or by type, room and nearby unambiguous scan coordinates. An object without sufficient depth
  evidence remains a local observation. "Objects in view" lets the buyer see and spotlight indexed parts.
- Duplicate handling runs after resolving the target and compares object identity, part and edit intent.
  The tour acknowledges an existing plan item instead of proposing it again. An explicit revision can
  replace it after the new preview verifies. Proximity alone does not turn a shower into a duplicate vanity.
- Manual and guided edits share the same renderer. The original scan anchors the fixture and the exact read-only
  image for each camera is captured by a separate Showcase instance. New views are matched to the fixture
  with scan projection, visibility checks, and the indexed parts before image generation. Alternate photographs
  are appearance references only. The edited pixels are limited to the confirmed region, and each angle
  needs its own review for placement, occlusion, geometry and seams. For angled cabinet faces, a validated
  polygon mask protects neighboring walls and floor more precisely than an enclosing rectangle.
- Direct neighbors are prepared first. On arrival at another eligible, unprepared scan point, Sandra queues
  that angle once the user settles. It uses the saved original photo and edit brief even after reload.
  Existing approved patches are reused, failed attempts are rate limited and **Check this angle** can retry.
  The original view is shown for blocked, pending or failed angles and during movement. Showcase previews
  represent registered scan points. A continuous remodeled mesh would require a different reconstruction system.
- For the sink shown in the demo, explicitly asking for only the counter and sink removes the entire base
  under the same countertop. The prompt calls for protected recessed plumbing and concealed support, a
  finished floor, and clear knee/toe space. The reviewer rejects remaining cabinet frames and smeared floor.
  Preview images illustrate the idea and do not establish structural feasibility or clearance measurements.

### Guided tour and interface

- `app/templates/base.html`, `index.html`, `home.html` and `app/static/css/sandra.css` introduce the
  charcoal-and-mint search and tour interface. The dark dock keeps the current decision, room, progress,
  angle status, and composer together. The transcript, report button, comparison, plan totals, drawers,
  room navigation, spotlight, and keyboard controls remain available. The dock stacks below the tour on
  narrow screens, and motion respects the operating system preference.
- `app/static/img/frontdoor-home.jpg` is an unedited kitchen view from the hackathon Matterport tour.
  It keeps the search header usable while a listing photograph is still loading.
- The tour gathers original views while moving and turning through the existing scan path. It uses room-local
  evidence and the buyer's preferences, opens the current proposal alongside its spotlight, and offers
  **Preview change**, **Refine with Sandra**, **Skip** and **End tour**.
- Refinement uses the original frame and the buyer's reply. A price or complexity objection asks a follow-up
  before proceeding. A stated installation cap filters the revised choices. A buyer can preserve a doorway and
  change only the handle, or skip the project. Unsolicited structural work is surfaced as a fit concern.
- `app/static/js/sandra-rover.js` adds a Three.js scene component through the existing Showcase SDK.
  Sandra rolls, turns, reverses, blinks, and scans in model coordinates. Guidance follows scan-point paths.
  Nearby placement uses ground raycasts. A hop is available only for a short, low, level surface supported
  by multiple scene hits. The rover uses the scan for placement rather than a general collision simulator.
- The supplied style playbook informed the live character, strong silhouette, idle animation, depth and clear
  controls. FrontDoor uses its own web layout, palette and typography.

### Reproduce the bathroom and proposal flows

1. Start the local app using the setup below. Search for a single-level Houston home, mark step-free entry
   or another required feature, and open a result with supporting or clearly labeled incomplete evidence.
2. In the 3D tour, open **Objects in view** to inspect individual fixture parts. Circle a sink and say
   “remove every cabinet below this countertop, keep this sink and faucet, and leave room to roll underneath.”
3. Compare the before and after at the current scan point. Step to the doorway, wait for Sandra's angle
   status, and check that the original is shown if the fixture is blocked or a rendering did not verify.
4. Start a guided tour, refine a proposal in the composer, set an installation budget or request a hardware-only
   change, preview it, and then review the plan. Reopen the home to verify saved edits and reuse of approvals.
5. Use **Scout with Sandra** at a suitable low platform to test hop detection. On flat floors, the rover
   stays on the floor. Imported listing/scan data and provider credentials remain in their existing locations.

### Validation

The browser walkthrough uses the real Matterport model and local stand-ins for the AI providers. It checks the
custom search, must-have filters, index reuse and spotlighting, the 3D rover, a revised suggestion's cost cap,
the preview and saved plan, and background doorway capture without moving the visitor camera. This exercises the
whole application flow without transmitting the bathroom screenshot to an additional service or charging AI credits.
Generated image quality still needs a provider-backed check.

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

### The tour, in the buyer's hands
The tour is full-screen Matterport with the listing small at top left and Sandra at bottom center: one card (one
question or answer at a time) above one input. Flow (`app/static/js/sandra-flow.js`):
1. **Who is it for?** Sandra asks first (multi-select or your own words) and never assumes a wheelchair; older age maps
   to aging-in-place changes. Saved per browser; "More → Change who it's for" edits it.
2. **Explore at your own pace.** Sandra never moves the camera here. When you settle in a new room she looks at what you
   see and may point out one thing ("Add to my list" / "No thanks"). Type a change, or tap ✎ and paint over anything
   (a real brush; Ctrl+Z removes the last stroke). Each change is understood and priced right away and goes on your list.
3. **Make my changes.** Sandra builds the whole list (render, review, auto-fix), then walks you through each change like a
   realtor: she goes there, frames it, explains it with its price, and you pick Next / Remove this / I'll look around.

### Empty rooms (automatic)
Furnished listings are hard to picture as your own. The moment you arrive at a scan point, Sandra captures its
360° panorama (`Renderer.takeEquirectangular`), the image model removes furniture and belongings while keeping
walls, windows, doors, floors and built-ins pixel-aligned (so real dimensions are untouched), a quick vision check
retries once if anything big is left, and the result is wrapped on a sphere centered on that scan point
(`app/static/js/empty-room.js`, `imaging.empty_pano`, `GET/POST /api/home/<id>/empty/<sweep>`). Panoramas are cached
per scan point. The panorama is centered on the camera heading at capture, so the sphere turns by that heading - 90°.
"Show furnished" brings everything back for comparison.

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
