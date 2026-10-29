import type {
  AdaptorAccount,
  AdaptorAccountState,
  AdaptorAccountWrite,
  AdaptorIdentity,
  AdaptorLock,
  AdaptorNetwork,
  AdaptorOverview,
  AdaptorPort,
  AdaptorTarget,
} from '@telno/shared';

/**
 * The report shape lives in `@telno/shared` because the console renders exactly
 * what the driver produces; these aliases keep the driver's vocabulary local
 * without a second definition that could drift.
 */
export type AtaAccount = AdaptorAccount;
export type AtaAccountState = AdaptorAccountState;
export type AtaAccountWrite = AdaptorAccountWrite;
export type AtaIdentity = AdaptorIdentity;
export type AtaLock = AdaptorLock;
export type AtaNetwork = AdaptorNetwork;
export type AtaOverview = AdaptorOverview;
export type AtaPort = AdaptorPort;
export type AtaTarget = AdaptorTarget;
export type AtaFirmware = AdaptorOverview['firmware'];
export type AtaState = AdaptorOverview['state'];

export interface AtaSystem {
  voiceImage: string | null;
  role: string | null;
}

export const emptyOverview = (target: AtaTarget, firmware: AtaFirmware): AtaOverview => ({
  target,
  firmware,
  state: 'unreachable',
  reachable: false,
  locked: false,
  remainSec: 0,
  authenticated: false,
  lock: null,
  system: null,
  sip: null,
  identity: null,
  ports: [],
  accounts: [],
  network: null,
  sources: {},
  notes: [],
  tookMs: 0,
  checkedAt: new Date().toISOString(),
});
