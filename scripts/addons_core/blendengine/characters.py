# SPDX-License-Identifier: GPL-2.0-or-later
#
# Skinned characters and weapons for BlendEngine games.
#
# Assets live in assets/characters/<id>/ and assets/weapons/<id>/ (built by
# tools/compile_character_assets.py). In the editor a character is a normal
# mesh object in its bind pose so it can be placed, scaled and given
# components; the custom properties below tell the exporter to ship the
# skeleton, animation clips and the chosen weapon instead of a static mesh.
#
#   be_character  asset id, e.g. "re_soldier_male"
#   be_variant    colour scheme, e.g. "desert"
#   be_weapon     weapon id carried in the right hand ("" for none)

import json
import os

import bpy

ASSET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")


def _read_asset(kind, ident):
    folder = os.path.join(ASSET_DIR, kind, ident)
    name = "character" if kind == "characters" else "weapon"
    with open(os.path.join(folder, name + ".json"), encoding="utf-8") as handle:
        info = json.load(handle)
    with open(os.path.join(folder, name + ".bin"), "rb") as handle:
        blob = handle.read()
    return folder, info, blob


_CACHE = {}


def load_character(ident):
    key = ("characters", ident)
    if key not in _CACHE:
        _CACHE[key] = _read_asset("characters", ident)
    return _CACHE[key]


def load_weapon(ident):
    key = ("weapons", ident)
    if key not in _CACHE:
        _CACHE[key] = _read_asset("weapons", ident)
    return _CACHE[key]


def available_characters():
    folder = os.path.join(ASSET_DIR, "characters")
    if not os.path.isdir(folder):
        return []
    return sorted(d for d in os.listdir(folder) if os.path.isfile(os.path.join(folder, d, "character.json")))


def available_weapons():
    folder = os.path.join(ASSET_DIR, "weapons")
    if not os.path.isdir(folder):
        return []
    return sorted(d for d in os.listdir(folder) if os.path.isfile(os.path.join(folder, d, "weapon.json")))


def character_variants(ident):
    return list(load_character(ident)[1].get("variants", {}))


def _array(blob, offset, dtype, count):
    import numpy as np
    return np.frombuffer(blob, dtype=dtype, count=count, offset=offset)


def _image(path, non_color=False):
    image = bpy.data.images.load(path, check_existing=True)
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    return image


def _material(name, base, normal=None, orm=None, emit=None):
    """Principled material wired like the exporter expects (base, roughness from G, emission, normal map)."""
    material = bpy.data.materials.get(name)
    if material is not None:
        return material
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    tree = material.node_tree
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    links = tree.links

    def tex(path, non_color, y):
        node = tree.nodes.new("ShaderNodeTexImage")
        node.image = _image(path, non_color)
        node.location = (-600, y)
        return node

    links.new(tex(base, False, 300).outputs["Color"], bsdf.inputs["Base Color"])
    if orm:
        # Roughness lives in the G channel; the runtime samples .g of the linked image.
        links.new(tex(orm, True, 0).outputs["Color"], bsdf.inputs["Roughness"])
        bsdf.inputs["Metallic"].default_value = 0.35
    if emit:
        socket = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
        links.new(tex(emit, False, -300).outputs["Color"], socket)
        strength = bsdf.inputs.get("Emission Strength")
        if strength is not None:
            strength.default_value = 2.0
    if normal:
        nmap = tree.nodes.new("ShaderNodeNormalMap")
        nmap.location = (-250, -500)
        links.new(tex(normal, True, -600).outputs["Color"], nmap.inputs["Color"])
        links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    return material


def character_material(ident, variant):
    folder, info, _blob = load_character(ident)
    v = info["variants"].get(variant) or next(iter(info["variants"].values()))
    t = info["textures"]
    j = lambda rel: os.path.normpath(os.path.join(folder, rel))  # noqa: E731
    skin = os.path.basename(os.path.dirname(j(v["base"])))
    return _material("BE_%s_%s" % (skin, variant), j(v["base"]), j(t["normal"]), j(t["orm"]), j(v["emit"]))


def weapon_material(ident):
    folder, info, _blob = load_weapon(ident)
    t = info["textures"]
    j = lambda rel: os.path.join(folder, rel)  # noqa: E731
    return _material("BE_Weapon_%s" % ident, j(t["base"]), j(t["normal"]), j(t["orm"]), j(t["emit"]))


def _mesh_from_arrays(name, positions, uvs, indices):
    mesh = bpy.data.meshes.new(name)
    tris = indices.reshape(-1, 3)
    mesh.from_pydata(positions.reshape(-1, 3).tolist(), [], tris.tolist())
    uv_layer = mesh.uv_layers.new(name="UVMap")
    loop_uv = uvs.reshape(-1, 2)[tris.reshape(-1)]
    uv_layer.data.foreach_set("uv", loop_uv.reshape(-1))
    for poly in mesh.polygons:
        poly.use_smooth = True
    mesh.update()
    return mesh


def character_mesh(ident):
    """Bind-pose preview mesh shared by every object using this character."""
    import numpy as np
    name = "BE_Character_%s" % ident
    mesh = bpy.data.meshes.get(name)
    if mesh is not None:
        return mesh
    _folder, info, blob = load_character(ident)
    m = info["mesh"]
    count = m["vertexCount"]
    positions = _array(blob, m["position"], np.float32, count * 3)
    uvs = _array(blob, m["uv"], np.float32, count * 2)
    index_type = np.uint16 if m["indexType"] == "uint16" else np.uint32
    indices = _array(blob, m["index"], index_type, m["indexCount"]).astype(np.int64)
    return _mesh_from_arrays(name, positions, uvs, indices)


def weapon_mesh(ident):
    import numpy as np
    name = "BE_Weapon_%s" % ident
    mesh = bpy.data.meshes.get(name)
    if mesh is not None:
        return mesh
    _folder, info, blob = load_weapon(ident)
    m = info["mesh"]
    count = m["vertexCount"]
    positions = _array(blob, m["position"], np.float32, count * 3)
    uvs = _array(blob, m["uv"], np.float32, count * 2)
    indices = _array(blob, m["index"], np.uint16, m["indexCount"]).astype(np.int64)
    mesh = _mesh_from_arrays(name, positions, uvs, indices)
    mesh.materials.append(weapon_material(ident))
    return mesh


def add_character(context, ident, name, location=(0.0, 0.0, 0.0), yaw=0.0, variant="", weapon="rifle", scale=1.0):
    """Create a character object (bind-pose mesh) with its own material variant."""
    variants = character_variants(ident)
    variant = variant if variant in variants else variants[0]
    data = character_mesh(ident).copy()
    data.name = "%s_mesh" % name
    data.materials.clear()
    data.materials.append(character_material(ident, variant))
    obj = bpy.data.objects.new(name, data)
    context.scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (0.0, 0.0, yaw)
    obj.scale = (scale, scale, scale)
    obj["be_character"] = ident
    obj["be_variant"] = variant
    obj["be_weapon"] = weapon or ""
    return obj


# -----------------------------------------------------------------------------
# Static props (trees, bushes, rocks, barrels) and surface materials


def available_props():
    folder = os.path.join(ASSET_DIR, "props")
    if not os.path.isdir(folder):
        return []
    return sorted(d for d in os.listdir(folder) if os.path.isfile(os.path.join(folder, d, "prop.json")))


def load_prop(ident):
    key = ("props", ident)
    if key not in _CACHE:
        folder = os.path.join(ASSET_DIR, "props", ident)
        with open(os.path.join(folder, "prop.json"), encoding="utf-8") as handle:
            info = json.load(handle)
        with open(os.path.join(folder, "prop.bin"), "rb") as handle:
            blob = handle.read()
        _CACHE[key] = (folder, info, blob)
    return _CACHE[key]


def _prop_material(folder, surface):
    t = surface["textures"]
    base = os.path.normpath(os.path.join(folder, t["base"]))
    normal = os.path.normpath(os.path.join(folder, t["normal"])) if t.get("normal") else None
    kind = surface.get("kind", "opaque")
    name = "BE_Prop_%s_%s" % (os.path.splitext(os.path.basename(base))[0], kind)
    material = bpy.data.materials.get(name)
    if material is not None:
        return material
    material = _material(name, base, normal)
    bsdf = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.85
    if kind == "foliage":
        image_node = bsdf.inputs["Base Color"].links[0].from_node
        material.node_tree.links.new(image_node.outputs["Alpha"], bsdf.inputs["Alpha"])
        material.blend_method = "CLIP"
        material["be_foliage"] = 1.0
        material.use_backface_culling = False
    return material


def prop_mesh(ident):
    """Shared mesh for a prop: every placement is a linked duplicate (GPU instancing)."""
    import numpy as np
    name = "BE_Prop_%s" % ident
    mesh = bpy.data.meshes.get(name)
    if mesh is not None:
        return mesh
    folder, info, blob = load_prop(ident)
    positions, uvs, indices, slots = [], [], [], []
    offset = 0
    for slot, surf in enumerate(info["surfaces"]):
        count = surf["vertexCount"]
        positions.append(_array(blob, surf["position"], np.float32, count * 3).reshape(-1, 3))
        uvs.append(_array(blob, surf["uv"], np.float32, count * 2).reshape(-1, 2))
        tris = _array(blob, surf["index"], np.uint32, surf["indexCount"]).astype(np.int64).reshape(-1, 3) + offset
        indices.append(tris)
        slots.append(np.full(len(tris), slot))
        offset += count
    mesh = _mesh_from_arrays(name, np.concatenate(positions), np.concatenate(uvs), np.concatenate(indices))
    for surf in info["surfaces"]:
        mesh.materials.append(_prop_material(folder, surf))
    mesh.polygons.foreach_set("material_index", np.concatenate(slots).astype(np.int32))
    mesh.update()
    return mesh


def add_prop(context, ident, name, location=(0.0, 0.0, 0.0), yaw=0.0, scale=1.0):
    obj = bpy.data.objects.new(name, prop_mesh(ident))
    context.scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (0.0, 0.0, yaw)
    obj.scale = (scale, scale, scale)
    obj["be_prop"] = ident
    return obj


def texture_path(name, normal=False):
    return os.path.join(ASSET_DIR, "textures", name + ("_n.png" if normal else ".png"))


def surface_material(name, texture, tile_metres=2.0, roughness=0.8, tint=(1.0, 1.0, 1.0)):
    """World-projected (triplanar) material using an engine surface texture: no UVs needed."""
    material = bpy.data.materials.get(name)
    if material is not None:
        return material
    normal = texture_path(texture, True)
    material = _material(name, texture_path(texture), normal if os.path.isfile(normal) else None)
    bsdf = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = roughness
    material.diffuse_color = (*tint, 1.0)
    material["be_triplanar"] = float(tile_metres)
    return material


def terrain_material(name, layers):
    """Terrain material: layers = [(texture, tile metres)] for grass, dirt patches and rock slopes."""
    material = bpy.data.materials.get(name)
    if material is not None:
        return material
    first = layers[0][0]
    normal = texture_path(first, True)
    material = _material(name, texture_path(first), normal if os.path.isfile(normal) else None)
    bsdf = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.92
    material["be_terrain"] = json.dumps([{"texture": t, "scale": float(sc)} for t, sc in layers])
    return material


def hdri_world(scene, name="forest", strength=1.0, rotation=0.0):
    """Use one of Blender's bundled HDRIs (studiolights/world, CC0) as the world: lighting + sky."""
    path = os.path.join(bpy.utils.system_resource("DATAFILES", path="studiolights/world"), name + ".exr")
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    tree = world.node_tree
    tree.nodes.clear()
    out = tree.nodes.new("ShaderNodeOutputWorld")
    bg = tree.nodes.new("ShaderNodeBackground")
    env = tree.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(path, check_existing=True)
    if rotation:
        coords = tree.nodes.new("ShaderNodeTexCoord")
        mapping = tree.nodes.new("ShaderNodeMapping")
        mapping.inputs["Rotation"].default_value[2] = rotation
        tree.links.new(coords.outputs["Generated"], mapping.inputs["Vector"])
        tree.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
    bg.inputs["Strength"].default_value = strength
    tree.links.new(env.outputs["Color"], bg.inputs["Color"])
    tree.links.new(bg.outputs["Background"], out.inputs["Surface"])
    return env.image


class BLENDENGINE_OT_add_prop(bpy.types.Operator):
    bl_idname = "blendengine.add_prop"
    bl_label = "Add Prop"
    bl_description = "Add a textured tree, bush, rock or prop (linked duplicates are GPU instanced)"
    bl_options = {"REGISTER", "UNDO"}

    prop: bpy.props.EnumProperty(name="Prop", items=lambda self, ctx: [(p, p.replace("_", " ").title(), "") for p in available_props()] or [("", "None", "")])

    def execute(self, context):
        if not self.prop:
            return {"CANCELLED"}
        obj = add_prop(context, self.prop, "BE_%s" % self.prop, context.scene.cursor.location.copy())
        for other in context.selected_objects:
            other.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj
        return {"FINISHED"}


class BLENDENGINE_OT_add_character(bpy.types.Operator):
    bl_idname = "blendengine.add_character"
    bl_label = "Add Character"
    bl_description = "Add an animated soldier (skeleton, run/shoot/death animations, weapon)"
    bl_options = {"REGISTER", "UNDO"}

    character: bpy.props.EnumProperty(name="Character", items=lambda self, ctx: [(c, c.replace("_", " ").title(), "") for c in available_characters()] or [("", "None", "")])
    variant: bpy.props.StringProperty(name="Variant", default="urban")
    weapon: bpy.props.EnumProperty(name="Weapon", items=lambda self, ctx: [("", "None", "")] + [(w, w.title(), "") for w in available_weapons()])

    def execute(self, context):
        if not self.character:
            self.report({"ERROR"}, "No character assets installed")
            return {"CANCELLED"}
        obj = add_character(context, self.character, "BE_%s" % self.character, context.scene.cursor.location.copy(), variant=self.variant, weapon=self.weapon)
        for other in context.selected_objects:
            other.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj
        return {"FINISHED"}


classes = (BLENDENGINE_OT_add_character, BLENDENGINE_OT_add_prop)


def register():
    for cls in classes:
        bpy.utils.register_class(cls)


def unregister():
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
