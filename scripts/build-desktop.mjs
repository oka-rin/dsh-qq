import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
await build({ absWorkingDir: root, entryPoints: ['desktop-client.js'], outfile: 'assets/desktop-viewer.js', bundle: true,
  format: 'iife', platform: 'browser', target: ['es2022'], minify: true, legalComments: 'eof' });
// Keep original notices and source access; noVNC is MPL-2.0, not relicensed MIT.
const source = path.join(root, 'node_modules/@novnc/novnc');
const dest = path.join(root, 'assets/licenses');
fs.mkdirSync(dest, { recursive: true });
for (const file of ['LICENSE.txt', 'AUTHORS', 'docs/LICENSE.MPL-2.0', 'docs/LICENSE.BSD-3-Clause', 'docs/LICENSE.BSD-2-Clause', 'docs/LICENSE.OFL-1.1']) {
  fs.copyFileSync(path.join(source, file), path.join(dest, path.basename(file)));
}
