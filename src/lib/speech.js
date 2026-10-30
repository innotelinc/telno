/**
 * Speech for announcements.
 *
 * Two engines, in a deliberate order:
 *
 *   gateway — an OpenAI-compatible `/audio/speech` route on the install's model
 *             gateway. Natural, and it is what an operator expects to hear.
 *   flite   — a small, offline, permissively-licensed formant synthesizer in the
 *             image. Synthetic, but it costs nothing, needs no network, and
 *             cannot stop working when a key expires.
 *
 * The gateway is tried first and flite is always the floor: a hold announcement
 * that silently disappears because a provider key lapsed would leave callers in
 * silence, which is worse than a robot reading the message. Which engine spoke
 * is returned with the audio, so the console can say so instead of guessing.
 *
 * A refused gateway is remembered for a few minutes. Without that, every
 * generation pays a timeout against a provider that is known to be down, and
 * the console feels broken while it waits.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { SWITCH_RATE, normalize, readWav, resample, trimSilence } from './audio.js';
import { aiKey } from './ai.js';
import { getSecret } from './vault.js';

/** The voices Debian's flite ships. Each is a distinct speaker, not a mood. */
export const VOICES = [
  { value: 'slt', label: 'Warm female (offline)' },
  { value: 'kal', label: 'Clear neutral (offline)' },
  { value: 'rms', label: 'Deep male (offline)' },
  { value: 'awb', label: 'Male, Scottish (offline)' },
];

/** Voices the gateway's `/audio/speech` understands, in OpenAI's naming. */
export const NATURAL_VOICES = [
  { value: 'nova', label: 'Natural — bright' },
  { value: 'alloy', label: 'Natural — neutral' },
  { value: 'shimmer', label: 'Natural — soft' },
  { value: 'onyx', label: 'Natural — deep' },
  { value: 'echo', label: 'Natural — warm' },
  { value: 'fable', label: 'Natural — expressive' },
];

export const DEFAULT_VOICE = 'slt';
export const DEFAULT_NATURAL_VOICE = 'nova';

const isFliteVoice = (value) => VOICES.some((entry) => entry.value === value);
const isNaturalVoice = (value) => NATURAL_VOICES.some((entry) => entry.value === value);

/**
 * Why the gateway cannot be used right now, or that it can.
 *
 * `cooldown` is the memory of a refusal: a provider that answered "no
 * credentials" a minute ago will answer the same way now.
 */
let cooldown = { until: 0, message: '' };

/** The key a gateway TTS route uses: its own if one is stored, else the model key. */
export const ttsKey = () => getSecret('TTS_API_KEY') || aiKey();

const noteFailure = (message) => {
  cooldown = { until: Date.now() + 10 * 60 * 1000, message };
};

export const clearGatewayCooldown = () => {
  cooldown = { until: 0, message: '' };
};

export function gatewayStatus() {
  if (!config.ai.enabled) return { ok: false, configured: false, reason: 'the model gateway is disabled on this install' };
  if (!ttsKey()) return { ok: false, configured: false, reason: 'no model key is stored (Settings → AI and subscriptions)' };
  if (cooldown.until > Date.now()) {
    return { ok: false, configured: true, reason: `the voice gateway refused the last request — ${cooldown.message}` };
  }
  let host = config.ai.ttsUrl;
  try {
    host = new URL(config.ai.ttsUrl).host;
  } catch {
    /* a misconfigured URL is reported as it is */
  }
  return { ok: true, configured: true, host, model: config.ai.ttsModel, reason: '' };
}

let localProbe = null;

/**
 * Whether flite is present.
 *
 * Probed once, by running it: flite has no version flag that exits cleanly, and
 * a missing binary is the one case that has to be reported rather than fallen
 * back from — a track with music and no words is not the thing that was asked
 * for.
 */
export function localSpeechStatus() {
  if (localProbe) return localProbe;
  const probe = spawnSync('flite', ['-t', 'ok'], { stdio: 'ignore', timeout: 20000 });
  if (probe.error && probe.error.code === 'ENOENT') {
    localProbe = { available: false, detail: 'flite is not installed in this image — rebuild to get the offline voice' };
  } else if (probe.error || probe.status !== 0) {
    localProbe = { available: false, detail: `flite could not run (${probe.error?.message || `exit ${probe.status}`})` };
  } else {
    localProbe = { available: true, detail: 'flite, running inside the container — no key, no network' };
  }
  return localProbe;
}

export const resetSpeechProbe = () => {
  localProbe = null;
  clearGatewayCooldown();
};

/**
 * What the console shows: which engine will speak, the voices that engine has,
 * and — when the natural voice is configured but unusable — why.
 */
export function speechStatus() {
  const gateway = gatewayStatus();
  const local = localSpeechStatus();
  const engine = gateway.ok ? 'gateway' : local.available ? 'flite' : 'none';
  const detail =
    engine === 'gateway'
      ? `natural voice through ${gateway.host} (${gateway.model}), falling back to flite`
      : engine === 'flite'
        ? `${local.detail}${gateway.configured ? ` — ${gateway.reason}` : gateway.reason ? ` — ${gateway.reason}` : ''}`
        : `${local.detail}${gateway.reason ? `; ${gateway.reason}` : ''}`;
  return {
    available: engine !== 'none',
    engine,
    detail,
    voices: engine === 'gateway' ? NATURAL_VOICES : VOICES,
    defaultVoice: engine === 'gateway' ? config.ai.ttsVoice || DEFAULT_NATURAL_VOICE : DEFAULT_VOICE,
    gateway,
    local,
  };
}

/* ------------------------------------------------------------------ engine -- */

/** Speak one message with flite. Returns 8 kHz mono floats, ready to mix. */
function speakLocally({ text, voice }) {
  const status = localSpeechStatus();
  if (!status.available) return { ok: false, error: status.detail };

  const dir = mkdtempSync(join(tmpdir(), 'telno-speech-'));
  const out = join(dir, 'speech.wav');
  const wanted = isFliteVoice(voice) ? voice : DEFAULT_VOICE;

  const attempts = [
    { args: ['-voice', wanted, '-t', text, '-o', out] },
    // A build whose voice data is trimmed answers the voice flag with an error,
    // and the default voice is still useful. Two attempts, not a fallback loop.
    { args: ['-t', text, '-o', out] },
  ];

  let failure = '';
  for (const [index, attempt] of attempts.entries()) {
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
        voice: index === 0 ? wanted : DEFAULT_VOICE,
        engine: 'flite',
        wordCount: text.split(' ').length,
      };
    } catch (err) {
      failure = err.message;
    }
  }

  rmSync(dir, { recursive: true, force: true });
  return { ok: false, error: `the offline synthesizer failed: ${failure || 'unknown error'}` };
}

/**
 * Speak one message through the gateway.
 *
 * The request is the documented OpenAI shape — `{ model, voice, input,
 * response_format }` — because every compatible proxy implements that and
 * nothing else reliably. A non-WAV answer is treated as a failure rather than
 * decoded as noise, so a gateway that ignores `response_format` is reported
 * instead of producing a track of static.
 */
async function speakNaturally({ text, voice }) {
  const gateway = gatewayStatus();
  if (!gateway.ok) return { ok: false, error: gateway.reason };

  const chosen = isNaturalVoice(voice) ? voice : config.ai.ttsVoice || DEFAULT_NATURAL_VOICE;
  let res;
  try {
    res = await fetch(`${config.ai.ttsUrl}/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ttsKey()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.ai.ttsModel,
        voice: chosen,
        input: text,
        response_format: 'wav',
      }),
      signal: AbortSignal.timeout(config.ai.ttsTimeoutMs),
    });
  } catch (err) {
    const message = err.name === 'TimeoutError' ? 'the gateway timed out' : `the gateway is unreachable (${err.message})`;
    noteFailure(message);
    return { ok: false, error: message };
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
    const message = `HTTP ${res.status}${body ? `: ${body}` : ''}`;
    noteFailure(message);
    return { ok: false, error: message };
  }

  try {
    const wav = readWav(Buffer.from(await res.arrayBuffer()));
    let samples = resample(wav.samples, wav.sampleRate, SWITCH_RATE);
    samples = trimSilence(samples, { rate: SWITCH_RATE });
    if (!samples.length) {
      noteFailure('the gateway returned silence');
      return { ok: false, error: 'the gateway returned silence' };
    }
    samples = normalize(samples, 0.93);
    return {
      ok: true,
      samples,
      sampleRate: SWITCH_RATE,
      seconds: samples.length / SWITCH_RATE,
      voice: chosen,
      engine: 'gateway',
      wordCount: text.split(' ').length,
    };
  } catch (err) {
    // A 200 that is not audio is a misconfigured route, and saying so is more
    // useful than a track of noise.
    noteFailure(`the gateway did not return audio (${err.message})`);
    return { ok: false, error: `the gateway did not return audio (${err.message})` };
  }
}

/**
 * Speak one message, choosing the engine.
 *
 * A voice the operator picked explicitly wins: a natural voice tries the gateway
 * and falls back, an offline voice goes straight to flite. Either way the result
 * carries the engine that actually spoke, so a track is never silently built
 * from a fallback the operator was not told about.
 */
export async function speak({ text, voice = '' } = {}) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return { ok: false, error: 'there is no message to speak' };
  if (clean.length > 800) return { ok: false, error: 'a hold message is limited to 800 characters' };

  const natural = isNaturalVoice(voice);
  const gateway = gatewayStatus();

  if (natural && gateway.ok) {
    const spoken = await speakNaturally({ text: clean, voice });
    if (spoken.ok) return spoken;
    const local = speakLocally({ text: clean, voice: DEFAULT_VOICE });
    if (local.ok) return { ...local, fallbackFrom: spoken.error };
    return { ok: false, error: `${spoken.error}; ${local.error}` };
  }

  if (!natural && isFliteVoice(voice)) {
    const local = speakLocally({ text: clean, voice });
    if (local.ok) return local;
    // Only reach for the gateway when the offline voice is the thing that is
    // missing — a working local engine and a chosen offline voice means local.
    if (gateway.ok) return speakNaturally({ text: clean, voice: config.ai.ttsVoice });
    return local;
  }

  // No voice chosen: whichever engine is the install's default.
  if (gateway.ok) {
    const spoken = await speakNaturally({ text: clean, voice: config.ai.ttsVoice });
    if (spoken.ok) return spoken;
    const local = speakLocally({ text: clean, voice: DEFAULT_VOICE });
    if (local.ok) return { ...local, fallbackFrom: spoken.error };
    return { ok: false, error: `${spoken.error}; ${local.error}` };
  }
  return speakLocally({ text: clean, voice: DEFAULT_VOICE });
}

/** Roughly how long a message takes to say, for the console's estimate. */
export const estimateSeconds = (text) => {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
  if (!words) return 0;
  // About 165 words a minute, and a comma is a breath.
  const commas = (String(text).match(/[,;:.]/g) || []).length;
  return Math.round((words / 165) * 60 + commas * 0.22);
};
