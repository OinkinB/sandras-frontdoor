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
- Match this photo's lighting direction, exposure, white balance, shadows, reflections, grain and lens softness.
- Correct real-world scale for the room; the new item must sit on the real floor/wall with contact shadows.
- Where something is removed, fill with the surrounding floor/wall/tile continuing naturally.
- Do not change anything outside the white mask. No text, labels, outlines or watermarks.
{ref}Return the full edited photo at the same framing."""

REF_NOTE = "- Image 3 shows the SAME installed item from another viewpoint in this home: match its model, color, finish and size exactly.\n"


def _jpeg(img: Image.Image, q=92) -> bytes:
    b = io.BytesIO(); img.convert("RGB").save(b, "JPEG", quality=q); return b.getvalue()


def _png(img: Image.Image) -> bytes:
    b = io.BytesIO(); img.save(b, "PNG", optimize=True); return b.getvalue()


def render(full_jpeg: bytes, rect: list[float], task: str, out_dir: Path, ref_png: bytes | None = None,
           poly: list | None = None) -> dict:
    """rect = [x0, y0, x1, y1] normalized (0-1) in the full view. Returns patch + metadata."""
    full = Image.open(io.BytesIO(full_jpeg)).convert("RGB")
    W, H = full.size
    x0, y0, x1, y1 = rect[0] * W, rect[1] * H, rect[2] * W, rect[3] * H
    sw, sh = max(8, x1 - x0), max(8, y1 - y0)
    # context window: the selection plus generous surroundings so the model sees perspective and light
    pad = max(sw, sh) * 0.6 + 40
    cx0, cy0 = max(0, int(x0 - pad)), max(0, int(y0 - pad))
    cx1, cy1 = min(W, int(x1 + pad)), min(H, int(y1 + pad))
    ctx = full.crop((cx0, cy0, cx1, cy1))
    cw, ch = ctx.size

    grow = 0.08 * max(sw, sh)            # edit slightly beyond the drawn box (new items rarely match it exactly)
    sel = (x0 - cx0 - grow, y0 - cy0 - grow, x1 - cx0 + grow, y1 - cy0 + grow)
    mask = Image.new("L", (cw, ch), 0)
    if poly and len(poly) > 2:          # lasso: mask the drawn shape, grown a little so the new item can fit
        pts = [(x * W - cx0, y * H - cy0) for x, y in poly]
        ImageDraw.Draw(mask).polygon(pts, fill=255)
        mask = mask.filter(ImageFilter.MaxFilter(min(31, max(3, int(grow) * 2 + 1)) | 1))
    else:
        ImageDraw.Draw(mask).rectangle(sel, fill=255)

    raw, provider = ai.edit_image(_jpeg(ctx), mask, PROMPT.format(task=task, ref=REF_NOTE if ref_png else ""), ref_png)
    out = Image.open(io.BytesIO(raw)).convert("RGB")
    out = out.resize((cw, ch), Image.LANCZOS)

    # color-match the generated image to the original using the area outside the mask (should be unchanged)
    outside = ImageChops.invert(mask)
    so, sg = ImageStat.Stat(ctx, outside), ImageStat.Stat(out, outside)
    gains = [max(0.8, min(1.25, (o + 1) / (g + 1))) for o, g in zip(so.mean, sg.mean)]
    out = Image.merge("RGB", [ch_.point(lambda v, k=k: min(255, v * k)) for ch_, k in zip(out.split(), gains)])

    # feathered alpha: full strength inside the selection, soft falloff around it
    feather = max(6, int(0.06 * max(sw, sh)))
    if poly and len(poly) > 2:
        alpha = mask.filter(ImageFilter.MaxFilter(min(21, max(3, feather)) | 1)).filter(ImageFilter.GaussianBlur(feather))
    else:
        alpha = Image.new("L", (cw, ch), 0)
        ImageDraw.Draw(alpha).rectangle((sel[0] - feather / 2, sel[1] - feather / 2, sel[2] + feather / 2, sel[3] + feather / 2), fill=255)
        alpha = alpha.filter(ImageFilter.GaussianBlur(feather))
    patch = out.copy(); patch.putalpha(alpha)
    bbox = alpha.point(lambda v: 255 if v > 3 else 0).getbbox() or (0, 0, cw, ch)
    patch = patch.crop(bbox)

    pid = uuid.uuid4().hex[:12]
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{pid}.png").write_bytes(_png(patch))
    after = full.copy(); after.paste(out, (cx0, cy0), alpha)
    (out_dir / f"{pid}_after.jpg").write_bytes(_jpeg(after, 88))
    (out_dir / f"{pid}_before.jpg").write_bytes(_jpeg(full, 88))
    # a tight crop of the edited item, used as the reference so other viewpoints render the same product
    ref = out.crop((max(0, int(sel[0])), max(0, int(sel[1])), min(cw, int(sel[2])), min(ch, int(sel[3]))))
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
    pad_x, pad_y = (x1 - x0) * 0.15, (y1 - y0) * 0.15
    box = (int(max(0, x0 - pad_x) * W), int(max(0, y0 - pad_y) * H), int(min(1, x1 + pad_x) * W), int(min(1, y1 + pad_y) * H))
    def jp(im):
        im = im.crop(box); im.thumbnail((900, 900)); return _jpeg(im, 88)
    return jp(before), jp(after)
