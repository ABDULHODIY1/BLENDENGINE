# SPDX-License-Identifier: GPL-2.0-or-later
#
# Scene package export for the BlendEngine 3D runtime.
#
# Converts the Blender scene into a compact package the standalone WebGL2
# runtime (runtime_web/) can draw: triangulated meshes with split normals and
# UVs, Principled BSDF materials, textures, lights, camera, world and the
# gameplay data from export_system.serialize_game_data().
#
# Layout of the produced data (see runtime_web/blendengine_runtime.js):
#   {"format": "BlendEngineScene", "version": 2,
#    "meshes": [...], "materials": [...], "textures": [...],
#    "nodes": [...], "camera": {...}, "world": {...}, "render": {...},
#    "game": {...}, "buffer": "<base64 binary>"}
#
# Everything is written into one JavaScript file (scene_data.js) so the player
# also works when index.html is opened straight from disk or from an
# Android/iOS WebView, where fetch() of local files is blocked.

import base64
import json
import math
import os
import tempfile

import bpy

try:
    import numpy as np
except ImportError:  # Blender always bundles numpy; keep a clear message if not.
    np = None


SCENE_FORMAT = "BlendEngineScene"
SCENE_VERSION = 2

RENDERABLE_TYPES = {"MESH", "CURVE", "SURFACE", "FONT", "META"}

TEXTURE_MAX_SIZE = {
    "LOW": 512,
    "MEDIUM": 1024,
    "HIGH": 2048,
    "ULTRA": 4096,
}

# Tags that never block movement even when they carry a collider.
NON_BLOCKING_TAGS = {"Water", "Trigger", "Coin", "Health", "Damage", "Checkpoint", "Spawn", "WorldLabel"}


class BinaryWriter:
    """Collects typed arrays into one little-endian buffer with 4 byte alignment."""

    def __init__(self):
        self._chunks = []
        self.size = 0

    def _align(self):
        padding = (-self.size) % 4
        if padding:
            self._chunks.append(b"\0" * padding)
            self.size += padding

    def add_bytes(self, data):
        self._align()
        offset = self.size
        self._chunks.append(data)
        self.size += len(data)
        return offset

    def add_array(self, array):
        return self.add_bytes(array.tobytes())

    def getvalue(self):
        self._align()
        return b"".join(self._chunks)


# -----------------------------------------------------------------------------
# Mesh extraction


def _corner_normals(mesh, loop_count):
    normals = np.empty(loop_count * 3, dtype=np.float32)
    corner_normals = getattr(mesh, "corner_normals", None)
    if corner_normals is not None:
        # Blender 4.1+.
        corner_normals.foreach_get("vector", normals)
        return normals
    # Blender 3.x / 4.0.
    if hasattr(mesh, "calc_normals_split"):
        mesh.calc_normals_split()
    mesh.loops.foreach_get("normal", normals)
    return normals


def extract_mesh_arrays(mesh):
    """Return (positions, normals, uvs or None, indices, material_slots) for a triangulated mesh.

    Vertices are welded per (vertex, normal, uv) so smooth surfaces share vertices
    while hard edges and UV seams stay split.
    """
    mesh.calc_loop_triangles()
    tri_count = len(mesh.loop_triangles)
    if tri_count == 0:
        return None

    loop_count = len(mesh.loops)
    vertex_count = len(mesh.vertices)

    tri_loops = np.empty(tri_count * 3, dtype=np.int32)
    mesh.loop_triangles.foreach_get("loops", tri_loops)
    tri_materials = np.empty(tri_count, dtype=np.int32)
    mesh.loop_triangles.foreach_get("material_index", tri_materials)

    loop_vertex = np.empty(loop_count, dtype=np.int32)
    mesh.loops.foreach_get("vertex_index", loop_vertex)

    co = np.empty(vertex_count * 3, dtype=np.float32)
    mesh.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)

    normals = _corner_normals(mesh, loop_count).reshape(-1, 3)

    uv_layer = mesh.uv_layers.active if mesh.uv_layers else None
    uvs = None
    if uv_layer is not None and len(uv_layer.data) == loop_count:
        uvs = np.empty(loop_count * 2, dtype=np.float32)
        uv_layer.data.foreach_get("uv", uvs)
        uvs = uvs.reshape(-1, 2)

    # Weld loops sharing position, normal and uv.
    columns = [loop_vertex.astype(np.float32)[:, None], np.round(normals, 4)]
    if uvs is not None:
        columns.append(np.round(uvs, 5))
    keys = np.hstack(columns)
    _unique, first_loop, loop_to_vertex = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    loop_to_vertex = loop_to_vertex.reshape(-1)

    out_positions = co[loop_vertex[first_loop]]
    out_normals = normals[first_loop]
    norms = np.linalg.norm(out_normals, axis=1)
    norms[norms < 1e-8] = 1.0
    out_normals = out_normals / norms[:, None]
    out_uvs = uvs[first_loop] if uvs is not None else None

    triangles = loop_to_vertex[tri_loops].reshape(-1, 3)
    order = np.argsort(tri_materials, kind="stable")
    triangles = triangles[order]
    tri_materials = tri_materials[order]

    groups = []
    if tri_count:
        boundaries = np.flatnonzero(np.diff(tri_materials)) + 1
        starts = np.concatenate(([0], boundaries))
        ends = np.concatenate((boundaries, [tri_count]))
        for start, end in zip(starts, ends):
            groups.append((int(tri_materials[start]), int(start) * 3, int(end - start) * 3))

    return (
        out_positions.astype(np.float32),
        out_normals.astype(np.float32),
        out_uvs.astype(np.float32) if out_uvs is not None else None,
        triangles.reshape(-1),
        groups,
    )


def pack_mesh(writer, name, positions, normals, uvs, indices, groups, material_lookup):
    """Store mesh arrays in the binary writer and return the JSON description."""
    vertex_count = len(positions)
    index_array = indices.astype(np.uint16 if vertex_count < 65536 else np.uint32)
    entry = {
        "name": name,
        "vertexCount": int(vertex_count),
        "position": writer.add_array(positions.astype(np.float32)),
        "normal": writer.add_array(normals.astype(np.float32)),
        "uv": writer.add_array(uvs.astype(np.float32)) if uvs is not None else -1,
        "indexType": "uint16" if index_array.dtype == np.uint16 else "uint32",
        "index": writer.add_array(index_array),
        "indexCount": int(len(index_array)),
        "primitives": [],
    }
    for slot, first, count in groups:
        entry["primitives"].append({
            "material": material_lookup(slot),
            "first": first,
            "count": count,
        })
    low = positions.min(axis=0)
    high = positions.max(axis=0)
    center = (low + high) * 0.5
    entry["boundsMin"] = [float(v) for v in low]
    entry["boundsMax"] = [float(v) for v in high]
    entry["center"] = [float(v) for v in center]
    entry["radius"] = float(np.linalg.norm(positions - center, axis=1).max()) if vertex_count else 0.0
    return entry


# -----------------------------------------------------------------------------
# Materials and textures


def _input(node, *names):
    for name in names:
        socket = node.inputs.get(name)
        if socket is not None:
            return socket
    return None


def _linked_image(socket, depth=0):
    """Find an Image Texture feeding a socket, looking through simple pass-through nodes."""
    if socket is None or not socket.is_linked or depth > 4:
        return None
    node = socket.links[0].from_node
    if node.type == "TEX_IMAGE" and node.image is not None:
        return node.image
    for name in ("Color", "Image", "Color1", "A", "Fac"):
        upstream = node.inputs.get(name) if hasattr(node, "inputs") else None
        found = _linked_image(upstream, depth + 1)
        if found is not None:
            return found
    return None


def _socket_value(socket, fallback):
    if socket is None:
        return fallback
    try:
        value = socket.default_value
    except AttributeError:
        return fallback
    try:
        return list(value)
    except TypeError:
        return float(value)


def _find_principled(material):
    # node_tree alone is checked: Material.use_nodes is deprecated in Blender 5 and removed in 6.
    if material.node_tree is None:
        return None
    output = None
    for node in material.node_tree.nodes:
        if node.type == "OUTPUT_MATERIAL" and getattr(node, "is_active_output", True):
            output = node
            break
    if output is not None:
        surface = output.inputs.get("Surface")
        if surface is not None and surface.is_linked:
            node = surface.links[0].from_node
            if node.type == "BSDF_PRINCIPLED":
                return node
    for node in material.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            return node
    return None


def _material_uses_blend(material, alpha):
    method = getattr(material, "surface_render_method", None)
    if method == "BLENDED":
        return True
    if getattr(material, "blend_method", "OPAQUE") in {"BLEND", "HASHED"}:
        return alpha < 0.999
    return alpha < 0.999


def describe_material(material, texture_index):
    """Return a runtime material dict; texture_index(image, srgb) returns an index or -1."""
    base_color = list(getattr(material, "diffuse_color", (0.8, 0.8, 0.8, 1.0)))
    data = {
        "name": material.name,
        "baseColor": [float(v) for v in base_color[:4]],
        "metallic": float(getattr(material, "metallic", 0.0)),
        "roughness": float(getattr(material, "roughness", 0.5)),
        "emission": [0.0, 0.0, 0.0],
        "emissionStrength": 0.0,
        "alpha": float(base_color[3]) if len(base_color) > 3 else 1.0,
        "blend": False,
        "doubleSided": not getattr(material, "use_backface_culling", False),
        "baseColorTexture": -1,
        "normalTexture": -1,
        "roughnessTexture": -1,
        "emissionTexture": -1,
        "normalStrength": 1.0,
    }
    node = _find_principled(material)
    if node is not None:
        base_socket = _input(node, "Base Color")
        color = _socket_value(base_socket, data["baseColor"])
        if isinstance(color, list):
            data["baseColor"] = [float(v) for v in (color + [1.0])[:4]]
        image = _linked_image(base_socket)
        if image is not None:
            data["baseColorTexture"] = texture_index(image, True)
            data["baseColor"][:3] = [1.0, 1.0, 1.0]

        data["metallic"] = float(_socket_value(_input(node, "Metallic"), data["metallic"]))
        roughness_socket = _input(node, "Roughness")
        data["roughness"] = float(_socket_value(roughness_socket, data["roughness"]))
        image = _linked_image(roughness_socket)
        if image is not None:
            data["roughnessTexture"] = texture_index(image, False)

        alpha = _socket_value(_input(node, "Alpha"), 1.0)
        data["alpha"] = float(alpha) if not isinstance(alpha, list) else 1.0
        data["baseColor"][3] = data["alpha"]

        emission_socket = _input(node, "Emission Color", "Emission")
        emission = _socket_value(emission_socket, [0.0, 0.0, 0.0, 1.0])
        if isinstance(emission, list):
            data["emission"] = [float(v) for v in emission[:3]]
        strength = _socket_value(_input(node, "Emission Strength"), 1.0)
        data["emissionStrength"] = float(strength) if not isinstance(strength, list) else 1.0
        image = _linked_image(emission_socket)
        if image is not None:
            data["emissionTexture"] = texture_index(image, True)
            if max(data["emission"]) <= 0.0:
                data["emission"] = [1.0, 1.0, 1.0]

        normal_socket = _input(node, "Normal")
        if normal_socket is not None and normal_socket.is_linked:
            normal_node = normal_socket.links[0].from_node
            if normal_node.type == "NORMAL_MAP":
                image = _linked_image(normal_node.inputs.get("Color"))
                if image is not None:
                    data["normalTexture"] = texture_index(image, False)
                    data["normalStrength"] = float(_socket_value(normal_node.inputs.get("Strength"), 1.0))

    data["blend"] = _material_uses_blend(material, data["alpha"])
    data["roughness"] = min(1.0, max(0.03, data["roughness"]))
    data["metallic"] = min(1.0, max(0.0, data["metallic"]))
    return data


def _image_mime(data, filepath=""):
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    extension = os.path.splitext(filepath)[1].lower()
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(extension, "")


def _save_image_copy(image, max_size, use_jpeg):
    """Write a (possibly downscaled) copy of an image to a temp file and return its bytes."""
    copy = image.copy()
    try:
        width, height = copy.size
        if max_size and max(width, height) > max_size:
            factor = float(max_size) / max(width, height)
            copy.scale(max(1, int(width * factor)), max(1, int(height * factor)))
        extension = ".jpg" if use_jpeg else ".png"
        handle, path = tempfile.mkstemp(suffix=extension, prefix="blendengine_tex_")
        os.close(handle)
        try:
            copy.filepath_raw = path
            copy.file_format = "JPEG" if use_jpeg else "PNG"
            copy.save()
            with open(path, "rb") as stream:
                return stream.read()
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
    finally:
        bpy.data.images.remove(copy)


def encode_image(image, max_size):
    """Return (mime, bytes) for an image, downscaling oversized images."""
    width, height = tuple(image.size) if image.has_data or image.source != "FILE" else (0, 0)
    if not width:
        try:
            image.reload()
            width, height = tuple(image.size)
        except Exception:
            width = height = 0
    oversized = bool(max_size and max(width, height) > max_size)

    raw = None
    filepath = ""
    if image.packed_file is not None:
        raw = bytes(image.packed_file.data)
    elif image.source == "FILE":
        filepath = bpy.path.abspath(image.filepath, library=image.library)
        if os.path.isfile(filepath):
            with open(filepath, "rb") as stream:
                raw = stream.read()

    if raw is not None and not oversized:
        mime = _image_mime(raw, filepath)
        if mime:
            return mime, raw

    if not width:
        return None, None
    use_jpeg = image.channels < 4
    try:
        data = _save_image_copy(image, max_size, use_jpeg)
    except Exception as ex:
        print("[BlendEngine] Texture %s skipped: %s" % (image.name, ex))
        return None, None
    return ("image/jpeg" if use_jpeg else "image/png"), data


# -----------------------------------------------------------------------------
# Scene graph


def _matrix_list(matrix):
    # Column-major, the layout WebGL expects.
    return [float(matrix[row][col]) for col in range(4) for row in range(4)]


def _trs(matrix):
    location, rotation, scale = matrix.decompose()
    return {
        "position": [float(v) for v in location],
        "rotation": [float(rotation.x), float(rotation.y), float(rotation.z), float(rotation.w)],
        "scale": [float(v) for v in scale],
    }


def _light_data(obj):
    light = obj.data
    energy = float(getattr(light, "energy", 1.0))
    color = [float(v) for v in light.color]
    data = {
        "type": light.type,
        "color": color,
        "energy": energy,
        "shadow": bool(getattr(light, "use_shadow", True)),
        "radius": float(getattr(light, "shadow_soft_size", 0.25)),
        "range": float(getattr(light, "cutoff_distance", 0.0)) if getattr(light, "use_custom_distance", False) else 0.0,
    }
    if light.type == "SUN":
        # Blender sun strength is irradiance in W/m^2, which maps well to runtime units.
        data["intensity"] = energy
        data["angle"] = float(getattr(light, "angle", 0.0))
    else:
        # Watts to radiant intensity, matching Eevee's point-light convention.
        data["intensity"] = energy / (4.0 * math.pi * math.pi)
        if light.type == "AREA":
            data["intensity"] *= 0.9
    if light.type == "SPOT":
        data["spotSize"] = float(light.spot_size)
        data["spotBlend"] = float(light.spot_blend)
    return data


def _camera_data(obj, scene):
    camera = obj.data
    render = scene.render
    aspect = max(1e-6, (render.resolution_x * render.pixel_aspect_x) / max(1e-6, render.resolution_y * render.pixel_aspect_y))
    if camera.type == "ORTHO":
        return {
            "type": "ORTHO",
            "orthoScale": float(camera.ortho_scale),
            "near": float(camera.clip_start),
            "far": float(camera.clip_end),
        }
    dof = camera.dof
    return {
        "type": "PERSP",
        "fovY": _camera_fov_y(camera, aspect),
        "near": max(0.01, float(camera.clip_start)),
        "far": max(10.0, float(camera.clip_end)),
        "lens": float(camera.lens),
        "sensor": float(camera.sensor_width),
        "dof": {
            "enabled": bool(dof.use_dof),
            "focusDistance": float(dof.focus_distance),
            "focusObject": dof.focus_object.name if dof.focus_object is not None else "",
            "fstop": float(dof.aperture_fstop),
        },
    }


def _camera_fov_y(camera, aspect):
    if camera.sensor_fit == "VERTICAL":
        return max(0.05, min(2.6, float(camera.angle_y)))
    fov_x = float(camera.angle_x)
    return max(0.05, min(2.6, 2.0 * math.atan(math.tan(fov_x * 0.5) / aspect)))


def _world_data(scene):
    world = scene.world
    color = [0.05, 0.05, 0.05]
    strength = 1.0
    if world is not None:
        color = [float(v) for v in world.color]
        if world.node_tree is not None:
            for node in world.node_tree.nodes:
                if node.type == "BACKGROUND":
                    socket = node.inputs.get("Color")
                    if socket is not None and not socket.is_linked:
                        color = [float(v) for v in socket.default_value[:3]]
                    strength_socket = node.inputs.get("Strength")
                    if strength_socket is not None:
                        strength = float(strength_socket.default_value)
                    break
    return {"color": color, "strength": strength}


def _object_hidden_in_game(obj):
    if obj.hide_render:
        return True
    if obj.display_type in {"WIRE", "BOUNDS"}:
        has_material = any(slot.material is not None for slot in obj.material_slots)
        return not has_material
    return False


def _object_game_entry(obj, objects_by_name):
    return objects_by_name.get(obj.name)


def _blocks_movement(obj, game_entry):
    """True when the object becomes part of the runtime's static collision world."""
    if game_entry is None or obj.type == "FONT" or obj.hide_render:
        return False
    components = {c["type"] for c in game_entry["components"] if c["enabled"]}
    if components & {"TRIGGER_ZONE", "PLAYER_CONTROLLER", "NPC_CONTROLLER", "RIGIDBODY", "DOOR"}:
        return False
    if game_entry["tag"] in NON_BLOCKING_TAGS:
        return False
    if "COLLIDER" in components or game_entry["tag"] == "Ground":
        return True
    # Static level geometry (imported cities, rocks, props) blocks by default.
    optimization = game_entry.get("optimization") or {}
    return bool(optimization.get("static_object")) and not optimization.get("dynamic_object")


MAX_BAKED_FRAMES = 3600


def _export_parent(obj, node_index):
    # Cameras are exported as roots in world space so the runtime camera rig and
    # the sequencer can drive them directly.
    if obj.type == "CAMERA" or obj.parent is None or obj.parent.name not in node_index:
        return None
    return obj.parent


def _is_animated(id_data):
    animation = getattr(id_data, "animation_data", None)
    if animation is None:
        return False
    return animation.action is not None or bool(getattr(animation, "drivers", None)) or bool(animation.nla_tracks)


def _animated_objects(objects):
    """Objects whose transform (or camera lens) changes over the timeline."""
    animated = set()
    for obj in objects:
        if _is_animated(obj) or obj.constraints or (obj.type == "CAMERA" and _is_animated(obj.data)):
            animated.add(obj.name)
    changed = True
    while changed:  # children of animated parents move too
        changed = False
        for obj in objects:
            if obj.name not in animated and obj.parent is not None and obj.parent.name in animated:
                animated.add(obj.name)
                changed = True
    return animated


def bake_timeline(scene, exported, node_index):
    """Sample animated transforms every frame. Returns (timeline, tracks by node index)."""
    animated = _animated_objects(exported)
    start, end = scene.frame_start, scene.frame_end
    end = min(end, start + MAX_BAKED_FRAMES - 1)
    fps = scene.render.fps / max(scene.render.fps_base, 1e-6)
    markers = []
    for marker in sorted(scene.timeline_markers, key=lambda m: m.frame):
        if marker.camera is not None and marker.camera.name in node_index:
            markers.append({"frame": int(marker.frame), "camera": node_index[marker.camera.name], "name": marker.name})
    timeline = {
        "frameStart": int(start),
        "frameEnd": int(end),
        "fps": float(fps),
        "cameraMarkers": markers,
    }
    if not animated:
        return timeline, {}
    objects = [obj for obj in exported if obj.name in animated]
    tracks = {obj.name: {"position": [], "rotation": [], "scale": [], "fovY": []} for obj in objects}
    render = scene.render
    aspect = max(1e-6, (render.resolution_x * render.pixel_aspect_x) / max(1e-6, render.resolution_y * render.pixel_aspect_y))
    current = scene.frame_current
    try:
        for frame in range(start, end + 1):
            scene.frame_set(frame)
            for obj in objects:
                parent = _export_parent(obj, node_index)
                local = obj.matrix_world if parent is None else parent.matrix_world.inverted_safe() @ obj.matrix_world
                location, rotation, scale = local.decompose()
                track = tracks[obj.name]
                track["position"].extend(round(float(v), 5) for v in location)
                track["rotation"].extend(round(float(v), 6) for v in (rotation.x, rotation.y, rotation.z, rotation.w))
                track["scale"].extend(round(float(v), 5) for v in scale)
                if obj.type == "CAMERA" and obj.data.type != "ORTHO":
                    track["fovY"].append(round(_camera_fov_y(obj.data, aspect), 6))
    finally:
        scene.frame_set(current)
    result = {}
    for obj in objects:
        track = tracks[obj.name]
        if not track["fovY"]:
            del track["fovY"]
        result[node_index[obj.name]] = track
    return timeline, result


def collect_scene(context, scene, game_data, texture_quality="MEDIUM", bake_animation=True):
    """Build the runtime scene dict and binary buffer for a scene."""
    if np is None:
        raise RuntimeError("numpy is required to export meshes")

    depsgraph = context.evaluated_depsgraph_get()
    writer = BinaryWriter()
    max_texture = TEXTURE_MAX_SIZE.get(texture_quality, 1024)

    textures = []
    texture_cache = {}
    materials = []
    material_cache = {}
    meshes = []
    mesh_cache = {}
    nodes = []
    node_index = {}

    def texture_index(image, srgb):
        key = (image.name, srgb)
        if key in texture_cache:
            return texture_cache[key]
        mime, data = encode_image(image, max_texture)
        if data is None:
            texture_cache[key] = -1
            return -1
        textures.append({
            "name": image.name,
            "srgb": srgb,
            "uri": "data:%s;base64,%s" % (mime, base64.b64encode(data).decode("ascii")),
        })
        texture_cache[key] = len(textures) - 1
        return texture_cache[key]

    def material_index(material):
        key = material.name if material is not None else None
        if key in material_cache:
            return material_cache[key]
        if material is None:
            materials.append({
                "name": "Default",
                "baseColor": [0.8, 0.8, 0.8, 1.0],
                "metallic": 0.0,
                "roughness": 0.6,
                "emission": [0.0, 0.0, 0.0],
                "emissionStrength": 0.0,
                "alpha": 1.0,
                "blend": False,
                "doubleSided": True,
                "baseColorTexture": -1,
                "normalTexture": -1,
                "roughnessTexture": -1,
                "emissionTexture": -1,
                "normalStrength": 1.0,
            })
        else:
            materials.append(describe_material(material, texture_index))
        material_cache[key] = len(materials) - 1
        return material_cache[key]

    def mesh_index(obj):
        evaluated = obj.evaluated_get(depsgraph)
        # Objects sharing unmodified mesh data share one GPU mesh (cheap instancing).
        shareable = obj.type == "MESH" and not any(m.show_render for m in obj.modifiers)
        key = ("data", obj.data.name) if shareable else ("object", obj.name)
        if key in mesh_cache:
            return mesh_cache[key]
        try:
            mesh = evaluated.to_mesh()
        except RuntimeError:
            mesh = None
        if mesh is None:
            mesh_cache[key] = -1
            return -1
        try:
            arrays = extract_mesh_arrays(mesh)
            if arrays is None:
                mesh_cache[key] = -1
                return -1
            positions, normals, uvs, indices, groups = arrays
            slots = [slot.material for slot in evaluated.material_slots]

            def lookup(slot_index):
                material = slots[slot_index] if 0 <= slot_index < len(slots) else None
                return material_index(material)

            meshes.append(pack_mesh(writer, key[1], positions, normals, uvs, indices, groups, lookup))
        finally:
            evaluated.to_mesh_clear()
        mesh_cache[key] = len(meshes) - 1
        return mesh_cache[key]

    objects_by_name = {entry["name"]: entry for entry in game_data.get("objects", [])}

    exported = [
        obj for obj in scene.objects
        if obj.type in RENDERABLE_TYPES | {"LIGHT", "CAMERA", "EMPTY"}
    ]
    for obj in exported:
        node_index[obj.name] = len(node_index)

    for obj in exported:
        parent = _export_parent(obj, node_index)
        local = obj.matrix_world if parent is None else parent.matrix_world.inverted_safe() @ obj.matrix_world
        game_entry = _object_game_entry(obj, objects_by_name)
        node = {
            "name": obj.name,
            "type": obj.type,
            "parent": node_index[parent.name] if parent is not None else -1,
            "matrix": _matrix_list(local),
            "world": _matrix_list(obj.matrix_world),
            "mesh": -1,
            "visible": not _object_hidden_in_game(obj),
            "castShadow": True,
            "dimensions": [float(v) for v in obj.dimensions],
            "game": game_entry,
            "blocking": _blocks_movement(obj, game_entry),
        }
        node.update(_trs(local))
        if obj.type in RENDERABLE_TYPES:
            node["mesh"] = mesh_index(obj)
            if obj.type == "FONT":
                node["castShadow"] = False
        elif obj.type == "LIGHT":
            node["light"] = _light_data(obj)
        elif obj.type == "CAMERA":
            node["camera"] = _camera_data(obj, scene)
        nodes.append(node)

    timeline = {"frameStart": scene.frame_start, "frameEnd": scene.frame_end, "fps": float(scene.render.fps), "cameraMarkers": []}
    if bake_animation:
        timeline, tracks = bake_timeline(scene, exported, node_index)
        for index, track in tracks.items():
            nodes[index]["animation"] = track
    camera_index = node_index.get(scene.camera.name, -1) if scene.camera is not None else -1
    view = scene.view_settings
    return {
        "format": SCENE_FORMAT,
        "version": SCENE_VERSION,
        "up": "Z",
        "meshes": meshes,
        "materials": materials,
        "textures": textures,
        "nodes": nodes,
        "camera": camera_index,
        "world": _world_data(scene),
        "timeline": timeline,
        "colorManagement": {
            "viewTransform": view.view_transform,
            "look": view.look,
            "exposure": float(view.exposure),
            "gamma": float(view.gamma),
        },
        "game": game_data,
    }, writer.getvalue()


def runtime_settings(scene):
    """Rendering options for the web runtime derived from quality profile and export settings."""
    profile = scene.blendengine_quality_profile
    export = scene.blendengine_export
    optimization = scene.blendengine_optimization
    return {
        "sky": export.runtime_sky,
        "fogDensity": export.runtime_fog_density,
        "bloom": export.runtime_bloom,
        "ssao": export.runtime_ssao,
        "exposure": export.runtime_exposure,
        "shadowQuality": profile.shadow_quality,
        "antiAliasing": profile.anti_aliasing,
        "textureQuality": profile.texture_quality,
        "resolutionScale": float(profile.resolution_scale),
        "targetFps": int(profile.target_fps),
        "dynamicResolution": bool(optimization.dynamic_resolution),
        "maxDynamicLights": int(profile.max_dynamic_lights),
        "builtinRules": export.runtime_builtin_rules,
        "film": film_settings(scene),
    }


def film_settings(scene):
    film = getattr(scene, "blendengine_film", None)
    if film is None:
        return {}
    return {
        "playMode": film.play_mode,
        "loopProps": film.animated_props_loop,
        "letterbox": 0.0 if film.letterbox == "NONE" else float(film.letterbox),
        "dof": film.depth_of_field,
        "motionBlur": film.motion_blur,
        "grain": film.film_grain,
        "chromatic": film.chromatic_aberration,
        "vignette": film.vignette,
        "contrast": film.contrast,
        "saturation": film.saturation,
        "temperature": film.temperature,
        "samples": film.render_samples,
        "resolution": [scene.render.resolution_x, scene.render.resolution_y],
    }


def write_scene_script(path, scene_dict, binary):
    """Write scene data as a script so the player works from file:// and WebViews."""
    payload = dict(scene_dict)
    payload["buffer"] = base64.b64encode(binary).decode("ascii")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("window.BLENDENGINE_SCENE = ")
        json.dump(payload, handle, separators=(",", ":"))
        handle.write(";\n")


def export_scene_package(context, scene, game_data, directory):
    """Export scene_data.js into directory and return (files, stats)."""
    texture_quality = scene.blendengine_quality_profile.texture_quality
    film = getattr(scene, "blendengine_film", None)
    bake = film.export_animation if film is not None else True
    scene_dict, binary = collect_scene(context, scene, game_data, texture_quality=texture_quality, bake_animation=bake)
    scene_dict["settings"] = runtime_settings(scene)
    write_scene_script(os.path.join(directory, "scene_data.js"), scene_dict, binary)
    stats = {
        "meshes": len(scene_dict["meshes"]),
        "materials": len(scene_dict["materials"]),
        "textures": len(scene_dict["textures"]),
        "nodes": len(scene_dict["nodes"]),
        "triangles": sum(mesh["indexCount"] // 3 for mesh in scene_dict["meshes"]),
        "binary_bytes": len(binary),
    }
    return ["scene_data.js"], stats


def runtime_source_dir():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "runtime_web")


def copy_runtime(directory):
    """Copy the static runtime files (index.html, blendengine_runtime.js) into directory."""
    os.makedirs(directory, exist_ok=True)
    written = []
    source = runtime_source_dir()
    for name in sorted(os.listdir(source)):
        if not name.endswith((".html", ".js", ".css")):
            continue
        with open(os.path.join(source, name), "rb") as stream:
            data = stream.read()
        with open(os.path.join(directory, name), "wb") as stream:
            stream.write(data)
        written.append(name)
    return written


def register():
    pass


def unregister():
    pass

