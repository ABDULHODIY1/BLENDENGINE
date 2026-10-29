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
    scene.world.color = (0.02, 0.02, 0.025)
    scene.render.fps = 30
    scene.frame_start, scene.frame_end = 1, 210

    mat = T._material
    ground = mat("KV_Grass", (0.17, 0.33, 0.11, 1.0), roughness=0.92)
    stone = mat("KV_Sandstone", (0.55, 0.42, 0.3, 1.0), roughness=0.8)
    dark_stone = mat("KV_DarkStone", (0.18, 0.17, 0.17, 1.0), roughness=0.7)
    crystal = mat("KV_Crystal", (0.25, 0.75, 1.0, 1.0), roughness=0.08, metallic=0.2, emission=(0.1, 0.65, 1.0, 1.0), emission_strength=2.4)
    lava = mat("KV_Lava", (1.0, 0.25, 0.02, 1.0), roughness=0.4, emission=(1.0, 0.28, 0.02, 1.0), emission_strength=4.0)
    hero = mat("KV_Hero", (0.9, 0.62, 0.15, 1.0), roughness=0.35, metallic=0.6)
    skin = mat("KV_Skin", (0.85, 0.6, 0.45, 1.0), roughness=0.55)
    guardian = mat("KV_Guardian", (0.35, 0.05, 0.08, 1.0), roughness=0.4, metallic=0.3, emission=(0.6, 0.02, 0.04, 1.0), emission_strength=0.4)
    portal = mat("KV_Portal", (0.6, 0.2, 1.0, 1.0), roughness=0.1, alpha=0.7, emission=(0.55, 0.15, 1.0, 1.0), emission_strength=3.0)
    heal = mat("KV_Heal", (0.1, 1.0, 0.4, 1.0), roughness=0.3, emission=(0.05, 1.0, 0.3, 1.0), emission_strength=1.5)
    wood = mat("KV_Wood", (0.25, 0.13, 0.06, 1.0), roughness=0.8)
    leaves = mat("KV_Leaves", (0.1, 0.32, 0.08, 1.0), roughness=0.9)

    T._terrain(context, "KV_Valley", 44.0, 34, ground)

    # Ruined walls around the valley and broken pillars as cover.
    for index, (loc, dims, rot) in enumerate((
        ((0, 19.5, 1.6), (40, 1.2, 3.2), 0), ((0, -19.5, 1.6), (40, 1.2, 3.2), 0),
        ((-19.5, 0, 1.6), (1.2, 40, 3.2), 0), ((19.5, -6, 1.6), (1.2, 27, 3.2), 0),
        ((-6, 2, 0.9), (4.0, 0.9, 1.8), 25), ((5, 3, 0.7), (3.0, 0.9, 1.4), -35), ((-11, -3, 0.8), (0.9, 4.0, 1.6), 0),
    )):
        wall = T._cube(context, "KV_Ruin_%02d" % index, loc, dims, stone if index < 4 else dark_stone, "Wall")
        wall.rotation_euler.z = math.radians(rot)
    for index, (x, y, h) in enumerate(((-4, 8, 3.5), (2, -5, 2.4), (11, -3, 4.2), (-13, 12, 2.8), (13, 9, 3.0))):
        bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.55, depth=h, location=(x, y, h / 2))
        pillar = context.object
        pillar.name = "KV_Pillar_%02d" % index
        T._assign_material(pillar, stone)
        components.add_collider(pillar, tag="Wall")
        optimization.mark_static_object(pillar)
    for index, (x, y) in enumerate(((-16, -15), (-16, 15), (16, 16), (-10, -16), (15, -16), (-17, 4))):
        T._add_tree(context, "KV_Tree_%02d" % index, (x, y, 0.0), wood, leaves, scale=1.4 + (index % 3) * 0.3)
    for index, (x, y) in enumerate(((-7, -6), (7, 12), (-15, 9), (12, -13), (1, 16))):
        T._add_rock(context, "KV_Rock_%02d" % index, (x, y, 0.35), dark_stone, scale=1.2 + index * 0.15)

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
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.35, location=(x, y, 0.9))
        gem = context.object
        gem.name = "KV_Crystal_%02d" % (index + 1)
        gem.scale = (0.7, 0.7, 1.4)
        T._assign_material(gem, crystal)
        components.add_trigger_zone(gem)
        gem.blendengine_object.object_tag = "Coin"
        optimization.mark_dynamic_object(gem)
        bpy.ops.object.light_add(type="POINT", location=(x, y, 1.4))
        glow = context.object
        glow.name = "KV_Crystal_Glow_%02d" % (index + 1)
        glow.data.energy = 40.0
        glow.data.color = (0.3, 0.75, 1.0)
        glow.parent = gem
        glow.matrix_parent_inverse = gem.matrix_world.inverted()

    # Lava pool that hurts (built-in Damage rule).
    lava_pool = T._cube(context, "KV_Lava_Pool", (-1, -1, 0.06), (6.5, 4.0, 0.12), lava, "", static=False)
    components.add_trigger_zone(lava_pool)
    lava_pool.blendengine_object.object_tag = "Damage"
    lava_pool.display_type = "TEXTURED"
    bpy.ops.object.light_add(type="POINT", location=(-1, -1, 1.2))
    lava_light = context.object
    lava_light.name = "KV_Lava_Light"
    lava_light.data.energy = 600.0
    lava_light.data.color = (1.0, 0.35, 0.08)

    # Healing spring.
    spring = T._cube(context, "KV_Healing_Spring", (-12, 2, 0.4), (0.8, 0.8, 0.8), heal, "", static=False)
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
    sand = mat("KV_Sandbag", (0.42, 0.37, 0.26, 1.0), roughness=0.95)
    crate_mat = mat("KV_Crate", (0.36, 0.25, 0.12, 1.0), roughness=0.75)
    for index, ((x, y), dims, rot) in enumerate(COVER):
        wall = T._cube(context, "KV_Cover_%02d" % index, (x, y, dims[2] / 2), dims, sand, "Wall")
        wall.rotation_euler.z = math.radians(rot)
    for index, (x, y) in enumerate(CRATES):
        crate = T._cube(context, "KV_Crate_%02d" % index, (x, y, 0.45), (0.9, 0.9, 0.9), crate_mat, "Wall")
        crate.rotation_euler.z = math.radians(index * 23 % 90)

    # Ammo boxes (built-in Ammo rule: +30 rounds).
    ammo_mat = mat("KV_Ammo", (0.2, 0.32, 0.12, 1.0), roughness=0.5, metallic=0.3, emission=(0.6, 0.9, 0.2, 1.0), emission_strength=0.6)
    for index, (x, y) in enumerate(((-10, -4), (2, 2), (10, -11), (-6, 15), (13, 3))):
        box = T._cube(context, "KV_Ammo_%02d" % index, (x, y, 0.25), (0.6, 0.4, 0.35), ammo_mat, "", static=False)
        components.add_trigger_zone(box)
        box.blendengine_object.object_tag = "Ammo"

    # Gate in front of the portal (Door component, opened with E).
    gate = T._cube(context, "KV_Gate", (16, 10, 1.5), (0.6, 5.0, 3.0), dark_stone, "Door")
    utils.ensure_component(gate, "DOOR", tag="Door")
    gate.blendengine_object.object_tag = "Gate"
    T._cube(context, "KV_Gate_Wall_A", (16, 15.5, 1.6), (0.9, 6.0, 3.2), stone, "Wall")
    T._cube(context, "KV_Gate_Wall_B", (16, 4.5, 1.6), (0.9, 6.0, 3.2), stone, "Wall")

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
    sun.rotation_euler = (math.radians(62.0), 0.0, math.radians(-38.0))
    sun.data.energy = 3.2
    sun.data.color = (1.0, 0.86, 0.7)

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
