# SPDX-License-Identifier: GPL-2.0-or-later
#
# "Kristall Vodiysi" (Crystal Valley) - a third-person shooter built entirely
# with BlendEngine's own tools: animated soldiers (skeletal animation, four
# weapon types, eight uniforms), squad AI that takes positions and fires
# bursts, components, no-code behaviors, triggers, a door, an animated lift
# and an intro cutscene on the timeline.
#
# Run inside BlendEngine (or any Blender with the add-on):
#   blendengine --python examples/kristall_vodiysi/build_game.py
#   blendengine --background --python examples/kristall_vodiysi/build_game.py -- --export <out_dir>
#
# Goal: fight through the squads guarding the valley, collect the 8 crystals,
# open the gate with E and step into the portal.

import math
import os
import sys

import bpy
from mathutils import Vector

ADDONS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "addons_core")
if ADDONS not in sys.path:
    sys.path.insert(0, ADDONS)

import blendengine  # noqa: E402
from blendengine import characters, components, export_system, input_system, optimization, utils  # noqa: E402
from blendengine import templates as T  # noqa: E402

CRYSTALS = [(-14, -8), (-9, 6), (-3, 13), (4, 9), (10, 14), (14, 2), (8, -9), (-2, -13)]
# Squads: (position, facing degrees, body, uniform, weapon, AI template, health).
ENEMIES = [
    ((-8, 10), 200, "re_soldier_male", "desert", "rifle", "PATROL", 100),
    ((-5, 13), 180, "re_soldier_female", "desert", "smg", "GUARD_AREA", 90),
    ((-11, 9), 160, "re_soldier_male", "olive", "shotgun", "PATROL", 110),
    ((9, 5), 230, "re_soldier_female", "blackops", "rifle", "GUARD_AREA", 100),
    ((11, 9), 250, "re_soldier_male", "blackops", "smg", "PATROL", 100),
    ((12, -6), 270, "re_soldier_male", "crimson", "pistol", "GUARD_AREA", 90),
    ((3, -10), 120, "re_soldier_male", "forest", "rifle", "PATROL", 100),
    ((6, -13), 100, "re_soldier_female", "forest", "shotgun", "GUARD_AREA", 100),
    ((-3, -15), 80, "re_soldier_male", "arctic", "smg", "PATROL", 100),
    ((14, 13), 225, "re_soldier_male", "crimson", "shotgun", "ENEMY_BOSS", 260),
    ((15, 7), 240, "re_soldier_female", "urban", "rifle", "GUARD_AREA", 110),
]
COVER = [((-6, -2), (2.6, 0.5, 1.1), 10), ((3, 4), (0.5, 2.8, 1.2), 0), ((8, -2), (2.4, 0.5, 1.0), -20), ((-2, 9), (2.0, 0.5, 1.1), 35),
         ((10, 12), (0.5, 2.6, 1.2), 0), ((-12, 6), (2.2, 0.5, 1.0), 70), ((1, -7), (2.8, 0.5, 1.1), 0), ((13, 0), (0.5, 2.4, 1.1), 15)]
CRATES = [(-8, -6), (-7.2, -6.4), (5, 9), (9, 0), (12.5, -9), (-14, 0), (0.5, 12), (6, -6)]


def ground_height(x, y):
    """Valley floor with gentle undulation, rising into steep forested hills outside the play area."""
    r = (abs(x) ** 4 + abs(y) ** 4) ** 0.25
    inner = 0.22 * (math.sin(x * 0.31) * math.cos(y * 0.27) + 0.5 * math.sin(x * 0.13 + y * 0.21))
    t = min(1.0, max(0.0, (r - 23.5) / 9.0))
    hill = (t * t * (3 - 2 * t)) * 13.0
    rough = 0.0
    if r > 23.5:
        rough = (math.sin(x * 0.17 + 1.3) * math.sin(y * 0.19 + 0.4) * 1.6 + math.sin(x * 0.51 + y * 0.37) * 0.5) * min(1.0, (r - 23.5) / 6.0)
    return inner * (1.0 - t) + hill + rough


def build_terrain(context, name, size, resolution, material):
    """Height-field terrain mesh (also the walkable collision)."""
    half = size * 0.5
    verts, faces = [], []
    for j in range(resolution + 1):
        y = -half + size * j / resolution
        for i in range(resolution + 1):
            x = -half + size * i / resolution
            verts.append((x, y, ground_height(x, y)))
    row = resolution + 1
    for j in range(resolution):
        for i in range(resolution):
            a = j * row + i
            faces.append((a, a + 1, a + row + 1, a + row))
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(verts, [], faces)
    for poly in mesh.polygons:
        poly.use_smooth = True
    mesh.materials.append(material)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    context.scene.collection.objects.link(obj)
    components.add_collider(obj, tag="Ground")
    optimization.mark_static_object(obj)
    return obj


def scatter(context, ident, name, points, scale_range=(0.8, 1.2), solid=True, seed=1):
    """Place linked duplicates of a prop on the terrain (rendered with GPU instancing)."""
    rnd = __import__("random").Random(seed)
    placed = []
    for index, (x, y) in enumerate(points):
        obj = characters.add_prop(context, ident, "%s_%03d" % (name, index), (x, y, ground_height(x, y) - 0.05),
                                  yaw=rnd.uniform(0, 2 * math.pi), scale=rnd.uniform(*scale_range))
        if solid:
            optimization.mark_static_object(obj)
        else:
            obj["be_noclip"] = 1
        placed.append(obj)
    return placed


def ring_points(count, r_min, r_max, seed, avoid=()):
    rnd = __import__("random").Random(seed)
    out = []
    while len(out) < count:
        x, y = rnd.uniform(-r_max, r_max), rnd.uniform(-r_max, r_max)
        r = (abs(x) ** 4 + abs(y) ** 4) ** 0.25
        if r_min <= r <= r_max and all(math.hypot(x - ax, y - ay) > ad for ax, ay, ad in avoid):
            out.append((x, y))
    return out


def ensure_addon():
    if not hasattr(bpy.types.Scene, "blendengine_project"):
        blendengine.register()


def clear_scene(context):
    scene = context.scene
    # Remove everything, including objects the startup scene locked against selection.
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    T._purge_unused_import_data()
    for marker in list(scene.timeline_markers):
        scene.timeline_markers.remove(marker)


def add_behavior(obj, name, event_type, actions, tag="", timer=0.0, conditions=()):
    behavior = obj.blendengine_object.behaviors.add()
    behavior.name = name
    event = behavior.events.add()
    event.name = name + " Event"
    event.event_type = event_type
    event.tag = tag
    event.timer_seconds = timer
    for kind, variable, compare, number in conditions:
        condition = behavior.conditions.add()
        condition.name = name + " Condition"
        condition.condition_type = kind
        condition.variable_name = variable
        condition.compare = compare
        condition.number_value = number
    for kind, text, variable, number in actions:
        action = behavior.actions.add()
        action.name = name + " " + kind.title()
        action.action_type = kind
        action.text_value = text
        action.variable_name = variable
        action.number_value = number
    return behavior


def add_variable(obj, name, kind, value):
    variable = obj.blendengine_object.variables.add()
    variable.name = name
    variable.variable_type = kind
    if kind == "INT":
        variable.int_value = value
    elif kind == "FLOAT":
        variable.float_value = value
    return variable


def build(context):
    ensure_addon()
    scene = context.scene
    clear_scene(context)
    project = utils.ensure_project_defaults(scene)
    project.game_title = "Kristall Vodiysi"
    project.default_scene = scene
    project.show_fps = True
    project.show_game_variables = False
    project.debug_mode = False
    optimization.apply_preset(scene, "HIGH")
    T._setup_realtime_rendering(scene)
    # Blender's own forest HDRI lights the scene (image based lighting) and is the sky.
    characters.hdri_world(scene, "forest", strength=1.0)
    scene.render.fps = 30
    scene.frame_start, scene.frame_end = 1, 210

    mat = T._material
    ground = characters.terrain_material("KV_Terrain", [("grass_lush", 3.2), ("grass_dry", 4.0), ("dirt", 4.5)])
    stone = characters.surface_material("KV_Ruin_Stone", "dirt", 2.4, roughness=0.88, tint=(0.95, 0.9, 0.82))
    dark_stone = characters.surface_material("KV_Concrete", "concrete_tiles", 2.0, roughness=0.75, tint=(0.6, 0.6, 0.58))
    crystal = mat("KV_Crystal", (0.25, 0.75, 1.0, 1.0), roughness=0.08, metallic=0.2, emission=(0.1, 0.65, 1.0, 1.0), emission_strength=2.4)
    lava = mat("KV_Lava", (1.0, 0.25, 0.02, 1.0), roughness=0.4, emission=(1.0, 0.28, 0.02, 1.0), emission_strength=4.0)
    hero = mat("KV_Hero", (0.9, 0.62, 0.15, 1.0), roughness=0.35, metallic=0.6)
    skin = mat("KV_Skin", (0.85, 0.6, 0.45, 1.0), roughness=0.55)
    guardian = mat("KV_Guardian", (0.35, 0.05, 0.08, 1.0), roughness=0.4, metallic=0.3, emission=(0.6, 0.02, 0.04, 1.0), emission_strength=0.4)
    portal = mat("KV_Portal", (0.6, 0.2, 1.0, 1.0), roughness=0.1, alpha=0.7, emission=(0.55, 0.15, 1.0, 1.0), emission_strength=3.0)
    heal = mat("KV_Heal", (0.1, 1.0, 0.4, 1.0), roughness=0.3, emission=(0.05, 1.0, 0.3, 1.0), emission_strength=1.5)
    pillar_mat = characters.surface_material("KV_Stone_Block", "brick_block", 1.6, roughness=0.8, tint=(0.62, 0.6, 0.56))

    build_terrain(context, "KV_Valley", 150.0, 150, ground)

    # Ruined brick buildings and broken walls inside the valley (cover and sight lines).
    ruins = (
        ((-6, 2, 1.1), (4.2, 0.5, 2.2), 25), ((5, 3, 0.9), (3.2, 0.5, 1.8), -35), ((-11, -3, 1.0), (0.5, 4.2, 2.0), 0),
        # A roofless house in the north-west.
        ((-9, 15.0, 1.5), (7.0, 0.45, 3.0), 0), ((-12.3, 12.3, 1.5), (0.45, 5.4, 3.0), 0), ((-5.7, 13.2, 1.1), (0.45, 3.5, 2.2), 0),
        ((-10.6, 9.6, 1.2), (3.2, 0.45, 2.4), 0),
        # Broken compound wall in the south-east.
        ((8, -15.5, 1.3), (9.0, 0.5, 2.6), 0), ((12.3, -12.5, 0.9), (0.5, 5.5, 1.8), 0), ((4.0, -12.0, 0.6), (0.5, 3.0, 1.2), 10),
    )
    for index, ((x, y, z), dims, rot) in enumerate(ruins):
        wall = T._cube(context, "KV_Ruin_%02d" % index, (x, y, z + ground_height(x, y) - 0.1), dims, stone, "Wall")
        wall.rotation_euler.z = math.radians(rot)
    for index, (x, y, h) in enumerate(((-4, 8, 3.5), (2, -5, 2.4), (11, -3, 4.2), (-13, 12, 2.8), (13, 9, 3.0))):
        bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=0.5, depth=h, location=(x, y, h / 2 + ground_height(x, y) - 0.1))
        pillar = context.object
        pillar.name = "KV_Pillar_%02d" % index
        T._assign_material(pillar, pillar_mat)
        components.add_collider(pillar, tag="Wall")
        optimization.mark_static_object(pillar)

    # Nature: forest on the hills, a few trees, bushes, weeds and rocks in the valley.
    keep_clear = [(-12, -11, 4), (16, 10, 5), (18, 10, 4), (-15, 16, 3), (-1, -1, 5), (-12, 2, 2)]
    scatter(context, "tree_pine", "KV_Pine", ring_points(70, 27, 72, 3), (0.8, 1.3), seed=4)
    scatter(context, "tree_broad", "KV_Broadleaf", ring_points(35, 28, 72, 5), (0.7, 1.1), seed=6)
    scatter(context, "tree_oak", "KV_Oak", ring_points(30, 26, 70, 7), (0.8, 1.2), seed=8)
    scatter(context, "tree_birch", "KV_Birch", [(-17, -16), (17, 17), (-18, 6), (6, 18), (-2, -18)], (0.8, 1.0), seed=9)
    scatter(context, "tree_dead", "KV_DeadTree", [(9, -8), (-15, -6), (3, 14)], (0.9, 1.2), seed=10)
    scatter(context, "rock_b", "KV_Boulder", ring_points(18, 22, 40, 11, keep_clear), (0.8, 1.8), seed=12)
    scatter(context, "rock_a", "KV_Rock", [(-7, -6), (7, 12), (-15, 9), (12, -13), (1, 16), (-18, -2), (18, -2)], (0.8, 1.3), seed=13)
    scatter(context, "bush", "KV_Bush", ring_points(55, 4, 26, 14, keep_clear), (0.8, 1.5), solid=False, seed=15)
    scatter(context, "weeds", "KV_Weeds", ring_points(90, 2, 30, 16, keep_clear), (0.7, 1.3), solid=False, seed=17)
    for index, (x, y) in enumerate(((-7.5, -7), (8.5, 1.0), (-13, 10.5), (6.5, -13.5), (11, 11))):
        scatter(context, "barrel", "KV_Barrel_%d" % index, [(x, y), (x + 0.8, y + 0.3)], (0.95, 1.05), seed=20 + index)
    scatter(context, "gas_tank", "KV_GasTank", [(-3.2, 10.5), (9.5, -10.5)], (1.0, 1.0), seed=30)
    scatter(context, "pallet", "KV_Pallet", [(4.5, 8.5), (-8.5, -8.5), (10.5, 2.5)], (1.0, 1.0), seed=31)

    # Hero: an animated soldier with a rifle, third-person over-the-shoulder shooter.
    player = characters.add_character(context, "re_soldier_male", "KV_Hero", (-12.0, -11.0, 0.0), yaw=math.radians(-20.0), variant="navy", weapon="rifle")
    components.add_player_controller(player)
    controller = player.blendengine_object.player_controller
    controller.controller_type = "THIRD_PERSON"
    controller.walk_speed = 3.6
    controller.run_speed = 6.8
    controller.jump_force = 5.5
    components.add_collider(player, tag="Player")
    components.add_health(player, max_health=100.0)
    optimization.mark_dynamic_object(player)
    add_variable(player, "Score", "INT", 0)
    add_variable(player, "Ammo", "INT", 150)
    add_variable(player, "IntroPlayed", "INT", 0)
    # Intro cutscene once, right after the game starts.
    add_behavior(
        player, "Intro Cutscene", "ON_TIMER", timer=0.05,
        conditions=[("VARIABLE_COMPARE", "IntroPlayed", "EQUAL", 0)],
        actions=[("SET_VARIABLE", "", "IntroPlayed", 1), ("START_CUTSCENE", "Kristall Vodiysi", "", 0)],
    )

    # Crystals to collect (built-in Coin rule: +10 score, needed for the portal).
    for index, (x, y) in enumerate(CRYSTALS):
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.35, location=(x, y, 0.9 + ground_height(x, y)))
        gem = context.object
        gem.name = "KV_Crystal_%02d" % (index + 1)
        gem.scale = (0.7, 0.7, 1.4)
        T._assign_material(gem, crystal)
        components.add_trigger_zone(gem)
        gem.blendengine_object.object_tag = "Coin"
        optimization.mark_dynamic_object(gem)
        bpy.ops.object.light_add(type="POINT", location=(x, y, 1.4 + ground_height(x, y)))
        glow = context.object
        glow.name = "KV_Crystal_Glow_%02d" % (index + 1)
        glow.data.energy = 40.0
        glow.data.color = (0.3, 0.75, 1.0)
        glow.parent = gem
        glow.matrix_parent_inverse = gem.matrix_world.inverted()

    # Lava pool that hurts (built-in Damage rule).
    lava_pool = T._cube(context, "KV_Lava_Pool", (-1, -1, 0.08 + ground_height(-1, -1)), (6.5, 4.0, 0.3), lava, "", static=False)
    components.add_trigger_zone(lava_pool)
    lava_pool.blendengine_object.object_tag = "Damage"
    lava_pool.display_type = "TEXTURED"
    bpy.ops.object.light_add(type="POINT", location=(-1, -1, 1.2))
    lava_light = context.object
    lava_light.name = "KV_Lava_Light"
    lava_light.data.energy = 600.0
    lava_light.data.color = (1.0, 0.35, 0.08)

    # Healing spring.
    spring = T._cube(context, "KV_Healing_Spring", (-12, 2, 0.4 + ground_height(-12, 2)), (0.8, 0.8, 0.8), heal, "", static=False)
    components.add_trigger_zone(spring)
    spring.blendengine_object.object_tag = "Health"

    # Squads of armed soldiers: every one has its own body, uniform and weapon.
    for index, ((x, y), facing, body, uniform, weapon, template, hp) in enumerate(ENEMIES):
        enemy = characters.add_character(context, body, "KV_Soldier_%02d" % (index + 1), (x, y, 0.0), yaw=math.radians(facing), variant=uniform, weapon=weapon,
                                          scale=1.08 if template == "ENEMY_BOSS" else 0.97 + (index % 3) * 0.03)
        enemy.blendengine_object.object_tag = "Enemy"
        components.add_collider(enemy, tag="Enemy")
        components.add_health(enemy, max_health=float(hp))
        npc = components.add_npc_behavior(enemy, template, target=player)
        npc.move_speed = 2.6 if weapon != "shotgun" else 3.2
        npc.patrol_radius = 4.0
        npc.detection_range = 24.0 if weapon in ("rifle", "pistol") else 18.0
        npc.attack_range = 1.3
        optimization.mark_dynamic_object(enemy)

    # Cover: sandbag walls and crates.
    sand = characters.surface_material("KV_Barrier", "concrete_stripes", 1.4, roughness=0.7, tint=(0.72, 0.7, 0.66))
    crate_mat = characters.surface_material("KV_Crate", "crate", 0.9, roughness=0.6, tint=(0.75, 0.75, 0.7))
    for index, ((x, y), dims, rot) in enumerate(COVER):
        wall = T._cube(context, "KV_Cover_%02d" % index, (x, y, dims[2] / 2 + ground_height(x, y) - 0.05), dims, sand, "Wall")
        wall.rotation_euler.z = math.radians(rot)
    for index, (x, y) in enumerate(CRATES):
        crate = T._cube(context, "KV_Crate_%02d" % index, (x, y, 0.45 + ground_height(x, y) - 0.03), (0.9, 0.9, 0.9), crate_mat, "Wall")
        crate.rotation_euler.z = math.radians(index * 23 % 90)

    # Ammo boxes (built-in Ammo rule: +30 rounds).
    ammo_mat = mat("KV_Ammo", (0.2, 0.32, 0.12, 1.0), roughness=0.5, metallic=0.3, emission=(0.6, 0.9, 0.2, 1.0), emission_strength=0.6)
    for index, (x, y) in enumerate(((-10, -4), (2, 2), (10, -11), (-6, 15), (13, 3))):
        box = T._cube(context, "KV_Ammo_%02d" % index, (x, y, 0.25 + ground_height(x, y)), (0.6, 0.4, 0.35), ammo_mat, "", static=False)
        components.add_trigger_zone(box)
        box.blendengine_object.object_tag = "Ammo"

    # Gate in front of the portal (Door component, opened with E).
    gate = T._cube(context, "KV_Gate", (16, 10, 1.5 + ground_height(16, 10)), (0.6, 5.0, 3.0), dark_stone, "Door")
    utils.ensure_component(gate, "DOOR", tag="Door")
    gate.blendengine_object.object_tag = "Gate"
    T._cube(context, "KV_Gate_Wall_A", (16, 15.5, 1.5 + ground_height(16, 15.5)), (0.9, 6.0, 3.4), stone, "Wall")
    T._cube(context, "KV_Gate_Wall_B", (16, 4.5, 1.5 + ground_height(16, 4.5)), (0.9, 6.0, 3.4), stone, "Wall")

    # Exit portal behind the gate.
    bpy.ops.mesh.primitive_torus_add(major_radius=1.3, minor_radius=0.14, location=(18, 10, 1.6))
    ring = context.object
    ring.name = "KV_Exit_Portal"
    ring.rotation_euler.y = math.radians(90.0)
    T._assign_material(ring, portal)
    components.add_trigger_zone(ring)
    bpy.ops.object.light_add(type="POINT", location=(17.5, 10, 1.8))
    portal_light = context.object
    portal_light.name = "KV_Portal_Light"
    portal_light.data.energy = 300.0
    portal_light.data.color = (0.6, 0.25, 1.0)

    # Animated lift (timeline keyframes): loops during play and carries the player.
    lift = T._cube(context, "KV_Lift", (-15, 16, 0.3), (2.4, 2.4, 0.3), dark_stone, "Ground")
    lift.keyframe_insert("location", frame=1)
    lift.location.z = 3.0
    lift.keyframe_insert("location", frame=105)
    lift.location.z = 0.3
    lift.keyframe_insert("location", frame=210)

    # Low evening sun for long shadows.
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 10))
    sun = context.object
    sun.name = "KV_Sun"
    # Point the sun at the HDRI's sun so lighting, shadows and sky agree (the runtime does the same).
    from mathutils import Vector as _V
    sun_dir = _V((0.76, -0.55, 0.34)).normalized()
    sun.rotation_euler = sun_dir.to_track_quat("Z", "Y").to_euler()
    sun.data.energy = 3.6
    sun.data.color = (1.0, 0.9, 0.78)

    # Gameplay camera behind the hero.
    bpy.ops.object.camera_add(location=(-12, -17.0, 3.6), rotation=(math.radians(74.0), 0.0, 0.0))
    camera = context.object
    camera.name = "KV_Game_Camera"
    camera.data.lens = 30
    scene.camera = camera
    controller.camera_follow = camera
    utils.ensure_component(camera, "CAMERA_CONTROLLER", tag="MainCamera")

    # Intro fly-over camera on the timeline (frames 1-150).
    bpy.ops.object.camera_add(location=(22, -24, 12))
    intro = context.object
    intro.name = "KV_Intro_Camera"
    intro.data.lens = 24
    intro.data.dof.use_dof = True
    intro.data.dof.focus_object = ring
    intro.data.dof.aperture_fstop = 4.0
    path = [
        (1, Vector((22, -24, 12)), Vector((0, 0, 0))),
        (70, Vector((6, -6, 4)), Vector((-1, -1, 0.5))),
        (140, Vector((10, 3, 3)), Vector((18, 10, 1.6))),
        (210, Vector((-12, -17.0, 3.6)), Vector((-12, -11, 1.0))),
    ]
    for frame, location, target in path:
        intro.location = location
        intro.rotation_euler = (target - location).to_track_quat("-Z", "Y").to_euler()
        intro.keyframe_insert("location", frame=frame)
        intro.keyframe_insert("rotation_euler", frame=frame)
    marker = scene.timeline_markers.new("Intro", frame=1)
    marker.camera = intro

    film = scene.blendengine_film
    film.letterbox = "2.39"
    film.film_grain = 0.03

    input_system.ensure_defaults(scene)
    export = scene.blendengine_export
    export.package_name = "KristallVodiysi"
    project.target_platform = "WEB"
    export.runtime_fog_density = 0.006
    export.runtime_bloom = 1.3
    T._select_only(context, player)
    return player


def export(context, out_dir):
    scene = context.scene
    scene.blendengine_project.target_platform = "WEB"
    scene.blendengine_project.build_folder = os.path.abspath(out_dir)
    scene.blendengine_export.package_name = "KristallVodiysi"
    package = export_system.prepare_build_package(context)
    print("[BlendEngine] Kristall Vodiysi exported to %s" % os.path.join(package["package_dir"], "web_player", "index.html"))
    return package


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    build(bpy.context)
    if "--export" in args:
        export(bpy.context, args[args.index("--export") + 1])
    if "--save" in args:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args[args.index("--save") + 1]))
