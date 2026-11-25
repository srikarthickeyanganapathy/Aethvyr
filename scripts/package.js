/**
 * Aethvyr - Package built extensions into store-ready zip files.
 *   npm run build && npm run package
 * Produces dist/aethvyr-chrome-<version>.zip and dist/aethvyr-firefox-<version>.zip
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
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(srcDir, false);
        archive.finalize().catch(reject);
    });
}

async function main() {
    const targets = ['chrome', 'firefox'].map(target => {
        const dir = path.join(DIST, target);
        const manifestPath = path.join(dir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) throw new Error('Missing ' + target + ' build. Run npm run build.');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.version !== version) throw new Error('Build version mismatch for ' + target + '. Run npm run build.');
        return { target, dir };
    });
    for (const { target, dir } of targets) {
        const out = path.join(DIST, `aethvyr-${target}-${version}.zip`);
        const temporary = out + '.' + process.pid + '.tmp';
        let bytes;
        try {
            bytes = await zipDir(dir, temporary);
            fs.renameSync(temporary, out);
        } finally {
            fs.rmSync(temporary, { force: true });
        }
        console.log(`[Package] ${path.relative(ROOT, out)} (${(bytes / 1024).toFixed(0)} KB)`);
    }
}

main().catch(err => {
    console.error('[Package] Failed:', err);
    process.exit(1);
});
