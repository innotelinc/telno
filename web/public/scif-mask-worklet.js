/*
 * The SCIF voice mask, as an AudioWorklet module.
 *
 * This lives in a file on this origin instead of a Blob built by the console at
 * runtime. A Blob URL is a script the page minted itself, and the console's
 * Content-Security-Policy (`script-src 'self'`) refuses to load one — so the
 * mask quietly failed to engage in production while every code path around it
 * looked correct. `self` already permits this file, so the policy stays strict.
 *
 * Two effects:
 *
 *   pitch   a granular pitch shifter — two taps reading one delay line, a half
 *           grain apart, cross-faded with sine windows. Each tap reads faster
 *           than the writer for a rise and slower for a fall, and is rewound by
 *           one grain while its own window is at zero, so the jump is inaudible.
 *           This is what makes a voice sound like someone else rather than like
 *           a tape played at the wrong speed.
 *   robot   a 55 Hz carrier multiplied into the signal, which flattens the
 *           pitch contour into a buzz — the unmistakably non-human option.
 *
 * `off` is a true passthrough, not ratio 1 through the shifter: two taps half a
 * grain apart on the same audio comb-filter each other, and "no disguise" must
 * sound exactly like the microphone.
 */

// How far behind the writer a tap reads at the start of its grain. Half a grain
// keeps every read comfortably in the past while leaving room for the drift a
// grain of pitch shifting adds on top.
const GRAIN = 2048;

class ScifMaskProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = 8192;
    this.buffer = new Float32Array(this.size);
    this.write = 0;
    this.half = GRAIN / 2;
    // Samples of extra delay the taps have drifted by, wrapped to one grain.
    // Its slope *is* the pitch ratio: a tap that drifts forward reads slower
    // than the writer and sounds lower.
    this.drift = 0;
    this.ratio = 1;
    this.robot = 0;
    this.carrier = 0;
    this.setMode(options && options.processorOptions && options.processorOptions.mode);
    this.port.onmessage = (event) => this.setMode(event.data && event.data.mode);
  }

  setMode(mode) {
    const table = {
      off: [1, 0],
      low: [Math.pow(2, -4 / 12), 0],
      high: [Math.pow(2, 5 / 12), 0],
      robot: [1, 1],
    };
    const setting = table[mode] || [1, 0];
    this.ratio = setting[0];
    this.robot = setting[1];
  }

  /** One delay-line read, interpolated: a fractional delay is a pitch, not a click. */
  read(delay) {
    const position = this.write - delay;
    const base = Math.floor(position);
    const fraction = position - base;
    const low = this.buffer[((base % this.size) + this.size) % this.size];
    const high = this.buffer[(((base + 1) % this.size) + this.size) % this.size];
    return low + (high - low) * fraction;
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }

    // No disguise, and nothing to disguise with: hand the microphone through.
    if (this.ratio === 1 && !this.robot) {
      output.set(input.length <= output.length ? input : input.subarray(0, output.length));
      if (input.length < output.length) output.fill(0, input.length);
      // The line is still fed while bypassed, so switching a disguise on mid-call
      // starts from this second's audio rather than from silence. The drift is
      // meaningless after a bypass: a later mode change starts a clean grain.
      for (let i = 0; i < input.length; i += 1) {
        this.buffer[this.write] = input[i];
        this.write = (this.write + 1) % this.size;
      }
      this.drift = 0;
      return true;
    }

    const step = this.ratio - 1;
    for (let i = 0; i < output.length; i += 1) {
      this.buffer[this.write] = input[i];

      this.drift -= step;
      if (this.drift < 0) this.drift += GRAIN;
      else if (this.drift >= GRAIN) this.drift -= GRAIN;

      const other = (this.drift + this.half) % GRAIN;
      // Each tap is windowed by its own position in the grain, so a tap is at
      // full gain exactly when the other is rewinding — and both windows reach
      // zero at the jump, which is what keeps the rewind inaudible.
      let sample =
        this.read(this.half + this.drift) * Math.sin((Math.PI * this.drift) / GRAIN) +
        this.read(this.half + other) * Math.sin((Math.PI * other) / GRAIN);

      if (this.robot) {
        this.carrier = (this.carrier + (2 * Math.PI * 55) / sampleRate) % (2 * Math.PI);
        sample *= Math.cos(this.carrier);
      }
      output[i] = Math.max(-1, Math.min(1, sample));
      this.write = (this.write + 1) % this.size;
    }
    return true;
  }
}

registerProcessor('scif-mask', ScifMaskProcessor);
