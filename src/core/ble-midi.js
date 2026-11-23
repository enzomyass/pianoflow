// Bluetooth LE MIDI packet parser (MIDI Manufacturers Association BLE-MIDI spec).
//
// Packet layout:
//   [header] [timestamp] [status] [data...] ([timestamp] [status|data...])*
//   header    : 1 0 t t t t t t   (bit7=1, bit6=0, 6 high timestamp bits)
//   timestamp : 1 t t t t t t t   (bit7=1, 7 low timestamp bits)
//
// The header and every timestamp byte have bit 7 set, exactly like status
// bytes. A naive parser therefore reads e.g. a timestamp of 0x90 as a NoteOn
// status and produces ghost notes. This parser tracks whether the previous
// byte was a timestamp: a high byte that does NOT follow a timestamp is itself
// a timestamp; a high byte that DOES follow one is a status byte.
//
// Running status (data bytes reusing the previous status, with or without a
// fresh timestamp), interleaved realtime bytes and SysEx spanning packets are
// all handled. No allocation happens per packet or per message.

export class BleMidiParser {
  /** @param {(status:number, d1:number, d2:number) => void} onMessage */
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.running = 0; // current channel-voice running status
    this.need = 0; // data bytes required by running status
    this.count = 0; // data bytes collected
    this.d1 = 0;
    this.skip = 0; // data bytes of a system-common message to discard
    this.inSysex = false;
    this.lastTimestamp = 0; // 13-bit ms timestamp of the latest message
    this.packets = 0;
    this.dropped = 0;
  }

  reset() {
    this.running = 0;
    this.need = 0;
    this.count = 0;
    this.skip = 0;
    this.inSysex = false;
  }

  /**
   * Parses one BLE notification.
   * @param {DataView|Uint8Array} packet
   */
  parse(packet) {
    const isView = typeof packet.getUint8 === 'function';
    const len = packet.byteLength;
    if (len < 2) {
      this.dropped++;
      return;
    }
    const header = isView ? packet.getUint8(0) : packet[0];
    if ((header & 0xc0) !== 0x80) {
      // Not a BLE-MIDI packet; never guess, guessing creates ghost notes.
      this.dropped++;
      return;
    }
    this.packets++;
    const tsHigh = header & 0x3f;
    let lastWasTimestamp = false;
    // A message cannot be split across packets except SysEx.
    this.count = 0;
    this.skip = 0;

    for (let i = 1; i < len; i++) {
      const b = isView ? packet.getUint8(i) : packet[i];
      if (b & 0x80) {
        if (!lastWasTimestamp) {
          lastWasTimestamp = true;
          this.lastTimestamp = (tsHigh << 7) | (b & 0x7f);
          this.count = 0; // a timestamp always starts a new message
          continue;
        }
        lastWasTimestamp = false;
        this._status(b);
      } else {
        lastWasTimestamp = false;
        this._data(b);
      }
    }
  }

  _status(b) {
    if (b >= 0xf8) {
      // Realtime: does not touch running status or an ongoing SysEx.
      return;
    }
    if (b === 0xf0) {
      this.inSysex = true;
      this.running = 0;
      return;
    }
    if (b === 0xf7) {
      this.inSysex = false;
      return;
    }
    this.inSysex = false;
    if (b >= 0xf0) {
      // System common cancels running status.
      this.running = 0;
      this.skip = b === 0xf2 ? 2 : b === 0xf1 || b === 0xf3 ? 1 : 0;
      return;
    }
    this.running = b;
    this.need = (b & 0xe0) === 0xc0 ? 1 : 2; // Cx/Dx have one data byte
    this.count = 0;
    this.skip = 0;
  }

  _data(b) {
    if (this.inSysex) return;
    if (this.skip > 0) {
      this.skip--;
      return;
    }
    if (!this.running) return; // stray data: drop rather than invent a note
    if (this.count === 0) {
      this.d1 = b;
      if (this.need === 1) {
        this.onMessage(this.running, b, 0);
      } else {
        this.count = 1;
      }
    } else {
      this.count = 0;
      this.onMessage(this.running, this.d1, b);
    }
  }
}
