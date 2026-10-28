# SPDX-License-Identifier: GPL-2.0-or-later
#
# "Kristall Vodiysi" (Crystal Valley) - an example game built entirely with
# BlendEngine's own tools: components, no-code behaviors, NPC AI templates,
# triggers, a door, an animated lift and an intro cutscene on the timeline.
#
# Run inside BlendEngine (or any Blender with the add-on):
#   blendengine --python examples/kristall_vodiysi/build_game.py
#   blendengine --background --python examples/kristall_vodiysi/build_game.py -- --export <out_dir>
#
# Goal: collect the 8 crystals, survive the guardians and the lava, open the
# gate with E and step into the portal.

import math
import os
import sys

import bpy
from mathutils import Vector

ADDONS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "addons_core")
if ADDONS not in sys.path:
    sys.path.insert(0, ADDONS)

import blendengine  # noqa: E402
from blendengine import components, export_system, input_system, optimization, utils  # noqa: E402
from blendengine import templates as T  # noqa: E402

CRYSTALS = [(-14, -8), (-9, 6), (-3, 13), (4, 9), (10, 14), (14, 2), (8, -9), (-2, -13)]
ENEMIES = [((-8, 10), "PATROL"), ((9, 5), "ATTACK"), ((3, -10), "ATTACK")]


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

    # Hero: body with a head and a crown, third-person controller.
    bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=0.38, depth=1.3, location=(-12, -11, 0.65))
    player = context.object
    player.name = "KV_Hero"
    T._assign_material(player, hero)
    T._shade_smooth(player)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.3, location=(-12, -11, 1.55))
    head = context.object
    head.name = "KV_Hero_Head"
    T._assign_material(head, skin)
    T._shade_smooth(head)
    head.parent = player
    head.matrix_parent_inverse = player.matrix_world.inverted()
    components.add_player_controller(player)
    controller = player.blendengine_object.player_controller
    controller.controller_type = "THIRD_PERSON"
    controller.walk_speed = 5.5
    controller.run_speed = 9.0
    controller.jump_force = 6.0
    components.add_collider(player, tag="Player")
    components.add_health(player, max_health=100.0)
    optimization.mark_dynamic_object(player)
    add_variable(player, "Score", "INT", 0)
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

    # Guardians: NPC AI templates with health.
    for index, ((x, y), template) in enumerate(ENEMIES):
        bpy.ops.mesh.primitive_cone_add(vertices=16, radius1=0.55, radius2=0.2, depth=1.7, location=(x, y, 0.85))
        enemy = context.object
        enemy.name = "KV_Guardian_%02d" % (index + 1)
        T._assign_material(enemy, guardian)
        T._shade_smooth(enemy)
        components.add_collider(enemy, tag="Enemy")
        components.add_health(enemy, max_health=60.0)
        npc = components.add_npc_behavior(enemy, template, target=player)
        npc.move_speed = 2.3
        npc.patrol_radius = 4.0
        npc.detection_range = 9.0
        npc.attack_range = 1.3
        optimization.mark_dynamic_object(enemy)

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
