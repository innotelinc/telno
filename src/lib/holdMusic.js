/**
 * Hold music, generated on the switch.
 *
 * A caller on hold hears one thing: whatever file this produces. The generator
 * exists because the alternative is either a licence fee for a music library or
 * a hand-edited WAV that nobody can re-record without a studio — and because a
 * hold message ("our office is closed until Monday") changes far more often
 * than a piece of music does.
 *
 * Three parts, synthesised separately and mixed once:
 *
 *   jingle  — a five-note motif, so the start of an announcement is expected
 *   speech  — the operator's own words (see lib/speech.js)
 *   music   — a chord bed with an arpeggio, built from sines only
 *
 * Everything is additive and band-limited by construction: no sawtooth, no
 * noise burst above 3.6 kHz, no resampling artefact. The switch plays 8 kHz mono
 * G.711, so a bed that is bright at 44 kHz would be wasted anyway, and this way
 * what is rendered is what the caller hears.
 */

import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db_, now } from '../db/index.js';
import { config } from '../config.js';
import { DEFAULT_VOICE, speak, speechStatus } from './speech.js';
import {
  SWITCH_RATE,
  encodeWav,
  fadeEdges,
  normalize,
  peakOf,
  rmsOf,
} from './audio.js';

export const STYLES = [
  { value: 'calm', label: 'Calm — piano over a soft pad', bpm: 68, progression: 'hopeful' },
  { value: 'bright', label: 'Bright — marimba over light chords', bpm: 92, progression: 'daylight' },
  { value: 'lofi', label: 'Lo-fi — warm chords and dust', bpm: 76, progression: 'reflective' },
  { value: 'sweep', label: 'Sweep — slow strings, wide', bpm: 58, progression: 'evening' },
];

export const DEFAULT_STYLE = 'calm';
/** What a caller hears if nothing has been generated yet. */
export const DEFAULT_SECONDS = 60;
export const MIN_SECONDS = 20;
export const MAX_SECONDS = 300;
export const MAX_MESSAGE = 800;

/**
 * Four-bar progressions, as semitones above the tonic.
 *
 * Chosen for being unmemorable in the right way: a loop that draws attention
 * makes a two-minute wait feel longer, and a progression that resolves every
 * four bars never does.
 */
const PROGRESSIONS = {
  hopeful: [
    { root: 0, third: 4 },
    { root: 7, third: 4 },
    { root: 9, third: 3 },
    { root: 5, third: 4 },
  ],
  daylight: [
    { root: 0, third: 4 },
    { root: 5, third: 4 },
    { root: 9, third: 3 },
    { root: 7, third: 4 },
  ],
  reflective: [
    { root: 9, third: 3 },
    { root: 5, third: 4 },
    { root: 0, third: 4 },
    { root: 7, third: 4 },
  ],
  evening: [
    { root: 2, third: 3 },
    { root: 7, third: 4 },
    { root: 0, third: 4 },
    { root: 9, third: 3 },
  ],
};

const TONIC = 220; // A3
const hz = (semitones, octave = 0) => TONIC * Math.pow(2, semitones / 12) * Math.pow(2, octave);

const styleOf = (value) => STYLES.find((entry) => entry.value === value) || STYLES[0];

/**
 * One sustained chord tone.
 *
 * Three detuned copies of the same partial set: the beating between them is
 * what stops a synthesised pad sounding like a test tone. Detune is a few cents
 * — wide enough to move, narrow enough not to be out of tune.
 */
function addPad(out, frequency, startSample, lengthSamples, amplitude) {
  const partials = [
    { ratio: 1, gain: 1 },
    { ratio: 2, gain: 0.26 },
    { ratio: 3, gain: 0.1 },
    { ratio: 4, gain: 0.04 },
  ];
  const detunes = [0.9975, 1, 1.0025];
  const attack = Math.min(Math.round(0.9 * SWITCH_RATE), Math.floor(lengthSamples * 0.4));
  const release = Math.min(Math.round(1.3 * SWITCH_RATE), Math.floor(lengthSamples * 0.5));
  const end = Math.min(out.length, startSample + lengthSamples);
  for (let i = Math.max(0, startSample); i < end; i += 1) {
    const local = i - startSample;
    let envelope = 1;
    if (local < attack) envelope = local / attack;
    const remaining = startSample + lengthSamples - i;
    if (remaining < release) envelope = Math.min(envelope, remaining / release);
    if (envelope <= 0) continue;
    const t = local / SWITCH_RATE;
    let value = 0;
    for (const detune of detunes) {
      for (const partial of partials) {
        const f = frequency * partial.ratio * detune;
        if (f > SWITCH_RATE * 0.45) continue;
        value += Math.sin(2 * Math.PI * f * t) * partial.gain;
      }
    }
    out[i] += (value / detunes.length) * amplitude * envelope;
  }
}

/** A struck tone: marimba in the low styles, a bell in the motif. */
function addStruck(out, frequency, startSample, decaySeconds, amplitude, timbre = 'bell') {
  const partials =
    timbre === 'marimba'
      ? [
          { ratio: 1, gain: 1, decay: 1 },
          { ratio: 3.93, gain: 0.3, decay: 0.5 },
          { ratio: 9.2, gain: 0.06, decay: 0.25 },
        ]
      : [
          { ratio: 1, gain: 1, decay: 1 },
          { ratio: 2.76, gain: 0.34, decay: 0.6 },
          { ratio: 5.4, gain: 0.12, decay: 0.3 },
        ];
  const total = Math.round(decaySeconds * SWITCH_RATE);
  const attack = Math.round(0.004 * SWITCH_RATE);
  const end = Math.min(out.length, startSample + total);
  for (let i = Math.max(0, startSample); i < end; i += 1) {
    const local = i - startSample;
    const t = local / SWITCH_RATE;
    let value = 0;
    for (const partial of partials) {
      const f = frequency * partial.ratio;
      if (f > SWITCH_RATE * 0.45) continue;
      value += Math.sin(2 * Math.PI * f * t) * partial.gain * Math.exp(-t / (decaySeconds * 0.35 * partial.decay));
    }
    const envelope = local < attack ? local / attack : 1;
    out[i] += value * amplitude * envelope;
  }
}

/** The bass note: a sine with a little of the octave, plucked per bar. */
function addBass(out, frequency, startSample, lengthSamples, amplitude) {
  const attack = Math.round(0.02 * SWITCH_RATE);
  const release = Math.round(0.25 * SWITCH_RATE);
  const end = Math.min(out.length, startSample + lengthSamples);
  for (let i = Math.max(0, startSample); i < end; i += 1) {
    const local = i - startSample;
    const remaining = startSample + lengthSamples - i;
    const t = local / SWITCH_RATE;
    const envelope =
      Math.min(local < attack ? local / attack : 1, remaining < release ? remaining / release : 1) *
      Math.exp(-t * 0.9);
    out[i] +=
      (Math.sin(2 * Math.PI * frequency * t) + 0.16 * Math.sin(4 * Math.PI * frequency * t)) * amplitude * envelope;
  }
}

/**
 * Schroeder reverb: four damped combs into two allpasses.
 *
 * Deliberately cheap and deliberately dark. It exists to put the instruments in
 * one room rather than to be an effect anyone should notice; the delays are the
 * classic 44.1 kHz tunings scaled to this rate.
 */
function reverb(samples, { mix = 0.2, feedback = 0.78, damp = 0.24 } = {}) {
  const scale = SWITCH_RATE / 44100;
  const combs = [1116, 1188, 1277, 1356].map((delay) => Math.max(1, Math.round(delay * scale)));
  const allpasses = [556, 441].map((delay) => Math.max(1, Math.round(delay * scale)));
  const wet = new Float32Array(samples.length);

  for (const delay of combs) {
    const line = new Float32Array(samples.length);
    let filter = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const delayed = i >= delay ? line[i - delay] : 0;
      filter = delayed * (1 - damp) + filter * damp;
      line[i] = samples[i] + filter * feedback;
      wet[i] += line[i] * 0.25;
    }
  }

  let stage = wet;
  for (const delay of allpasses) {
    const out = new Float32Array(stage.length);
    for (let i = 0; i < stage.length; i += 1) {
      const delayed = i >= delay ? stage[i - delay] : 0;
      out[i] = -stage[i] + delayed;
    }
    stage = out;
  }

  const result = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    result[i] = samples[i] * (1 - mix) + stage[i] * mix;
  }
  return result;
}

/** The chord bed for one style, without any announcement in it. */
function synthesizeBed({ style, seconds }) {
  const config_ = styleOf(style);
  const progression = PROGRESSIONS[config_.progression] || PROGRESSIONS.hopeful;
  const length = Math.round(seconds * SWITCH_RATE);
  const out = new Float32Array(length);
  const beat = 60 / config_.bpm;
  const bar = beat * 4;
  const bars = Math.ceil(seconds / bar) + 1;

  for (let index = 0; index < bars; index += 1) {
    const chord = progression[index % progression.length];
    const at = Math.round(index * bar * SWITCH_RATE);
    if (at >= length) break;

    // Voicing: chord tones in a band around the tonic, so the pad never jumps
    // an octave between chords and the top note never fights the speech.
    const tones = [chord.root, chord.root + chord.third, chord.root + 7, chord.root + 12].map((semitone) => {
      let frequency = hz(semitone);
      while (frequency > 660) frequency /= 2;
      while (frequency < 180) frequency *= 2;
      return frequency;
    });

    for (const tone of tones.slice(0, 3)) {
      addPad(out, tone, at, Math.round(bar * SWITCH_RATE * 1.05), 0.055);
    }

    // Arpeggio. The pattern is a waltz-like 1-3-5-3 over eighth notes; the
    // repeating figure is what makes it feel like a piece rather than a drone.
    const pattern = [0, 2, 1, 3, 2, 1, 3, 2];
    const eighth = beat / 2;
    const steps = Math.floor(bar / eighth);
    for (let step = 0; step < steps; step += 1) {
      const semitone = chord.root + [0, chord.third, 7, 12][pattern[step % pattern.length]];
      let frequency = hz(semitone);
      while (frequency < 330) frequency *= 2;
      const timbre = style === 'bright' ? 'marimba' : 'bell';
      const level = style === 'bright' ? 0.075 : 0.045;
      addStruck(out, frequency, at + Math.round(step * eighth * SWITCH_RATE), 0.9, level, timbre);
    }

    // Bass on the first and third beat of the bar, an octave under the chord.
    let bass = hz(chord.root, -2);
    while (bass > 140) bass /= 2;
    while (bass < 55) bass *= 2;
    addBass(out, bass, at, Math.round(beat * 1.6 * SWITCH_RATE), 0.1);
    addBass(out, bass, at + Math.round(beat * 2 * SWITCH_RATE), Math.round(beat * 1.4 * SWITCH_RATE), 0.07);
  }

  const wet = reverb(out, { mix: style === 'sweep' ? 0.3 : 0.2 });
  fadeEdges(wet, SWITCH_RATE, 0.08);
  return wet;
}

/** The five-note motif that opens a track and marks each announcement. */
function synthesizeJingle({ style }) {
  const chord = PROGRESSIONS[styleOf(style).progression][0];
  const motif = [0, chord.third, 7, 12, 7];
  const seconds = 2.6;
  const out = new Float32Array(Math.round(seconds * SWITCH_RATE));
  motif.forEach((semitone, index) => {
    let frequency = hz(chord.root + semitone);
    while (frequency < 330) frequency *= 2;
    addStruck(out, frequency, Math.round((0.05 + index * 0.17) * SWITCH_RATE), 1.3, 0.16, 'bell');
  });
  // A quiet pad under the motif holds it together instead of leaving five
  // separate pings.
  for (const semitone of [chord.root, chord.root + chord.third, chord.root + 7]) {
    let frequency = hz(semitone);
    while (frequency < 200) frequency *= 2;
    addPad(out, frequency, 0, out.length, 0.03);
  }
  return reverb(fadeEdges(out, SWITCH_RATE, 0.02), { mix: 0.24 });
}

/**
 * Duck the bed under each announcement.
 *
 * A ramp rather than a cut: the music has to come back without the caller
 * noticing the mechanism, and a hard gain change on a chord sounds like a
 * dropped packet.
 */
function duckBed(bed, windows, { level = 0.28, ramp = 0.35 } = {}) {
  if (!windows.length) return bed;
  const gain = new Float32Array(bed.length).fill(1);
  const rampSamples = Math.max(1, Math.round(ramp * SWITCH_RATE));
  for (const { start, end } of windows) {
    const from = Math.max(0, start - rampSamples);
    const to = Math.min(bed.length, end + rampSamples);
    for (let i = from; i < to; i += 1) {
      let value = level;
      if (i < start) value = 1 + (level - 1) * ((i - from) / rampSamples);
      else if (i > end) value = level + (1 - level) * ((i - end) / rampSamples);
      if (value < gain[i]) gain[i] = value;
    }
  }
  const out = new Float32Array(bed.length);
  for (let i = 0; i < bed.length; i += 1) out[i] = bed[i] * gain[i];
  return out;
}

/**
 * Render one track.
 *
 * `audio` lets a caller supply already-rendered speech (the tests and the
 * recorded-message path), so this function never decides on its own to call a
 * synthesizer that might not exist.
 */
export function renderHoldMusic({ message = '', style = DEFAULT_STYLE, seconds = DEFAULT_SECONDS, audio = null }) {
  const length = Math.round(Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Number(seconds) || DEFAULT_SECONDS)) * SWITCH_RATE);
  const bed = synthesizeBed({ style, seconds: length / SWITCH_RATE });
  const jingle = synthesizeJingle({ style });

  const speech = audio && audio.samples?.length ? audio : null;
  const placements = [];
  if (speech) {
    const first = Math.max(Math.round(2.6 * SWITCH_RATE), jingle.length + Math.round(0.35 * SWITCH_RATE));
    const gap = Math.max(Math.round(45 * SWITCH_RATE), speech.samples.length + Math.round(12 * SWITCH_RATE));
    for (let at = first; at + speech.samples.length + Math.round(1.2 * SWITCH_RATE) < length; at += gap) {
      placements.push({ start: at, end: at + speech.samples.length });
    }
  }

  const mix = Float32Array.from(bed);
  mix.set(jingle.subarray(0, Math.min(jingle.length, mix.length)), Math.round(0.25 * SWITCH_RATE));

  const music = duckBed(mix, placements);
  for (const placement of placements) {
    const samples = speech.samples;
    for (let i = 0; i < samples.length; i += 1) {
      const at = placement.start + i;
      if (at >= length) break;
      // A little air on each end of the phrase so it does not clip the bed.
      const edge = Math.min(1, i / (0.02 * SWITCH_RATE), (samples.length - i) / (0.02 * SWITCH_RATE));
      music[at] += samples[i] * 0.85 * Math.max(0, edge);
    }
  }

  // Soft-knee limit rather than a hard clip: a chord under a voice will exceed
  // full scale at the peaks and a clip there is audible as crackle.
  for (let i = 0; i < music.length; i += 1) {
    music[i] = Math.tanh(music[i] * 1.15) / Math.tanh(1.15);
  }
  const mastered = normalize(fadeEdges(music, SWITCH_RATE, 0.03), 0.89);

  return {
    ok: true,
    buffer: encodeWav({ sampleRate: SWITCH_RATE, samples: mastered }),
    seconds: mastered.length / SWITCH_RATE,
    style: styleOf(style).value,
    announcements: placements.length,
    messageSeconds: speech ? speech.samples.length / SWITCH_RATE : 0,
    peak: peakOf(mastered),
    rms: rmsOf(mastered),
  };
}

/* ------------------------------------------------------------------ storage -- */

/**
 * Where the switch reads hold music from.
 *
 * The data volume, not the image: a track generated today has to still be there
 * after an image upgrade, and Asterisk reads it from the same directory the
 * generated musiconhold.conf names.
 */
export const holdsDir = () => join(config.dataDir, 'moh');
export const trackDir = (id) => join(holdsDir(), id);
export const trackFile = (id) => join(trackDir(id), 'hold.wav');

const view = (row) => ({
  id: row.id,
  name: row.name,
  message: row.message,
  style: row.style,
  voice: row.voice,
  seconds: row.seconds,
  bytes: row.bytes,
  applied: !!row.applied,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  audioUrl: `/api/hold-music/${row.id}/audio`,
});

export const holdMusicView = view;

export function listHoldMusic() {
  return db_.all('SELECT * FROM hold_music ORDER BY created_at DESC').map(view);
}

export function getHoldMusic(id) {
  const row = db_.get('SELECT * FROM hold_music WHERE id = ?', [String(id || '')]);
  return row ? view(row) : null;
}

export const appliedHoldMusic = () => {
  const row = db_.get('SELECT * FROM hold_music WHERE applied = 1 ORDER BY updated_at DESC LIMIT 1');
  return row ? view(row) : null;
};

/**
 * Save a rendered track.
 *
 * The row is written only after the file is: a row that names a file the switch
 * cannot open is a hold queue that goes silent, and that is worse than a failed
 * save the operator can see.
 */
export function saveHoldMusic({ id, name, message, style, voice, seconds, buffer }) {
  mkdirSync(trackDir(id), { recursive: true });
  const file = trackFile(id);
  writeFileSync(file, buffer);
  const bytes = statSync(file).size;
  const stamp = now();
  db_.run(
    `INSERT INTO hold_music (id, name, message, style, voice, seconds, file, bytes, applied, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, message = excluded.message,
       style = excluded.style, voice = excluded.voice, seconds = excluded.seconds,
       file = excluded.file, bytes = excluded.bytes, updated_at = excluded.updated_at`,
    [id, name, message, style, voice, seconds, file, bytes, stamp, stamp]
  );
  return getHoldMusic(id);
}

export function deleteHoldMusic(id) {
  const row = db_.get('SELECT id FROM hold_music WHERE id = ?', [String(id || '')]);
  if (!row) return false;
  db_.run('DELETE FROM hold_music WHERE id = ?', [row.id]);
  rmSync(trackDir(row.id), { recursive: true, force: true });
  return true;
}

/** Exactly one track is applied: the class the switch plays has one directory. */
export function setAppliedHoldMusic(id) {
  const stamp = now();
  db_.run('UPDATE hold_music SET applied = 0, updated_at = ? WHERE applied = 1', [stamp]);
  const changed = db_.run('UPDATE hold_music SET applied = 1, updated_at = ? WHERE id = ?', [stamp, String(id || '')]);
  return Number(changed.changes) > 0;
}

/** What the switch needs to know about the generator, for the console. */
export const holdMusicStatus = () => {
  const applied = appliedHoldMusic();
  const speech = speechStatus();
  return {
    styles: STYLES.map(({ value, label }) => ({ value, label })),
    voice: {
      available: speech.available,
      engine: speech.engine,
      detail: speech.detail,
      voices: [],
    },
    defaultVoice: DEFAULT_VOICE,
    limits: { minSeconds: MIN_SECONDS, maxSeconds: MAX_SECONDS, maxMessage: MAX_MESSAGE },
    applied,
    clazz: config.parking.mohClass,
    directory: applied ? trackDir(applied.id) : null,
  };
};

/** Speak a message, or explain why the switch cannot. */
export const speechFor = (message, voice) => speak({ text: message, voice });
