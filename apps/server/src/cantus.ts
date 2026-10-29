import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  CantusRouteDecision,
  CantusStatus,
  Line,
  PathProbeResult,
  RoutingDocument,
} from '@telno/shared';
import { env } from './env.js';

/**
 * cantus integration.
 *
 * cantus is a voice standard with a reference stack and a CLI — there is no HTTP
 * control API to call, so the platform drives it the way its own operators do:
 * it builds routing documents, evaluates them offline with `route-test`, and
 * uses `selftest` / `demo` as the health and path evidence for a deployment.
 *
 * Nothing here shells out to a PBX: no dialplan is generated, no SDP is written
 * and no RTP port range is reserved.
 */

const CANTUS_REJECT = {
  NOT_FOUND: 2,
  REJECTED: 3,
  UNAVAILABLE: 4,
} as const;

interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function cantusBinary(): string {
  return join(env.cantusDir, 'bin', 'cantus');
}

function runCantus(args: string[], timeoutMs = 20_000): Promise<RunResult> {
  const bin = cantusBinary();
  if (!existsSync(bin)) {
    return Promise.resolve({
      ok: false,
      code: null,
      stdout: '',
      stderr: `cantus CLI not found at ${bin}`,
      timedOut: false,
    });
  }
  return new Promise((resolve) => {
    const child = execFile(
      env.perl,
      ['-I', join(env.cantusDir, 'lib'), bin, ...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error && (error as { killed?: boolean }).killed);
        resolve({
          ok: !error,
          code: error ? ((error as { code?: number }).code ?? null) : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? (error ? String(error.message) : ''),
          timedOut,
        });
      },
    );
    child.on('error', () => {
      /* handled by the exec callback */
    });
  });
}

/* ------------------------------------------------------------ routing documents */

export interface RoutingInput {
  lines: Line[];
  domain: string;
}

export function buildRoutingDocument({ lines, domain }: RoutingInput): RoutingDocument {
  const routes: RoutingDocument['routes'] = [];
  const voicemail = `voicemail@${domain}`;
  const dayList = (days: string[]) => days.map((d) => d.toLowerCase());

  for (const line of lines.filter((l) => l.enabled)) {
    const base = {
      to: line.aor,
      // Calls are only answered for a verified, key-bound peer identity.
      verified: true,
    };

    if (line.routingMode === 'always') {
      routes.push({ name: `${line.extension}-answer`, when: base, then: [{ answer: {} }] });
      continue;
    }

    if (line.routingMode === 'forward') {
      const to = line.forwardTo || voicemail;
      routes.push({ name: `${line.extension}-forward`, when: base, then: [{ forward: { to } }] });
      continue;
    }

    if (line.routingMode === 'voicemail') {
      routes.push({
        name: `${line.extension}-voicemail`,
        when: base,
        then: [{ forward: { to: voicemail } }],
      });
      continue;
    }

    // business-hours: answer inside the window, then hand off outside it.
    routes.push({
      name: `${line.extension}-business-hours`,
      when: {
        ...base,
        weekday: dayList(line.businessHours.weekdays),
        time: `${line.businessHours.start}-${line.businessHours.end}`,
      },
      then: [{ answer: {} }],
    });
    routes.push({
      name: `${line.extension}-after-hours`,
      when: { ...base, verified: true },
      then: line.forwardTo
        ? [{ forward: { to: line.forwardTo } }]
        : [{ reject: CANTUS_REJECT.UNAVAILABLE }],
    });
  }

  return {
    version: 1,
    default: { reject: CANTUS_REJECT.NOT_FOUND },
    routes,
  };
}

const PREDICATES = new Set(['to', 'from', 'weekday', 'time', 'limit', 'event', 'verified']);
const ACTIONS = new Set([
  'answer',
  'reject',
  'forward',
  'bridge',
  'play',
  'record',
  'pause',
  'noop',
]);

/** Mirrors Cantus::Router->load so the console can explain a bad document offline. */
export function validateLocally(doc: unknown): string[] {
  const errors: string[] = [];
  if (!doc || typeof doc !== 'object') return ['document is not an object'];
  const d = doc as Partial<RoutingDocument>;
  if (d.version !== 1) errors.push('version must be 1');
  if (!Array.isArray(d.routes)) return [...errors, 'routes must be an array'];
  d.routes.forEach((route, i) => {
    const where = `route[${i}]`;
    if (!route || typeof route !== 'object') {
      errors.push(`${where} is not an object`);
      return;
    }
    if (!route.name) errors.push(`${where} needs a name`);
    for (const key of Object.keys(route.when ?? {})) {
      if (!PREDICATES.has(key)) errors.push(`${where}: unknown predicate '${key}'`);
    }
    if (!Array.isArray(route.then) || route.then.length === 0) {
      errors.push(`${where}: 'then' must be a non-empty array`);
      return;
    }
    for (const action of route.then) {
      if (!action || typeof action !== 'object' || Object.keys(action).length !== 1) {
        errors.push(`${where}: each action is a single-key object`);
        continue;
      }
      const [name] = Object.keys(action);
      if (!ACTIONS.has(name!)) errors.push(`${where}: unknown action '${name}'`);
    }
  });
  return errors;
}

function tmpDocument(doc: RoutingDocument): string {
  const dir = join(env.dbPath, '..', 'tmp');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `routes-${randomBytes(6).toString('hex')}.json`);
  writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}

export interface ValidationResult {
  ok: boolean;
  verifiedBy: 'cantus' | 'local';
  errors: string[];
  output: string;
}

/** Validates with the reference stack when it is present, never pretending it was. */
export async function validateDocument(doc: RoutingDocument): Promise<ValidationResult> {
  const localErrors = validateLocally(doc);
  if (localErrors.length) {
    return { ok: false, verifiedBy: 'local', errors: localErrors, output: localErrors.join('\n') };
  }
  const file = tmpDocument(doc);
  try {
    const result = await runCantus(['route-test', file], 15_000);
    if (result.ok) {
      const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
      return { ok: true, verifiedBy: 'cantus', errors: [], output: combined };
    }
    const detail = (result.stderr || result.stdout || 'cantus route-test failed').trim();
    return {
      ok: false,
      verifiedBy: 'cantus',
      errors: detail.split('\n').filter(Boolean),
      output: detail,
    };
  } finally {
    rmSync(file, { force: true });
  }
}

export async function routeTest(
  doc: RoutingDocument,
  ctx: { to: string; from: string; hour?: string },
): Promise<CantusRouteDecision & { raw: string }> {
  const file = tmpDocument(doc);
  try {
    const args = ['route-test', file, '--to', ctx.to, '--from', ctx.from];
    if (ctx.hour) args.push('--hour', ctx.hour);
    const result = await runCantus(args, 15_000);
    const raw = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    const routeLine = raw.split('\n').find((l) => l.startsWith('route'));
    const actionLine = raw.split('\n').find((l) => l.startsWith('actions'));
    const route = routeLine ? routeLine.replace(/^route\s+/, '').trim() : null;
    const actions = actionLine
      ? actionLine.replace(/^actions\s+/, '').split('->').map((a) => a.trim()).filter(Boolean)
      : [];
    if (!result.ok) return { route: null, actions: [], matched: false, raw };
    return { route, actions, matched: Boolean(route && route !== '(default)'), raw };
  } finally {
    rmSync(file, { force: true });
  }
}

/* ------------------------------------------------------------------- health */

interface CachedStatus {
  at: number;
  value: CantusStatus;
}

let cached: CachedStatus | null = null;
const STATUS_TTL = 30_000;

export async function cantusStatus(force = false): Promise<CantusStatus> {
  if (!force && cached && Date.now() - cached.at < STATUS_TTL) return cached.value;

  const versionRun = await runCantus(['version'], 10_000);
  const available = versionRun.ok;
  let value: CantusStatus = {
    available,
    binary: cantusBinary(),
    version: available ? versionRun.stdout.split('\n')[0]?.trim() ?? null : null,
    reason: available
      ? null
      : versionRun.timedOut
        ? 'cantus did not respond in time'
        : (versionRun.stderr || 'cantus CLI unavailable').split('\n')[0] ?? null,
    selftest: null,
  };

  if (available) {
    const test = await runCantus(['selftest'], 20_000);
    const checks = test.stdout
      .split('\n')
      .map((line) => line.match(/^(.*?)\s{2,}(ok|FAIL)\s*$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => ({ name: m[1]!.trim(), ok: m[2] === 'ok' }));
    value = {
      ...value,
      selftest: {
        ok: test.ok && checks.every((c) => c.ok),
        checks,
        output: [test.stdout.trim(), test.stderr.trim()].filter(Boolean).join('\n').trim(),
      },
    };
  }

  cached = { at: Date.now(), value };
  return value;
}

export function invalidateCantusStatus(): void {
  cached = null;
}

/* --------------------------------------------------------------- path probe */

type NatMode = 'none' | 'cone' | 'symmetric';

export async function pathProbe(options: { nat?: NatMode; rebind?: boolean } = {}): Promise<PathProbeResult> {
  const nat: NatMode = options.nat ?? 'symmetric';
  const rebind = Boolean(options.rebind);
  if (rebind && nat === 'none') {
    return {
      ok: false,
      path: null,
      frames: 0,
      peak: 0,
      codec: null,
      rebind: { requested: true, recoveredAtMs: null },
      nat,
      output: 'rebind needs a middlebox: choose cone or symmetric',
      ranAt: new Date().toISOString(),
    };
  }

  const args = ['demo', '--nat', nat, '--quiet'];
  if (rebind) args.push('--rebind');
  const result = await runCantus(args, 60_000);
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');

  const value = (label: string): string | null => {
    const re = new RegExp(`^\\s*${label}\\s+(.+)$`, 'm');
    const m = result.stdout.match(re);
    return m ? m[1]!.trim() : null;
  };

  const pathText = value('path');
  const audio = value('audio');
  const framesMatch = audio?.match(/(\d+)\s+frames/);
  const peakMatch = audio?.match(/peak amplitude\s+(\d+)/);
  const rebindLine = value('rebinding');
  const recovered = rebindLine?.match(/direct restored at ([\d.]+)s/);

  return {
    ok: result.ok && /PASS/.test(result.stdout),
    path: pathText?.startsWith('direct') ? 'direct' : pathText?.startsWith('relay') ? 'relay' : null,
    frames: framesMatch ? Number(framesMatch[1]) : 0,
    peak: peakMatch ? Number(peakMatch[1]) : 0,
    codec: value('codec'),
    rebind: rebind
      ? {
          requested: true,
          recoveredAtMs: recovered ? Math.round(Number(recovered[1]) * 1000) : null,
        }
      : null,
    nat,
    output,
    ranAt: new Date().toISOString(),
  };
}
