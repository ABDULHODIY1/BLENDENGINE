# SPDX-License-Identifier: GPL-2.0-or-later
#
# Export/build package helpers.

import json
import os
import re
import shutil
import stat

import bpy

from . import game_package, performance, scene_export, utils


def _safe_name(value, fallback="BlendEngineBuild"):
    value = re.sub(r"[^A-Za-z0-9_.-]+", "_", value or "")
    value = value.strip("._")
    return value or fallback


def _component_list(obj):
    return [
        {
            "name": component.name,
            "type": component.component_type,
            "enabled": component.enabled,
            "tag": component.tag,
            "notes": component.notes,
        }
        for component in obj.blendengine_object.components
    ]


def _variables(obj):
    values = []
    for variable in obj.blendengine_object.variables:
        value = variable.float_value
        if variable.variable_type == "BOOL":
            value = variable.bool_value
        elif variable.variable_type == "INT":
            value = variable.int_value
        elif variable.variable_type == "STRING":
            value = variable.string_value
        values.append({
            "name": variable.name,
            "type": variable.variable_type,
            "value": value,
            "description": variable.description,
        })
    return values


def _behaviors(obj):
    data = []
    for behavior in obj.blendengine_object.behaviors:
        data.append({
            "name": behavior.name,
            "enabled": behavior.enabled,
            "description": behavior.description,
            "events": [
                {
                    "name": event.name,
                    "type": event.event_type,
                    "key": event.key,
                    "tag": event.tag,
                    "timer_seconds": event.timer_seconds,
                    "custom_event": event.custom_event,
                }
                for event in behavior.events
            ],
            "conditions": [
                {
                    "name": condition.name,
                    "type": condition.condition_type,
                    "variable_name": condition.variable_name,
                    "compare": condition.compare,
                    "number_value": condition.number_value,
                    "text_value": condition.text_value,
                    "bool_value": condition.bool_value,
                }
                for condition in behavior.conditions
            ],
            "actions": [
                {
                    "name": action.name,
                    "type": action.action_type,
                    "target_object": action.target_object.name if action.target_object else "",
                    "animation": action.animation.name if action.animation else "",
                    "scene": action.scene.name if action.scene else "",
                    "variable_name": action.variable_name,
                    "number_value": action.number_value,
                    "text_value": action.text_value,
                    "vector_value": list(action.vector_value),
                }
                for action in behavior.actions
            ],
        })
    return data


def _player_settings(obj):
    player = obj.blendengine_object.player_controller
    return {
        "enabled": player.enabled,
        "controller_type": player.controller_type,
        "walk_speed": player.walk_speed,
        "run_speed": player.run_speed,
        "jump_force": player.jump_force,
        "gravity": player.gravity,
        "camera_follow": player.camera_follow.name if player.camera_follow else "",
    }


def _npc_settings(obj):
    npc = obj.blendengine_object.npc_behavior
    return {
        "enabled": npc.enabled,
        "behavior_template": npc.behavior_template,
        "target_object": npc.target_object.name if npc.target_object else "",
        "move_speed": npc.move_speed,
        "patrol_radius": npc.patrol_radius,
        "detection_range": npc.detection_range,
        "attack_range": npc.attack_range,
        "dialogue_text": npc.dialogue_text,
        "quest_id": npc.quest_id,
    }


def _health_settings(obj):
    health = obj.blendengine_object.health
    return {
        "enabled": health.enabled,
        "max_health": health.max_health,
        "current_health": health.current_health,
        "destroy_on_death": health.destroy_on_death,
        "game_over_on_death": health.game_over_on_death,
    }


def serialize_game_data(scene):
    project = scene.blendengine_project
    profile = scene.blendengine_quality_profile
    budget = scene.blendengine_performance_budget
    optimization = scene.blendengine_optimization
    editor = scene.blendengine_editor
    multiplayer = scene.blendengine_multiplayer
    metrics = performance.estimate_scene(scene)
    metrics.pop("unique_material_names", None)
    objects = []
    eevee = getattr(scene, "eevee", None)

    for obj in scene.objects:
        settings = obj.blendengine_object
        if not settings.is_game_object and not settings.components:
            continue
        objects.append({
            "name": obj.name,
            "type": obj.type,
            "tag": settings.object_tag,
            "location": list(obj.location),
            "rotation": list(obj.rotation_euler),
            "scale": list(obj.scale),
            "components": _component_list(obj),
            "variables": _variables(obj),
            "behaviors": _behaviors(obj),
            "player_controller": _player_settings(obj),
            "npc_behavior": _npc_settings(obj),
            "health": _health_settings(obj),
            "optimization": {
                "static_object": settings.optimization.static_object,
                "dynamic_object": settings.optimization.dynamic_object,
                "lod_group": settings.optimization.lod_group,
                "instancing_candidate": settings.optimization.instancing_candidate,
                "baked_lighting_candidate": settings.optimization.baked_lighting_candidate,
                "collider_simplification": settings.optimization.collider_simplification,
                "disable_when_far": settings.optimization.disable_when_far,
                "disable_distance": settings.optimization.disable_distance,
                "physics_sleep": settings.optimization.physics_sleep,
            },
        })

    quality_profile = {
        "preset": profile.preset,
        "target_fps": profile.target_fps,
        "resolution_scale": profile.resolution_scale,
        "texture_quality": profile.texture_quality,
        "shadow_quality": profile.shadow_quality,
        "anti_aliasing": profile.anti_aliasing,
        "max_dynamic_lights": profile.max_dynamic_lights,
        "max_shadow_casters": profile.max_shadow_casters,
    }
    performance_budget = {
        "max_triangles_visible": budget.max_triangles_visible,
        "max_draw_calls_estimated": budget.max_draw_calls_estimated,
        "max_texture_memory_mb": budget.max_texture_memory_mb,
        "max_dynamic_lights": budget.max_dynamic_lights,
        "max_shadow_casters": budget.max_shadow_casters,
        "max_rigidbodies": budget.max_rigidbodies,
        "max_particles": budget.max_particles,
        "max_bones_visible": budget.max_bones_visible,
        "target_fps": budget.target_fps,
    }

    return {
        "format": "BlendEngineGameData",
        "version": 1,
        "project": {
            "title": project.game_title,
            "default_scene": project.default_scene.name if project.default_scene else scene.name,
            "target_platform": project.target_platform,
            "game_dimension": project.game_dimension,
            "resolution": [project.resolution_x, project.resolution_y],
            "display_mode": project.display_mode,
            "quality_level": project.quality_level,
            "show_fps": project.show_fps,
            "debug_mode": project.debug_mode,
        },
        "quality": quality_profile,
        "quality_profile": quality_profile,
        "rendering": {
            "engine": scene.render.engine,
            "fps": scene.render.fps,
            "resolution_percentage": scene.render.resolution_percentage,
            "view_transform": scene.view_settings.view_transform,
            "look": scene.view_settings.look,
            "exposure": scene.view_settings.exposure,
            "gamma": scene.view_settings.gamma,
            "ambient_occlusion": bool(getattr(eevee, "use_gtao", False)) if eevee else False,
            "bloom": bool(getattr(eevee, "use_bloom", False)) if eevee else False,
            "screen_space_reflections": bool(getattr(eevee, "use_ssr", False)) if eevee else False,
            "soft_shadows": bool(getattr(eevee, "use_soft_shadows", False)) if eevee else False,
            "world_color": list(scene.world.color) if scene.world else [0.0, 0.0, 0.0],
        },
        "performance_budget": performance_budget,
        "runtime_optimization": {
            "one_gb_ram_mode": optimization.one_gb_ram_mode,
            "max_runtime_ram_mb": optimization.max_runtime_ram_mb,
            "camera_frustum_generation": optimization.camera_frustum_generation,
            "hide_behind_camera": optimization.hide_behind_camera,
            "hidden_surface_culling": optimization.hidden_surface_culling,
            "texture_streaming": optimization.texture_streaming,
            "mesh_streaming": optimization.mesh_streaming,
            "world_cell_size": optimization.world_cell_size,
            "visible_cell_radius": optimization.visible_cell_radius,
            "max_visible_objects": optimization.max_visible_objects,
            "generation_budget_ms": optimization.generation_budget_ms,
            "dynamic_resolution": optimization.dynamic_resolution,
            "emergency_quality_drop": optimization.emergency_quality_drop,
            "occlusion_culling": optimization.use_occlusion_culling,
            "frustum_culling": optimization.use_frustum_culling,
            "lod_strategy": optimization.use_lod_strategy,
            "level_streaming": optimization.level_streaming,
            "async_asset_loading": optimization.async_asset_loading,
        },
        "editor_tools": {
            "object_snap": editor.object_snap,
            "grid_snap": editor.grid_snap,
            "physics_preview": editor.physics_preview,
            "lighting_preview": editor.lighting_preview,
            "ai_navigation_preview": editor.ai_navigation_preview,
            "collision_preview": editor.collision_preview,
            "performance_heatmap": editor.performance_heatmap,
            "camera_preview": editor.camera_preview,
            "multiplayer_preview": editor.multiplayer_preview,
        },
        "multiplayer": {
            "enabled": multiplayer.enabled,
            "mode": multiplayer.mode,
            "max_players": multiplayer.max_players,
            "server_tick_rate": multiplayer.server_tick_rate,
            "port": multiplayer.port,
            "sync_position": multiplayer.sync_position,
            "sync_health": multiplayer.sync_health,
            "sync_inventory": multiplayer.sync_inventory,
            "sync_animation": multiplayer.sync_animation,
            "predicted_movement": multiplayer.predicted_movement,
            "rollback_safety": multiplayer.rollback_safety,
        },
        "input": [
            {
                "name": binding.name,
                "action": binding.action,
                "custom_action": binding.custom_action,
                "device": binding.device,
                "key": binding.key,
                "scale": binding.scale,
            }
            for binding in scene.blendengine_input_map.bindings
        ],
        "objects": objects,
        "metrics": metrics,
    }


def build_profile_summary(scene):
    project = scene.blendengine_project
    export = scene.blendengine_export
    parts = [
        "Title: %s" % project.game_title,
        "Platform: %s" % project.target_platform,
        "Resolution: %dx%d" % (project.resolution_x, project.resolution_y),
        "Folder: %s" % project.build_folder,
    ]
    enabled = []
    if export.export_playable_project:
        enabled.append("playable project")
    if export.export_assets:
        enabled.append("asset manifest")
    if export.export_scene_package:
        enabled.append("scene package")
    parts.append("Packages: %s" % (", ".join(enabled) if enabled else "none"))
    return "; ".join(parts)


def _write_text(path, text, executable=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    if executable:
        current_mode = os.stat(path).st_mode
        os.chmod(path, current_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)


GAME_SCRIPTS_TEMPLATE = """// BlendEngine game scripts (optional).
//
// This file is loaded before the game starts and is kept between exports, so
// custom code written here is never overwritten. Examples:
//
// BlendEngine.on('start', (game) => game.toast('Welcome!'));
// BlendEngine.on('kill', (game, enemy) => console.log('Defeated', enemy.name));
// BlendEngine.on('update', (game, dt) => { /* runs every frame */ });
//
// A "Custom Script" behavior action with Text = "openVault" calls:
// BlendEngine.scripts.openVault = ({ game, owner, target }) => { target.alive = false; };
"""


def _web_runtime_files(context, package_dir, game_data):
    """Write the standalone 3D WebGL2 runtime player into package_dir/web_player."""
    web_dir = os.path.join(package_dir, "web_player")
    os.makedirs(web_dir, exist_ok=True)
    _write_json(os.path.join(web_dir, "game_data.json"), game_data)
    files = scene_export.copy_runtime(web_dir)
    scene_files, stats = scene_export.export_scene_package(context, context.scene, game_data, web_dir)
    scripts_path = os.path.join(web_dir, "game_scripts.js")
    if not os.path.exists(scripts_path):
        _write_text(scripts_path, GAME_SCRIPTS_TEMPLATE)
    print(
        "[BlendEngine] 3D runtime: %(meshes)d meshes, %(materials)d materials, %(textures)d textures, "
        "%(triangles)d triangles, %(binary_bytes)d bytes geometry" % stats
    )
    return ["web_player/" + name for name in files + scene_files + ["game_scripts.js", "game_data.json"]]


def _write_desktop_launchers(package_dir, package_name):
    _write_text(os.path.join(package_dir, "run_game.bat"),
                "@echo off\r\n"
                "set BLENDER=%BLENDER%\r\n"
                "if \"%BLENDER%\"==\"\" set BLENDER=blender\r\n"
                "\"%BLENDER%\" --window-fullscreen \"%~dp0%s.blend\" --python \"%~dp0run_game.py\"\r\n".replace("%s", package_name))
    _write_text(os.path.join(package_dir, "run_game.command"),
                "#!/usr/bin/env sh\n"
                "set -eu\n"
                "BLENDER=${BLENDER:-/Applications/BlendEngine.app/Contents/MacOS/blender}\n"
                "DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\n"
                "exec \"$BLENDER\" --window-fullscreen \"$DIR/%s.blend\" --python \"$DIR/run_game.py\"\n" % package_name,
                executable=True)
    return ["run_game.bat", "run_game.command"]


def _write_android_project(context, package_dir, game_data, platform_config):
    android_dir = os.path.join(package_dir, "android_project")
    app_assets = os.path.join(android_dir, "app", "src", "main", "assets")
    web_files = _web_runtime_files(context, android_dir, game_data)
    _write_json(os.path.join(app_assets, "game_data.json"), game_data)
    _write_json(os.path.join(app_assets, "platform_config.json"), platform_config)
    _write_text(os.path.join(android_dir, "settings.gradle"), "pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }\nrootProject.name='BlendEngineAndroidExport'\ninclude ':app'\n")
    _write_text(os.path.join(android_dir, "build.gradle"), "plugins {\n    id 'com.android.application' version '8.5.2' apply false\n}\n")
    _write_text(os.path.join(android_dir, "app", "build.gradle"), "plugins { id 'com.android.application' }\n\nandroid { namespace 'com.blendengine.export'; compileSdk 35\n    defaultConfig { applicationId 'com.blendengine.export'; minSdk 26; targetSdk 35; versionCode 1; versionName '1.0' }\n}\n")
    _write_text(os.path.join(android_dir, "app", "src", "main", "AndroidManifest.xml"), "<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\"><uses-permission android:name=\"android.permission.INTERNET\"/><application android:theme=\"@style/AppTheme\" android:label=\"BlendEngine Game\" android:usesCleartextTraffic=\"true\"><activity android:name=\".MainActivity\" android:screenOrientation=\"landscape\" android:exported=\"true\"><intent-filter><action android:name=\"android.intent.action.MAIN\"/><category android:name=\"android.intent.category.LAUNCHER\"/></intent-filter></activity></application></manifest>\n")
    _write_text(os.path.join(android_dir, "app", "src", "main", "res", "values", "styles.xml"), "<resources><style name=\"AppTheme\" parent=\"android:style/Theme.Material.NoActionBar\"><item name=\"android:windowFullscreen\">true</item><item name=\"android:windowNoTitle\">true</item><item name=\"android:colorAccent\">#00e6c3</item></style></resources>\n")
    _write_text(os.path.join(android_dir, "app", "src", "main", "java", "com", "blendengine", "export", "MainActivity.java"), "package com.blendengine.export;\nimport android.app.Activity;\nimport android.os.Bundle;\nimport android.webkit.WebSettings;\nimport android.webkit.WebView;\npublic class MainActivity extends Activity {\n  public void onCreate(Bundle b){ super.onCreate(b); WebView v=new WebView(this); WebSettings s=v.getSettings(); s.setJavaScriptEnabled(true); s.setAllowFileAccess(true); s.setDomStorageEnabled(true); s.setMediaPlaybackRequiresUserGesture(false); setContentView(v); v.loadUrl(\"file:///android_asset/web_player/index.html\"); }\n}\n")
    shutil.copytree(os.path.join(android_dir, "web_player"), os.path.join(app_assets, "web_player"), dirs_exist_ok=True)
    _write_text(os.path.join(android_dir, "build_android_apk.sh"),
                "#!/usr/bin/env sh\nset -eu\ncd \"$(dirname \"$0\")\"\nif ! command -v gradle >/dev/null 2>&1; then echo 'Install Android Studio or Gradle + Android SDK to build APK.'; exit 2; fi\ngradle :app:assembleDebug\nprintf '\\nAPK: %s\\n' \"$(pwd)/app/build/outputs/apk/debug/app-debug.apk\"\n",
                executable=True)
    _write_text(os.path.join(android_dir, "README.md"), "# Android APK Export\n\nRun `./build_android_apk.sh` after installing Android Studio/SDK and Gradle. The project wraps the BlendEngine 3D WebGL2 runtime (`web_player/`) in a fullscreen Android WebView player. Touch controls and gamepads work out of the box.\n")
    return ["android_project/" + item for item in web_files] + [
        "android_project/settings.gradle",
        "android_project/build.gradle",
        "android_project/app/build.gradle",
        "android_project/app/src/main/AndroidManifest.xml",
        "android_project/app/src/main/java/com/blendengine/export/MainActivity.java",
        "android_project/build_android_apk.sh",
        "android_project/README.md",
    ]


def _write_ios_project(context, package_dir, game_data, platform_config):
    ios_dir = os.path.join(package_dir, "ios_project")
    _write_json(os.path.join(ios_dir, "Assets", "game_data.json"), game_data)
    _write_json(os.path.join(ios_dir, "Assets", "platform_config.json"), platform_config)
    web_files = _web_runtime_files(context, ios_dir, game_data)
    _write_text(os.path.join(ios_dir, "BlendEnginePlayer.swift"), "import SwiftUI\nimport WebKit\nstruct BlendEngineView: UIViewRepresentable { func makeUIView(context: Context) -> WKWebView { let v = WKWebView(); if let url = Bundle.main.url(forResource: \"index\", withExtension: \"html\", subdirectory: \"web_player\") { v.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }; return v } func updateUIView(_ uiView: WKWebView, context: Context) {} }\n@main struct BlendEngineApp: App { var body: some Scene { WindowGroup { BlendEngineView().ignoresSafeArea() } } }\n")
    _write_text(os.path.join(ios_dir, "Info.plist"), "<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>CFBundleDisplayName</key><string>BlendEngine Game</string><key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationLandscapeLeft</string><string>UIInterfaceOrientationLandscapeRight</string></array></dict></plist>\n")
    _write_text(os.path.join(ios_dir, "build_ios_ipa.sh"),
                "#!/usr/bin/env sh\nset -eu\necho 'Open this folder in Xcode, add BlendEnginePlayer.swift + Assets + web_player to an iOS App target, choose your signing team, then Archive to create an IPA.'\nexit 2\n",
                executable=True)
    _write_text(os.path.join(ios_dir, "README.md"), "# iOS Export\n\nApple requires Xcode and a signing team for IPA files. This export includes SwiftUI/WebKit player source, web runtime, and BlendEngine game data. Add these files to an iOS App target and archive/sign in Xcode.\n")
    return [
        "ios_project/Assets/game_data.json",
        "ios_project/Assets/platform_config.json",
    ] + ["ios_project/" + item for item in web_files] + [
        "ios_project/BlendEnginePlayer.swift",
        "ios_project/Info.plist",
        "ios_project/build_ios_ipa.sh",
        "ios_project/README.md",
    ]


def prepare_build_package(context):
    scene = context.scene
    project = scene.blendengine_project
    export = scene.blendengine_export
    package_name = _safe_name(export.package_name)
    build_root = bpy.path.abspath(project.build_folder)
    package_dir = os.path.join(build_root, package_name)
    os.makedirs(package_dir, exist_ok=True)
    is_desktop_target = project.target_platform in {"WINDOWS", "LINUX", "MACOS"}
    # The .blend + Blender launch scripts are only for re-opening the project in BlendEngine.
    include_project = getattr(export, "include_project_files", False)
    writes_blend = is_desktop_target and include_project and (export.export_playable_project or export.export_scene_package)

    game_data = serialize_game_data(scene)
    manifest = {
        "name": package_name,
        "title": project.game_title,
        "platform": project.target_platform,
        "supported_targets": ["WINDOWS", "LINUX", "MACOS", "IOS", "ANDROID", "WEB"],
        "blend_file": package_name + ".blend" if writes_blend else "",
        "game_data": "game_data.json",
        "created_by": "BlendEngine",
        "summary": build_profile_summary(scene),
        "files": [],
    }

    data_path = os.path.join(package_dir, "game_data.json")
    with open(data_path, "w", encoding="utf-8") as handle:
        json.dump(game_data, handle, indent=2, sort_keys=True)
    manifest["files"].append("game_data.json")

    platform_config = {
        "target": project.target_platform,
        "desktop": project.target_platform in {"WINDOWS", "LINUX", "MACOS"},
        "mobile": project.target_platform in {"IOS", "ANDROID"},
        "web": project.target_platform == "WEB",
        "touch_controls": project.target_platform in {"IOS", "ANDROID"},
        "memory_budget_mb": scene.blendengine_optimization.max_runtime_ram_mb,
        "runtime": "BlendEngine 3D WebGL2 runtime (web_player/) on every target, plus the Blender-based editor runtime on desktop",
        "native_toolchain_required": project.target_platform in {"IOS", "ANDROID", "WEB"},
        "desktop_launcher": project.target_platform in {"WINDOWS", "LINUX", "MACOS"},
        "android_apk_script": project.target_platform == "ANDROID",
        "ios_xcode_required": project.target_platform == "IOS",
        "notes": (
            "web_player/index.html runs the exported 3D game in any WebGL2 browser without Blender. "
            "Desktop packages can also run through BlendEngine/Blender. APK/IPA creation requires the platform SDK and signing."
        ),
    }
    platform_path = os.path.join(package_dir, "platform_config.json")
    with open(platform_path, "w", encoding="utf-8") as handle:
        json.dump(platform_config, handle, indent=2, sort_keys=True)
    manifest["files"].append("platform_config.json")

    manifest_path = os.path.join(package_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
    manifest["files"].append("manifest.json")

    if writes_blend:
        blend_path = os.path.join(package_dir, package_name + ".blend")
        bpy.ops.wm.save_as_mainfile(filepath=blend_path, check_existing=False, copy=True)
        manifest["files"].append(package_name + ".blend")

    if is_desktop_target and include_project:
        launcher_path = os.path.join(package_dir, "run_game.py")
        with open(launcher_path, "w", encoding="utf-8") as handle:
            handle.write(
                "import bpy\n"
                "import addon_utils\n\n"
                "addon_utils.enable('blendengine', default_set=False, persistent=True)\n"
                "bpy.context.preferences.view.show_splash = False\n\n"
                "def _fullscreen_view3d():\n"
                "    screen = bpy.context.screen\n"
                "    if screen is None:\n"
                "        return\n"
                "    for area in screen.areas:\n"
                "        if area.type != 'VIEW_3D':\n"
                "            continue\n"
                "        region = next((r for r in area.regions if r.type == 'WINDOW'), None)\n"
                "        if region is None:\n"
                "            continue\n"
                "        with bpy.context.temp_override(area=area, region=region):\n"
                "            try:\n"
                "                bpy.ops.screen.screen_full_area(use_hide_panels=True)\n"
                "            except Exception:\n"
                "                pass\n"
                "        break\n\n"
                "def _start_game_only():\n"
                "    from blendengine import utils\n"
                "    utils.activate_engine_page(bpy.context, 'PLAY')\n"
                "    def _after_workspace():\n"
                "        from blendengine import utils\n"
                "        utils.configure_current_screen_for_blendengine(bpy.context)\n"
                "        utils.enter_camera_view(bpy.context)\n"
                "        _fullscreen_view3d()\n"
                "        bpy.ops.blendengine.test_run_scene()\n"
                "        return None\n"
                "    bpy.app.timers.register(_after_workspace, first_interval=0.35)\n"
                "    return None\n\n"
                "bpy.app.timers.register(_start_game_only, first_interval=0.10)\n"
            )
        manifest["files"].append("run_game.py")

        shell_path = os.path.join(package_dir, "run_game.sh")
        with open(shell_path, "w", encoding="utf-8") as handle:
            handle.write(
                "#!/usr/bin/env sh\n"
                "set -eu\n"
                "BLENDER=${BLENDER:-blender}\n"
                "DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\n"
                "exec \"$BLENDER\" --window-fullscreen \"$DIR/%s.blend\" --python \"$DIR/run_game.py\"\n" % package_name
            )
        current_mode = os.stat(shell_path).st_mode
        os.chmod(shell_path, current_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        manifest["files"].append("run_game.sh")
        manifest["files"].extend(_write_desktop_launchers(package_dir, package_name))

    web_dir = None
    if project.target_platform == "ANDROID":
        manifest["files"].extend(_write_android_project(context, package_dir, game_data, platform_config))
        web_dir = os.path.join(package_dir, "android_project", "web_player")
    elif project.target_platform == "IOS":
        manifest["files"].extend(_write_ios_project(context, package_dir, game_data, platform_config))
        web_dir = os.path.join(package_dir, "ios_project", "web_player")
    elif project.target_platform == "WEB" or export.export_web_player:
        # Desktop targets also get the standalone player: it runs in any browser without Blender.
        manifest["files"].extend(_web_runtime_files(context, package_dir, game_data))
        web_dir = os.path.join(package_dir, "web_player")

    # The finished game: one HTML file, Play launchers and an itch.io-ready zip.
    game_file = None
    if web_dir and os.path.isfile(os.path.join(web_dir, "index.html")):
        game_file, game_files = game_package.finish_package(package_dir, web_dir, project.game_title or package_name, package_name)
        manifest["files"].extend(game_files)
        manifest["game"] = os.path.basename(game_file)

    readme_path = os.path.join(package_dir, "README.txt")
    with open(readme_path, "w", encoding="utf-8") as handle:
        handle.write(
            "%s\n\n"
            "PLAY THE GAME (no Blender needed):\n"
            "  Windows: double-click %s.exe\n"
            "  Linux:   run ./%s (or install the .desktop shortcut)\n"
            "  macOS:   open %s.app\n"
            "  Any OS:  open %s.html in Chrome, Edge, Firefox or Safari.\n"
            "  %s_web.zip is ready to upload to itch.io or any web host.\n\n"
            "Graphics: add ?quality=low|medium|high|ultra to the game URL to change quality.\n"
            "Custom code: web_player/game_scripts.js (kept between exports).\n\n"
            "Controls:\n"
            "  W/A/S/D move, Space jump, Shift sprint, Mouse look, Left Mouse / F attack, E use, Esc pause, F3 stats.\n"
            "  Gamepads and touch screens work too.\n\n"
            "Mobile:\n"
            "  Android target writes android_project/ (build the APK with Android Studio).\n"
            "  iOS target writes ios_project/ (sign and archive with Xcode).\n"
            % (project.game_title, package_name, package_name, package_name, package_name, package_name)
        )
    manifest["files"].append("README.txt")

    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)

    return {
        "package_dir": package_dir,
        "manifest": manifest_path,
        "game_data": data_path,
        "summary": build_profile_summary(scene),
        "game_file": game_file,
    }


def register():
    pass


def unregister():
    pass
