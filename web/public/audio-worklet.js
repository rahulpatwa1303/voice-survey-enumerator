// Runs on the audio thread. Two processors:
//  capture: downsamples mic (context rate) to 24kHz PCM16, posts Int16 chunks.
//  playback: buffers incoming Int16 PCM and plays it out; clear() on barge-in.
const OUT_RATE = 24000;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this._buf = []; this._ratio = sampleRate / OUT_RATE; this._pos = 0; }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    // linear-ish decimation to 24k
    const out = [];
    for (; this._pos < ch.length; this._pos += this._ratio) {
      const s = ch[Math.floor(this._pos)];
      out.push(Math.max(-1, Math.min(1, s)) * 0x7fff);
    }
    this._pos -= ch.length;
    const pcm = new Int16Array(out);
    this.port.postMessage(pcm, [pcm.buffer]);
    return true;
  }
}

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._queue = [];       // Float32Array chunks at OUT_RATE
    this._cur = null; this._i = 0; this._frac = 0;
    this._ratio = OUT_RATE / sampleRate;
    this.port.onmessage = (e) => {
      if (e.data === 'clear') { this._queue = []; this._cur = null; return; }
      const i16 = new Int16Array(e.data);
      const f = new Float32Array(i16.length);
      for (let k = 0; k < i16.length; k++) f[k] = i16[k] / 0x8000;
      this._queue.push(f);
    };
  }
  process(_i, outputs) {
    const out = outputs[0][0];
    for (let n = 0; n < out.length; n++) {
      if (!this._cur) { this._cur = this._queue.shift() || null; this._i = 0; this._frac = 0; }
      if (!this._cur) { out[n] = 0; continue; }
      out[n] = this._cur[this._i] || 0;
      this._frac += this._ratio;
      while (this._frac >= 1) { this._frac -= 1; this._i++; }
      if (this._i >= this._cur.length) { this._cur = this._queue.shift() || null; this._i = 0; }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
registerProcessor('playback', PlaybackProcessor);
