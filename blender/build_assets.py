"""Procedurally build realistic accessibility fixtures, export GLB, render previews.

Run:  blender --background --python blender/build_assets.py -- [asset ...]
Units are meters, real-world sizes. Origin = floor contact point (or wall
mount point for wall fixtures) so the web app can drop them on a clicked spot.
"""
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "app" / "static" / "models"
RENDERS = HERE / "renders"
OUT.mkdir(parents=True, exist_ok=True)
RENDERS.mkdir(parents=True, exist_ok=True)
IN = 0.0254


# ---------------- scene helpers ----------------
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mat(name, color, metal=0.0, rough=0.5, alpha=1.0, transmission=0.0, ior=1.45):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Metallic"].default_value = metal
    b.inputs["Roughness"].default_value = rough
    for key in ("Transmission Weight", "Transmission"):
        if key in b.inputs:
            b.inputs[key].default_value = transmission
            break
    b.inputs["IOR"].default_value = ior
    if alpha < 1:
        b.inputs["Alpha"].default_value = alpha
        try:
            m.surface_render_method = "BLENDED"
        except AttributeError:
            m.blend_method = "BLEND"
    return m


STEEL = lambda: mat("Brushed steel", (0.85, 0.85, 0.87), metal=0.55, rough=0.3)
ALU = lambda: mat("Aluminum", (0.86, 0.87, 0.89), metal=0.5, rough=0.4)
WHITE_PLASTIC = lambda: mat("White plastic", (0.92, 0.92, 0.9), rough=0.42)
GRAY_RUBBER = lambda: mat("Gray rubber", (0.12, 0.12, 0.13), rough=0.85)
PORCELAIN = lambda: mat("Porcelain", (0.95, 0.95, 0.94), rough=0.08)
GLASS = lambda: mat("Glass", (0.9, 0.97, 0.97), rough=0.02, alpha=0.18, transmission=1.0)
TILE = lambda: mat("Floor tile", (0.62, 0.6, 0.57), rough=0.55)
TEAK = lambda: mat("Teak", (0.42, 0.26, 0.14), rough=0.6)
TRIM = lambda: mat("Painted trim", (0.93, 0.93, 0.91), rough=0.35)
DOOR = lambda: mat("Door slab", (0.9, 0.9, 0.88), rough=0.4)
FABRIC = lambda: mat("Seat fabric", (0.2, 0.22, 0.25), rough=0.9)
GRIP = lambda: mat("Anti-slip grip", (0.2, 0.2, 0.21), rough=0.95)


def obj_from_bm(name, bm, material):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    o.data.materials.append(material)
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def box(name, size, loc, material, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        mod = o.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 3
    o.data.materials.append(material)
    return o


def cyl(name, r, depth, loc, material, rot=(0, 0, 0), verts=32):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, location=loc, rotation=rot, vertices=verts)
    o = bpy.context.object
    o.name = name
    o.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    return o


def tube(name, points, r, material, segs=24):
    """Round tube along a polyline, built as a curve with bevel then converted to mesh."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = r
    cu.bevel_resolution = 6
    sp = cu.splines.new("POLY")
    sp.points.add(len(points) - 1)
    for i, p in enumerate(points):
        sp.points[i].co = (*p, 1)
    o = bpy.data.objects.new(name, cu)
    bpy.context.collection.objects.link(o)
    o.data.materials.append(material)
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.convert(target="MESH")
    bpy.ops.object.shade_smooth()
    return bpy.context.object


def rounded_path(pts, radius, steps=8):
    """Fillet the corners of a polyline (for bent grab bars / handrails)."""
    out = [Vector(pts[0])]
    for i in range(1, len(pts) - 1):
        a, b, c = Vector(pts[i - 1]), Vector(pts[i]), Vector(pts[i + 1])
        d1, d2 = (a - b).normalized(), (c - b).normalized()
        p1, p2 = b + d1 * radius, b + d2 * radius
        for s in range(steps + 1):
            t = s / steps
            out.append((1 - t) ** 2 * p1 + 2 * (1 - t) * t * b + t ** 2 * p2)
    out.append(Vector(pts[-1]))
    return [tuple(v) for v in out]


def flange(name, loc, material, axis="Y"):
    rot = {"Y": (math.pi / 2, 0, 0), "X": (0, math.pi / 2, 0), "Z": (0, 0, 0)}[axis]
    return cyl(name, 1.6 * IN, 0.35 * IN, loc, material, rot=rot)


def finish(name, objs, preview_cam):
    for o in bpy.context.scene.objects:
        o.select_set(o in objs)
    bpy.context.view_layer.objects.active = objs[0]
    for o in objs:
        for m in list(o.modifiers):
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    root = bpy.context.object
    root.name = name
    bpy.ops.export_scene.gltf(filepath=str(OUT / f"{name}.glb"), export_format="GLB", use_selection=True,
                              export_apply=True, export_yup=True)
    render(name, root, preview_cam)


def render(name, root, cam_dir):
    sc = bpy.context.scene
    for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
        try:
            sc.render.engine = eng
            break
        except TypeError:
            continue
    sc.render.resolution_x, sc.render.resolution_y = 640, 640
    sc.render.film_transparent = False
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.86, 0.87, 0.89, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.9
    sc.world = world
    # floor + back wall for context
    box("_floor", (6, 6, 0.01), (0, 0, -0.005), mat("_floor", (0.7, 0.68, 0.65), rough=0.7))
    box("_wall", (6, 0.01, 4), (0, 1.2 if cam_dir[1] < 0 else -1.2, 2), mat("_wall", (0.93, 0.92, 0.9), rough=0.9))
    bb = [root.matrix_world @ Vector(c) for c in root.bound_box]
    ctr = sum(bb, Vector()) / 8
    size = max((max(v[i] for v in bb) - min(v[i] for v in bb)) for i in range(3))
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("cam", cam_data)
    sc.collection.objects.link(cam)
    d = Vector(cam_dir).normalized()
    cam.location = ctr + d * size * 2.6
    cam.rotation_euler = (ctr - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam
    for i, (loc, e) in enumerate((((3, -3, 5), 900), ((-4, -2, 3), 350))):
        L = bpy.data.lights.new(f"l{i}", "AREA")
        L.energy, L.size = e, 3
        lo = bpy.data.objects.new(f"l{i}", L)
        sc.collection.objects.link(lo)
        lo.location = loc
        lo.rotation_euler = (ctr - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = str(RENDERS / f"{name}.png")
    bpy.ops.render.render(write_still=True)


# ---------------- assets ----------------
def grab_bar(length_in=24):
    """Stainless 1.25 in grab bar, 1.5 in off the wall. Origin = wall plane, bar center. Wall is +Y side."""
    L, r, off = length_in * IN, 0.625 * IN, 1.5 * IN + 0.625 * IN
    pts = rounded_path([(-L / 2, 0, 0), (-L / 2, -off, 0), (L / 2, -off, 0), (L / 2, 0, 0)], 0.9 * IN)
    bar = tube("bar", pts, r, STEEL())
    f1 = flange("f1", (-L / 2, -0.17 * IN, 0), STEEL())
    f2 = flange("f2", (L / 2, -0.17 * IN, 0), STEEL())
    finish("grab_bar", [bar, f1, f2], (0.3, -1, 0.35))


def shower_chair():
    """Bath/shower chair: white perforated-look seat, backrest, aluminum legs with rubber tips."""
    objs = [box("seat", (0.5, 0.42, 0.04), (0, 0, 0.48), WHITE_PLASTIC(), bevel=0.012),
            box("back", (0.48, 0.035, 0.3), (0, 0.2, 0.72), WHITE_PLASTIC(), bevel=0.012)]
    for i in range(-3, 4):  # drain slots
        objs.append(box(f"slot{i}", (0.012, 0.3, 0.006), (i * 0.06, -0.02, 0.501), GRAY_RUBBER()))
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = sx * 0.21, sy * 0.17
            objs.append(cyl(f"leg{sx}{sy}", 0.013, 0.46, (x * 1.05, y * 1.05, 0.24), ALU(), rot=(sy * 0.05, -sx * 0.05, 0)))
            objs.append(cyl(f"tip{sx}{sy}", 0.018, 0.035, (x * 1.1, y * 1.1, 0.017), GRAY_RUBBER()))
        objs.append(tube(f"arm{sx}", rounded_path([(sx * 0.24, 0.18, 0.5), (sx * 0.24, 0.18, 0.7), (sx * 0.24, -0.12, 0.7), (sx * 0.24, -0.12, 0.5)], 0.04), 0.014, ALU()))
    objs.append(tube("brace", [(-0.22, -0.17, 0.2), (0.22, -0.17, 0.2)], 0.009, ALU()))
    objs.append(tube("brace2", [(-0.22, 0.17, 0.2), (0.22, 0.17, 0.2)], 0.009, ALU()))
    finish("shower_chair", objs, (0.8, -1, 0.55))


def ramp(rise_in=6, width_in=36):
    """Aluminum modular entry ramp at 1:12 slope with top landing and handrails. Origin = bottom center of ramp run."""
    rise, W = rise_in * IN, width_in * IN
    run = rise * 12
    bm = bmesh.new()
    t = 0.04
    v = [bm.verts.new(p) for p in [(-W / 2, 0, 0), (W / 2, 0, 0), (W / 2, run, rise), (-W / 2, run, rise),
                                   (-W / 2, 0, -0.0), (W / 2, 0, -0.0), (W / 2, run, rise - t), (-W / 2, run, rise - t)]]
    bm.faces.new((v[0], v[1], v[2], v[3]))
    bm.faces.new((v[7], v[6], v[5], v[4]))
    bm.faces.new((v[0], v[3], v[7], v[4]))
    bm.faces.new((v[1], v[5], v[6], v[2]))
    deck = obj_from_bm("deck", bm, ALU())
    objs = [deck,
            box("landing", (W, 1.524, 0.05), (0, run + 0.762, rise - 0.025), ALU()),
            box("grip", (W - 0.06, run * 1.003, 0.004), (0, run / 2, rise / 2 + 0.003), GRIP())]
    objs[-1].rotation_euler = (math.atan2(rise, run), 0, 0)
    for sx in (-1, 1):
        x = sx * (W / 2 + 0.03)
        objs.append(box(f"curb{sx}", (0.05, run, 0.06), (sx * (W / 2 - 0.025), run / 2, rise / 2 + 0.03), ALU()))
        objs[-1].rotation_euler = (math.atan2(rise, run), 0, 0)
        h = 0.86
        rail = [(x, -0.3, h), (x, 0, h), (x, run, rise + h), (x, run + 1.5, rise + h)]
        objs.append(tube(f"rail{sx}", rounded_path(rail, 0.1), 0.019, ALU()))
        for k in range(0, 5):
            y = k * (run + 1.4) / 4
            z = min(y, run) / run * rise
            objs.append(cyl(f"post{sx}{k}", 0.022, h, (x, y, z + h / 2), ALU()))
    finish("ramp", objs, (1.2, -1, 0.7))


def walk_in_shower():
    """60x36 in curbless shower: sloped tile pan, linear drain, fixed glass panel,
    fold-down teak seat, grab bar, hand shower on slide bar, back + side tile walls.
    Origin = floor, front-center of the shower opening; walls at +Y."""
    W, D, H = 60 * IN, 36 * IN, 80 * IN
    objs = [box("pan", (W, D, 0.012), (0, D / 2, 0.006), TILE()),
            box("drain", (W - 0.15, 0.06, 0.004), (0, D - 0.08, 0.0135), STEEL()),
            box("wall_back", (W, 0.02, H), (0, D + 0.01, H / 2), mat("Wall tile", (0.86, 0.85, 0.82), rough=0.25)),
            box("wall_side", (0.02, D, H), (-W / 2 - 0.01, D / 2, H / 2), mat("Wall tile", (0.86, 0.85, 0.82), rough=0.25)),
            box("glass", (0.01, D * 0.62, H * 0.92), (W / 2 - 0.01, D * 0.69, H * 0.46 + 0.01), GLASS()),
            box("glass_clip", (0.02, 0.03, H * 0.92), (W / 2 - 0.01, D + 0.0, H * 0.46 + 0.01), STEEL())]
    # fold-down teak seat with steel brackets
    for i in range(5):
        objs.append(box(f"slat{i}", (0.07, 0.38, 0.025), (-W / 2 + 0.06 + i * 0.085, D - 0.22, 0.47), TEAK(), bevel=0.004))
    objs.append(box("seat_bracket", (0.42, 0.03, 0.05), (-W / 2 + 0.23, D - 0.02, 0.45), STEEL()))
    # horizontal grab bar on back wall
    gb_y = D - 1.5 * IN - 0.625 * IN
    objs.append(tube("gb", rounded_path([(0.0, D, 0.9), (0.0, gb_y, 0.9), (0.6, gb_y, 0.9), (0.6, D, 0.9)], 0.02), 0.016, STEEL()))
    # slide bar + hand shower + valve
    objs.append(cyl("slidebar", 0.012, 0.75, (0.35, D - 0.04, 1.35), STEEL()))
    objs.append(cyl("handshower", 0.03, 0.04, (0.35, D - 0.06, 1.55), STEEL(), rot=(math.pi / 2.5, 0, 0)))
    objs.append(tube("hose", [(0.35, D - 0.05, 1.5), (0.33, D - 0.09, 1.2), (0.3, D - 0.06, 1.0)], 0.007, STEEL()))
    objs.append(cyl("valve", 0.05, 0.02, (0.0, D - 0.01, 1.05), STEEL(), rot=(math.pi / 2, 0, 0)))
    objs.append(box("lever", (0.1, 0.02, 0.015), (0.04, D - 0.03, 1.05), STEEL()))
    finish("walk_in_shower", objs, (0.45, -1, 0.5))


def stairlift():
    """Straight stairlift: rail at 35 deg with a folding padded seat, armrests and footrest. Origin = bottom of rail."""
    ang = math.radians(35)
    Lr = 3.2
    z0 = 0.14
    p0 = Vector((0, 0, z0))
    p1 = Vector((0, Lr * math.cos(ang), z0 + Lr * math.sin(ang)))
    objs = [tube("rail", [tuple(p0), tuple(p1)], 0.045, ALU())]
    for k in range(3):  # floor/step stands
        p = p0.lerp(p1, 0.08 + k * 0.42)
        objs.append(cyl(f"stand{k}", 0.02, p.z, (0, p.y, p.z / 2), ALU()))
    yc = 0.35  # carriage parked at the bottom of the rail
    cz = z0 + yc * math.tan(ang)
    objs += [
        box("carriage", (0.16, 0.34, 0.3), (-0.1, yc, cz + 0.05), WHITE_PLASTIC(), bevel=0.03),
        box("column", (0.08, 0.1, 0.32), (-0.18, yc, 0.38), WHITE_PLASTIC(), bevel=0.02),
        box("seat", (0.44, 0.44, 0.08), (-0.42, yc, 0.56), FABRIC(), bevel=0.03),
        box("back", (0.08, 0.44, 0.52), (-0.2, yc, 0.86), FABRIC(), bevel=0.03),
        box("foot", (0.34, 0.36, 0.03), (-0.44, yc, 0.09), WHITE_PLASTIC(), bevel=0.01),
        box("footarm", (0.06, 0.08, 0.42), (-0.2, yc, 0.3), WHITE_PLASTIC(), bevel=0.01),
    ]
    for sy in (-1, 1):
        objs.append(box(f"arm{sy}", (0.36, 0.06, 0.05), (-0.38, yc + sy * 0.25, 0.78), WHITE_PLASTIC(), bevel=0.02))
        objs.append(box(f"armpost{sy}", (0.05, 0.05, 0.2), (-0.22, yc + sy * 0.25, 0.68), WHITE_PLASTIC()))
    finish("stairlift", objs, (-1, -0.8, 0.45))


def door_frame():
    """36 in clear-width door opening: frame, casing, slab swung open 90 deg, lever handle. Origin = floor, center of opening; wall along X."""
    W, H, wall = 38 * IN, 80 * IN, 4.5 * IN
    c = 2.75 * IN
    objs = []
    for sx in (-1, 1):
        objs.append(box(f"jamb{sx}", (0.02, wall, H), (sx * (W / 2 + 0.01), 0, H / 2), TRIM()))
        objs.append(box(f"casing{sx}", (c, 0.015, H + c), (sx * (W / 2 + c / 2), -wall / 2 - 0.007, (H + c) / 2), TRIM()))
        objs.append(box(f"casingb{sx}", (c, 0.015, H + c), (sx * (W / 2 + c / 2), wall / 2 + 0.007, (H + c) / 2), TRIM()))
    objs.append(box("head", (W + 0.04, wall, 0.02), (0, 0, H + 0.01), TRIM()))
    objs.append(box("headcasing", (W + 2 * c, 0.015, c), (0, -wall / 2 - 0.007, H + c / 2), TRIM()))
    # slab open 90 deg, hinged at -X jamb
    slab = box("slab", (36 * IN, 1.75 * IN, H - 0.01), (-W / 2 + 0.03, -36 * IN / 2 - 0.02, H / 2), DOOR(), bevel=0.003)
    slab.rotation_euler = (0, 0, math.pi / 2)
    objs.append(slab)
    lx, ly = -W / 2 + 0.07, -36 * IN + 0.08
    objs.append(cyl("rose", 0.03, 0.012, (lx, ly, 0.92), STEEL(), rot=(0, math.pi / 2, 0)))
    objs.append(box("lever", (0.02, 0.12, 0.018), (lx + 0.02, ly + 0.05, 0.92), STEEL(), bevel=0.006))
    finish("door_frame", objs, (0.7, -1, 0.35))


def raised_toilet():
    """Comfort-height (18.5 in) elongated toilet with tank. Origin = floor under bowl, tank toward +Y."""
    objs = []
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=48, radius1=0.13, radius2=0.2, depth=0.4)
    for v in bm.verts:
        v.co.y *= 1.35
        v.co.z += 0.2
    objs.append(obj_from_bm("bowl", bm, PORCELAIN()))
    objs.append(cyl("seat", 0.205, 0.03, (0, 0, 0.455), WHITE_PLASTIC(), verts=48))
    objs[-1].scale = (1, 1.38, 1)
    objs.append(box("tank", (0.45, 0.2, 0.38), (0, 0.33, 0.62), PORCELAIN(), bevel=0.02))
    objs.append(box("lid", (0.47, 0.22, 0.03), (0, 0.33, 0.825), PORCELAIN(), bevel=0.01))
    objs.append(box("flush", (0.06, 0.012, 0.015), (-0.16, 0.225, 0.76), STEEL()))
    finish("raised_toilet", objs, (0.8, -1, 0.5))


def lever_handle():
    objs = [cyl("rose", 0.032, 0.012, (0, 0, 0), STEEL(), rot=(math.pi / 2, 0, 0)),
            cyl("neck", 0.01, 0.04, (0, -0.02, 0), STEEL(), rot=(math.pi / 2, 0, 0)),
            box("lever", (0.13, 0.018, 0.016), (0.055, -0.04, 0), STEEL(), bevel=0.006)]
    finish("lever_handle", objs, (0.4, -1, 0.3))


ASSETS = {f.__name__: f for f in (grab_bar, shower_chair, ramp, walk_in_shower, stairlift, door_frame, raised_toilet, lever_handle)}

if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    for name in argv or ASSETS:
        reset()
        print(f"[build] {name}")
        ASSETS[name]()
    print("[build] done")
