import type { CantusVoice, ModelKey, SipVoice } from '@telno/shared';
import { DEVICE_MODELS } from '@telno/shared';

/**
 * The voice profile a device is given.
 *
 * Kept apart from the rest of provisioning because it is the one place the two
 * product families differ, and because it is pure: a config that claimed
 * `cantus/1` for a SIP handset would describe a device that does not exist.
 */

export interface VoiceSettings {
  domain: string;
  voiceNode: string;
  voicePort: number;
  relay: string | null;
  /** SIP server for a SIP device; falls back to the domain when unset. */
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
 * A SIP device's only voice protocol is SIP.
 *
 * A handset or an analog adaptor has no concept of cantus/1. It registers over
 * SIP against the edge, and the edge is what carries the call onward over
 * cantus. Without an edge there is nothing to bridge, so the device is pointed
 * at the domain and the note says so plainly rather than leaving an installer to
 * guess.
 *
 * `localPorts` is passed in because it is a property of the hardware: an ATA
 * binds one per FXS port so a NAT keeps the flows apart, while a phone or a DECT
 * base multiplexes every account over one socket.
 */
export function sipVoice(settings: VoiceSettings, localPorts: number[] = [5060]): SipVoice {
  const edge = settings.sipEdge?.trim() ?? '';
  const server = edge || settings.domain;
  const port = settings.sipPort && settings.sipPort > 0 ? settings.sipPort : 5060;
  return {
    transport: 'sip',
    server,
    port,
    domain: settings.domain,
    expiresSec: 120,
    localPorts,
    codecs: ['pcmu/8000', 'pcma/8000'],
    note: edge
      ? `SIP to ${server}:${port}; the edge carries the call over cantus on ${settings.voicePort}/udp.`
      : `No SIP edge is configured, so this device registers directly at ${server}:${port}. Set a SIP edge if calls should be bridged to cantus.`,
  };
}

/**
 * Which profile a model is given.
 *
 * Read from the catalog rather than tested against model names here: a new
 * product declares its transport where the rest of its identity already lives,
 * so adding hardware cannot silently inherit the wrong one.
 */
export function voiceProfileFor(model: ModelKey, settings: VoiceSettings): CantusVoice | SipVoice {
  const info = DEVICE_MODELS[model];
  if (!info || info.voice === 'cantus') return cantusVoice(settings);
  return sipVoice(settings, info.sipLocalPorts ?? [5060]);
}
