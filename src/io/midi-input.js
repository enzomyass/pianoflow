// MIDI input: Bluetooth LE MIDI, USB MIDI and Web MIDI, normalised to
// noteOn/noteOff callbacks.
//
// Android WebView (what Capacitor runs in) implements neither Web Bluetooth
// nor Web MIDI. So inside the APK:
//   - BLE MIDI goes through @capacitor-community/bluetooth-le (native GATT),
//     and the raw notification packets are parsed by BleMidiParser here.
//   - USB MIDI goes through the bundled UsbMidi native plugin (Android
//     MidiManager), whose raw bytes are parsed by MidiStreamParser.
// In a desktop/Android Chrome browser, navigator.bluetooth and
// navigator.requestMIDIAccess are used instead.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { BLE_MIDI_SERVICE, BLE_MIDI_CHARACTERISTIC } from '../core/constants.js';
import { BleMidiParser } from '../core/ble-midi.js';
import { MidiStreamParser } from '../core/midi-stream.js';

const UsbMidi = registerPlugin('UsbMidi');
const LAST_BLE_KEY = 'pianoflow.lastBleDevice';
const NOT_MIDI = (name) =>
  '“' + name + '” does not send piano keys over Bluetooth (it may only be its speaker/audio connection). Use a USB cable instead.';

export class MidiInput {
  /**
   * @param {{onNoteOn:(p:number,v:number)=>void, onNoteOff:(p:number)=>void, onAllOff:()=>void,
   *          onStatus:(text:string, kind:string)=>void}} handlers
   */
  constructor(handlers) {
    this.h = handlers;
    const onMessage = (status, d1, d2) => this._message(status, d1, d2);
    this.bleParser = new BleMidiParser(onMessage);
    this.usbParser = new MidiStreamParser(onMessage);
    this.webMidiParser = new MidiStreamParser(onMessage);
    this.native = Capacitor.isNativePlatform();
    this.bleDeviceId = null;
    this.bleName = '';
    this.webBleDevice = null;
    this.webBleChar = null;
    this.usbStarted = false;
    this.midiAccess = null;
    this.reconnectTimer = 0;
    this.userDisconnected = false;
    this._onWebBleValue = (e) => this.bleParser.parse(e.target.value);
    this._onWebMidi = (e) => this.webMidiParser.feed(e.data);
  }

  _message(status, d1, d2) {
    const hi = status & 0xf0;
    if (hi === 0x90 && d2 > 0) this.h.onNoteOn(d1, d2);
    else if (hi === 0x80 || hi === 0x90) this.h.onNoteOff(d1);
    else if (hi === 0xb0 && (d1 === 123 || d1 === 120)) this.h.onAllOff();
    else if (hi === 0xb0 && d1 === 64 && this.h.onSustain) this.h.onSustain(d2 >= 64);
  }

  get bleSupported() {
    return this.native || !!(globalThis.navigator && navigator.bluetooth);
  }

  // ---------------------------------------------------------------- BLE ----

  /**
   * @param {{scanAll?: boolean}} [opts] scanAll lists every nearby Bluetooth LE
   *   device, for pianos that do not advertise the MIDI service.
   */
  async connectBluetooth(opts = {}) {
    this.userDisconnected = false;
    this.scanAll = !!opts.scanAll;
    if (this.native) return this._connectNativeBle();
    if (globalThis.navigator && navigator.bluetooth) return this._connectWebBle();
    throw new Error('Bluetooth MIDI is not available on this device/browser.');
  }

  async _connectNativeBle(knownId) {
    await BleClient.initialize({ androidNeverForLocation: false });
    let enabled = true;
    try {
      enabled = await BleClient.isEnabled();
    } catch (_) {
      /* web stub */
    }
    if (!enabled) {
      if (typeof BleClient.requestEnable === 'function') {
        try {
          await BleClient.requestEnable();
        } catch (_) {
          throw new Error('Please turn on Bluetooth and try again.');
        }
      } else {
        throw new Error('Please turn on Bluetooth and try again.');
      }
    }
    let deviceId = knownId;
    let name = this.bleName;
    if (!deviceId) {
      const device = await BleClient.requestDevice(
        this.scanAll ? { optionalServices: [BLE_MIDI_SERVICE] } : { services: [BLE_MIDI_SERVICE], optionalServices: [BLE_MIDI_SERVICE] },
      );
      deviceId = device.deviceId;
      name = device.name || 'Bluetooth piano';
    }
    this.h.onStatus('Connecting to ' + name + '…', 'busy');
    await BleClient.connect(deviceId, () => this._onBleDisconnected());
    try {
      if (typeof BleClient.requestConnectionPriority === 'function') {
        await BleClient.requestConnectionPriority(deviceId, 1); // CONNECTION_PRIORITY_HIGH: lowest latency
      }
    } catch (_) {
      /* optional */
    }
    if (typeof BleClient.getServices === 'function') {
      let services = [];
      try {
        services = await BleClient.getServices(deviceId);
      } catch (_) {
        services = null;
      }
      if (services && !services.some((sv) => String(sv.uuid).toLowerCase() === BLE_MIDI_SERVICE)) {
        try {
          await BleClient.disconnect(deviceId);
        } catch (_) {
          /* ignore */
        }
        throw new Error(NOT_MIDI(name));
      }
    }
    this.bleParser.reset();
    await BleClient.startNotifications(deviceId, BLE_MIDI_SERVICE, BLE_MIDI_CHARACTERISTIC, (value) => this.bleParser.parse(value));
    this.bleDeviceId = deviceId;
    this.bleName = name;
    try {
      localStorage.setItem(LAST_BLE_KEY, JSON.stringify({ id: deviceId, name }));
    } catch (_) {
      /* storage unavailable */
    }
    this.h.onStatus(name, 'ble');
    return name;
  }

  async _connectWebBle() {
    const device = await navigator.bluetooth.requestDevice(
      this.scanAll
        ? { acceptAllDevices: true, optionalServices: [BLE_MIDI_SERVICE] }
        : { filters: [{ services: [BLE_MIDI_SERVICE] }], optionalServices: [BLE_MIDI_SERVICE] },
    );
    this.webBleDevice = device;
    device.addEventListener('gattserverdisconnected', () => this._onBleDisconnected());
    await this._webBleAttach(device);
    return device.name || 'Bluetooth piano';
  }

  async _webBleAttach(device) {
    const name = device.name || 'Bluetooth piano';
    this.h.onStatus('Connecting to ' + name + '…', 'busy');
    const server = await device.gatt.connect();
    let service;
    try {
      service = await server.getPrimaryService(BLE_MIDI_SERVICE);
    } catch (_) {
      server.disconnect();
      throw new Error(NOT_MIDI(name));
    }
    const ch = await service.getCharacteristic(BLE_MIDI_CHARACTERISTIC);
    if (this.webBleChar) this.webBleChar.removeEventListener('characteristicvaluechanged', this._onWebBleValue);
    this.webBleChar = ch;
    ch.addEventListener('characteristicvaluechanged', this._onWebBleValue);
    await ch.startNotifications();
    this.bleParser.reset();
    this.bleName = name;
    this.h.onStatus(name, 'ble');
  }

  _onBleDisconnected() {
    this.h.onAllOff();
    if (this.userDisconnected) {
      this.h.onStatus('Piano disconnected', 'idle');
      return;
    }
    this.h.onStatus('Connection lost — reconnecting…', 'busy');
    this._scheduleReconnect(1);
  }

  _scheduleReconnect(attempt) {
    clearTimeout(this.reconnectTimer);
    if (attempt > 5) {
      this.h.onStatus('Piano disconnected — tap Connect', 'error');
      return;
    }
    this.reconnectTimer = setTimeout(async () => {
      try {
        if (this.native && this.bleDeviceId) await this._connectNativeBle(this.bleDeviceId);
        else if (this.webBleDevice) await this._webBleAttach(this.webBleDevice);
      } catch (_) {
        this._scheduleReconnect(attempt + 1);
      }
    }, 800 * attempt);
  }

  /** Reconnects to the last paired BLE piano without showing the picker (native only). */
  async reconnectLast() {
    if (!this.native) return false;
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(LAST_BLE_KEY) || 'null');
    } catch (_) {
      saved = null;
    }
    if (!saved || !saved.id) return false;
    this.bleName = saved.name || 'Bluetooth piano';
    try {
      await this._connectNativeBle(saved.id);
      return true;
    } catch (_) {
      return false;
    }
  }

  async disconnectBluetooth() {
    this.userDisconnected = true;
    clearTimeout(this.reconnectTimer);
    try {
      if (this.native && this.bleDeviceId) await BleClient.disconnect(this.bleDeviceId);
      else if (this.webBleDevice && this.webBleDevice.gatt.connected) this.webBleDevice.gatt.disconnect();
    } catch (_) {
      /* already gone */
    }
    this.bleDeviceId = null;
    this.h.onAllOff();
    this.h.onStatus('Piano disconnected', 'idle');
  }

  get bleConnected() {
    if (this.native) return !!this.bleDeviceId;
    return !!(this.webBleDevice && this.webBleDevice.gatt && this.webBleDevice.gatt.connected);
  }

  // ---------------------------------------------------------- USB / Web MIDI

  /** Starts listening to wired MIDI. Silent no-op when unsupported. */
  async startWired({ interactive = false } = {}) {
    if (this.native) {
      if (this.usbStarted) return true;
      try {
        await UsbMidi.addListener('midi', (ev) => {
          const bytes = ev && ev.bytes;
          if (bytes) this.usbParser.feed(bytes);
        });
        await UsbMidi.addListener('devices', (ev) => {
          const names = (ev && ev.names) || [];
          if (names.length) this.h.onStatus(names.join(', ') + ' (USB)', 'usb');
          else if (!this.bleConnected) this.h.onStatus('No piano connected', 'idle');
        });
        const res = await UsbMidi.start();
        this.usbStarted = true;
        if (res && res.supported === false && interactive) this.h.onStatus('USB MIDI not supported on this device', 'error');
        return true;
      } catch (err) {
        if (interactive) this.h.onStatus('USB MIDI unavailable: ' + (err && err.message ? err.message : err), 'error');
        return false;
      }
    }
    if (!(globalThis.navigator && navigator.requestMIDIAccess)) {
      if (interactive) this.h.onStatus('Web MIDI is not supported in this browser', 'error');
      return false;
    }
    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      const attach = () => {
        const names = [];
        this.midiAccess.inputs.forEach((input) => {
          input.onmidimessage = this._onWebMidi;
          if (input.state === 'connected') names.push(input.name || 'MIDI device');
        });
        if (names.length) this.h.onStatus(names.join(', ') + ' (USB)', 'usb');
        else if (interactive && !this.bleConnected) this.h.onStatus('No USB MIDI device found', 'idle');
      };
      this.midiAccess.onstatechange = attach;
      attach();
      return true;
    } catch (err) {
      if (interactive) this.h.onStatus('MIDI permission denied', 'error');
      return false;
    }
  }
}
