/**
 * Voice masking in the browser.
 *
 * The mask runs on the outgoing microphone before it reaches the peer
 * connection, so the switch and the far end only ever receive the disguised
 * audio. The DSP itself is `web/public/scif-mask-worklet.js`, loaded from this
 * origin — a Blob module is refused by the console's `script-src 'self'` policy,
 * which is why this file used to build one and quietly fail in production.
 *
 * Nothing here is a claim of anonymity. A pitch shift changes how you sound; it
 * does not change what you say, and it is not a substitute for a secure line.
 */

export const WORKLET_URL = '/scif-mask-worklet.js';

export const MASK_MODES = [
  { value: 'off', label: 'Off — your own voice' },
  { value: 'low', label: 'Lower — deeper than you' },
  { value: 'high', label: 'Higher — lighter than you' },
  { value: 'robot', label: 'Robot — masked carrier' },
];

/**
 * Build a masked copy of one microphone track.
 *
 * Returns the replacement track plus `setMode` (change without renegotiating)
 * and `stop` (tear the graph down). The caller owns the original track and must
 * put it back when masking is switched off — this function never stops it.
 */
export async function createVoiceMask(track, mode = 'off') {
  if (!track) throw new Error('There is no microphone track to mask');
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !window.AudioWorkletNode) {
    throw new Error('This browser does not support audio worklets');
  }
  const context = new AudioContextClass();
  try {
    await context.audioWorklet.addModule(WORKLET_URL);
  } catch (err) {
    // A refused worklet is reported rather than fallen back from: carrying on
    // would send the caller's own voice to the far end after they asked for a
    // disguise. The call is left to the operator to end, but nothing here
    // pretends the mask applied.
    await context.close().catch(() => {});
    throw new Error(`The mask could not be loaded (${err.message})`);
  }
  // A call is a user gesture, so this normally resumes at once; a tab that was
  // suspended in the background may need it explicitly.
  await context.resume().catch(() => {});

  const source = context.createMediaStreamSource(new MediaStream([track]));
  const node = new AudioWorkletNode(context, 'scif-mask', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    // The mode goes in at construction so the very first block is already
    // masked: a message would leave the first words of the call in the
    // operator's own voice, which is exactly what the mask is for.
    processorOptions: { mode },
  });
  const destination = context.createMediaStreamDestination();
  source.connect(node);
  node.connect(destination);
  node.port.postMessage({ mode });

  return {
    track: destination.stream.getAudioTracks()[0],
    setMode(next) {
      node.port.postMessage({ mode: next });
    },
    async stop() {
      try {
        source.disconnect();
        node.disconnect();
        destination.stream.getTracks().forEach((entry) => entry.stop());
        await context.close();
      } catch {
        /* the graph is already gone */
      }
    },
  };
}
