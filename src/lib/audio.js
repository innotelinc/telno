/**
 * PCM helpers for hold music.
 *
 * Everything here works on mono Float32 samples in [-1, 1]. The switch wants
 * 8 kHz 16-bit mono WAV — that is what every codec a caller might be on can
 * play without a resample inside Asterisk — so the generator renders at 8 kHz
 * and this file is what turns samples into a file (or a synthesizer's output
 * into 8 kHz samples).
 *
 * Nothing here is a general-purpose audio library: there is no mixer bus, no
 * float WAV writer and no Opus. It is the smallest set of operations the hold
 * music generator needs, kept separate so its maths can be checked on its own.
 */

/** The rate the switch plays. 8 kHz is G.711's own rate. */
export const SWITCH_RATE = 8000;

/**
 * Decode a PCM WAV into mono floats.
 *
 * A synthesizer hands back whatever rate it likes — flite writes 16 kHz — so
 * the header is read rather than assumed. Compressed WAVs (ADPCM, mu-law) are
 * refused by name instead of being read as noise.
 */
export function readWav(buffer) {
  if (!buffer || buffer.length < 44) throw new Error('that audio is not a WAV file');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('that audio is not a WAV file');
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let format = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (id === 'fmt ') {
      format = {
        codec: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        bits: view.getUint16(start + 14, true),
      };
    } else if (id === 'data') {
      data = { start, size: Math.min(size, buffer.length - start) };
    }
    offset = start + size + (size % 2);
  }

  if (!format || !data) throw new Error('that WAV file has no audio in it');
  if (format.codec !== 1 && format.codec !== 3) {
    throw new Error('only uncompressed PCM WAV is supported');
  }
  if (!format.sampleRate || !format.channels) throw new Error('that WAV file has no usable header');

  const width = format.bits / 8;
  const frames = Math.floor(data.size / (width * format.channels));
  const samples = new Float32Array(frames);
  const read = (at) => {
    if (format.codec === 3) {
      if (format.bits === 32) return view.getFloat32(at, true);
      return view.getInt16(at, true) / 0x8000;
    }
    if (format.bits === 16) return view.getInt16(at, true) / 0x8000;
    if (format.bits === 8) return (view.getUint8(at) - 128) / 0x80;
    if (format.bits === 32) return view.getInt32(at, true) / 0x80000000;
    return 0;
  };

  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < format.channels; channel += 1) {
      sum += read(data.start + (frame * format.channels + channel) * width);
    }
    samples[frame] = sum / format.channels;
  }

  return { sampleRate: format.sampleRate, channels: format.channels, samples };
}

/** 16-bit mono PCM WAV. The one format the switch is guaranteed to play. */
export function encodeWav({ sampleRate = SWITCH_RATE, samples }) {
  const frames = samples.length;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    const clamped = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

/**
 * Windowed-sinc low pass, as a kernel.
 *
 * A plain running average is cheap and leaks badly: decimating a 16 kHz voice
 * to 8 kHz through one leaves sibilants folding back into the formants as a
 * metallic buzz. A Blackman-windowed sinc costs a few million multiplies for a
 * sentence and is clean.
 */
export function lowpassKernel(cutoffHz, rate, taps = 63) {
  const count = taps % 2 === 0 ? taps + 1 : taps;
  const mid = (count - 1) / 2;
  const omega = (2 * Math.PI * cutoffHz) / rate;
  const kernel = new Float64Array(count);
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const n = i - mid;
    const sinc = n === 0 ? 1 : Math.sin(omega * n) / (omega * n);
    const window = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (count - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (count - 1));
    kernel[i] = sinc * window;
    sum += kernel[i];
  }
  for (let i = 0; i < count; i += 1) kernel[i] /= sum;
  return kernel;
}

function applyKernel(samples, kernel) {
  const out = new Float32Array(samples.length);
  const mid = (kernel.length - 1) / 2;
  for (let i = 0; i < samples.length; i += 1) {
    let sum = 0;
    for (let k = 0; k < kernel.length; k += 1) {
      const at = i + k - mid;
      if (at >= 0 && at < samples.length) sum += samples[at] * kernel[k];
    }
    out[i] = sum;
  }
  return out;
}

/**
 * Resample mono floats. Downsampling is filtered first, so aliases do not
 * become part of the signal; upsampling is a linear interpolation, which for
 * speech at these ratios is inaudible next to the interpolation itself.
 */
export function resample(samples, from, to) {
  if (from === to) return Float32Array.from(samples);
  const source = from > to ? applyKernel(samples, lowpassKernel(to * 0.45, from)) : samples;
  const frames = Math.max(1, Math.round((source.length * to) / from));
  const out = new Float32Array(frames);
  const step = from / to;
  for (let i = 0; i < frames; i += 1) {
    const at = i * step;
    const index = Math.floor(at);
    const frac = at - index;
    const a = source[index] ?? 0;
    const b = source[index + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Clip the silence a synthesizer leaves at both ends. */
export function trimSilence(samples, { threshold = 0.012, keep = 0.03, rate = SWITCH_RATE } = {}) {
  let first = 0;
  let last = samples.length - 1;
  while (first < samples.length && Math.abs(samples[first]) < threshold) first += 1;
  while (last > first && Math.abs(samples[last]) < threshold) last -= 1;
  if (first >= last) return new Float32Array(0);
  const pad = Math.round(keep * rate);
  const from = Math.max(0, first - pad);
  const to = Math.min(samples.length, last + pad);
  return samples.slice(from, to);
}

export const peakOf = (samples) => {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
  }
  return peak;
};

export const rmsOf = (samples) => {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
};

/**
 * Scale to a target peak.
 *
 * Both directions: a bed that peaks at -5 dB is needlessly quiet next to a
 * voice, and the limit is `cap` rather than 1.0 so a nearly-silent buffer is
 * not amplified into a roar. The switch's G.711 ladder is unforgiving about
 * level, so the target is a little under full scale.
 */
export function normalize(samples, target = 0.89, { cap = 4 } = {}) {
  const peak = peakOf(samples);
  if (peak <= 0) return samples;
  const gain = Math.min(target / peak, cap);
  if (Math.abs(gain - 1) < 0.002) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] * gain;
  return out;
}

/**
 * Add `source` into `target` at a sample offset, with a gain that can be a
 * function of the sample index (used for the duck under the announcement).
 */
export function mixInto(target, source, offset, gain = 1) {
  const start = Math.max(0, Math.round(offset));
  for (let i = 0; i < source.length; i += 1) {
    const at = start + i;
    if (at >= target.length) break;
    const g = typeof gain === 'function' ? gain(i) : gain;
    target[at] += source[i] * g;
  }
  return target;
}

/** A short linear fade, so a loop point does not click. */
export function fadeEdges(samples, rate = SWITCH_RATE, seconds = 0.05) {
  const frames = Math.min(Math.round(seconds * rate), Math.floor(samples.length / 2));
  for (let i = 0; i < frames; i += 1) {
    const factor = i / frames;
    samples[i] *= factor;
    samples[samples.length - 1 - i] *= factor;
  }
  return samples;
}
