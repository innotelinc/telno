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
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
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

/**
 * The install files are served from here too, because the quickstart tells a
 * visitor to run one command against this host and they have no checkout to
 * copy a compose file out of. The published names are what an installer
 * expects to find: docker-compose.yml, env.example and install.sh.
 */
const deploy = join(repoRoot, 'deploy');
const shipping = [
  ['docker-compose.release.yml', 'docker-compose.yml'],
  ['docker-compose.desktop.yml', 'docker-compose.desktop.yml'],
  ['env.example', 'env.example'],
  ['install.sh', 'install.sh'],
];
for (const [from, to] of shipping) {
  if (!existsSync(join(deploy, from))) {
    console.error(`deploy/${from} is missing — the quickstart would install nothing.`);
    process.exit(1);
  }
  await copyFile(join(deploy, from), join(dist, to));
}

// The installer names the release archive it downloads, so its version comes
// from package.json at build time rather than being typed twice and drifting.
const version = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version;
const installerPath = join(dist, 'install.sh');
const installer = await readFile(installerPath, 'utf8');
if (!installer.includes('@VERSION@')) {
  console.error('deploy/install.sh lost its @VERSION@ placeholder — the archive name would be wrong.');
  process.exit(1);
}
await writeFile(installerPath, installer.replaceAll('@VERSION@', version), 'utf8');

console.log(
  'landing: staged index.html, unity-theme.css and unity-theme.js into web/dist; ' +
    'install: staged docker-compose.yml, env.example and install.sh'
);
