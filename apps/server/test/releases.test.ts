import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRange, resolveRelease } from '../src/releases.js';

describe('release archive lookup', () => {
  let volume = '';
  let outside = '';

  beforeAll(async () => {
    // A volume shaped like the deployment's: `<data dir>/releases`, with a
    // sibling whose name begins the same way, which a naive prefix check on the
    // string would accept.
    const data = await mkdtemp(join(tmpdir(), 'telno-releases-'));
    volume = join(data, 'releases');
    outside = join(data, 'releases-shadow');
    await mkdir(volume);
    await mkdir(outside);
    await writeFile(join(volume, 'telno-2026.1.0.tar.gz'), 'archive-bytes');
    await writeFile(join(volume, '.hidden'), 'x');
    await mkdir(join(volume, 'nested'));
    await writeFile(join(outside, 'escaped.tar.gz'), 'not yours');
    await writeFile(join(data, 'secret.txt'), 'not yours either');
  });

  afterAll(async () => {
    await rm(join(volume, '..'), { recursive: true, force: true });
  });

  it('names the archive and its size', () => {
    expect(resolveRelease(volume, '/download/telno-2026.1.0.tar.gz')).toEqual({
      file: join(volume, 'telno-2026.1.0.tar.gz'),
      size: 13,
    });
  });

  it('ignores a query string the installer appended', () => {
    expect(resolveRelease(volume, '/download/telno-2026.1.0.tar.gz?token=x')?.size).toBe(13);
  });

  it('refuses a path that walks out of the volume', () => {
    expect(resolveRelease(volume, '/download/../secret.txt')).toBeNull();
    expect(resolveRelease(volume, '/download/%2e%2e%2fsecret.txt')).toBeNull();
    expect(resolveRelease(volume, '/download/..%2F..%2Fetc%2Fpasswd')).toBeNull();
  });

  it('refuses a sibling volume whose name shares the prefix', () => {
    expect(resolveRelease(volume, '/download/../releases-shadow/escaped.tar.gz')).toBeNull();
  });

  it('refuses an absolute path', () => {
    expect(resolveRelease(volume, '/download//etc/passwd')).toBeNull();
  });

  it('refuses a directory, a missing file, and the bare endpoint', () => {
    expect(resolveRelease(volume, '/download/nested')).toBeNull();
    expect(resolveRelease(volume, '/download/nope.tar.gz')).toBeNull();
    expect(resolveRelease(volume, '/download/')).toBeNull();
  });

  it('refuses a malformed escape instead of guessing at a path', () => {
    expect(resolveRelease(volume, '/download/%E0%A4%A')).toBeNull();
  });

  it('ignores requests that are not on the download route', () => {
    expect(resolveRelease(volume, '/api/devices')).toBeNull();
    expect(resolveRelease(volume, '/downloads/telno.tar.gz')).toBeNull();
  });
});

describe('release download ranges', () => {
  const size = 100;

  it('asks for nothing when the client sent no range', () => {
    expect(parseRange(undefined, size)).toBeNull();
    expect(parseRange('', size)).toBeNull();
  });

  it('serves the tail of an open-ended range', () => {
    expect(parseRange('bytes=0-', size)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=90-', size)).toEqual({ start: 90, end: 99 });
  });

  it('clamps an end past the last byte rather than refusing', () => {
    expect(parseRange('bytes=90-9999', size)).toEqual({ start: 90, end: 99 });
  });

  it('serves a single byte, which is a legal range', () => {
    expect(parseRange('bytes=0-0', size)).toEqual({ start: 0, end: 0 });
  });

  it('serves the last N bytes for a suffix range', () => {
    expect(parseRange('bytes=-10', size)).toEqual({ start: 90, end: 99 });
    // A suffix longer than the file is the whole file, not an error.
    expect(parseRange('bytes=-500', size)).toEqual({ start: 0, end: 99 });
  });

  it('calls a start past the end unsatisfiable so the answer is 416, not 200', () => {
    expect(parseRange('bytes=100-', size)).toBe('unsatisfiable');
    expect(parseRange('bytes=120-130', size)).toBe('unsatisfiable');
  });

  it('calls any range unsatisfiable on an empty archive', () => {
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
  });

  it('ignores ranges it does not speak, sending the whole file instead', () => {
    expect(parseRange('bytes=0-1,4-5', size)).toBeNull();
    expect(parseRange('items=0-1', size)).toBeNull();
    expect(parseRange('bytes=abc', size)).toBeNull();
    // Backwards or zero-length: the client cannot mean this, so send all of it.
    expect(parseRange('bytes=50-10', size)).toBeNull();
    expect(parseRange('bytes=-0', size)).toBeNull();
  });
});
