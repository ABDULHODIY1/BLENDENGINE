# SPDX-License-Identifier: GPL-2.0-or-later
# Driven by test_run_input.sh: starts a Test Run in the BlendEngine UI and records
# scene snapshots while xdotool sends real keyboard and mouse input.
import os
import sys

import bpy

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "addons_core"))
OUT = os.environ.get("BE_GUI_RESULT", "result.txt")
state = {}

def log(msg):
    with open(OUT, "a") as f:
        f.write(msg + "\n")

def snap(tag):
    scene = bpy.context.scene
    p = scene.objects.get("BE_Player")
    win = bpy.context.window_manager.windows[0]
    area = next(a for a in win.screen.areas if a.type == "VIEW_3D")
    r3d = area.spaces.active.region_3d
    changed = {o.name: tuple(round(v, 3) for v in o.scale) for o in scene.objects if o.type == "MESH" and tuple(round(v, 3) for v in o.scale) != state["scales"].get(o.name)}
    log("%s running=%s player=%s loc=%s objects=%d scale_changed=%s view_dist=%.2f persp=%s workspace=%s" % (
        tag, scene.blendengine_project.test_running, bool(p), tuple(round(v, 2) for v in p.location) if p else None,
        len(scene.objects), changed, r3d.view_distance, r3d.view_perspective, win.workspace.name))

def setup():
    import blendengine
    try:
        blendengine.register()
    except ValueError:
        pass
    open(OUT, "w").close()
    bpy.ops.blendengine.generate_basic_template()
    scene = bpy.context.scene
    state["scales"] = {o.name: tuple(round(v, 3) for v in o.scale) for o in scene.objects if o.type == "MESH"}
    win = bpy.context.window_manager.windows[0]
    area = next(a for a in win.screen.areas if a.type == "VIEW_3D")
    region = next(r for r in area.regions if r.type == "WINDOW")
    with bpy.context.temp_override(window=win, area=area, region=region):
        player = scene.objects.get("BE_Player")
        for o in bpy.context.selected_objects:
            o.select_set(False)
        player.select_set(True)
        bpy.context.view_layer.objects.active = player
        bpy.ops.blendengine.test_run_scene("INVOKE_DEFAULT")
    snap("start")

def mid():
    snap("during")

def stop():
    bpy.ops.blendengine.stop_test_run()

def after_stop():
    snap("after_stop")

def final():
    snap("final")
    bpy.ops.wm.quit_blender()

for fn, t in ((setup, 3.0), (mid, 17.0), (stop, 18.0), (after_stop, 20.0), (final, 33.0)):
    bpy.app.timers.register(fn, first_interval=t)
