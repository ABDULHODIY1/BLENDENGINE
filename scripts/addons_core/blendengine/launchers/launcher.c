/* SPDX-License-Identifier: GPL-2.0-or-later
 *
 * BlendEngine game launcher.
 *
 * Build copies this program next to the exported game and renames it after
 * the game ("KristallVodiysi.exe" / "KristallVodiysi"). When started it opens
 * "<its own name>.html" from the same folder in a chromeless browser window
 * (Edge / Chrome / Chromium / Brave "--app" mode), so the game behaves like a
 * normal desktop application. Falls back to the default browser.
 *
 * Build:
 *   x86_64-w64-mingw32-gcc -O2 -s -mwindows -municode -o blendengine_launcher_win64.exe launcher.c
 *   gcc -O2 -s -static -o blendengine_launcher_linux_x64 launcher.c
 */

#ifdef _WIN32

#  include <windows.h>
#  include <shellapi.h>
#  include <wchar.h>

static int file_exists(const wchar_t *path)
{
  DWORD attr = GetFileAttributesW(path);
  return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR cmd, int show)
{
  (void)inst;
  (void)prev;
  (void)cmd;
  (void)show;
  wchar_t game[MAX_PATH * 2];
  DWORD len = GetModuleFileNameW(NULL, game, MAX_PATH);
  if (len == 0 || len >= MAX_PATH) {
    return 1;
  }
  wchar_t *dot = wcsrchr(game, L'.');
  if (dot == NULL) {
    return 1;
  }
  wcscpy(dot, L".html");
  if (!file_exists(game)) {
    MessageBoxW(NULL, L"The game file (.html) was not found next to this program.", L"BlendEngine", MB_ICONERROR);
    return 1;
  }

  /* file:///C:/path/Game.html */
  wchar_t url[MAX_PATH * 3] = L"file:///";
  size_t n = wcslen(url);
  for (const wchar_t *c = game; *c && n < MAX_PATH * 3 - 4; c++) {
    url[n++] = (*c == L'\\') ? L'/' : *c;
  }
  url[n] = 0;

  const wchar_t *env_names[] = {L"ProgramFiles(x86)", L"ProgramFiles", L"LocalAppData"};
  const wchar_t *browsers[] = {L"\\Microsoft\\Edge\\Application\\msedge.exe",
                               L"\\Google\\Chrome\\Application\\chrome.exe",
                               L"\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"};
  for (int b = 0; b < 3; b++) {
    for (int e = 0; e < 3; e++) {
      wchar_t base[MAX_PATH];
      if (!GetEnvironmentVariableW(env_names[e], base, MAX_PATH)) {
        continue;
      }
      wchar_t exe[MAX_PATH * 2];
      wcscpy(exe, base);
      wcscat(exe, browsers[b]);
      if (!file_exists(exe)) {
        continue;
      }
      wchar_t args[MAX_PATH * 4];
      swprintf(args, MAX_PATH * 4, L"--app=\"%ls\" --start-maximized", url);
      if ((INT_PTR)ShellExecuteW(NULL, L"open", exe, args, NULL, SW_SHOWMAXIMIZED) > 32) {
        return 0;
      }
    }
  }
  ShellExecuteW(NULL, L"open", game, NULL, NULL, SW_SHOWMAXIMIZED);
  return 0;
}

#else /* POSIX */

#  include <limits.h>
#  include <stdio.h>
#  include <stdlib.h>
#  include <string.h>
#  include <sys/stat.h>
#  include <unistd.h>

static int on_path(const char *name, char *out, size_t size)
{
  if (name == NULL || name[0] == 0) {
    return 0;
  }
  if (strchr(name, '/')) {
    snprintf(out, size, "%s", name);
    return access(out, X_OK) == 0;
  }
  const char *path = getenv("PATH");
  if (path == NULL) {
    return 0;
  }
  char buf[8192];
  snprintf(buf, sizeof(buf), "%s", path);
  for (char *dir = strtok(buf, ":"); dir; dir = strtok(NULL, ":")) {
    snprintf(out, size, "%s/%s", dir, name);
    if (access(out, X_OK) == 0) {
      return 1;
    }
  }
  return 0;
}

int main(int argc, char **argv)
{
  (void)argc;
  char self[PATH_MAX];
  ssize_t len = readlink("/proc/self/exe", self, sizeof(self) - 8);
  if (len <= 0) {
    if (realpath(argv[0], self) == NULL) {
      return 1;
    }
    len = (ssize_t)strlen(self);
  }
  self[len] = 0;

  char game[PATH_MAX + 8];
  snprintf(game, sizeof(game), "%s.html", self);
  struct stat st;
  if (stat(game, &st) != 0) {
    fprintf(stderr, "BlendEngine: game file not found: %s\n", game);
    return 1;
  }
  char url[PATH_MAX + 64];
  snprintf(url, sizeof(url), "--app=file://%s", game);

  const char *candidates[] = {getenv("BLENDENGINE_BROWSER"), "google-chrome", "google-chrome-stable", "chromium",
                              "chromium-browser", "microsoft-edge", "brave-browser", NULL};
  char exe[PATH_MAX];
  for (int i = 0; i < 7; i++) {
    if (candidates[i] && on_path(candidates[i], exe, sizeof(exe))) {
      char *args[32];
      int n = 0;
      args[n++] = exe;
      args[n++] = url;
      args[n++] = "--start-maximized";
      /* Extra flags, e.g. for software rendering: BLENDENGINE_BROWSER_FLAGS="--no-sandbox". */
      char flags[2048] = {0};
      const char *extra = getenv("BLENDENGINE_BROWSER_FLAGS");
      if (extra) {
        snprintf(flags, sizeof(flags), "%s", extra);
        for (char *f = strtok(flags, " "); f && n < 30; f = strtok(NULL, " ")) {
          args[n++] = f;
        }
      }
      args[n] = NULL;
      execv(exe, args);
    }
  }
  if (on_path("firefox", exe, sizeof(exe))) {
    char *args[] = {exe, "--new-window", game, NULL};
    execv(exe, args);
  }
  char *args[] = {"xdg-open", game, NULL};
  execvp("xdg-open", args);
  return 1;
}

#endif
