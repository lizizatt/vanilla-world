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
    ("dug_default", "dug-racer.glb", (0.72, 0.035, 0.018, 1)),
    ("dug_goblin_green", "dug-racer-green.glb", (0.14, 0.38, 0.075, 1)),
    ("dug_crimson", "dug-racer-crimson.glb", (0.48, 0.055, 0.045, 1)),
)
REQUIRED = {"Body", "EngineL", "EngineR", "Cockpit", "ExhaustL", "ExhaustR"}


def material(name, color, metallic=0, pattern="paint"):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = color
    shader.inputs["Metallic"].default_value = 0
    shader.inputs["Roughness"].default_value = 1
    shader.inputs["Specular"].default_value = 0
    image = bpy.data.images.new(name + " painted 128", width=128, height=128)
    pixels = []
    for y in range(128):
        for x in range(128):
            u, v = x / 128, y / 128
            grain = 0.025 * math.sin(x * 12.31 + y * 7.17)
            if pattern == "rope":
                ridge = (0.5 + 0.5 * math.cos(math.tau * (u * 12 - v * 3))) ** 0.6
                value = 0.36 + 0.60 * ridge + grain
            elif pattern == "wood":
                seam = abs(math.sin(math.tau * u * 4))
                value = 0.38 + 0.35 * min(1, seam * 7) + 0.12 * math.sin(u * 95 + math.sin(v * 15)) + grain
            else:
                value = (0.70 + 0.12 * math.sin(u * math.tau)
                         + 0.07 * math.sin(u * 29 + math.sin(v * 13))
                         + 0.04 * math.cos(v * 37 + u * 8) + grain)
            pixels.extend((value * color[0], value * color[1], value * color[2], 1))
    image.pixels = pixels
    image.pack()
    texture = mat.node_tree.nodes.new("ShaderNodeTexImage")
    texture.image = image
    texture.interpolation = "Linear"
    mat.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
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
    if mat.name == "Twisted hemp":
        uv = obj.data.uv_layers.active or obj.data.uv_layers.new()
        for loop in obj.data.loops:
            co = obj.data.vertices[loop.vertex_index].co
            uv.data[loop.index].uv = (math.atan2(co.y, co.x) / math.tau,
                                      co.z / 0.35)
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
    uv = obj.data.uv_layers.new()
    for poly in obj.data.polygons:
        j, i = divmod(poly.index, sides)
        for loop, coord in zip(poly.loop_indices,
                               ((i / sides, j / (len(profile) - 1)),
                                (i / sides, (j + 1) / (len(profile) - 1)),
                                ((i + 1) / sides, (j + 1) / (len(profile) - 1)),
                                ((i + 1) / sides, j / (len(profile) - 1)))):
            uv.data[loop].uv = coord
    for mat in mats[1:]:
        obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.material_index = 0
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
    rope = material("Twisted hemp", (0.60, 0.40, 0.18, 1), pattern="rope")
    wood = material("Painted oak planks", (0.36, 0.18, 0.065, 1), pattern="wood")
    ivory = material("Chalk grin", (0.92, 0.86, 0.65, 1))
    glow = material("Alchemical jade", (0.20, 0.72, 0.37, 1))
    glow.node_tree.nodes["Principled BSDF"].inputs["Emission"].default_value = (0.04, 0.28, 0.10, 1)
    body = empty("Body")
    # Author in Blender's Z-up coordinates; glTF exports Y-up and forward -Z.
    for side, x in (("L", -1.58), ("R", 1.58)):
        engine = empty("Engine" + side, body)
        profile = [
            (-2.25, 0.40), (-2.12, 0.43), (-1.85, 0.44), (-1.7, 0.45),
            (-1.55, 0.46), (-1.42, 0.47), (-1.10, 0.50), (-0.95, 0.51),
            (-0.75, 0.53), (-0.40, 0.55), (0, 0.58), (0.4, 0.62),
            (0.8, 0.65), (1.2, 0.69), (1.65, 0.72), (1.92, 0.77),
            (2.12, 0.79), (2.36, 0.79), (2.55, 0.77),
            (2.55, 0.62), (2.34, 0.60), (2.02, 0.50), (1.85, 0.21),
        ]
        shell("Faceted engine casing", x, 1.02, profile, [paint, shade, light], engine)
        for y, r in ((-1.6, 0.48), (-0.92, 0.54), (1.62, 0.75), (2.34, 0.81)):
            shell("Riveted hoop", x, 1.02,
                  [(y - 0.16, r), (y - 0.12, r + 0.05),
                   (y + 0.12, r + 0.05), (y + 0.16, r)],
                  [iron if y < -1 else rope], engine)
            for i in range(12):
                angle = i * math.tau / 12
                start = (x + r * math.cos(angle), y, 1.02 + r * math.sin(angle))
                end = (x + (r + 0.05) * math.cos(angle), y,
                       1.02 + (r + 0.05) * math.sin(angle))
                if y < -1:
                    rod("Square rivet", start, end, 0.055, iron, engine, 4)
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
        fin("Engine dorsal fin", x, -0.75, 1.42, paint, engine, 0.45)
        sign = -1 if x < 0 else 1

        def cowl_point(u, height, depth=0):
            return (x + sign * u, 2.90 - 0.22 * u - depth, 1.45 + height)

        outline = [(-0.96, -0.22), (0.95, 0.78), (1.12, 0.23), (-0.77, -0.78)]
        verts = [cowl_point(u, h, d) for d in (0, 0.65) for u, h in outline]
        faces = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1),
                 (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
        if sign < 0:
            faces = [tuple(reversed(face)) for face in faces]
        mesh("Angular brow armor", verts, faces, paint, engine)
        vent = [(-0.73, -0.27), (0.85, 0.55), (0.91, 0.29), (-0.66, -0.54)]
        face = (0, 1, 2, 3) if sign > 0 else (3, 2, 1, 0)
        mesh("Dark slanted intake", [cowl_point(u, h, -0.015) for u, h in vent],
             [face], dark, engine)
        # An original crooked chalk grin, not a copied faction or character insignia.
        for i in range(7):
            u = -0.62 + i * 0.21
            h = 0.52 * u - 0.30
            tooth = [(u, h), (u + 0.16, h + 0.08),
                     (u + 0.10, h - 0.10 - 0.035 * (i % 2))]
            mesh("Painted crooked tooth", [cowl_point(a, b, -0.021) for a, b in tooth],
                 [(0, 1, 2) if sign > 0 else (2, 1, 0)], ivory, engine)
        for i in range(10):
            u = -0.65 + i * 0.16
            rod("Vent louvre", cowl_point(u, 0.52 * u - 0.19, -0.04),
                cowl_point(u, 0.52 * u + 0.04, -0.04), 0.025, iron, engine, 4)
        rod("Worn brow edge", cowl_point(-0.96, -0.22, -0.025),
            cowl_point(0.95, 0.78, -0.025), 0.055, brass, engine)
        for i in range(8):
            a = i * math.tau / 8
            rod("Exhaust cooling fin",
                (x + 0.51 * math.cos(a), -2.32, 1.02 + 0.51 * math.sin(a)),
                (x + 0.49 * math.cos(a), -1.65, 1.02 + 0.49 * math.sin(a)),
                0.055, iron, engine, 4)
        for offset in (-0.26, 0, 0.26):
            rod("Top cooling pipe", (x + offset, -1.2, 1.48),
                (x + offset, 0.85, 1.65), 0.045, brass, engine)
        cube("Landing skid", (x, -0.05, 0.08), (0.26, 3.3, 0.16), iron, engine)
        for y in (-1.05, 1.1):
            rod("Skid leg", (x, y, 0.16), (x, y, 0.47), 0.10, iron, engine)
        rod("TowLine" + side, (sign * 0.26, -6.55, 1.18), (sign * 0.85, -1.05, 0.95),
            0.075, rope, body)
        points = [(sign * 0.26, -6.55, 1.18), (sign * 0.45, -4.8, 0.70),
                  (sign * 0.65, -2.8, 0.62), (sign * 0.85, -1.05, 0.95)]
        for a, b in zip(points, points[1:]):
            rod("Suspended control cable", a, b, 0.075, rope, body)

    rod("Rear cross brace", (-1.58, -1.05, 0.95), (1.58, -1.05, 0.95),
        0.12, wood, body)
    arc = [(-0.83, 2.82, 1.10), (-0.60, 2.85, 1.19), (-0.30, 2.82, 1.02),
           (0, 2.88, 1.15), (0.26, 2.82, 0.98), (0.56, 2.85, 1.16),
           (0.83, 2.82, 1.10)]
    for start, end in zip(arc, arc[1:]):
        rod("Jade energy arc", start, end, 0.028, glow, body, 6)
    cockpit = empty("Cockpit", body, (0, -6.1, 0.25))
    cockpit.scale = (0.7, 0.45, 0.7)
    shell("Cockpit belly", 0, 0.95,
          [(-3.0, 0.12), (-2.7, 0.38), (-2.1, 0.48), (-1.4, 0.43),
           (-0.75, 0.31), (-0.45, 0.06)], [wood], cockpit, 8)
    for y, radius in ((-2.55, 0.43), (-1.35, 0.44)):
        shell("Barrel iron binding", 0, 0.95,
              [(y - 0.08, radius), (y + 0.08, radius)], [iron], cockpit, 8)
    cube("Seat cushion", (0, -1.99, 1.35), (0.60, 0.70, 0.18), leather, cockpit)
    cube("Tall seat back", (0, -2.42, 1.75), (0.63, 0.16, 0.95),
         leather, cockpit, (0.12, 0, 0))
    for x in (-0.43, 0.43):
        cube("Cockpit side armor", (x, -1.90, 1.43), (0.13, 1.5, 0.48),
             wood, cockpit)
        rod("Cockpit rim", (x, -2.65, 1.69), (x, -1.15, 1.69),
            0.07, iron, cockpit)
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
        rod("Iron wheel rim", (x, -2.08, 1.12), (x * 1.06, -2.08, 1.12),
            0.35, iron, cockpit, 12)
        rod("Wood wheel disc", (x * 1.065, -2.08, 1.12), (x * 1.08, -2.08, 1.12),
            0.27, wood, cockpit, 12)
        rod("Gear medallion", (x, -2.08, 1.47), (x * 1.05, -2.08, 1.47),
            0.21, brass, cockpit, 12)
        for i in range(10):
            angle = math.tau * i / 10
            cube("Gear tooth", (x, -2.08 + 0.22 * math.cos(angle),
                               1.47 + 0.22 * math.sin(angle)),
                 (0.075, 0.095, 0.095), brass, cockpit, (angle, 0, 0))
    # Put the camera attachment at the seat without rotating the forward-facing chair.
    seat = Vector((0, -1.99, 1.35))
    for child in cockpit.children:
        child.location -= seat
    cockpit.location += Vector(tuple(seat[i] * cockpit.scale[i] for i in range(3)))
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH" and not obj.data.uv_layers:
            uv = obj.data.uv_layers.new()
            for poly in obj.data.polygons:
                axes = sorted(range(3), key=lambda i: abs(poly.normal[i]))[:2]
                for loop in poly.loop_indices:
                    co = obj.data.vertices[obj.data.loops[loop].vertex_index].co
                    uv.data[loop].uv = (co[axes[0]], co[axes[1]])
    return paint, shade, light


def triangles():
    return sum(len(p.vertices) - 2 for obj in bpy.context.scene.objects
               if obj.type == "MESH" for p in obj.data.polygons)


def verify(path, expected):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(path))
    assert REQUIRED <= set(bpy.data.objects.keys()), "Missing attachment nodes"
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        assert obj.data.uv_layers, obj.name
        for mat in obj.data.materials:
            shader = mat.node_tree.nodes.get("Principled BSDF")
            assert shader.inputs["Metallic"].default_value == 0
            assert shader.inputs["Roughness"].default_value == 1
            textures = [n.image for n in mat.node_tree.nodes if n.type == "TEX_IMAGE"]
            assert textures and all(tuple(image.size) == (128, 128) for image in textures)
    count = triangles()
    assert 3000 <= count <= 6000 and count == expected, (path, count, expected)
    for name in ("ExhaustL", "ExhaustR"):
        assert bpy.data.objects[name].type == "EMPTY"
    coords = [obj.matrix_world @ Vector(corner) for obj in bpy.context.scene.objects
              if obj.type == "MESH" for corner in obj.bound_box]
    bounds = [max(v[i] for v in coords) - min(v[i] for v in coords) for i in range(3)]
    assert 5 < bounds[0] < 5.7 and 10 < bounds[1] < 11, bounds
    assert abs(min(v.z for v in coords)) < 0.001
    def group_bounds(name):
        return [obj.matrix_world @ Vector(corner)
                for obj in bpy.data.objects[name].children if obj.type == "MESH"
                for corner in obj.bound_box]

    pod = group_bounds("Cockpit")
    left, right = group_bounds("EngineL"), group_bounds("EngineR")
    engine_rear = min(v.y for v in left + right)
    pod_rear, pod_front = min(v.y for v in pod), max(v.y for v in pod)
    gap = engine_rear - pod_front
    offset = engine_rear - (pod_rear + pod_front) / 2
    inner_gap = min(v.x for v in right) - max(v.x for v in left)
    assert gap > 3.8 and 4 <= offset <= 5, (gap, offset)
    assert inner_gap >= max(v.x for v in pod) - min(v.x for v in pod)
    for side in ("L", "R"):
        arm = bpy.data.objects["TowLine" + side]
        ends = [arm.matrix_world @ Vector((0, 0, z))
                for z in (min(v.co.z for v in arm.data.vertices),
                          max(v.co.z for v in arm.data.vertices))]
        delta = ends[1] - ends[0]
        angle = math.degrees(math.atan2(abs(delta.x), abs(delta.y)))
        assert 5 <= angle <= 10 and delta.length > 4.5, (angle, delta.length)
        nozzle = bpy.data.objects["Exhaust" + side].matrix_world.translation
        # Reserve a 0.6 m radius rearward flame corridor, independent of flame length.
        trailing = pod + [
            obj.matrix_world @ vertex.co for obj in bpy.context.scene.objects
            if obj.type == "MESH" and obj.name.startswith(("TowLine", "Suspended control cable"))
            for vertex in obj.data.vertices]
        assert all(abs(v.x - nozzle.x) > 0.6 for v in trailing if v.y < nozzle.y)
    seat = bpy.data.objects["Seat cushion"].matrix_world.translation
    assert (bpy.data.objects["Cockpit"].matrix_world.translation - seat).length < 0.001
    assert bpy.data.objects["Tall seat back"].matrix_world.translation.y < seat.y
    assert bpy.data.objects["Instrument cowl"].matrix_world.translation.y > seat.y
    print("Silhouette: gap {:.2f} m; center trails {:.2f} m; tow half-angle {:.1f} deg"
          .format(gap, offset, angle))
    print("VERIFIED {}: {} triangles".format(path.name, count))


def preview(path):
    scene = bpy.context.scene
    floor = material("Preview floor", (0.085, 0.105, 0.115, 1))
    shader = floor.node_tree.nodes["Principled BSDF"]
    for link in list(shader.inputs["Base Color"].links):
        floor.node_tree.links.remove(link)
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
    bpy.ops.object.camera_add(location=(11, 10, 12))
    camera = bpy.context.object
    camera.rotation_euler = (Vector((0, -2.2, 1.3)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 13.0
    scene.camera = camera
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.use_gtao = True
    scene.eevee.gtao_distance = 3
    scene.eevee.use_soft_shadows = True
    scene.eevee.use_bloom = True
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 1000
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "Medium High Contrast"
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    camera.location = (0, -2.2, 16)
    camera.data.ortho_scale = 14
    camera.rotation_euler = (0, 0, 0)
    scene.render.filepath = str(path.with_name(path.stem + "-above" + path.suffix))
    bpy.ops.render.render(write_still=True)
    camera.location = (16, -2.2, 2)
    camera.rotation_euler = (Vector((0, -2.2, 1.45)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.ortho_scale = 12.0
    scene.render.filepath = str(path.with_name(path.stem + "-side" + path.suffix))
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
        for mat, factor in ((paint, 1), (shade, 0.85), (light, 1.1)):
            rgba = tuple(min(channel * factor, 1) for channel in color[:3]) + (1,)
            image = next(node.image for node in mat.node_tree.nodes if node.type == "TEX_IMAGE")
            pixels = list(image.pixels[:])
            for i in range(0, len(pixels), 4):
                for channel in range(3):
                    pixels[i + channel] *= rgba[channel] / mat.diffuse_color[channel]
            image.pixels = pixels
            image.pack()
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
