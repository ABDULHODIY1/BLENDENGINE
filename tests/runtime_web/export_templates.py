# SPDX-License-Identifier: GPL-2.0-or-later
#
# Export BlendEngine templates as standalone 3D web packages (headless).
#
#   blender --background --factory-startup --python tests/runtime_web/export_templates.py -- <out_dir> [basic|shooter|2d ...]
#   python tests/runtime_web/export_templates.py -- <out_dir> basic      (with the bpy module)
#
# Each template is written to <out_dir>/<name>/web_player/index.html.

import os
import sys

import bpy

ADDONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "addons_core")
sys.path.insert(0, ADDONS_DIR)

import blendengine  # noqa: E402
from blendengine import export_system  # noqa: E402

TEMPLATES = {
    "basic": "generate_basic_template",
    "shooter": "generate_cyberpunk_shooter_template",
    "2d": "generate_2d_template",
}


def main():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not args:
        print(__doc__ or "usage: -- <out_dir> [basic|shooter|2d ...]")
        return 1
    out_dir = os.path.abspath(args[0])
    names = args[1:] or ["basic"]
    blendengine.register()
    for name in names:
        bpy.ops.wm.read_homefile(use_empty=True)
        getattr(bpy.ops.blendengine, TEMPLATES[name])()
        scene = bpy.context.scene
        scene.blendengine_project.target_platform = "WEB"
        scene.blendengine_project.build_folder = out_dir
        scene.blendengine_export.package_name = name
        package = export_system.prepare_build_package(bpy.context)
        print("[BlendEngine] %s -> %s" % (name, os.path.join(package["package_dir"], "web_player", "index.html")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
