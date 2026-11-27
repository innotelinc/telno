/**
 * The ringtone must ring once, keep ringing, and go quiet on demand.
 *
 * `web/src/ringtone.js` is browser code: it builds oscillators and a gain gate
 * on a WebAudio context and holds a four-second gap on a `setInterval`. Left
 * untested, the two failures that matter are silent ones — a second INVITE
 * restarting the cadence, and a stop that leaves an oscillator running into the
 * answered call. Both are timing bugs, so the fake context here records what was
 * scheduled instead of playing it, and time only moves when the test moves it.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const RING_ON = 2;
const RING_OFF = 4;
const LEVEL = 0.12;

let now = 0;

class FakeParam {
  constructor() {
    this.value = 0;
    this.calls = [];
  }
  cancelScheduledValues(t) {
    this.calls.push(['cancel', t]);
  }
  setValueAtTime(v, t) {
    this.value = v;
    this.calls.push(['set', v, t]);
  }
  linearRampToValueAtTime(v, t) {
    this.value = v;
    this.calls.push(['ramp', v, t]);
  }
}

class FakeGain {
  constructor() {
    this.gain = new FakeParam();
    this.connectedTo = null;
  }
  connect(node) {
    this.connectedTo = node;
  }
}

class FakeOscillator {
  constructor(context) {
    this.context = context;
    this.type = 'sine';
    this.frequency = { value: 0 };
    this.connectedTo = null;
    this.startedAt = null;
    this.scheduledStopAt = null;
    this.stopCalls = 0;
    this.disconnected = false;
  }
  connect(node) {
    this.connectedTo = node;
  }
  start(at) {
    this.startedAt = at;
  }
  stop(at) {
    this.stopCalls += 1;
    if (at !== undefined) this.scheduledStopAt = at;
  }
  disconnect() {
    this.disconnected = true;
  }
}

class FakeAudioContext {
  static instances = [];
  constructor() {
    this.currentTime = now;
    this.state = 'running';
    this.destination = { name: 'destination' };
    this.oscillators = [];
    this.gates = [];
    FakeAudioContext.instances.push(this);
  }
  createGain() {
    const gain = new FakeGain();
    this.gates.push(gain);
    return gain;
  }
  createOscillator() {
    const osc = new FakeOscillator(this);
    this.oscillators.push(osc);
    return osc;
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}

// setInterval/clearInterval are faked so the ring cadence is driven by the test
// rather than by wall-clock time, and so an idle interval cannot hold node open.
const intervals = new Map();
let nextTimer = 1;
const cleared = [];

globalThis.window = {
  AudioContext: FakeAudioContext,
  setInterval(fn, ms) {
    const id = nextTimer++;
    intervals.set(id, { fn, ms });
    return id;
  },
  clearInterval(id) {
    cleared.push(id);
    intervals.delete(id);
  },
};

const { startRingtone, stopRingtone } = await import('../web/src/ringtone.js');

const ctx = () => FakeAudioContext.instances[0];
const gate = () => ctx().gates[0];

test('start schedules a ring and keeps the cadence running', () => {
  startRingtone();

  assert.equal(FakeAudioContext.instances.length, 1, 'one context is shared');
  assert.equal(ctx().state, 'running');
  assert.equal(gate().connectedTo, ctx().destination, 'the gate is the only path to output');

  const oscs = ctx().oscillators;
  assert.equal(oscs.length, 2, 'one oscillator per tone');
  assert.deepEqual(
    oscs.map((o) => o.frequency.value),
    [440, 480],
    'both tones are in the ring'
  );
  for (const osc of oscs) {
    assert.equal(osc.type, 'sine');
    assert.equal(osc.connectedTo, gate(), 'tones funnel through the gate');
    assert.equal(osc.startedAt, 0, 'the first ring starts now');
    assert.equal(osc.scheduledStopAt, RING_ON, 'and stops after the on period');
  }

  const ramp = gate().gain.calls.find(([kind, value]) => kind === 'ramp' && value === LEVEL);
  assert.ok(ramp, 'the tone is ramped up, not switched on');
  assert.ok(ramp[2] > 0 && ramp[2] <= 0.1, 'ramp is short enough to be a ramp');

  assert.equal(intervals.size, 1, 'exactly one cadence timer');
  const [timerId, timer] = [...intervals.entries()][0];
  assert.equal(timer.ms, (RING_ON + RING_OFF) * 1000, 'two seconds on, four seconds off');

  // The cadence callback is what rides through the gap; it must ring again.
  now += RING_ON + RING_OFF;
  ctx().currentTime = now;
  timer.fn();
  assert.equal(ctx().oscillators.length, 4, 'the next ring sounds');
  assert.equal(
    gate().gain.calls.filter(([kind, value]) => kind === 'ramp' && value === LEVEL).length,
    2,
    'the gate opens for the second ring too'
  );

  assert.ok(timerId > 0);
});

test('a second start does not double-schedule', () => {
  const oscCount = ctx().oscillators.length;
  const rampCount = gate().gain.calls.filter(([kind]) => kind === 'ramp').length;
  const gateCount = ctx().gates.length;

  startRingtone();
  startRingtone();

  assert.equal(ctx().oscillators.length, oscCount, 'no extra tones');
  assert.equal(
    gate().gain.calls.filter(([kind]) => kind === 'ramp').length,
    rampCount,
    'the cadence is not restarted from the top'
  );
  assert.equal(intervals.size, 1, 'still one timer');
  assert.equal(ctx().gates.length, gateCount, 'no second gate');
  assert.equal(FakeAudioContext.instances.length, 1, 'no second context');
});

test('stop clears the timer and silences the tone', () => {
  const sounding = ctx().oscillators.slice(-2);

  stopRingtone();

  assert.equal(intervals.size, 0, 'the cadence timer is cleared');
  assert.equal(cleared.length, 1, 'the timer id was passed to clearInterval');
  assert.equal(gate().gain.value, 0, 'the gate is closed');
  const last = gate().gain.calls.at(-1);
  assert.deepEqual(last.slice(0, 2), ['set', 0], 'closing is immediate, not a ramp');

  for (const osc of sounding) {
    assert.equal(osc.stopCalls, 2, 'stopped now, on top of the scheduled stop');
    assert.equal(osc.disconnected, true, 'and detached from the gate');
  }

  // Answering then ringing again must work: the timer was really released.
  startRingtone();
  assert.equal(ctx().oscillators.length, 6, 'a later call rings again');
  assert.equal(intervals.size, 1, 'with a fresh cadence');
  stopRingtone();
});
