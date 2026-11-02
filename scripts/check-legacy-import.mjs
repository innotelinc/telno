#!/usr/bin/env node
/*
 * check-legacy-import.mjs — fails when the console and the legacy database have
 * drifted apart.
 *
 * The importer is idempotent, so on a healthy node every record it knows about
 * is already present and it reports nothing but `exists`. Anything else means a
 * row was deleted in the console, an extension collided, or a device arrived in
 * the legacy database after the last import — all worth a look.
 *
 * Exit status is the interface: 0 when everything is present, 1 when something
 * would change. The report is printed either way, so a timer failure is readable
 * in `journalctl -u telno-legacy-import-check`.
 *
 *   node scripts/check-legacy-import.mjs
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const importer = join(here, 'import-legacy.mjs');

const run = () =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [importer, '--json'],
      { maxBuffer: 8 * 1024 * 1024, timeout: 60_000 },
      (error, stdout) => resolve({ error, stdout }),
    );
  });

const { error, stdout } = await run();

if (error && !stdout) {
  console.error(`importer did not run: ${error.message}`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(stdout);
} catch {
  console.error(`importer produced no report:\n${stdout}`);
  process.exit(2);
}

/* Every list the importer fills; the name is what a human reads in the output. */
const sections = ['devices', 'lines', 'directory', 'settings', 'pruned'];
const drift = [];
const missing = [];

for (const section of sections) {
  for (const item of report[section] ?? []) {
    if (item.action === 'exists') continue;
    // A skipped row is a real gap, not drift: the importer could not map it.
    if (item.action === 'skipped') {
      missing.push({ section, ...item });
      continue;
    }
    drift.push({ section, ...item });
  }
}

const describe = (item) =>
  item.serial ?? item.extension ?? item.number ?? item.key ?? item.kind ?? '(unknown)';

if (drift.length === 0 && missing.length === 0) {
  const counts = sections
    .map((section) => `${section}=${(report[section] ?? []).length}`)
    .join(' ');
  console.log(`legacy import is complete (${counts})`);
  process.exit(0);
}

for (const item of drift) {
  console.error(`drift   ${item.section}: ${describe(item)} (${item.action})`);
}
for (const item of missing) {
  console.error(`skipped ${item.section}: ${describe(item)} — ${item.reason ?? 'no reason given'}`);
}
console.error(
  `\n${drift.length} record(s) would change, ${missing.length} could not be mapped.` +
    ' Run `node scripts/import-legacy.mjs` for the plan.',
);
process.exit(1);
