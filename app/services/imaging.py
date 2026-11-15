"""Photoreal edits of a 3D-tour view.

The selected region of the current view is edited by Gemini's image model, then only that region
is cut out with a feathered alpha mask, color-matched to the untouched surroundings, and returned
as a patch the tour projects back into 3D at the exact viewpoint it came from.
"""
import io
import json
import uuid
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat

from . import ai

PROMPT = """This is a real photograph from a 3D tour of a home (image 1). Image 2 is a mask: edit ONLY the white area.
Task: {task}
Requirements:
- Photorealistic, as if the change was really installed and then photographed with the same camera.
- Show the FINISHED result after the work is complete: painted, trimmed, cleaned up, move-in ready. Never show a
  construction site, exposed framing or studs, bare drywall, tape, tools, debris or protective plastic.
- Keep the exact same camera position, field of view, perspective lines and vanishing points.
- Image 1 is authoritative for geometry. Keep the fixture on the same wall, at the same elevation,
  angle and footprint unless the task explicitly requests changing those. Do not duplicate it.
- Preserve the shape and occlusion of any foreground doorway and nearby fixtures.
- Perspective: the new item lies on the same surface plane as what it replaces (wall, door face, floor) and is
  foreshortened exactly like that surface in this photo. Parts that stick out (a lever, grab bar, faucet spout)
  project perpendicular to that surface, following its vanishing lines, with matching shading and shadows.
- If the mask is larger than the old item, that extra room is there so the new item can be its real size
  (e.g. a full-length lever handle); outside the new item, keep the original surface (door, wall, floor).
- Match this photo's lighting direction, exposure, white balance, shadows, reflections, grain and lens softness.
- Correct real-world scale for the room; the new item must sit on the real floor/wall with contact shadows.
- Where something is removed, fill with the surrounding floor/wall/tile continuing naturally.
- Do not change anything outside the white mask. No text, labels, outlines or watermarks.
{ref}Return the full edited photo at the same framing."""

REF_NOTE = (
    "- Image 3 is a product appearance reference only. Match only its finish and installed design. "
    "Do not transfer its wall, floor, framing, orientation, lighting or viewpoint. Rebuild the design "
    "in the perspective of image 1.\n"
)


def _jpeg(img: Image.Image, q=92) -> bytes:
    b = io.BytesIO(); img.convert("RGB").save(b, "JPEG", quality=q); return b.getvalue()


def _png(img: Image.Image) -> bytes:
    b = io.BytesIO(); img.save(b, "PNG", optimize=True); return b.getvalue()


def render(full_jpeg: bytes, rect: list[float], task: str, out_dir: Path, ref_png: bytes | None = None,
           poly: list | None = None) -> dict:
    """rect = [x0, y0, x1, y1] normalized (0-1) in the full view. Returns patch + metadata."""
    full = Image.open(io.BytesIO(full_jpeg)).convert("RGB")
    W, H = full.size
    if len(rect) != 4 or not (0 <= rect[0] < rect[2] <= 1 and 0 <= rect[1] < rect[3] <= 1):
        raise ValueError("The edit region must be inside the source photo.")
    x0, y0, x1, y1 = rect[0] * W, rect[1] * H, rect[2] * W, rect[3] * H
    sw, sh = max(8, x1 - x0), max(8, y1 - y0)
    # Small fixtures (door knobs, switches, faucets): the replacement is often bigger than the original and
    # a tiny crop hides the surface's perspective. Give the new item room and the model more context.
    small = max(sw, sh) < 0.12 * max(W, H)
    grow_rect = None
    if small:
        cxm, cym = (x0 + x1) / 2, (y0 + y1) / 2
        gw, gh = max(sw * 2.6, 0.07 * W), max(sh * 1.7, 0.06 * H)
        grow_rect = (max(0, cxm - gw / 2), max(0, cym - gh / 2), min(W, cxm + gw / 2), min(H, cym + gh / 2))
    # context window: the selection plus generous surroundings so the model sees perspective and light
    pad = max(max(sw, sh) * 0.6 + 40, 0.2 * max(W, H) if small else 0)
    cx0, cy0 = max(0, int(x0 - pad)), max(0, int(y0 - pad))
    cx1, cy1 = min(W, int(x1 + pad)), min(H, int(y1 + pad))
    ctx = full.crop((cx0, cy0, cx1, cy1))
    cw, ch = ctx.size

    sel = (x0 - cx0, y0 - cy0, x1 - cx0, y1 - cy0)
    mask = Image.new("L", (cw, ch), 0)
    if poly and len(poly) > 2:
        pts = [(x * W - cx0, y * H - cy0) for x, y in poly]
        ImageDraw.Draw(mask).polygon(pts, fill=255)
    else:
        ImageDraw.Draw(mask).rectangle(sel, fill=255)
    if grow_rect:
        ImageDraw.Draw(mask).rectangle((grow_rect[0] - cx0, grow_rect[1] - cy0, grow_rect[2] - cx0, grow_rect[3] - cy0), fill=255)

    # upscale small crops so the model works at a useful resolution; the result is scaled back below
    up = max(1.0, 1024 / max(cw, ch))
    send_ctx = ctx.resize((round(cw * up), round(ch * up)), Image.LANCZOS) if up > 1 else ctx
    send_mask = mask.resize(send_ctx.size) if up > 1 else mask
    raw, provider = ai.edit_image(_jpeg(send_ctx), send_mask, PROMPT.format(task=task, ref=REF_NOTE if ref_png else ""), ref_png)
    out = Image.open(io.BytesIO(raw)).convert("RGB")
    out = out.resize((cw, ch), Image.LANCZOS)

    # color-match the generated image to the original using the area outside the mask (should be unchanged)
    outside = ImageChops.invert(mask)
    if outside.getbbox():
        so, sg = ImageStat.Stat(ctx, outside), ImageStat.Stat(out, outside)
        gains = [max(0.8, min(1.25, (o + 1) / (g + 1))) for o, g in zip(so.mean, sg.mean)]
        out = Image.merge("RGB", [ch_.point(lambda v, k=k: min(255, v * k)) for ch_, k in zip(out.split(), gains)])

    # Feather inward. Generated pixels must never cover the counter, wall, or doorway outside the mask.
    feather = max(2, min(8, int(0.015 * max(sw, sh) * (2.2 if small else 1))))
    alpha = ImageChops.multiply(mask, mask.filter(ImageFilter.GaussianBlur(feather)))
    patch = out.copy(); patch.putalpha(alpha)
    bbox = alpha.point(lambda v: 255 if v > 3 else 0).getbbox() or (0, 0, cw, ch)
    patch = patch.crop(bbox)

    pid = uuid.uuid4().hex[:12]
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{pid}.png").write_bytes(_png(patch))
    after = full.copy(); after.paste(out, (cx0, cy0), alpha)
    (out_dir / f"{pid}_after.jpg").write_bytes(_jpeg(after, 88))
    (out_dir / f"{pid}_before.jpg").write_bytes(_jpeg(full, 94))
    # a tight crop of the edited item, used as the reference so other viewpoints render the same product
    ref = after.crop((int(x0), int(y0), int(x1), int(y1)))
    (out_dir / f"{pid}_ref.png").write_bytes(_png(ref))
    meta = {"provider": provider, "id": pid, "rect": [(cx0 + bbox[0]) / W, (cy0 + bbox[1]) / H, (cx0 + bbox[2]) / W, (cy0 + bbox[3]) / H],
            "size": [W, H]}
    (out_dir / f"{pid}.json").write_text(json.dumps(meta))
    return meta


def crop_pair(out_dir: Path, rid: str) -> tuple[bytes, bytes]:
    """Before/after crops around an edit (with some context) for the quality check."""
    meta = json.loads((out_dir / f"{rid}.json").read_text())
    before = Image.open(out_dir / f"{rid}_before.jpg").convert("RGB")
    after = Image.open(out_dir / f"{rid}_after.jpg").convert("RGB")
    W, H = before.size
    x0, y0, x1, y1 = meta["rect"]
    pad_x, pad_y = max(0.12, (x1 - x0) * 0.55), max(0.14, (y1 - y0) * 0.75)
    box = (int(max(0, x0 - pad_x) * W), int(max(0, y0 - pad_y) * H), int(min(1, x1 + pad_x) * W), int(min(1, y1 + pad_y) * H))
    def jp(im):
        im = im.crop(box); im.thumbnail((900, 900)); return _jpeg(im, 88)
    return jp(before), jp(after)
