# Presenting Sandra's FrontDoor

## Before you go on (10 minutes ahead)

1. Start the server: `python run.py` in `homematch/` and open **http://localhost:5000** (the Matterport SDK key only
   works on `localhost`). Keep this tab in front; a background tab slows the 3D player.
2. Warm-up run in the same browser you'll present from: open the demo home below, let the tour play once, then build
   one change (for example the toilet grab bar). Built changes are saved in that browser, so if the AI is slow on stage,
   your backup is already there.
3. Demo home: **9918 Dipping Woods Street, Houston**:
   `http://localhost:5000/home/236060791?needs=grab_bars,walk_in_shower,step_free_entry`
   It has the hand-placed support-rail example in the tour.
4. Close other tabs that use the GPU. Zoom the browser to 100%.

## The 30-second pitch

> One in four American adults has a disability, and most of us will need an accessible home at some point. Today,
> finding one means scrolling listings that don't tell you about stairs, door widths or showers, then guessing what it
> would cost to fix. **Sandra's FrontDoor** lets you describe what you need in plain words. Sandra finds homes that
> fit, walks you through the real 3D tour, and shows, photorealistically and in place, what the home would look like
> with your changes, with real prices. So "Could I live here?" becomes "Here's my home, and here's what it costs."

## Demo script (about 4 minutes)

| Step | Do | Say |
|---|---|---|
| 1. Search | On the landing page, click **Aging in place** (or type your own), press Enter. | "I just describe my situation. Results come back instantly from listing evidence, then Sandra refines them with AI. Each card says what's confirmed and what I still need to check in the scan, so it never pretends." |
| 2. Open the home | Open the Dipping Woods link. | "Every home here has a real Matterport 3D scan. That's 1,905 CoStar/Homes.com listings in Houston and LA." |
| 3. Guided tour | Let it play; don't touch the mouse. | "Sandra walks me through the rooms that matter for my needs, using the scan's real walking graph, and tells me where each claim comes from: listing, scan, or 'check this in person'." |
| 4. Rail example | When the bathroom rail appears. | "That support rail is placed in real 3D coordinates of this scan, so it stays put as I look around." |
| 5. Ask for a change | Click **Explore & edit**, type: `add a grab bar beside the toilet`. | "I'm facing the vanity. Sandra doesn't guess: she looks around the room herself, finds the toilet, and prices the change with item plus labor." |
| 6. Paint a change | Turn to the tub, tap ✎, paint over it, type `make this a curbless walk-in shower`. | "Or I paint over anything. The paint is just a hint: Sandra figures out the whole fixture and everything the change touches." |
| 7. Build | Tap **Make my changes**. | Talk during the build (see below). |
| 8. Walkthrough | Sandra walks you to each change. Hold **B**. | "Holding B shows today's version. The total at the top left is now list price plus my changes, my real cost to live here." |

**While it builds (60–120 s), say:**
> "Here's what's happening. Sandra freezes the exact camera view and finds the fixture with Gemini on Google Cloud.
> She renders the change into that photo, then a *different* model, OpenAI, reviews before and after like a
> contractor's inspector. If it's wrong (bar on the wrong wall, fixture moved, a visible seam), Sandra fixes it from the
> reviewer's notes and tries again. Only a passing result gets projected back into the 3D tour at that scan point,
> and nearby angles are rendered too so it holds up as you move."

## Questions you'll likely get

- **How is it different from virtual staging or Zillow's AI?** Staging decorates empty photos. This changes the
  *real fixtures* in the *real 3D tour*, and every change has a price and a quality check. It's tied to a buyer's
  stated needs, and it's honest about what's confirmed versus what to check.
- **Where do prices come from?** A cost catalog of 10 accessibility change types with Budget / Standard / Premium
  options, split into item plus labor. They're estimates, not quotes, and the app says so.
- **Is the AI image accurate?** Every render is independently reviewed; failing ones are fixed or rejected, never
  shown silently. Room measurements come from the Matterport scan; the image is a visualization of the change, placed
  at the exact scan viewpoint. "Preview empty here" removes furniture while keeping walls, windows and floors in place.
- **Does it assume what I need?** No. Needs come from what you say. It never assumes a wheelchair; aging in place maps
  to grab bars, lighting and lever handles, not wheelchair work.
- **What does it cost to run?** Gemini on Vertex for planning and images (about a few cents per change), OpenAI as a
  fallback and reviewer. Packaged as a Docker container for Cloud Run, which scales to zero, so it costs nothing when idle.
- **What's next?** Contractor quotes from the change list, measured clearances from the scan geometry, voice for
  Sandra, and agents for real-estate brokers ("show this buyer what it would take").

## Tech one-liner

Flask (blueprints) + Tailwind, Matterport Showcase SDK (scene components, sweep graph, equirect capture),
Gemini 3 Flash + Gemini 2.5 Flash Image on Vertex AI, OpenAI gpt-image-2 / gpt-4.1-mini as fallback and reviewer,
Vexcel aerials, CoStar/Homes.com listings. Cloud Run-ready Dockerfile.

## If something goes wrong on stage

- **A render takes long or fails:** "The reviewer rejected it, which is the point: it won't show me something wrong."
  Then show the change you built in the warm-up (open **Your list**, then **View**).
- **The 3D tour is slow to load:** reload once; keep the tab in front.
- **Search refinement is slow:** the instant results are already on screen; just keep talking.
