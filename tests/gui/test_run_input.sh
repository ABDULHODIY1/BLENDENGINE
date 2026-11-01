#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Real keyboard/mouse test of the editor Test Run (needs Xvfb and xdotool):
#   BLENDER=/path/to/blendengine tests/gui/test_run_input.sh
# While the game runs and after it stops, W/A/S/D, G, R, X, Delete, Tab, wheel and
# clicks over the game view must not edit the scene; stopping restores the level.
# Prints the snapshot lines and exits non-zero on failure.
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${OUT_DIR:-$(mktemp -d)}"
export BE_GUI_RESULT="$OUT_DIR/result.txt"
export DISPLAY=:91
Xvfb :91 -screen 0 1600x900x24 >/dev/null 2>&1 &
XPID=$!
sleep 2
"${BLENDER:-blender}" --factory-startup --python "$HERE/test_run_input.py" > "$OUT_DIR/blender.log" 2>&1 &
BPID=$!
sleep 9
WID=$(xdotool search --name "Blend" | head -1)
xdotool windowfocus $WID 2>/dev/null
xdotool mousemove 650 450
# While the game runs (t~9-16 s): hold W, then editing keys, wheel, clicks.
xdotool keydown w; sleep 1.5; xdotool keyup w
for k in s g r x Delete Tab; do xdotool key $k; sleep 0.2; done
for i in 1 2 3 4 5; do xdotool click 5; sleep 0.1; done
xdotool click 1; sleep 0.2; xdotool click 3; sleep 0.3
sleep 9
# After the run stopped (t~21-30 s): the same keys must not edit the scene.
xdotool mousemove 650 450
for k in s s g r x Delete Tab; do xdotool key $k; sleep 0.25; done
xdotool keydown s; sleep 0.8; xdotool mousemove 700 500; sleep 0.3; xdotool keyup s
for i in 1 2 3 4 5; do xdotool click 5; sleep 0.1; done
xdotool click 1; sleep 0.3
wait $BPID
kill $XPID
cat "$BE_GUI_RESULT"
grep -q "scale_changed={}" "$BE_GUI_RESULT" || exit 1
! grep "scale_changed={'" "$BE_GUI_RESULT" >/dev/null || exit 1
grep "^final" "$BE_GUI_RESULT" | grep -q "loc=(0.0, 0.0, 0.9)" || exit 1
echo "ok: game input never reached Blender and the level was restored"
