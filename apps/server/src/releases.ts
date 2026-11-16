import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export interface ReleaseFile {
  /** Absolute path of the archive on the release volume. */
  file: string;
  size: number;
}

/**
 * Maps a `/download/…` request onto a file on the release volume.
 *
 * The archive is the application itself, source included, and the repository it
 * is built from is private — so this only ever names a file, never serves one;
 * the caller authenticates first and looks the path up afterwards. Returning
 * null for everything that is not a regular file inside the volume keeps the
 * answer identical whether the archive is missing or the path escaped, which is
 * what stops a caller probing what happens to be there.
 */
export function resolveRelease(root: string, urlPath: string): ReleaseFile | null {
  const path = (urlPath.split('?')[0] ?? '').replace(/\/+$/, '');
  if (!path.startsWith('/download/')) return null;

  let requested: string;
  try {
    requested = decodeURIComponent(path.slice('/download/'.length));
  } catch {
    return null; // A malformed escape is not a path, and resolve() would guess.
  }
  if (requested === '' || requested.includes('\0')) return null;

  const candidate = resolve(root, requested);
  // Containment against the volume itself, not a string prefix that `../x` can
  // satisfy: `releases-evil` starts with `releases`, `releases/x` does not.
  if (!candidate.startsWith(root + sep)) return null;
  if (!existsSync(candidate)) return null;

  const stat = statSync(candidate);
  if (!stat.isFile()) return null;
  return { file: candidate, size: stat.size };
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * One `bytes=` range, so a download the installer interrupted resumes instead
 * of restarting over a slow link.
 *
 * Bytes are what the operator's curl asks for; anything else is answered with
 * the whole file (`null`) because an ignored Range is always a valid response.
 * A range that starts past the end is `'unsatisfiable'` instead, so the caller
 * can say 416 — answering 200 there would silently hand back a file the client
 * is not asking for.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Several ranges at once, or a unit this server does not speak: send it all.
  if (!match) return null;
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (size === 0) return 'unsatisfiable';

  if (rawStart === '') {
    // `bytes=-500`: the last 500 bytes, used to read a tail without fetching.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable';
  const end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}
