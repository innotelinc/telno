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
 *   pitch   a phase vocoder. The signal is cut into overlapping frames, each
 *           frame is transformed, every partial is moved to the bin its new
 *           pitch belongs in, and the frames are overlap-added again. Because
 *           pitch comes from moving energy between bins rather than from
 *           re-reading a delay line, there is no cross-fade to modulate the
 *           output: the level stays flat and the voice is simply someone else's
 *           register, without the tremolo a granular shifter leaves behind.
 *   robot   a 55 Hz carrier multiplied into the signal, which flattens the
 *           pitch contour into a buzz — the unmistakably non-human option.
 *
 * `off` is a true passthrough: the vocoder costs a couple of frames of latency,
 * and "no disguise" should neither delay the operator's voice nor colour it.
 *
 * Nothing here is a claim of anonymity. A pitch shift changes how you sound; it
 * does not change what you say, and it is not a substitute for a secure line.
 */

// One analysis frame is the resolution of the shift: 1024 at 48 kHz gives ~47 Hz
// bins, fine enough to move a voice's harmonics without smearing them into each
// other, and small enough that the added latency stays under one syllable.
const FFT_SIZE = 1024;
const HOP = 256;
const BINS = FFT_SIZE / 2;

// Hann on the way in and on the way out, at 75% overlap: the squared windows
// sum to this, so dividing by it restores the input's level.
const OVERLAP_GAIN = 1.5;

// Re-stacking partials is not level-neutral: a voice's harmonics land on shared
// bins and add, which measured about 2 dB hot on tones (and 3 dB quiet on
// broadband hiss, where the top of the spectrum shifts past Nyquist). This trim
// is the measured average, so a masked voice arrives at roughly the level it
// would have arrived at unmasked instead of noticeably louder.
const PITCH_TRIM = 0.78;

const WINDOW = new Float32Array(FFT_SIZE);
for (let n = 0; n < FFT_SIZE; n += 1) {
  WINDOW[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / FFT_SIZE);
}

/**
 * In-place radix-2 FFT with precomputed twiddles. A worklet has to do this on
 * the audio thread, so it allocates nothing per frame.
 */
class Fft {
  constructor(size) {
    this.size = size;
    const bits = Math.round(Math.log2(size));
    this.reverse = new Uint32Array(size);
    for (let i = 0; i < size; i += 1) {
      let reversed = 0;
      for (let bit = 0; bit < bits; bit += 1) reversed = (reversed << 1) | ((i >> bit) & 1);
      this.reverse[i] = reversed;
    }
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i += 1) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((2 * Math.PI * i) / size);
    }
  }

  /** Forward transform, e^{-i2πkn/N}. */
  forward(re, im) {
    const { size, reverse, cos, sin } = this;
    for (let i = 0; i < size; i += 1) {
      const j = reverse[i];
      if (j > i) {
        let swap = re[i];
        re[i] = re[j];
        re[j] = swap;
        swap = im[i];
        im[i] = im[j];
        im[j] = swap;
      }
    }
    for (let span = 2; span <= size; span *= 2) {
      const halfSpan = span / 2;
      const stride = size / span;
      for (let start = 0; start < size; start += span) {
        for (let j = start, k = 0; j < start + halfSpan; j += 1, k += stride) {
          const evenRe = re[j];
          const evenIm = im[j];
          const oddRe = re[j + halfSpan];
          const oddIm = im[j + halfSpan];
          const twiddleRe = oddRe * cos[k] + oddIm * sin[k];
          const twiddleIm = oddIm * cos[k] - oddRe * sin[k];
          re[j] = evenRe + twiddleRe;
          im[j] = evenIm + twiddleIm;
          re[j + halfSpan] = evenRe - twiddleRe;
          im[j + halfSpan] = evenIm - twiddleIm;
        }
      }
    }
  }

  /** Inverse transform: swapping the parts inverts it, scaled by the size. */
  inverse(re, im) {
    this.forward(im, re);
    for (let i = 0; i < this.size; i += 1) {
      re[i] /= this.size;
      im[i] /= this.size;
    }
  }
}

const FFT = new Fft(FFT_SIZE);
// Phase advance per hop for a partial sitting exactly on a bin, in radians.
const HOP_PHASE = (2 * Math.PI * HOP) / FFT_SIZE;

class ScifMaskProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // The sample ring the analysis frames are cut from, its write cursor, and
    // the overlap-add accumulator the frames are written back into.
    this.ring = new Float32Array(FFT_SIZE);
    this.write = 0;
    this.overlap = new Float32Array(FFT_SIZE);
    this.cursor = 0;
    this.sinceHop = 0;

    this.re = new Float32Array(FFT_SIZE);
    this.im = new Float32Array(FFT_SIZE);
    this.lastPhase = new Float32Array(BINS);
    this.sumPhase = new Float32Array(BINS);
    this.startPhase = new Float32Array(BINS);
    this.magnitude = new Float32Array(BINS);
    this.frequency = new Float32Array(BINS);
    this.first = true;

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

  /**
   * Shift one frame and add it to the output.
   *
   * Phase comes from the analysis, frequency from the analysis too: the change
   * between a frame's phase and the phase a bin's own frequency predicts is what
   * a partial has really been doing, so adding that deviation to the hop's phase
   * gives the next frame's phase for the shifted partial. Without it the frames
   * would not line up and the shift would arrive as a rumble.
   */
  shiftFrame() {
    const { ring, re, im, lastPhase, sumPhase, magnitude, frequency, startPhase } = this;

    for (let n = 0; n < FFT_SIZE; n += 1) {
      // `write` is the oldest sample, so the frame reads forward from it.
      re[n] = ring[(this.write + n) % FFT_SIZE] * WINDOW[n];
      im[n] = 0;
    }
    FFT.forward(re, im);

    magnitude.fill(0);
    frequency.fill(0);
    for (let bin = 1; bin < BINS; bin += 1) {
      const real = re[bin];
      const imaginary = im[bin];
      const level = Math.hypot(real, imaginary);
      const phase = Math.atan2(imaginary, real);
      // How far this frame's phase is from what the bin's own frequency would
      // have produced: the excess is the partial's real frequency offset.
      let deviation = phase - lastPhase[bin] - bin * HOP_PHASE;
      lastPhase[bin] = phase;
      deviation -= 2 * Math.PI * Math.round(deviation / (2 * Math.PI));
      const trueBin = bin + deviation / HOP_PHASE;

      const target = Math.round(trueBin * this.ratio);
      if (target > 0 && target < BINS) {
        const previous = magnitude[target];
        magnitude[target] = previous + level;
        // Every source bin landing on the same target contributes its level; the
        // strongest partial owns the frequency and the starting phase, which is
        // what keeps the shifted harmonics from smearing into one another.
        if (level >= previous) {
          frequency[target] = trueBin * this.ratio;
          startPhase[target] = phase;
        }
      }
    }

    re.fill(0);
    im.fill(0);
    for (let bin = 1; bin < BINS; bin += 1) {
      if (magnitude[bin] <= 0) continue;
      // The first frame starts at the phase it was analysed at, not at zero:
      // starting at zero would open every disguise with a click.
      if (this.first) sumPhase[bin] = startPhase[bin];
      else sumPhase[bin] += frequency[bin] * HOP_PHASE;
      sumPhase[bin] -= 2 * Math.PI * Math.round(sumPhase[bin] / (2 * Math.PI));
      const real = magnitude[bin] * Math.cos(sumPhase[bin]);
      const imaginary = magnitude[bin] * Math.sin(sumPhase[bin]);
      re[bin] = real;
      im[bin] = imaginary;
      // A real signal has a conjugate spectrum; without it the inverse would
      // come back complex and the imaginary half would be thrown away.
      re[FFT_SIZE - bin] = real;
      im[FFT_SIZE - bin] = -imaginary;
    }
    FFT.inverse(re, im);

    for (let n = 0; n < FFT_SIZE; n += 1) {
      this.overlap[(this.cursor + n) % FFT_SIZE] += re[n] * WINDOW[n];
    }
    this.first = false;
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
      // The analysis ring is still fed while bypassed, so switching a disguise on
      // mid-call starts from this second's audio rather than from silence.
      for (let i = 0; i < input.length; i += 1) {
        this.ring[this.write] = input[i];
        this.write = (this.write + 1) % FFT_SIZE;
      }
      return true;
    }

    // Ring modulation needs no frames: it is a multiply against a carrier.
    if (this.robot && this.ratio === 1) {
      for (let i = 0; i < output.length; i += 1) {
        this.ring[this.write] = input[i];
        this.write = (this.write + 1) % FFT_SIZE;
        this.carrier = (this.carrier + (2 * Math.PI * 55) / sampleRate) % (2 * Math.PI);
        output[i] = Math.max(-1, Math.min(1, input[i] * Math.cos(this.carrier)));
      }
      return true;
    }

    for (let i = 0; i < output.length; i += 1) {
      this.ring[this.write] = input[i];
      this.write = (this.write + 1) % FFT_SIZE;

      // Emit the oldest sample of the overlap-add accumulator and clear it, so
      // the frame that is about to be added lands on empty space.
      let sample = this.overlap[this.cursor];
      this.overlap[this.cursor] = 0;
      this.cursor = (this.cursor + 1) % FFT_SIZE;

      this.sinceHop += 1;
      if (this.sinceHop >= HOP) {
        this.sinceHop = 0;
        this.shiftFrame();
      }
      output[i] = Math.max(-1, Math.min(1, (sample / OVERLAP_GAIN) * PITCH_TRIM));
    }
    return true;
  }
}

registerProcessor('scif-mask', ScifMaskProcessor);
