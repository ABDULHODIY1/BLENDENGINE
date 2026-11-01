# SPDX-License-Identifier: GPL-2.0-or-later
#
# Editor Test Run safety: gameplay input must never reach Blender's modeling
# shortcuts, and stopping a Test Run must leave the project exactly as it was.
#
#   blender --background --factory-startup --python tests/python/blendengine_test_run_test.py

import os
import sys
import unittest

import bpy

ADDONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "addons_core")
if ADDONS_DIR not in sys.path:
    sys.path.insert(0, ADDONS_DIR)

import blendengine  # noqa: E402
from blendengine import operators, runtime  # noqa: E402


class FakeEvent:
    def __init__(self, type_, value="PRESS", x=0, y=0, repeat=False):
        self.type, self.value, self.mouse_x, self.mouse_y, self.is_repeat = type_, value, x, y, repeat
        self.ctrl = self.alt = self.shift = self.oskey = False


class TestRunSafetyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            blendengine.register()
        except ValueError:
            pass
        bpy.ops.blendengine.generate_basic_template()

    def test_keyboard_events_are_classified(self):
        for key in ("W", "A", "S", "D", "G", "X", "R", "TAB", "DEL", "ONE", "F3", "LEFT_SHIFT", "SPACE"):
            self.assertTrue(operators._is_keyboard_event(FakeEvent(key)), key)
        for other in ("MOUSEMOVE", "WHEELUPMOUSE", "WHEELDOWNMOUSE", "LEFTMOUSE", "TIMER", "NDOF_MOTION", "WINDOW_DEACTIVATE", "TRACKPADPAN"):
            self.assertFalse(operators._is_keyboard_event(FakeEvent(other)), other)

    def test_stop_restores_scene(self):
        scene = bpy.context.scene
        before = {o.name: (tuple(o.location), tuple(o.rotation_euler), tuple(o.scale), o.hide_viewport) for o in scene.objects}
        names = set(before)
        session, result = runtime.start_test_run(bpy.context)
        self.assertTrue(result.ok, result.summary())
        player = session._player
        self.assertIsNotNone(player)
        start = player.location.copy()
        for key in ("W", "D"):
            session.handle_event(FakeEvent(key, "PRESS"))
        session.handle_event(FakeEvent("W", "PRESS", repeat=True))
        for _ in range(90):
            session.step(1.0 / 60.0)
        self.assertGreater((player.location - start).length, 0.5, "player should move while W is held")
        # Something the game changes on its own: hide a coin like a pickup does.
        coin = next((o for o in scene.objects if "Coin" in o.name or "coin" in o.name.lower()), None)
        if coin is not None:
            coin.hide_viewport = True
        runtime.finish_active_session("Stopped")
        after = {o.name: (tuple(o.location), tuple(o.rotation_euler), tuple(o.scale), o.hide_viewport) for o in scene.objects}
        self.assertEqual(set(after), names, "objects spawned during play must be removed")
        for name, state in before.items():
            for a, b in zip(state[:3], after[name][:3]):
                for x, y in zip(a, b):
                    self.assertAlmostEqual(x, y, places=5, msg=name)
            self.assertEqual(state[3], after[name][3], name)
        self.assertFalse(scene.blendengine_project.test_running)

    def test_release_clears_key(self):
        session, _ = runtime.start_test_run(bpy.context)
        session.handle_event(FakeEvent("S", "PRESS"))
        self.assertIn("S", session.input_state)
        session.handle_event(FakeEvent("S", "RELEASE"))
        self.assertNotIn("S", session.input_state)
        runtime.finish_active_session("Stopped")


if __name__ == "__main__":
    argv = [sys.argv[0]] + (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    result = unittest.main(argv=argv, exit=False).result
    sys.exit(0 if result.wasSuccessful() else 1)
