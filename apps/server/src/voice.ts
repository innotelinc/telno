import type { CantusVoice, ModelKey, SipVoice } from '@telno/shared';

/**
 * The voice profile a device is given.
 *
 * Kept apart from the rest of provisioning because it is the one place the two
 * product families differ, and because it is pure: a config that claimed
 * `cantus/1` for an analog adaptor would describe a device that does not exist.
 */

export interface VoiceSettings {
  domain: string;
  voiceNode: string;
  voicePort: number;
  relay: string | null;
  /** SIP server for an analog adaptor; falls back to the domain when unset. */
  sipEdge?: string;
  sipPort?: number;
}

/**
 * One socket for signalling and media: no SDP, no RTP port range, no static NAT
 * knobs to reconcile on the device.
 */
export function cantusVoice(settings: VoiceSettings): CantusVoice {
  return {
    transport: 'cantus/1',
    node: settings.voiceNode,
    port: settings.voicePort,
    relay: settings.relay,
    reachMs: 300,
    codecs: ['pcm-s16/8000/1'],
    keepaliveMs: 15_000,
  };
}

/**
 * An analog adaptor's only voice protocol is SIP.
 *
 * The box has two FXS ports and a SIP stack; it has no concept of cantus/1. It
 * registers over SIP against the edge, and the edge is what carries the call
 * onward over cantus. Without an edge there is nothing to bridge, so the
 * adaptor is pointed at the domain and the note says so plainly rather than
 * leaving an installer to guess.
 */
export function sipVoice(settings: VoiceSettings): SipVoice {
  const edge = settings.sipEdge?.trim() ?? '';
  const server = edge || settings.domain;
  const port = settings.sipPort && settings.sipPort > 0 ? settings.sipPort : 5060;
  return {
    transport: 'sip',
    server,
    port,
    domain: settings.domain,
    expiresSec: 120,
    // Separate local ports per FXS port so a NAT can keep the flows apart.
    localPorts: [5060, 5062],
    codecs: ['pcmu/8000', 'pcma/8000'],
    note: edge
      ? `SIP to ${server}:${port}; the edge carries the call over cantus on ${settings.voicePort}/udp.`
      : `No SIP edge is configured, so this adaptor registers directly at ${server}:${port}. Set a SIP edge if calls should be bridged to cantus.`,
  };
}

/** Which profile a model is given: a desk phone speaks cantus, an ATA cannot. */
export function voiceProfileFor(model: ModelKey, settings: VoiceSettings): CantusVoice | SipVoice {
  return model === 'ht802' ? sipVoice(settings) : cantusVoice(settings);
}
