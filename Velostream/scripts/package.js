/**
 * Velostream - Package built extensions into store-ready zip files.
 *   npm run build && npm run package
 * Produces dist/velostream-chrome-<version>.zip and dist/velostream-firefox-<version>.zip
 * (the Firefox zip doubles as an .xpi for signing on addons.mozilla.org).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import archiver from 'archiver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function zipDir(srcDir, outFile) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outFile);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', () => resolve(archive.pointer()));
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(srcDir, false);
        archive.finalize();
    });
}

async function main() {
    let built = 0;
    for (const target of ['chrome', 'firefox']) {
        const dir = path.join(DIST, target);
        if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
            console.warn(`[Package] dist/${target} not built - run "npm run build:${target}" first. Skipping.`);
            continue;
        }
        const out = path.join(DIST, `velostream-${target}-${version}.zip`);
        const bytes = await zipDir(dir, out);
        console.log(`[Package] ${path.relative(ROOT, out)} (${(bytes / 1024).toFixed(0)} KB)`);
        built++;
    }
    if (!built) process.exit(1);
}

main().catch(err => {
    console.error('[Package] Failed:', err);
    process.exit(1);
});
