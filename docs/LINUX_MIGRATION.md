# Linux (Ubuntu + X11) Migration Plan — telegram-bridge browser-ops & automation layer

Date: 2026-08-07
Target: Ubuntu 22.04+ on X11 (XTEST available). Wayland is out of scope
for now (see §7).

## 1. Why Linux is actually an easier target for this stack

The two hardest blockers hit on macOS simply do not exist on X11:

- Bluetooth: macOS TCC gate blocks blueutil and GUI-click automation.
  Linux has `bluetoothctl` (bluez) — no permission gate at all.
- Input injection: SwiftUI filters synthetic mouse events. X11's
  XTEST injects events at the server level, so `xdotool click` is
  indistinguishable from a real click and works on every app.

## 2. Existing state

- `main` / `linux-screenshot` branch already carries Linux screenshot
  support: `src/tools/screenshot.ts` (X11 `xdotool` + ImageMagick
  `import`, Wayland `grim`). See commit d917788.
- `browser_ops.ts` is still macOS-bound: it drives Chrome via cua-driver
  (Apple Events `execute javascript`, per-pid window scoring).
- `src/connections/connect_bluetooth.ts` records the macOS lesson:
  Bluetooth must go through `bluetoothctl` on Linux.

## 3. Tool-map (macOS → X11)

| Concern                | macOS                              | Linux/X11                        |
|------------------------|------------------------------------|----------------------------------|
| Browser JS             | cua-driver Apple Events            | CDP over --remote-debugging-port |
| Click/type/keys/drag   | SLEventPostToPid (per-pid)         | xdotool (global XTEST)           |
| Window list/enum       | cua-driver list_windows            | wmctrl -lG / xdotool search      |
| Workspace/space        | window space ids                   | wmctrl -d (desktops)             |
| Window capture         | ScreenCaptureKit                   | import -window (or maim/scrot)   |
| Accessibility tree     | AppKit AX (System Settings broken) | AT-SPI2 (GTK good, else patchy)  |
| Hidden launch          | launch_app + FocusRestoreGuard     | direct spawn (setsid nohup)      |
| Screenshot             | cua-driver screenshot              | src/tools/screenshot.ts (done)   |
| Bluetooth              | blueutil (TCC dead end)            | bluetoothctl (no gate)           |
| Audio output verify    | system_profiler SPAudio            | pactl list sinks short           |

## 4. Browser backend: replace cua-driver with CDP

`browser_ops.ts` is the single largest rewrite. On Linux:

1. Launch Chrome/Chromium with a persistent profile so logins survive:
   `chrome --user-data-dir=$HOME/.config/telegram-bridge-chrome
   --remote-debugging-port=9222`
2. Drive via CDP using Bun (raw WebSocket to `http://127.0.0.1:9222/json`
   + `/json/version`), or the `chrome-remote-interface` npm package.
3. Map the two helpers the tools depend on:
   - `bestWindow()` → `/json/list` targets filtered by `type: "page"`
     and URL match (LinkedIn/Spotify/Gmail), keep the on-screen/space
     filter concept via `wmctrl -l` intersect.
   - `pageJs(target, js)` → `Runtime.evaluate { expression, returnByValue:
     true }`, unwrap `result.result.value`. Cleaner than Apple Events —
     no `## Result` text wrapper to parse.
4. All `operate_*.ts` consumers (`operate_chrome`, `operate_gmail`,
   `operate_new_trends_twitter`, `operate_polling_jobs`) keep their DOM
   selectors and only swap the JS-eval backend. The LinkedIn
   login-guard and `f_TPR` logic already in place carries over
   unchanged.

## 5. Native-app shim (best-effort)

- `xdotool` covers click/type/key/scroll globally — accept that the
  real cursor warps and clicks may raise windows (no per-pid isolation).
- Window geometry via `wmctrl -lG`; capture via `import -window`.
- Accessibility: AT-SPI2 (`pyatspi` / `dogtail`) is toolkit-dependent.
  Prefer CDP/xdotool for browsers; use AT-SPI only for GTK native apps.
- Hidden launch: `setsid nohup <binary> ... &` — never `xdg-open`
  (equivalent of macOS `open`, steals focus).

## 6. Severity

| Level | Items |
|---|---|
| REWRITE | browser_ops → CDP (biggest change, biggest win) |
| ADAPT | window enum, capture, hidden launch |
| EASY | input shim (xdotool), screenshot (done), Bluetooth (bluetoothctl) |
| OPTIONAL | AT-SPI2 shim for GTK apps |
| DROP | per-pid isolation, FocusRestoreGuard, Safari/Arc, TCC |

## 7. Roadmap

1. CDP backend for browser_ops + verify LinkedIn polling jobs on Ubuntu.
2. xdotool input shim + wmctrl window list.
3. bluetoothctl connect helper + pactl output verification.
4. AT-SPI2 shim only if a native GTK flow requires it.
5. Wayland later: input via ydotool/uinput, window list restricted,
   focusless control effectively unavailable.

## 8. Verification steps

- `bun -e` operatePollingJobs on Ubuntu → jobs list from CDP, login
  guard works.
- `xdotool` click into a native toggle → state flips (XTEST real input).
- `bluetoothctl connect <MAC>` → `system_profiler`-equivalent via
  `bluetoothctl devices` / `pactl list sinks short`.
- Window capture matches `wmctrl -lG` geometry.
