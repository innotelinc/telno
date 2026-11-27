/**
 * The browser's own ringtone.
 *
 * The switch tells the softphone that a call is ringing; it does not make this
 * computer audible. Until now an incoming call was an "Incoming call" panel and
 * a toast, which nobody notices from across the room. The tone is generated
 * here with WebAudio rather than shipped as an audio file: nothing to
 * cache-bust, nothing to decode before the first ring, nothing to license.
 *
 * Shape: 440 + 480 Hz for two seconds, then four seconds of quiet — the same
 * cadence a desk phone in the next room is making.
 */

const RING_ON = 2;
const RING_OFF = 4;
const TONES = [440, 480];
// Two sines at full scale would clip, and quieter than this cannot be heard
// over an open mic.
const LEVEL = 0.12;

let context = null;
let gate = null; // the single gain everything rings through
let timer = null;
let sounding = []; // the oscillators of the ring currently playing

function ensureContext() {
  if (context) return context;
  const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!Ctor) return null;
  try {
    context = new Ctor();
    gate = context.createGain();
    // Silence is the resting state: an oscillator runs only while ringing.
    gate.gain.value = 0;
    gate.connect(context.destination);
  } catch {
    // No audio device, or a browser that refuses a context: a silent softphone
    // still takes calls, so this is not worth an error card.
    context = null;
    gate = null;
  }
  return context;
}

/**
 * Called from a click (Connect, Answer) so the context exists and is running
 * while the page still has a user gesture. A context first created inside the
 * INVITE handler is suspended by browser autoplay policy and the ring is
 * silent.
 */
export function primeRingtone() {
  const ctx = ensureContext();
  if (!ctx) return;
  if (ctx.state !== 'running') ctx.resume?.().catch(() => {});
}

function ringOnce() {
  if (!context || !gate) return;
  const now = context.currentTime;
  // Ramp instead of switching: a hard edge on a sine is a click at the start and
  // end of every ring, and an operator hears that as a fault in the line.
  gate.gain.cancelScheduledValues(now);
  gate.gain.setValueAtTime(0, now);
  gate.gain.linearRampToValueAtTime(LEVEL, now + 0.02);
  gate.gain.setValueAtTime(LEVEL, now + RING_ON - 0.05);
  gate.gain.linearRampToValueAtTime(0, now + RING_ON);
  sounding = TONES.map((hz) => {
    const osc = context.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = hz;
    osc.connect(gate);
    osc.start(now);
    osc.stop(now + RING_ON);
    return osc;
  });
}

export function startRingtone() {
  const ctx = ensureContext();
  if (!ctx) return;
  // A resume that was refused at creation time succeeds once the operator has
  // clicked anything at all, so every ring tries again.
  if (ctx.state !== 'running') ctx.resume?.().catch(() => {});
  // Already ringing: a re-INVITE or a second dialog must not restart the
  // cadence from the top, or a caller who retries sounds like two phones.
  if (timer) return;
  ringOnce();
  timer = window.setInterval(ringOnce, (RING_ON + RING_OFF) * 1000);
}

export function stopRingtone() {
  if (timer) {
    window.clearInterval(timer);
    timer = null;
  }
  if (context && gate) {
    const now = context.currentTime;
    try {
      gate.gain.cancelScheduledValues(now);
      gate.gain.setValueAtTime(0, now);
    } catch {
      /* context closed underneath us */
    }
  }
  for (const osc of sounding) {
    // Stop now rather than at the scheduled end: answering on the first ring
    // should be silent from that frame, not finish the tone.
    try {
      osc.stop();
      osc.disconnect();
    } catch {
      /* already stopped */
    }
  }
  sounding = [];
}
