# SPDX-License-Identifier: GPL-2.0-or-later
#
# Checks the BlendEngine 3D runtime export (scene_export.py).
#
# Run with:
#   blender --background --factory-startup --python tests/python/blendengine_scene_export_test.py
# or with the bpy module:
#   python tests/python/blendengine_scene_export_test.py

import base64
import json
import os
import struct
import sys
import tempfile
import unittest

import bpy

ADDONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "addons_core")
if ADDONS_DIR not in sys.path:
    sys.path.insert(0, ADDONS_DIR)

import blendengine  # noqa: E402
from blendengine import export_system  # noqa: E402


def load_scene_script(path):
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    prefix = "window.BLENDENGINE_SCENE = "
    assert text.startswith(prefix)
    return json.loads(text[len(prefix):].rstrip().rstrip(";"))


class SceneExportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            blendengine.register()
        except ValueError:
            pass  # Already registered by a previous run in this session.
        bpy.ops.blendengine.generate_basic_template()
        scene = bpy.context.scene
        cls.tmp = tempfile.mkdtemp(prefix="blendengine_export_")
        scene.blendengine_project.target_platform = "WEB"
        scene.blendengine_project.build_folder = cls.tmp
        scene.blendengine_export.package_name = "ExportTest"
        cls.package = export_system.prepare_build_package(bpy.context)
        cls.web_dir = os.path.join(cls.package["package_dir"], "web_player")
        cls.data = load_scene_script(os.path.join(cls.web_dir, "scene_data.js"))
        cls.buffer = base64.b64decode(cls.data["buffer"])

    def test_runtime_files_written(self):
        for name in ("index.html", "blendengine_runtime.js", "scene_data.js", "game_scripts.js", "game_data.json"):
            self.assertTrue(os.path.isfile(os.path.join(self.web_dir, name)), name)

    def test_manifest_lists_existing_files(self):
        with open(self.package["manifest"], encoding="utf-8") as handle:
            manifest = json.load(handle)
        for name in manifest["files"]:
            self.assertTrue(os.path.exists(os.path.join(self.package["package_dir"], name)), name)

    def test_format(self):
        self.assertEqual(self.data["format"], "BlendEngineScene")
        self.assertEqual(self.data["version"], 2)
        self.assertGreater(len(self.data["meshes"]), 10)
        self.assertGreater(len(self.data["materials"]), 5)
        self.assertIn("settings", self.data)
        self.assertGreaterEqual(self.data["camera"], 0)

    def test_mesh_buffers_are_consistent(self):
        size = len(self.buffer)
        for mesh in self.data["meshes"]:
            count = mesh["vertexCount"]
            self.assertLessEqual(mesh["position"] + count * 12, size)
            self.assertLessEqual(mesh["normal"] + count * 12, size)
            if mesh["uv"] >= 0:
                self.assertLessEqual(mesh["uv"] + count * 8, size)
            item = 2 if mesh["indexType"] == "uint16" else 4
            self.assertEqual(mesh["indexCount"] % 3, 0)
            self.assertLessEqual(mesh["index"] + mesh["indexCount"] * item, size)
            fmt = "<%d%s" % (mesh["indexCount"], "H" if item == 2 else "I")
            indices = struct.unpack_from(fmt, self.buffer, mesh["index"])
            self.assertLess(max(indices), count)
            covered = sum(p["count"] for p in mesh["primitives"])
            self.assertEqual(covered, mesh["indexCount"])
            for primitive in mesh["primitives"]:
                self.assertLess(primitive["material"], len(self.data["materials"]))

    def test_normals_are_unit_length(self):
        mesh = self.data["meshes"][0]
        normals = struct.unpack_from("<%df" % (mesh["vertexCount"] * 3), self.buffer, mesh["normal"])
        for i in range(0, len(normals), 3):
            length = (normals[i] ** 2 + normals[i + 1] ** 2 + normals[i + 2] ** 2) ** 0.5
            self.assertAlmostEqual(length, 1.0, places=3)

    def test_gameplay_nodes(self):
        nodes = {node["name"]: node for node in self.data["nodes"]}
        player = nodes["BE_Player"]
        self.assertTrue(player["game"]["player_controller"]["enabled"])
        self.assertFalse(player["blocking"])
        self.assertTrue(nodes["BE_ForestRuins_Terrain"]["blocking"])
        self.assertTrue(any(node.get("light", {}).get("type") == "SUN" for node in self.data["nodes"]))
        coins = [node for node in self.data["nodes"] if node["game"] and node["game"]["tag"] == "Coin"]
        self.assertEqual(len(coins), 6)
        self.assertTrue(all(node["visible"] for node in coins))

    def test_materials(self):
        materials = {m["name"]: m for m in self.data["materials"]}
        coin = materials["BE_Glowing_GoldCoin"]
        self.assertGreater(coin["emissionStrength"], 0.0)
        self.assertGreater(coin["metallic"], 0.5)
        self.assertTrue(materials["BE_PBR_ShallowWater"]["blend"])
        self.assertFalse(materials["BE_PBR_MossyGround"]["blend"])


if __name__ == "__main__":
    argv = [sys.argv[0]] + (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    unittest.main(argv=argv)
