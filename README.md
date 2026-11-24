# PianoFlow

Offline Synthesia-style piano trainer for Android tablets (landscape). Falling-note waterfall, full 88-key bed, Bluetooth LE MIDI and USB MIDI input, strict mistake detection (neon red `#ff2a4d` flash), Wait Mode, and IndexedDB song storage.

## Get the APK

1. Create an empty repository on GitHub and push this folder to the `main` branch.
2. Open the repository's **Actions** tab. The **Build Android APK** workflow runs automatically (about 6–8 minutes).
3. Open the finished run and download **PianoFlow-debug-apk** from the **Artifacts** section. It is a zip containing `PianoFlow-debug-<sha>.apk`.
4. For a permanent download link instead, push a tag: `git tag v1.0.0 && git push --tags`. The APK is attached to a GitHub Release under **Releases**.

## Install on the tablet

1. Copy the `.apk` to the tablet (USB, Google Drive, or download the Release directly on the tablet).
2. Open it. Android asks to allow installs from that app (Files/Chrome/Drive): allow it once.
3. Launch **PianoFlow**. On first **Connect Piano**, allow the Bluetooth (and on Android ≤ 11, location) permission. Android needs it to scan for BLE devices.

The debug APK is signed with a debug key. It installs fine by sideloading; it is not meant for the Play Store.

## Using it

| Control | What it does |
|---|---|
| **Connect Piano** | Native Bluetooth picker filtered to BLE MIDI pianos (service `03b80e5a-ede8-4b33-aab5-11ba5b2430c6`). Reconnects automatically if the link drops, and on next launch. |
| USB icon | Listens for a piano on a USB-C (OTG) cable. Also starts automatically in the app. |
| **Wait** | The waterfall freezes when a chord reaches the strike line and only continues once every required key is pressed. Wrong keys flash red and never move the playhead. |
| **L / R** | Muted (speaker crossed out) = **you** play that hand; it is required and the tablet stays silent for it. Unmuted = the tablet plays that hand for you. |
| Tempo | 0.25×–2.0×, changes instantly without desync. |
| Songs drawer | Import `.mid` files (or drag & drop on desktop). Saved on the device, works with no internet. |
| Waterfall | Tap to play/pause, drag vertically to scrub. Tap the on-screen keys to play notes. |

Track 1 / right hand = cyan, track 2 / left hand = mint, other tracks = violet accompaniment.

## What's new in 2.0

- **7 themes**: Neon Night, Candy Cane (striped notes, letter badges, confetti), Midnight Gold, Sakura Dusk, Ocean Deep, Synthwave, Paper Classic. Settings → Theme.
- **10 sounds**: real recorded Grand Piano (Salamander Grand Piano by Alexander Holm, CC BY 3.0, bundled at build time), Bright Piano, Electric Piano, Organ, Strings, Harpsichord, Music Box, Vibraphone, Synth Lead, Warm Pad.
- **Practice** panel: loop A–B, memorize mode (Fade / Ghost / Hidden, optional auto-hide after clean loops), speed trainer, metronome + count-in, step-by-step tutor, record & play back.
- **MP3 / MP4 → piano**: Songs → "MP3 / MP4 → piano". On-device transcription (no internet). Best on solo piano covers.
- **Connect menu**: Bluetooth MIDI, "Show all Bluetooth devices" (for pianos that hide the MIDI service), USB cable. Clear message when a device is only a Bluetooth *speaker*.
- **Bluetooth speaker delay** compensation (Settings) for when the piano's speaker plays the tablet's sound.
- Sustain pedal (CC64), combo counter, sparkle effects, progress card (streak, practice time, best score per song).

## Architecture

```
src/core/midi-file.js     Standalone SMF parser/writer (tempo map, running status, SMPTE, RMID)
src/core/ble-midi.js      BLE-MIDI packet parser (header/timestamp stripping, running status, SysEx)
src/core/midi-stream.js   Raw MIDI byte-stream parser (USB / Web MIDI)
src/core/song.js          Typed-array song model + hand assignment
src/core/transport.js     Drift-free playhead anchored to the AudioContext clock
src/core/practice.js      Hit detection, chord grouping, Wait Mode, flash state
src/audio/synth.js        Polyphonic Web Audio synth (64 voices)
src/audio/scheduler.js    Look-ahead scheduler sharing the transport clock
src/render/renderer.js    Canvas waterfall + key bed (integer device-pixel, allocation-free)
src/io/midi-input.js      BLE (native + Web Bluetooth), USB (native + Web MIDI)
src/io/storage.js         IndexedDB (metadata + raw ArrayBuffer stores)
native/android/           MainActivity + UsbMidi Capacitor plugin (android.media.midi)
scripts/patch-android.mjs Applies native files, landscape lock, minSdk 23, icon
```

**Why native bridges?** Android WebView (what Capacitor runs in) implements neither Web Bluetooth nor Web MIDI. Inside the APK, BLE goes through `@capacitor-community/bluetooth-le` and raw packets are parsed by `ble-midi.js`. USB goes through the bundled `UsbMidi` plugin. In a desktop/Android Chrome browser (`npm run dev`), `navigator.bluetooth` and `navigator.requestMIDIAccess` are used directly.

## Develop

```bash
npm install
npm test            # 40 unit tests: timing, BLE parser, MIDI parser, wait mode, detection
npm run dev         # browser preview (Chrome: Web Bluetooth + Web MIDI work here)
npm run android:init && npm run apk   # local APK (needs Android Studio / SDK, Java 17)
```

Stack: Vite 5, Capacitor 6 (Java 17, Android API 34), no runtime MIDI dependency.
