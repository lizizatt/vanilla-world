"""Blender 2.90+: blender -b -P tools/vehicles/make_dug_racer.py -- [--preview PATH]."""
import argparse
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "browser" / "vehicles"
VARIANTS = (
    ("dug_default", "dug-racer.glb", (0.58, 0.28, 0.055, 1)),
    ("dug_goblin_green", "dug-racer-green.glb", (0.14, 0.38, 0.075, 1)),
    ("dug_crimson", "dug-racer-crimson.glb", (0.48, 0.055, 0.045, 1)),
)
REQUIRED = {"Body", "EngineL", "EngineR", "Cockpit", "ExhaustL", "ExhaustR"}


def material(name, color, metallic=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = color
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = 0.78
    return mat


def empty(name, parent=None, location=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(obj)
    obj.parent = parent
    obj.location = location
    return obj


def mesh(name, verts, faces, mat, parent):
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    obj.parent = parent
    return obj


def cube(name, location, scale, mat, parent, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.rotation_euler = rotation
    obj.data.materials.append(mat)
    obj.parent = parent
    return obj


def rod(name, start, end, radius, mat, parent, sides=8, tip=None):
    direction = Vector(end) - Vector(start)
    bpy.ops.mesh.primitive_cone_add(
        vertices=sides, radius1=radius, radius2=radius if tip is None else tip,
        depth=direction.length, location=(Vector(start) + Vector(end)) / 2,
    )
    obj = bpy.context.object
    obj.name = name
    obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
    obj.data.materials.append(mat)
    obj.parent = parent
    return obj


def shell(name, x, z, profile, mats, parent, sides=16):
    verts = [(x + r * math.cos(i * 2 * math.pi / sides), y,
              z + r * math.sin(i * 2 * math.pi / sides))
             for y, r in profile for i in range(sides)]
    faces = []
    for j in range(len(profile) - 1):
        for i in range(sides):
            a = j * sides + i
            b = j * sides + (i + 1) % sides
            faces.append((a, a + sides, b + sides, b))
    obj = mesh(name, verts, faces, mats[0], parent)
    for mat in mats[1:]:
        obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        # Alternating broad painted facets make lighting readable without textures.
        poly.material_index = (poly.index % sides) % len(mats)
    return obj


def fin(name, x, y, z, mat, parent, height=0.8):
    return mesh(name, [
        (x - 0.06, y, z), (x - 0.06, y - 0.85, z),
        (x - 0.06, y - 0.7, z + height),
        (x + 0.06, y, z), (x + 0.06, y - 0.85, z),
        (x + 0.06, y - 0.7, z + height),
    ], [(0, 2, 1), (3, 4, 5), (0, 1, 4, 3), (1, 2, 5, 4), (2, 0, 3, 5)],
        mat, parent)


def build():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    paint = material("dug_default", VARIANTS[0][2])
    shade = material("Paint shadow", (0.32, 0.12, 0.025, 1))
    light = material("Paint worn edge", (0.76, 0.43, 0.12, 1))
    iron = material("Charcoal iron", (0.085, 0.11, 0.12, 1), 0.35)
    brass = material("Old brass", (0.52, 0.37, 0.13, 1), 0.4)
    dark = material("Soot and rubber", (0.024, 0.029, 0.027, 1))
    leather = material("Worn saddle", (0.20, 0.08, 0.034, 1))
    glow = material("Alchemical jade", (0.20, 0.72, 0.37, 1))
    body = empty("Body")
    # Author in Blender's Z-up coordinates; glTF exports Y-up and forward -Z.
    for side, x in (("L", -1.58), ("R", 1.58)):
        engine = empty("Engine" + side, body)
        engine.scale.y = 0.65
        profile = [
            (-2.25, 0.48), (-2.12, 0.58), (-1.85, 0.58), (-1.7, 0.68),
            (-1.55, 0.70), (-1.42, 0.63), (-1.10, 0.64), (-0.95, 0.70),
            (-0.75, 0.72), (-0.40, 0.76), (0, 0.79), (0.4, 0.81),
            (0.8, 0.78), (1.2, 0.74), (1.65, 0.69), (1.92, 0.77),
            (2.12, 0.86), (2.36, 0.86), (2.55, 0.77),
            (2.55, 0.62), (2.34, 0.60), (2.02, 0.50), (1.85, 0.21),
        ]
        shell("Faceted engine casing", x, 1.02, profile, [paint, shade, light], engine)
        for y, r in ((-1.6, 0.72), (-0.92, 0.74), (1.62, 0.73), (2.34, 0.885)):
            shell("Riveted hoop", x, 1.02,
                  [(y - 0.065, r), (y + 0.065, r)], [brass], engine)
            for i in range(12):
                angle = i * math.tau / 12
                start = (x + r * math.cos(angle), y, 1.02 + r * math.sin(angle))
                end = (x + (r + 0.05) * math.cos(angle), y,
                       1.02 + (r + 0.05) * math.sin(angle))
                rod("Square rivet", start, end, 0.041, iron, engine, 4)
        shell("Hollow exhaust", x, 1.02,
              [(-2.08, 0.36), (-2.40, 0.41), (-2.40, 0.54),
               (-1.85, 0.48)], [iron, dark], engine)
        rod("Exhaust recess", (x, -2.06, 1.02), (x, -2.07, 1.02),
            0.36, dark, engine, 16)
        empty("Exhaust" + side, engine, (x, -2.41, 1.02))
        rod("Intake hub", (x, 1.9, 1.02), (x, 2.61, 1.02), 0.22,
            brass, engine, 12, 0.055)
        for i in range(8):
            angle = i * math.tau / 8
            verts = []
            for y in (2.10, 2.15):
                for r, a in ((0.20, angle), (0.58, angle + 0.13),
                             (0.58, angle + 0.42), (0.20, angle + 0.23)):
                    verts.append((x + r * math.cos(a), y, 1.02 + r * math.sin(a)))
            mesh("Intake paddle", verts,
                 [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1),
                  (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)], iron, engine)
        fin("Engine dorsal fin", x, -0.75, 1.70, paint, engine)
        for offset in (-0.26, 0, 0.26):
            rod("Top cooling pipe", (x + offset, -1.2, 1.75),
                (x + offset, 0.85, 1.84), 0.045, brass, engine)
        cube("Landing skid", (x, -0.05, 0.08), (0.26, 3.3, 0.16), iron, engine)
        for y in (-1.05, 1.1):
            rod("Skid leg", (x, y, 0.16), (x, y, 0.47), 0.10, iron, engine)
        rod("VArm" + side, (0, 3.55, 1.55), (x * 1.2, 1.65, 1.25),
            0.13, brass, body)
        points = [(x * 0.22, 3.8, 1.75), (x * 0.40, 3.0, 0.90),
                  (x * 0.70, 2.2, 0.62), (x, 1.25, 0.95)]
        for a, b in zip(points, points[1:]):
            rod("Suspended control cable", a, b, 0.037, dark, body)

    rod("Rear cross brace", (-1.58, -1.05, 0.95), (1.58, -1.05, 0.95),
        0.12, iron, body)
    cockpit = empty("Cockpit", body, (0, 5.6, 0.45))
    cockpit.scale.y = 0.7
    shell("Cockpit belly", 0, 0.95,
          [(-3.0, 0.12), (-2.7, 0.38), (-2.1, 0.48), (-1.4, 0.43),
           (-0.75, 0.31), (-0.45, 0.06)], [paint, shade, light], cockpit, 8)
    cube("Seat cushion", (0, -1.99, 1.35), (0.60, 0.70, 0.18), leather, cockpit)
    cube("Tall seat back", (0, -2.42, 1.75), (0.63, 0.16, 0.95),
         leather, cockpit, (0.12, 0, 0))
    for x in (-0.43, 0.43):
        cube("Cockpit side armor", (x, -1.90, 1.43), (0.13, 1.5, 0.48),
             paint, cockpit)
        rod("Cockpit rim", (x, -2.65, 1.69), (x, -1.15, 1.69),
            0.055, brass, cockpit)
        rod("Roll cage upright", (x, -2.48, 1.46), (x, -2.58, 2.35),
            0.065, iron, cockpit)
        rod("Steering lever", (x * 0.53, -1.51, 1.36),
            (x * 0.53, -1.29, 1.83), 0.05, iron, cockpit)
        cube("Leather handgrip", (x * 0.53, -1.29, 1.83),
             (0.11, 0.19, 0.10), leather, cockpit)
    rod("Roll cage crown", (-0.43, -2.58, 2.35), (0.43, -2.58, 2.35),
        0.065, brass, cockpit)
    cube("Instrument cowl", (0, -1.04, 1.56), (0.74, 0.3, 0.32), iron, cockpit)
    for x in (-0.2, 0.05, 0.23):
        rod("Jade gauge", (x, -1.20, 1.63), (x, -1.23, 1.63),
            0.077 if x < 0 else 0.05, glow, cockpit, 8)
    fin("Tail rudder", 0, -2.24, 1.73, paint, cockpit, 0.93)
    rod("Pennant pole", (0.42, -2.6, 1.7), (0.42, -2.6, 2.95),
        0.024, brass, cockpit)
    mesh("Split pennant", [(0.42, -2.6, 2.95), (0.45, -3.05, 2.86),
                          (0.44, -2.94, 2.69), (0.46, -3.15, 2.49),
                          (0.42, -2.6, 2.59)],
         [(0, 1, 2), (0, 2, 4), (2, 3, 4)], paint, cockpit)
    paint.use_backface_culling = False
    for x in (-0.53, 0.53):
        rod("Gear medallion", (x, -2.08, 1.47), (x * 1.05, -2.08, 1.47),
            0.21, brass, cockpit, 12)
        for i in range(10):
            angle = math.tau * i / 10
            cube("Gear tooth", (x, -2.08 + 0.22 * math.cos(angle),
                               1.47 + 0.22 * math.sin(angle)),
                 (0.075, 0.095, 0.095), brass, cockpit, (angle, 0, 0))
    return paint, shade, light


def triangles():
    return sum(len(p.vertices) - 2 for obj in bpy.context.scene.objects
               if obj.type == "MESH" for p in obj.data.polygons)


def verify(path, expected):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(path))
    assert REQUIRED <= set(bpy.data.objects.keys()), "Missing attachment nodes"
    count = triangles()
    assert 3000 <= count <= 6000 and count == expected, (path, count, expected)
    for name in ("ExhaustL", "ExhaustR"):
        assert bpy.data.objects[name].type == "EMPTY"
    coords = [obj.matrix_world @ Vector(corner) for obj in bpy.context.scene.objects
              if obj.type == "MESH" for corner in obj.bound_box]
    bounds = [max(v[i] for v in coords) - min(v[i] for v in coords) for i in range(3)]
    assert 4.7 < bounds[0] < 5.3 and 6 < bounds[1] < 7, bounds
    assert abs(min(v.z for v in coords)) < 0.001
    def group_bounds(name):
        return [obj.matrix_world @ Vector(corner)
                for obj in bpy.data.objects[name].children if obj.type == "MESH"
                for corner in obj.bound_box]

    pod = group_bounds("Cockpit")
    left, right = group_bounds("EngineL"), group_bounds("EngineR")
    engine_front = max(v.y for v in left + right)
    pod_rear, pod_front = min(v.y for v in pod), max(v.y for v in pod)
    gap = pod_rear - engine_front
    offset = (pod_rear + pod_front) / 2 - engine_front
    inner_gap = min(v.x for v in right) - max(v.x for v in left)
    assert gap > 1.5 and 2.5 <= offset <= 3.5, (gap, offset)
    assert inner_gap >= max(v.x for v in pod) - min(v.x for v in pod)
    for side in ("L", "R"):
        arm = bpy.data.objects["VArm" + side]
        ends = [arm.matrix_world @ Vector((0, 0, z))
                for z in (min(v.co.z for v in arm.data.vertices),
                          max(v.co.z for v in arm.data.vertices))]
        delta = ends[1] - ends[0]
        angle = math.degrees(math.atan2(abs(delta.x), abs(delta.y)))
        assert 40 <= angle <= 60, angle
    print("Silhouette: gap {:.2f} m; center lead {:.2f} m; V half-angle {:.1f} deg"
          .format(gap, offset, angle))
    print("VERIFIED {}: {} triangles".format(path.name, count))


def preview(path):
    scene = bpy.context.scene
    floor = material("Preview floor", (0.085, 0.105, 0.115, 1))
    cube("Preview floor", (0, 0, -0.12), (200, 200, 0.20), floor, None)
    world = bpy.data.worlds.new("Studio") if scene.world is None else scene.world
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.24, 0.29, 0.35, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
    for location, power, size in (((-4, 4, 8), 1400, 6), ((4, -4, 6), 1100, 5)):
        bpy.ops.object.light_add(type="AREA", location=location)
        lamp = bpy.context.object
        lamp.data.energy = power
        lamp.data.size = size
        lamp.rotation_euler = (Vector((0, 0, 1)) - lamp.location).to_track_quat("-Z", "Y").to_euler()
    bpy.ops.object.camera_add(location=(8, 12, 9))
    camera = bpy.context.object
    camera.rotation_euler = (Vector((0, 1.8, 1.3)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 9.3
    scene.camera = camera
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.use_gtao = True
    scene.eevee.gtao_distance = 3
    scene.eevee.use_soft_shadows = True
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 1000
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "Medium High Contrast"
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    camera.location = (0, 1.8, 14)
    camera.rotation_euler = (0, 0, 0)
    scene.render.filepath = str(path.with_name(path.stem + "-above" + path.suffix))
    bpy.ops.render.render(write_still=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    OUT.mkdir(parents=True, exist_ok=True)
    paint, shade, light = build()
    count = triangles()
    assert 3000 <= count <= 6000, count
    for name, filename, color in VARIANTS:
        for mat, factor in ((paint, 1), (shade, 0.62), (light, 1.3)):
            rgba = tuple(min(channel * factor, 1) for channel in color[:3]) + (1,)
            mat.diffuse_color = rgba
            mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = rgba
        paint.name = name
        bpy.ops.export_scene.gltf(filepath=str(OUT / filename), export_format="GLB",
                                  export_yup=True, export_cameras=False, export_lights=False)
    for _, filename, _ in reversed(VARIANTS):
        verify(OUT / filename, count)
    if args.preview:
        preview(args.preview)


if __name__ == "__main__":
    main()
