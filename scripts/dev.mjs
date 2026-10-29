#!/usr/bin/env node
/**
 * Runs the control plane and the console dev server together, cross-platform.
 *   node scripts/dev.mjs
 */
import { spawn } from 'node:child_process';

const targets = [
  ['server', 'dev:server'],
  ['console', 'dev:console'],
];

const children = targets.map(([name, script]) => {
  const child = spawn('npm', ['run', script], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`[dev] ${name} exited with ${code}`);
      shutdown(code);
    }
  });
  return child;
});

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
