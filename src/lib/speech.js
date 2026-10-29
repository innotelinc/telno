/**
 * Speech for announcements, from the switch's own container.
 *
 * flite is a small, offline, permissively-licensed synthesizer that ships in the
 * image. It is chosen over a hosted text-to-speech API for three reasons that
 * all matter on a phone platform: a hold announcement has to be produced while
 * the operator waits, it has to keep working when the internet does not, and it
 * must not put a per-word cost on every welcome message a customer writes.
 *
 * It sounds synthetic — this is a 1990s-style formant voice, not a studio
 * narrator — because that is the trade for being free and local. Anything more
 * natural has to come from a provider with a key, which is not wired here on
 * purpose: a feature that quietly stops working when a key expires is worse
 * than one that is honest about its voice.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SWITCH_RATE, normalize, readWav, resample, trimSilence } from './audio.js';

/** The voices Debian's flite ships. Each is a distinct speaker, not a mood. */
export const VOICES = [
  { value: 'slt', label: 'Warm female' },
  { value: 'kal', label: 'Clear neutral' },
  { value: 'rms', label: 'Deep male' },
  { value: 'awb', label: 'Male, Scottish' },
];

export const DEFAULT_VOICE = 'slt';

let cached = null;

/**
 * Whether a synthesizer is actually present.
 *
 * Probed once, by running it: flite has no version flag that exits cleanly, and
 * a missing binary is the one case that has to be reported rather than fallen
 * back from — a track with music and no words is not the thing that was asked
 * for, so the console needs to say so before an operator saves one.
 */
export function speechStatus() {
  if (cached) return cached;
  const probe = spawnSync('flite', ['-t', 'ok'], { stdio: 'ignore', timeout: 20000 });
  if (probe.error && probe.error.code === 'ENOENT') {
    cached = {
      available: false,
      engine: 'none',
      detail: 'flite is not installed in this image — rebuild to get the speech engine, or use a recorded message',
    };
  } else if (probe.error || probe.status !== 0) {
    cached = {
      available: false,
      engine: 'none',
      detail: `flite could not run (${probe.error?.message || `exit ${probe.status}`})`,
    };
  } else {
    cached = { available: true, engine: 'flite', detail: 'flite, running inside the container — no key, no network' };
  }
  return cached;
}

/** Clear the probe after an image change without a restart. */
export const resetSpeechProbe = () => {
  cached = null;
};

/**
 * Speak one message. Returns 8 kHz mono floats, ready to mix.
 *
 * The text goes through a file argument rather than a shell so a customer's
 * apostrophes, dashes and dollar signs are spoken instead of interpreted.
 */
export function speak({ text, voice = DEFAULT_VOICE } = {}) {
  const status = speechStatus();
  if (!status.available) return { ok: false, error: status.detail };

  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return { ok: false, error: 'there is no message to speak' };
  if (clean.length > 800) return { ok: false, error: 'a hold message is limited to 800 characters' };

  const dir = mkdtempSync(join(tmpdir(), 'telno-speech-'));
  const out = join(dir, 'speech.wav');
  const wanted = VOICES.some((entry) => entry.value === voice) ? voice : DEFAULT_VOICE;

  const attempts = [
    { args: ['-voice', wanted, '-t', clean, '-o', out] },
    // A build whose voice data is trimmed answers the voice flag with an error,
    // and the default voice is still useful. Two attempts, not a fallback loop.
    { args: ['-t', clean, '-o', out] },
  ];

  let used = wanted;
  let failure = '';
  for (const attempt of attempts) {
    rmSync(out, { force: true });
    const result = spawnSync('flite', attempt.args, { encoding: 'utf8', timeout: 30000 });
    if (result.error) {
      failure = result.error.message;
      continue;
    }
    if (result.status !== 0) {
      failure = (result.stderr || `exit ${result.status}`).trim().slice(0, 200);
      continue;
    }
    try {
      if (statSync(out).size < 1000) {
        failure = 'the synthesizer produced an empty file';
        continue;
      }
      const wav = readWav(readFileSync(out));
      let samples = resample(wav.samples, wav.sampleRate, SWITCH_RATE);
      samples = trimSilence(samples, { rate: SWITCH_RATE });
      if (!samples.length) {
        failure = 'the synthesizer produced silence';
        continue;
      }
      samples = normalize(samples, 0.93);
      rmSync(dir, { recursive: true, force: true });
      return {
        ok: true,
        samples,
        sampleRate: SWITCH_RATE,
        seconds: samples.length / SWITCH_RATE,
        voice: attempt === attempts[0] ? used : 'default',
        wordCount: clean.split(' ').length,
      };
    } catch (err) {
      failure = err.message;
    }
  }

  rmSync(dir, { recursive: true, force: true });
  return { ok: false, error: `the synthesizer failed: ${failure || 'unknown error'}` };
}

/** Roughly how long a message takes to say, for the console's length estimate. */
export const estimateSeconds = (text) => {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
  if (!words) return 0;
  // flite's default pace is about 165 words a minute, and a comma is a breath.
  const commas = (String(text).match(/[,;:.]/g) || []).length;
  return Math.round((words / 165) * 60 + commas * 0.22);
};
