/**
 * Velostream - Build script
 *
 *   node scripts/build.js                   -> dist/chrome + dist/firefox
 *   node scripts/build.js --target=chrome   -> dist/chrome only
 *   node scripts/build.js --target=firefox  -> dist/firefox only
 *   node scripts/build.js --watch           -> rebuild on source changes
 *
 * Copies the sources and ships the locally installed Shaka Player (HLS + DASH + TS
 * transmuxer + AES-128) as lib/shaka-player.compiled.js. It is loaded by the player
 * extension page (player/player.html), never from a CDN and never into the site's page.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const SHARED_FILES = ['background', 'common', 'content', 'player', 'popup', 'icons', 'rules'];
const SHAKA_PATH = path.join(ROOT, 'node_modules', 'shaka-player', 'dist', 'shaka-player.compiled-es2021.js');
const SHAKA_LICENSE = path.join(ROOT, 'node_modules', 'shaka-player', 'LICENSE');
// Firefox add-on ID. AMO ties the add-on to it forever and never accepts an ID again after the
// add-on is deleted (velostream@antigravity.dev is burned that way). Do not change it once published.
const GECKO_ID = 'velostream@srikarthickeyanganapathy.github.io';

const args = process.argv.slice(2);
const targetArg = (args.find(a => a.startsWith('--target=')) || '').split('=')[1];
const WATCH = args.includes('--watch');
const TARGETS = targetArg ? [targetArg] : ['chrome', 'firefox'];

for (const t of TARGETS) {
    if (!['chrome', 'firefox'].includes(t)) {
        console.error(`[Build] Unknown target "${t}". Use chrome or firefox.`);
        process.exit(1);
    }
}

/** Shaka Player is shipped as a plain file and loaded by the player extension page. */
function readShaka() {
    if (!fs.existsSync(SHAKA_PATH)) {
        throw new Error('shaka-player is not installed. Run "npm install" first.');
    }
    // Byte-for-byte copy: AMO reviewers verify third-party libraries against the official release,
    // so the file must stay unmodified (the trailing sourceMappingURL comment included).
    return fs.readFileSync(SHAKA_PATH);
}

function verifyManifestFiles(manifest, targetDir) {
    const files = new Set();
    const addIcons = obj => obj && Object.values(obj).forEach(p => files.add(p));
    addIcons(manifest.icons);
    addIcons(manifest.action && manifest.action.default_icon);
    if (manifest.action && manifest.action.default_popup) files.add(manifest.action.default_popup);
    if (manifest.background.service_worker) files.add(manifest.background.service_worker);
    (manifest.background.scripts || []).forEach(f => files.add(f));
    (manifest.content_scripts || []).forEach(cs => cs.js.forEach(f => files.add(f)));
    ((manifest.declarative_net_request || {}).rule_resources || []).forEach(r => files.add(r.path));
    ((manifest.web_accessible_resources || [])).forEach(w => w.resources.forEach(f => files.add(f)));
    files.add('background/hls-parser.js');
    const missing = [...files].filter(f => !fs.existsSync(path.join(targetDir, f)));
    if (missing.length) throw new Error(`Missing files in ${targetDir}: ${missing.join(', ')}`);

    // Validate JSON rule resources parse correctly.
    ((manifest.declarative_net_request || {}).rule_resources || []).forEach(r => {
        JSON.parse(fs.readFileSync(path.join(targetDir, r.path), 'utf8'));
    });
}

function buildTarget(browser, shaka) {
    console.log(`[Build] Building for ${browser}...`);
    const targetDir = path.join(DIST, browser);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });

    for (const item of SHARED_FILES) {
        const src = path.join(ROOT, item);
        if (!fs.existsSync(src)) throw new Error(`Source "${item}" not found.`);
        fs.cpSync(src, path.join(targetDir, item), {
            recursive: true,
            filter: p => !p.endsWith('.gitkeep')
        });
    }

    fs.mkdirSync(path.join(targetDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'lib', 'shaka-player.compiled.js'), shaka);
    if (fs.existsSync(SHAKA_LICENSE)) {
        fs.copyFileSync(SHAKA_LICENSE, path.join(targetDir, 'lib', 'SHAKA-LICENSE.txt'));
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    manifest.version = pkg.version;

    if (browser === 'firefox') {
        manifest.browser_specific_settings = {
            gecko: {
                id: GECKO_ID,
                // Firefox 128 ESR is the real floor (MV3 + the APIs Velostream uses).
                strict_min_version: '128.0',
                // Firefox built-in data consent (https://mzl.la/firefox-builtin-data-consent):
                // Velostream collects and transmits no user data. The key is only understood from
                // Firefox 140 / Android 142; older versions ignore unknown gecko sub-keys. Because the
                // minimum versions are lower than that, AMO's linter shows 2 non-blocking warnings
                // (one for gecko, one for gecko_android) - expected, and they do not block signing.
                data_collection_permissions: { required: ['none'] }
            },
            gecko_android: { strict_min_version: '128.0' }
        };
        // Firefox MV3 uses a non-persistent event page instead of a service worker.
        manifest.background = { scripts: ['background/engine.js'], type: 'module' };
    } else {
        // world: "MAIN" content scripts need Chromium 111+.
        manifest.minimum_chrome_version = '111';
    }

    fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    verifyManifestFiles(manifest, targetDir);
    console.log(`[Build] ${browser}: OK -> ${path.relative(ROOT, targetDir)}`);
}

function build() {
    const started = Date.now();
    const shaka = readShaka();
    fs.mkdirSync(DIST, { recursive: true });
    for (const t of TARGETS) buildTarget(t, shaka);
    console.log(`[Build] Complete in ${Date.now() - started}ms`);
}

function runBuild() {
    try {
        build();
        return true;
    } catch (err) {
        console.error('[Build] Failed:', err.message);
        return false;
    }
}

if (WATCH) {
    runBuild();
    let timer = null;
    const watched = [...SHARED_FILES.map(f => path.join(ROOT, f)), path.join(ROOT, 'manifest.json')];
    for (const p of watched) {
        if (!fs.existsSync(p)) continue;
        fs.watch(p, { recursive: fs.statSync(p).isDirectory() }, () => {
            clearTimeout(timer);
            timer = setTimeout(runBuild, 200);
        });
    }
    console.log('[Build] Watching for changes...');
} else if (!runBuild()) {
    process.exit(1);
}
