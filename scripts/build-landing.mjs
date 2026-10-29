#!/usr/bin/env node
/**
 * Put the landing page inside the console's build output.
 *
 * The marketing page used to be published by GitHub Pages, which cannot serve a
 * private repository on a free plan — turning the source private took the page
 * down with it. It ships in the image now and the app serves it at the site
 * root, so the page lives on telno.services and the source can stay closed.
 *
 * The three files land at the top of `web/dist` rather than in a subdirectory
 * because the page is requested at `/`, where its own relative `href="unity-theme.css"`
 * and `src="unity-theme.js"` resolve to the site root. The server reads this same
 * `landing.html` at boot to hash its inline scripts, so nothing here rewrites the
 * markup: what the browser receives is byte-for-byte what is in `web/landing`.
 *
 * `npm run build` runs this after Vite, which wipes `dist`.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const landing = join(repoRoot, 'web', 'landing');
const dist = join(repoRoot, 'web', 'dist');

if (!existsSync(dist)) {
  console.error('web/dist is missing — run the Vite build first (npm run build does both).');
  process.exit(1);
}

const files = ['index.html', 'unity-theme.css', 'unity-theme.js'];
for (const name of files) {
  if (!existsSync(join(landing, name))) {
    console.error(`web/landing/${name} is missing — the landing page would render broken.`);
    process.exit(1);
  }
}

await mkdir(dist, { recursive: true });
await copyFile(join(landing, 'index.html'), join(dist, 'landing.html'));
await copyFile(join(landing, 'unity-theme.css'), join(dist, 'unity-theme.css'));
await copyFile(join(landing, 'unity-theme.js'), join(dist, 'unity-theme.js'));

console.log('landing: staged index.html, unity-theme.css and unity-theme.js into web/dist');
