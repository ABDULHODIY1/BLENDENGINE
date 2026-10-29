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


classes = (BLENDENGINE_OT_add_character,)


def register():
    for cls in classes:
        bpy.utils.register_class(cls)


def unregister():
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
