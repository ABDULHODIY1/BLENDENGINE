# SPDX-License-Identifier: GPL-2.0-or-later
#
# Film-making tools: cinematic cameras, camera shots on the timeline and
# rendering the project as a video with Eevee or Cycles.
#
# The same timeline (object/camera animation and camera markers) is exported
# to the web runtime by scene_export.py, so one project can be a game, a film
# or a game with cutscenes.

import math
import os

import bpy
from bpy.types import Operator, Panel
from mathutils import Vector

from . import export_system, utils


RESOLUTIONS = {"720": (1280, 720), "1080": (1920, 1080), "1440": (2560, 1440), "2160": (3840, 2160)}


def _set_engine(scene, wanted):
    """Select the render engine; the engine enum is dynamic, so try the names in order."""
    candidates = ["CYCLES"] if wanted == "CYCLES" else []
    candidates += ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"]
    for name in candidates:
        try:
            scene.render.engine = name
            return name
        except TypeError:
            continue
    return scene.render.engine


def _try_set(data, name, value):
    if not hasattr(data, name):
        return False
    try:
        setattr(data, name, value)
        return True
    except (TypeError, ValueError, AttributeError):
        return False


def film_output_path(scene):
    project = scene.blendengine_project
    folder = os.path.join(bpy.path.abspath(project.build_folder), "film")
    os.makedirs(folder, exist_ok=True)
    name = export_system._safe_name(project.game_title, "BlendEngineFilm")
    return os.path.join(folder, name + ".mp4")


def configure_film_render(scene, filepath):
    """Set up the scene to render the timeline as an H.264 MP4 with film-like settings."""
    film = scene.blendengine_film
    render = scene.render
    _set_engine(scene, film.film_engine)
    if render.engine == "CYCLES":
        cycles = getattr(scene, "cycles", None)
        if cycles is not None:
            _try_set(cycles, "samples", film.film_samples)
            _try_set(cycles, "use_denoising", True)
    else:
        eevee = getattr(scene, "eevee", None)
        if eevee is not None:
            _try_set(eevee, "taa_render_samples", film.film_samples)
            for name in ("use_gtao", "use_bloom", "use_ssr", "use_soft_shadows"):
                _try_set(eevee, name, True)

    if film.film_resolution in RESOLUTIONS:
        render.resolution_x, render.resolution_y = RESOLUTIONS[film.film_resolution]
        render.resolution_percentage = 100
    render.use_motion_blur = film.motion_blur > 0.0
    _try_set(render, "motion_blur_shutter", max(0.01, film.motion_blur))

    view = scene.view_settings
    for transform in ("AgX", "Filmic"):
        if _try_set(view, "view_transform", transform):
            break
    _try_set(view, "look", "None")

    settings = render.image_settings
    _try_set(settings, "media_type", "VIDEO")
    settings.file_format = "FFMPEG"
    ffmpeg = render.ffmpeg
    _try_set(ffmpeg, "format", "MPEG4")
    _try_set(ffmpeg, "codec", "H264")
    _try_set(ffmpeg, "constant_rate_factor", film.film_quality)
    _try_set(ffmpeg, "ffmpeg_preset", "GOOD")
    render.filepath = filepath
    return filepath


def add_cinematic_camera(context, name="BE_Cinematic_Camera", focus=None):
    """Add a 35mm camera with depth of field, framing the focus object if given."""
    scene = context.scene
    data = bpy.data.cameras.new(name)
    data.lens = 35.0
    data.sensor_width = 36.0
    data.dof.use_dof = True
    data.dof.aperture_fstop = 2.8
    camera = bpy.data.objects.new(name, data)
    context.collection.objects.link(camera)
    target = focus.matrix_world.translation.copy() if focus is not None else Vector((0.0, 0.0, 1.0))
    camera.location = target + Vector((0.0, -7.0, 2.2))
    direction = target - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    if focus is not None:
        data.dof.focus_object = focus
    else:
        data.dof.focus_distance = direction.length
    if scene.camera is None:
        scene.camera = camera
    utils.ensure_component(camera, "CAMERA_CONTROLLER", tag="CinematicCamera")
    return camera


def add_camera_shot(scene, camera, frame):
    """Cut to camera at frame (a timeline marker bound to the camera)."""
    marker = scene.timeline_markers.new("Shot %d" % (len(scene.timeline_markers) + 1), frame=frame)
    marker.camera = camera
    return marker


def _key_transform(obj, frame):
    obj.keyframe_insert("location", frame=frame)
    obj.keyframe_insert("rotation_euler", frame=frame)


def _look_at(obj, target):
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def create_demo_sequence(context, subject=None):
    """Two-shot demo: a dolly-in and an orbit around the subject, with camera cuts."""
    scene = context.scene
    if subject is None:
        subject = utils.find_player_object(scene) or context.active_object
    center = subject.matrix_world.translation.copy() if subject is not None else Vector((0.0, 0.0, 1.0))
    center.z += 0.6

    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 168

    dolly = add_cinematic_camera(context, "BE_Shot_Dolly", focus=subject)
    dolly.data.lens = 28.0
    dolly.location = center + Vector((-9.0, -11.0, 3.6))
    _look_at(dolly, center)
    _key_transform(dolly, 1)
    dolly.location = center + Vector((-2.2, -4.2, 1.4))
    _look_at(dolly, center)
    _key_transform(dolly, 72)
    dolly.data.keyframe_insert("lens", frame=1)
    dolly.data.lens = 40.0
    dolly.data.keyframe_insert("lens", frame=72)

    orbit = add_cinematic_camera(context, "BE_Shot_Orbit", focus=subject)
    orbit.data.lens = 50.0
    orbit.data.dof.aperture_fstop = 2.0
    for index, frame in enumerate(range(73, 169, 12)):
        angle = math.radians(-60 + index * 22.0)
        orbit.location = center + Vector((math.sin(angle) * 6.0, -math.cos(angle) * 6.0, 1.6 + index * 0.12))
        _look_at(orbit, center)
        _key_transform(orbit, frame)

    for marker in [m for m in scene.timeline_markers if m.camera is not None]:
        scene.timeline_markers.remove(marker)
    add_camera_shot(scene, dolly, 1)
    add_camera_shot(scene, orbit, 73)
    scene.camera = dolly
    return dolly, orbit


class BE_OT_add_cinematic_camera(Operator):
    bl_idname = "blendengine.add_cinematic_camera"
    bl_label = "Add Cinematic Camera"
    bl_description = "Add a 35mm camera with depth of field focused on the active object"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        camera = add_cinematic_camera(context, focus=context.active_object)
        self.report({"INFO"}, "Added %s" % camera.name)
        return {"FINISHED"}


class BE_OT_add_camera_shot(Operator):
    bl_idname = "blendengine.add_camera_shot"
    bl_label = "Cut To Camera Here"
    bl_description = "Add a timeline marker that cuts to the selected camera at the current frame"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        camera = context.active_object if context.active_object and context.active_object.type == "CAMERA" else context.scene.camera
        if camera is None:
            self.report({"ERROR"}, "Select a camera first")
            return {"CANCELLED"}
        marker = add_camera_shot(context.scene, camera, context.scene.frame_current)
        self.report({"INFO"}, "%s: cut to %s at frame %d" % (marker.name, camera.name, marker.frame))
        return {"FINISHED"}


class BE_OT_create_demo_sequence(Operator):
    bl_idname = "blendengine.create_demo_sequence"
    bl_label = "Demo Film Sequence"
    bl_description = "Add a two-shot cinematic (dolly-in and orbit) around the player or active object"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        dolly, orbit = create_demo_sequence(context)
        self.report({"INFO"}, "Added shots %s and %s (frames %d-%d)" % (dolly.name, orbit.name, context.scene.frame_start, context.scene.frame_end))
        return {"FINISHED"}


class BE_OT_render_film(Operator):
    bl_idname = "blendengine.render_film"
    bl_label = "Render Film"
    bl_description = "Render the timeline as an MP4 film with Eevee or Cycles into the build folder"
    bl_options = {"REGISTER"}

    def execute(self, context):
        scene = context.scene
        if scene.camera is None:
            self.report({"ERROR"}, "Add a camera first")
            return {"CANCELLED"}
        path = configure_film_render(scene, film_output_path(scene))
        print("[BlendEngine] Rendering film frames %d-%d with %s to %s" % (scene.frame_start, scene.frame_end, scene.render.engine, path))
        if bpy.app.background:
            bpy.ops.render.render(animation=True)
        else:
            bpy.ops.render.render("INVOKE_DEFAULT", animation=True)
        self.report({"INFO"}, "Rendering film to %s" % path)
        return {"FINISHED"}


def draw_film(layout, scene):
    film = scene.blendengine_film
    layout.use_property_split = True
    layout.use_property_decorate = False
    col = layout.column(align=True)
    col.operator("blendengine.add_cinematic_camera", icon="OUTLINER_OB_CAMERA")
    col.operator("blendengine.add_camera_shot", icon="MARKER_HLT")
    col.operator("blendengine.create_demo_sequence", icon="SEQUENCE")
    layout.label(text="Timeline: frames %d-%d at %d fps, %d shots" % (
        scene.frame_start, scene.frame_end, scene.render.fps, sum(1 for m in scene.timeline_markers if m.camera)))
    layout.prop(film, "play_mode")
    layout.prop(film, "export_animation")
    layout.prop(film, "animated_props_loop")
    box = layout.box()
    box.label(text="Film Look", icon="CAMERA_DATA")
    box.prop(film, "letterbox")
    box.prop(film, "depth_of_field")
    box.prop(film, "motion_blur")
    box.prop(film, "film_grain")
    box.prop(film, "chromatic_aberration")
    box.prop(film, "vignette")
    box.prop(film, "contrast")
    box.prop(film, "saturation")
    box.prop(film, "temperature")
    box.prop(film, "render_samples")
    box = layout.box()
    box.label(text="Blender Film Render", icon="RENDER_ANIMATION")
    box.prop(film, "film_engine")
    box.prop(film, "film_samples")
    box.prop(film, "film_resolution")
    box.prop(film, "film_quality")
    box.operator("blendengine.render_film", icon="RENDER_ANIMATION")


class VIEW3D_PT_blendengine_film(Panel):
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Film"
    bl_label = "Film Studio"

    def draw(self, context):
        draw_film(self.layout, context.scene)


classes = (
    BE_OT_add_cinematic_camera,
    BE_OT_add_camera_shot,
    BE_OT_create_demo_sequence,
    BE_OT_render_film,
    VIEW3D_PT_blendengine_film,
)


def register():
    for cls in classes:
        bpy.utils.register_class(cls)


def unregister():
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
