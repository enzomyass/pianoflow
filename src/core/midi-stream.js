// Plain MIDI 1.0 byte-stream parser (USB MIDI via Android MidiManager, Web MIDI).
// Handles running status, interleaved realtime bytes and SysEx. No allocation.

export class MidiStreamParser {
  /** @param {(status:number, d1:number, d2:number) => void} onMessage */
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.running = 0;
    this.need = 0;
    this.count = 0;
    this.d1 = 0;
    this.skip = 0;
    this.inSysex = false;
  }

  reset() {
    this.running = 0;
    this.count = 0;
    this.skip = 0;
    this.inSysex = false;
  }

  /** @param {ArrayLike<number>} bytes */
  feed(bytes, offset = 0, length = bytes.length - offset) {
    const end = offset + length;
    for (let i = offset; i < end; i++) this.byte(bytes[i] & 0xff);
  }

  byte(b) {
    if (b & 0x80) {
      if (b >= 0xf8) return; // realtime
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
        this.running = 0;
        this.skip = b === 0xf2 ? 2 : b === 0xf1 || b === 0xf3 ? 1 : 0;
        return;
      }
      this.running = b;
      this.need = (b & 0xe0) === 0xc0 ? 1 : 2;
      this.count = 0;
      this.skip = 0;
      return;
    }
    if (this.inSysex) return;
    if (this.skip > 0) {
      this.skip--;
      return;
    }
    if (!this.running) return;
    if (this.count === 0) {
      this.d1 = b;
      if (this.need === 1) this.onMessage(this.running, b, 0);
      else this.count = 1;
    } else {
      this.count = 0;
      this.onMessage(this.running, this.d1, b);
    }
  }
}
