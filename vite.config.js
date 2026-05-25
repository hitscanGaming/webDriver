import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Project-wide release version lives at repo-root VERSION (synced from the
// OC Agent monorepo at deploy time). The web driver reads the same source so
// its "expected firmware" matches what just shipped.
const versionText = readFileSync(join(__dirname, 'VERSION'), 'utf-8');
const parseVer = (key) =>
  versionText.match(new RegExp(`^${key}\\s*=\\s*(\\S+)`, 'm'))?.[1] ?? '0';
const releaseVersion =
  `${parseVer('VERSION_MAJOR')}.${parseVer('VERSION_MINOR')}.${parseVer('PATCHLEVEL')}`;

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __RELEASE_VERSION__: JSON.stringify(releaseVersion),
  },
});
