# SPDX-License-Identifier: GPL-2.0-or-later
#
# Turns the exported 3D player into a finished, shareable game:
#
#   <Game>.exe           Windows program (native launcher, see launchers/launcher.c)
#   <Game>               Linux program (static x86-64 executable)
#   <Game>.app           macOS application bundle
#   <Game>.html          the game itself: one self-contained file (runtime + scene)
#   <game>.desktop       Linux menu / desktop shortcut
#   <Game>_web.zip       index.html at the root, ready for itch.io or any web host
#
# The programs open <Game>.html in a chromeless Edge/Chrome window, so the game
# runs like a normal desktop application. Nothing needs Blender or BlendEngine.

import os
import re
import shutil
import stat
import subprocess
import sys
import webbrowser
import zipfile
from urllib.request import pathname2url

SCRIPT_TAG = re.compile(r'<script src="([^"]+)"></script>')


def _inline_script(text):
    # A literal "</script" inside inlined code would end the tag early.
    return text.replace("</script", "<\\/script")


def make_standalone_html(web_dir, out_path):
    """Inline every local script of web_player/index.html into a single HTML file."""
    with open(os.path.join(web_dir, "index.html"), encoding="utf-8") as handle:
        html = handle.read()

    def replace(match):
        path = os.path.join(web_dir, match.group(1))
        if not os.path.isfile(path):
            return ""
        with open(path, encoding="utf-8") as handle:
            return "<script>\n%s\n</script>" % _inline_script(handle.read())

    html = SCRIPT_TAG.sub(replace, html)
    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(html)
    return out_path


def make_web_zip(web_dir, zip_path):
    """Zip the player folder with index.html at the root (itch.io HTML5 format)."""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for root, _dirs, files in os.walk(web_dir):
            for name in sorted(files):
                full = os.path.join(root, name)
                archive.write(full, os.path.relpath(full, web_dir))
    return zip_path


def _write(path, text, executable=False, newline="\n"):
    with open(path, "w", encoding="utf-8", newline=newline) as handle:
        handle.write(text)
    if executable:
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


LAUNCHER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "launchers")

MAC_SCRIPT = """#!/bin/sh
# %(title)s - made with BlendEngine.
HERE="$(cd "$(dirname "$0")/../Resources" && pwd)"
GAME="$HERE/%(name)s"
for app in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
  if open -Ra "$app" >/dev/null 2>&1; then exec open -na "$app" --args --app="file://$GAME"; fi
done
exec open "$GAME"
"""

MAC_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>%(title)s</string>
  <key>CFBundleDisplayName</key><string>%(title)s</string>
  <key>CFBundleIdentifier</key><string>com.blendengine.%(ident)s</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>%(slug)s</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.games</string>
</dict></plist>
"""


def write_programs(package_dir, game_file, title, slug):
    """Copy the native launchers next to the game, named after it, plus a macOS .app."""
    written = []
    windows = os.path.join(package_dir, slug + ".exe")
    shutil.copyfile(os.path.join(LAUNCHER_DIR, "blendengine_launcher_win64.exe"), windows)
    written.append(os.path.basename(windows))

    linux = os.path.join(package_dir, slug)
    shutil.copyfile(os.path.join(LAUNCHER_DIR, "blendengine_launcher_linux_x64"), linux)
    os.chmod(linux, os.stat(linux).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    written.append(os.path.basename(linux))

    app = os.path.join(package_dir, slug + ".app", "Contents")
    os.makedirs(os.path.join(app, "MacOS"), exist_ok=True)
    os.makedirs(os.path.join(app, "Resources"), exist_ok=True)
    name = os.path.basename(game_file)
    shutil.copyfile(game_file, os.path.join(app, "Resources", name))
    ident = re.sub(r"[^a-z0-9]+", "", slug.lower()) or "game"
    _write(os.path.join(app, "MacOS", slug), MAC_SCRIPT % {"title": title, "name": name}, executable=True)
    _write(os.path.join(app, "Info.plist"), MAC_PLIST % {"title": title, "slug": slug, "ident": ident})
    written.append(slug + ".app")

    desktop = slug.lower() + ".desktop"
    _write(os.path.join(package_dir, desktop), (
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=%(title)s\n"
        "Comment=Made with BlendEngine\n"
        "Exec=sh -c 'cd \"$(dirname \"%%k\")\" && ./%(slug)s'\n"
        "Icon=applications-games\n"
        "Categories=Game;\n"
        "Terminal=false\n"
    ) % {"title": title, "slug": slug}, executable=True)
    written.append(desktop)
    return written


def file_url(path):
    return "file:" + pathname2url(os.path.abspath(path))


def _browser_candidates():
    custom = os.environ.get("BLENDENGINE_BROWSER")
    if custom:
        yield custom
    if sys.platform.startswith("win"):
        for base in (os.environ.get("ProgramFiles(x86)", ""), os.environ.get("ProgramFiles", ""), os.environ.get("LocalAppData", "")):
            yield os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe")
            yield os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")
    elif sys.platform == "darwin":
        for app in ("Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"):
            yield "/Applications/%s.app/Contents/MacOS/%s" % (app, app)
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"):
        found = shutil.which(name)
        if found:
            yield found


def launch_game(game_file):
    """Open the built game in its own browser app window; fall back to the default browser."""
    url = file_url(game_file)
    flags = os.environ.get("BLENDENGINE_BROWSER_FLAGS", "").split()
    for browser in _browser_candidates():
        if browser and os.path.isfile(browser):
            try:
                subprocess.Popen([browser, "--app=" + url, "--start-maximized", *flags],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return browser
            except OSError:
                continue
    webbrowser.open(url)
    return "default browser"


def run_program(package_dir, slug, game_file):
    """Start the built game program for this OS; fall back to a browser window."""
    try:
        if sys.platform.startswith("win"):
            os.startfile(os.path.join(package_dir, slug + ".exe"))  # noqa: B606 (Windows only)
            return slug + ".exe"
        if sys.platform == "darwin":
            subprocess.Popen(["open", os.path.join(package_dir, slug + ".app")])
            return slug + ".app"
        program = os.path.join(package_dir, slug)
        if os.access(program, os.X_OK):
            subprocess.Popen([program], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return slug
    except OSError:
        pass
    return launch_game(game_file)


def finish_package(package_dir, web_dir, title, slug):
    """Create the single-file game, launchers and web zip. Returns (game_file, files)."""
    game_file = os.path.join(package_dir, slug + ".html")
    make_standalone_html(web_dir, game_file)
    files = [os.path.basename(game_file)]
    files += write_programs(package_dir, game_file, title, slug)
    zip_path = os.path.join(package_dir, slug + "_web.zip")
    make_web_zip(web_dir, zip_path)
    files.append(os.path.basename(zip_path))
    return game_file, files



def register():
    pass


def unregister():
    pass
