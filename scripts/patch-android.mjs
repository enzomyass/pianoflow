#!/usr/bin/env node
// Applies PianoFlow's native customisations to the Capacitor-generated
// android/ project. Idempotent: safe to run after every `npx cap add/sync`.
//
//  - Installs MainActivity (immersive, keep-screen-on, registers UsbMidi plugin)
//  - Installs the UsbMidi Capacitor plugin (android.media.midi → JS)
//  - Locks the activity to landscape (sensorLandscape)
//  - Declares optional MIDI / BLE hardware features
//  - Raises minSdk to 23 (android.media.midi requires API 23)
//  - Installs an adaptive launcher icon
//
// Fails loudly (exit 1) if the generated project does not look as expected,
// so CI never silently ships an unpatched APK.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'android');
const config = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8'));
const appId = config.appId;

function fail(msg) {
  console.error('[patch-android] ERROR: ' + msg);
  process.exit(1);
}
function log(msg) {
  console.log('[patch-android] ' + msg);
}

if (!fs.existsSync(androidDir)) fail('android/ not found. Run `npx cap add android` first.');

// 1. Java sources
const javaDir = path.join(androidDir, 'app', 'src', 'main', 'java', ...appId.split('.'));
if (!fs.existsSync(javaDir)) fail('Java package dir missing: ' + javaDir);
for (const file of ['MainActivity.java', 'UsbMidiPlugin.java']) {
  let src = fs.readFileSync(path.join(root, 'native', 'android', file), 'utf8');
  src = src.replace(/^package [\w.]+;/m, 'package ' + appId + ';');
  fs.writeFileSync(path.join(javaDir, file), src);
  log('installed ' + file);
}

// 2. AndroidManifest.xml
const manifestPath = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
if (!fs.existsSync(manifestPath)) fail('AndroidManifest.xml not found');
let manifest = fs.readFileSync(manifestPath, 'utf8');

const activityRe = /<activity\b[^>]*android:name="\.MainActivity"[^>]*>/s;
const activityTag = manifest.match(activityRe);
if (!activityTag) fail('MainActivity <activity> tag not found in manifest');
if (!/android:screenOrientation=/.test(activityTag[0])) {
  const patched = activityTag[0].replace('<activity', '<activity\n            android:screenOrientation="sensorLandscape"');
  manifest = manifest.replace(activityTag[0], patched);
  log('locked MainActivity to sensorLandscape');
}

const features = [
  '<uses-feature android:name="android.software.midi" android:required="false" />',
  '<uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />',
  '<uses-feature android:name="android.hardware.usb.host" android:required="false" />',
];
for (const f of features) {
  const name = f.match(/android:name="([^"]+)"/)[1];
  if (!manifest.includes('android:name="' + name + '"')) {
    if (!manifest.includes('</manifest>')) fail('</manifest> not found');
    manifest = manifest.replace('</manifest>', '    ' + f + '\n</manifest>');
    log('declared optional feature ' + name);
  }
}
fs.writeFileSync(manifestPath, manifest);

// 3. minSdk 23
const varsPath = path.join(androidDir, 'variables.gradle');
if (!fs.existsSync(varsPath)) fail('variables.gradle not found');
let vars = fs.readFileSync(varsPath, 'utf8');
const minMatch = vars.match(/minSdkVersion\s*=\s*(\d+)/);
if (!minMatch) fail('minSdkVersion not found in variables.gradle');
if (parseInt(minMatch[1], 10) < 23) {
  vars = vars.replace(/minSdkVersion\s*=\s*\d+/, 'minSdkVersion = 23');
  fs.writeFileSync(varsPath, vars);
  log('minSdkVersion ' + minMatch[1] + ' -> 23');
}

// 4. Adaptive launcher icon (API 26+); older devices keep the default PNGs.
const res = path.join(androidDir, 'app', 'src', 'main', 'res');
fs.mkdirSync(path.join(res, 'drawable'), { recursive: true });
fs.mkdirSync(path.join(res, 'mipmap-anydpi-v26'), { recursive: true });
fs.copyFileSync(path.join(root, 'native', 'android', 'res', 'pf_icon_bg.xml'), path.join(res, 'drawable', 'pf_icon_bg.xml'));
fs.copyFileSync(path.join(root, 'native', 'android', 'res', 'pf_icon_fg.xml'), path.join(res, 'drawable', 'pf_icon_fg.xml'));
const adaptive =
  '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
  '    <background android:drawable="@drawable/pf_icon_bg" />\n    <foreground android:drawable="@drawable/pf_icon_fg" />\n</adaptive-icon>\n';
fs.writeFileSync(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptive);
fs.writeFileSync(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), adaptive);
log('installed adaptive launcher icon');

log('done');
