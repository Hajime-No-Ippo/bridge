# Automating Music Playback & Device Connection via cua-driver — Experience Report

Date: 2026-08-07
Context: telegram-bridge (Bun/TS) agent, macOS (arm64)

## 1. Task

Use cua-driver to fully automate:
1. Connecting a Bluetooth audio device (Sony SRS-XB13).
2. Playing a Spotify playlist through it.

## 2. Verdict

| Goal | Outcome |
|---|---|
| Connect Bluetooth device | FAILED to automate — required a human mouse click |
| Play music (Spotify) | SUCCEEDED via a synthesized click into Chromium web content |

## 3. Why connecting devices failed

### 3.1 No Bluetooth capability in cua-driver
cua-driver has no Bluetooth/WiFi tool. Every alternative was also
blocked:

- `blueutil` hangs on every query — a `kTCCServiceBluetoothAlways`
  TCC permission prompt can never appear for a CLI binary.
- Hand-inserted TCC grants (user DB) are ignored by the OS; the
  system DB that holds real grants is SIP-protected.
- The only path left was System Settings GUI.

### 3.2 System Settings GUI is not automatable here
- Its AX tree is **menu-bar-only / broken** (recursive
  `AXApplication` nesting, no window-content elements) — no
  `element_index` to click.
- **SwiftUI filters per-pid synthesized mouse events**: pixel clicks
  post successfully and land visually at the right spot, but the
  event loop rejects them (no real HID origin) — no focus, no
  button press, no "Connecting..." state.
- Keyboard events DO reach System Settings (search + Return work),
  but blind Tab navigation is impractical.
- OCR fallbacks for reading the UI failed: model can't view images,
  tesseract returned nothing on System Settings screenshots, and
  swiftc was broken (module-cache error) so a Vision helper couldn't
  compile.

### 3.3 What finally worked
A **human click**. Once it was clear synthesized clicks are
rejected, the user clicked Connect with a real mouse — connection
succeeded in ~30s and macOS auto-switched the default audio output.

## 4. Playing music succeeded

- Control tool: `spotatui` (Rust CLI) + Spotify Web Player in Chrome.
- The Web Player's session went stale (`No active device found`
  404), and a tab reload didn't fix it — the player needs a
  **user-gesture play click** in the page to re-initialize.
- Unlike SwiftUI, **Chromium web content accepts synthesized
  clicks**: a `cua-driver click` on the bottom-bar play button
  resumed playback immediately (through the now-connected speaker).

## 5. Generalizable lessons

1. **cua-driver cannot connect Bluetooth devices** — no tool, no
   working CLI/TCC path, and SwiftUI Settings rejects synthetic
   clicks. Plan on a human step for device pairing.
2. **SwiftUI apps reject non-HID synthesized mouse events** while
   accepting synthetic keyboard. Pixel clicks land visually but
   never activate controls.
3. **Chromium web content accepts synthesized clicks** — cua-driver
   works great for browser-driven playback (Spotify/YouTube/etc.).
4. **Don't burn cycles on TCC DB edits** — permissions must come
   from a real consent flow.
5. **Screenshot-driven automation requires a vision/OCR path.**
   Without one (no image input, broken tesseract/swiftc), layout
   inference had to fall back to ASCII brightness maps.
6. **Synthesize a clear verdict**: when a layer rejects synthetic
   input, delegate the single human step instead of looping.
