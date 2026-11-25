// Run from the repository root with Node 22+, Python 3 and a Chromium browser.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [binary, baseline] = process.argv.slice(2);
assert.ok(binary && baseline, 'Provide a Chromium executable and the legacy Chromium ZIP.');
const work = await mkdtemp(path.join(tmpdir(), 'aethvyr-browser-'));
const extension = path.join(work, 'extension');
const profile = path.join(work, 'profile');
const video = await readFile('scripts/fixtures/seek-video.mp4');
let mediaBytes = 0;
const server = createServer((req, res) => {
    if (req.url.endsWith('.mp4')) {
        const start = Number(/^bytes=(\d+)-/.exec(req.headers.range)?.[1] || 0);
        if (start >= video.length) { res.writeHead(416).end(); return; }
        const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': video.length - start };
        if (req.headers.range) headers['Content-Range'] = `bytes ${start}-${video.length - 1}/${video.length}`;
        headers['Cache-Control'] = 'public, max-age=600';
        mediaBytes += video.length - start;
        res.writeHead(req.headers.range ? 206 : 200, headers).end(video.subarray(start));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Playback test pattern</title><style>*{margin:0}video{width:100vw;height:100vh;background:black}</style><video controls loop muted autoplay src="pattern.mp4"></video>');
    }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const site = 'http://127.0.0.1:' + server.address().port;
async function until(fn, label) {
    for (let i = 0; i < 100; i++) {
        const value = await fn();
        if (value) return value;
        await delay(100);
    }
    throw new Error('Timed out: ' + label);
}

async function launch(run) {
    const child = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0',
        '--user-data-dir=' + profile, '--load-extension=' + extension, '--window-size=1280,800', 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const exit = once(child, 'exit');
    let log = '';
    child.stderr.on('data', chunk => { log = (log + chunk).slice(-32000); });
    let socket;
    let call;
    try {
        const endpoint = await until(() => /DevTools listening on (ws:\/\/[^\s]+)/.exec(log)?.[1], 'browser startup');
        socket = new WebSocket(endpoint);
        await once(socket, 'open');
        const pending = new Map();
        let id = 0;
        socket.onmessage = event => {
            const reply = JSON.parse(event.data);
            pending.get(reply.id)?.(reply);
        };
        call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
            const n = ++id;
            const timer = setTimeout(() => { pending.delete(n); reject(new Error(method + ' timed out')); }, 12000);
            pending.set(n, reply => {
                clearTimeout(timer);
                pending.delete(n);
                if (reply.error) reject(new Error(method + ': ' + reply.error.message));
                else resolve(reply.result);
            });
            socket.send(JSON.stringify({ id: n, method, params, sessionId }));
        });
        const targets = async () => (await call('Target.getTargets')).targetInfos;
        const attach = async targetId => (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
        async function page(url) {
            const { targetId } = await call('Target.createTarget', { url });
            const session = await attach(targetId);
            await until(() => evaluate(session, 'document.readyState === "complete" && location.href === ' + JSON.stringify(url)), url);
            return session;
        }
        async function evaluate(session, expression) {
            const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, session);
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
            return r.result.value;
        }
        const worker = await until(async () => (await targets()).find(t => t.type === 'service_worker' && t.url.endsWith('/background/engine.js')), 'extension worker');
        console.log((await call('Browser.getVersion')).product, worker.url);
        await run({ base: new URL(worker.url).protocol + '//' + new URL(worker.url).host,
            worker: await attach(worker.targetId), call, page, evaluate, targets, attach });
    } finally {
        if (call) await call('Browser.close').catch(() => {});
        else child.kill();
        socket?.close();
        await exit;
    }
}

const storageFixture = {
    fs_history: { foundation: { url: site + '/normal.mp4', title: 'Fixture', t: 9, updatedAt: 1 } },
    fs_bm_foundation: [{ t: 9, label: 'Cue' }],
    fs_library: { favorites: ['foundation'], collections: [{ id: 'one', name: 'Collection', keys: ['foundation'] }] }
};
async function screenshot(browser, session, filename) {
    const { data } = await browser.call('Page.captureScreenshot', { format: 'png' }, session);
    if (filename) await writeFile('docs/media/' + filename, Buffer.from(data, 'base64'));
    return data;
}

// Web-platform clock inside the same document for both native and extension video.
async function benchmarkVideo(evaluate, session, selector) {
    return evaluate(session, `(async () => {
        const video = ${selector};
        const framesBefore = video.getVideoPlaybackQuality();
        const seekMs = [];
        let waits = 0;
        const countWait = () => waits++;
        video.addEventListener('waiting', countWait);
        try {
            for (const target of [2, 7, 3, 8, 4]) {
                const started = performance.now();
                await new Promise((resolve, reject) => {
                    let handle;
                    const timeout = setTimeout(() => {
                        video.cancelVideoFrameCallback(handle);
                        reject(Error('Target frame timeout'));
                    }, 1500);
                    const presented = (_, metadata) => {
                        if (!video.seeking && Math.abs(metadata.mediaTime - target) < 0.35) {
                            clearTimeout(timeout);
                            resolve();
                        } else handle = video.requestVideoFrameCallback(presented);
                    };
                    handle = video.requestVideoFrameCallback(presented);
                    video.currentTime = target;
                });
                seekMs.push(Math.round(performance.now() - started));
            }
        } finally { video.removeEventListener('waiting', countWait); }
        const frames = video.getVideoPlaybackQuality();
        return { seekMs, waitingEvents: waits, dropped: frames.droppedVideoFrames - framesBefore.droppedVideoFrames,
            frames: frames.totalVideoFrames - framesBefore.totalVideoFrames };
    })()`);
}

try {
    execFileSync('python', ['-m', 'zipfile', '-e', baseline, extension]);
    let identity;
    await launch(async browser => {
        identity = browser.base;
        const session = await browser.page(identity + '/popup/library.html');
        assert.equal(await browser.evaluate(session, 'chrome.runtime.getManifest().short_name'), 'Velostream');
        await browser.evaluate(session, `(async () => {
            await chrome.storage.local.set(${JSON.stringify(storageFixture)});
            const handle = await (await navigator.storage.getDirectory()).getFileHandle('resume.mp4',{create:true});
            await VelostreamLocal.save({id:'fixture',name:'resume.mp4',handle,time:9});
            const {downloadStore} = await import('../background/download-store.js');
            await downloadStore.save({id:'fixture',base:'Test',bytes:0,completedCount:0});
            await downloadStore.commit('fixture','seg:0',{data:new Uint8Array([42]).buffer});
        })()`);
    });
    await cp('dist/chrome', extension, { recursive: true, filter: src => path.basename(src) !== '_metadata' });
    await launch(async browser => {
        const { page, evaluate, base, worker, call, targets, attach } = browser;
        assert.equal(base, identity);
        let library = await page(base + '/popup/library.html');
        assert.deepEqual(await evaluate(library, `chrome.storage.local.get(${JSON.stringify(Object.keys(storageFixture))})`), storageFixture);
        assert.equal(await evaluate(library, `(async()=>{
            const row=await VelostreamLocal.get('fixture');
            const {downloadStore}=await import('../background/download-store.js');
            return row.time===9 && (await row.handle.getFile()).name==='resume.mp4' &&
                new Uint8Array((await downloadStore.read('fixture','seg:0')).data)[0]===42;
        })()`), true);
        console.log('Upgrade preserved real file handle, bookmark, collection, position and download bytes.');
        const guide = await page(base + '/popup/guide.html');
        await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, guide);
        if (process.argv.includes('--capture')) await screenshot(browser, guide, 'feature-guide.png');
        const focus = await evaluate(guide, `(()=>{
            const link=document.querySelector('a.skip-link');
            link.focus();
            const standard=getComputedStyle(link).outlineWidth;
            document.body.classList.add('hc');
            const highContrast=getComputedStyle(link).outlineWidth;
            document.body.classList.remove('hc');
            return {focused:document.activeElement===link,standard,highContrast};
        })()`);
        assert.deepEqual(focus,{focused:true,standard:'2px',highContrast:'3px'});
        if (process.argv.includes('--icons')) {
            for (const state of ['', '-active']) for (const size of [16, 32, 48, 128]) {
                const svg = await readFile(`assets/brand/icon${state}${size <= 32 ? '-small' : ''}.svg`, 'utf8');
                const data = await evaluate(guide, `(async()=>{
                    const img=new Image();img.src=${JSON.stringify('data:image/svg+xml,' + encodeURIComponent(svg))};await img.decode();
                    const c=document.createElement('canvas');c.width=c.height=${size};
                    c.getContext('2d').drawImage(img,0,0,c.width,c.height);return c.toDataURL();
                })()`);
                await writeFile(`icons/icon${state}-${size}.png`, Buffer.from(data.split(',')[1], 'base64'));
            }
        }
        let controls = await page(base + '/popup/popup.html');
        const send = message => evaluate(controls, `chrome.runtime.sendMessage(${JSON.stringify(message)})`);
        const watch = await page(site + '/watch');
        await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, watch);
        const demo = [];
        const capture = process.argv.includes('--capture');
        await until(() => evaluate(watch, 'document.querySelector("video").currentTime > 0'), 'native playback');
        if (process.argv.includes('--benchmark')) {
            console.log('Native warm seeks', JSON.stringify(await benchmarkVideo(evaluate, watch, 'document.querySelector("video")')));
        }
        if (capture) demo.push(await screenshot(browser, watch));
        const tabId = await evaluate(worker, `chrome.tabs.query({url:${JSON.stringify(site + '/*')}}).then(t=>t[0].id)`);
        const stream = await until(async () => (await send({ action: 'GET_STREAMS', tabId })).streams.find(s=>s.url.endsWith('pattern.mp4')), 'stream detection');
        assert.equal((await send({ action: 'LAUNCH_PLAYER', tabId, streamId: stream.id })).ok, true);
        const frame = await until(async () => (await targets()).find(t=>t.url.startsWith(base + '/player/player.html?session=')), 'mounted player');
        const player = await attach(frame.targetId);
        const shadow = 'document.getElementById("velostream-host")?.shadowRoot';
        const media = shadow + '?.querySelector("video")';
        await until(() => evaluate(player, media + '?.readyState >= 2'), 'extension playback');
        await evaluate(player, media + '.play()');
        await until(() => evaluate(player, media + '.currentTime > 0.1'), 'extension time advances');
        if (process.argv.includes('--benchmark')) {
            console.log('Aethvyr warm seeks', JSON.stringify(await benchmarkVideo(evaluate, player, media)));
            console.log('WebGL recovery', await evaluate(player, `(async()=>{
                const canvas=document.createElement('canvas');
                const pipeline=new VelostreamShaders.VideoShaderPipeline(${media},canvas);
                try {
                    if (!pipeline.init()) return 'WebGL unavailable; original video active';
                    const ext=pipeline.gl.getExtension('WEBGL_lose_context');
                    if (!ext) return 'Context loss simulation unavailable';
                    const lost=new Promise(resolve=>canvas.addEventListener('webglcontextlost',resolve,{once:true}));
                    ext.loseContext();await lost;
                    if (!canvas.hidden || pipeline.active) throw Error('Original video fallback failed');
                    const restored=new Promise(resolve=>canvas.addEventListener('webglcontextrestored',resolve,{once:true}));
                    await new Promise(resolve=>setTimeout(resolve,100));
                    ext.restoreContext();await restored;
                    if(pipeline.failed || pipeline.lost || !pipeline.gl) throw Error('Context recovery failed');
                    return 'Context loss and rebuild passed';
                } finally { pipeline.destroy(); }
            })()`));
        }
        await evaluate(player, '(' + media + ').currentTime = 5');
        await until(() => evaluate(player, media + '.currentTime >= 5 && !' + media + '.seeking'), 'seek completion');
        if (capture) demo.push(await screenshot(browser, watch));
        await evaluate(player, shadow + '.querySelector(".btn-studio").click()');
        if (capture) {
            await evaluate(player, shadow + '.querySelector("#st-tab-tools").click()');
            await evaluate(player, shadow + '.querySelector("#tl-diagnostics").scrollIntoView({block:"center"})');
            await delay(400);
            demo.push(await screenshot(browser, watch, 'playback-diagnostics.png'));
        }
        assert.equal((await send({ action: 'CLOSE_PLAYER', tabId })).ok, true);
        await until(() => evaluate(watch, '!document.querySelector("iframe") && !document.querySelector("video").paused'), 'native restoration');
        if (process.argv.includes('--benchmark')) {
            for (const cache of ['cold', 'warm']) {
                const results = { native: [], overlay: [] };
                for (let i = 0; i < 5; i++) {
                    const order = i % 2 ? ['overlay', 'native'] : ['native', 'overlay'];
                    for (const mode of order) {
                        if (cache === 'cold') await call('Network.clearBrowserCache', {}, watch);
                        const before = mediaBytes;
                        const started = performance.now();
                        let target = watch;
                        let selector = 'document.querySelector("video")';
                        if (mode === 'native') {
                            // Clearing HTTP cache alone leaves the current media resource reusable.
                            const src = cache === 'cold' ? '/cold-' + i + '.mp4' : '/pattern.mp4';
                            await evaluate(watch, selector + '.src = ' + JSON.stringify(src));
                        } else {
                            assert.equal((await send({ action: 'LAUNCH_PLAYER', tabId, streamId: stream.id })).ok, true);
                            const f = await until(async () => (await targets()).find(t => t.url.startsWith(base + '/player/player.html?session=')), 'benchmark player');
                            target = await attach(f.targetId);
                            selector = media;
                        }
                        await evaluate(target, `(async()=>{
                            const end=performance.now()+5000;
                            let v;
                            while (!(v=${selector}) && performance.now()<end) await new Promise(r=>setTimeout(r,10));
                            await v.play();
                            await new Promise(r=>v.requestVideoFrameCallback(r));
                        })()`);
                        results[mode].push({ ms: Math.round(performance.now() - started), bytes: mediaBytes - before });
                        if (cache === 'cold') assert.ok(mediaBytes > before, 'cold start must fetch media');
                        if (mode === 'overlay') {
                            assert.equal((await send({ action: 'CLOSE_PLAYER', tabId })).ok, true);
                            await until(() => evaluate(watch, '!document.querySelector("iframe") && !document.querySelector("video").paused'), 'restored between trials');
                        }
                    }
                }
                console.log(cache + ' HTTP cache playback starts', JSON.stringify(results));
            }
        }
        if (capture) {
            demo.push(await screenshot(browser, watch));
            const movie = await evaluate(guide, `(async()=>{
                const images=await Promise.all(${JSON.stringify(demo)}.map(async data=>{
                    const img=new Image();img.src='data:image/png;base64,'+data;await img.decode();return img;
                }));
                const canvas=document.createElement('canvas');canvas.width=960;canvas.height=600;
                const ctx=canvas.getContext('2d');
                const stream=canvas.captureStream(8);
                const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
                const chunks=[];
                recorder.ondataavailable=e=>chunks.push(e.data);
                const ended=new Promise(resolve=>recorder.onstop=resolve);
                recorder.start();
                for(const img of images) {
                    ctx.drawImage(img,0,0,960,600);
                    await new Promise(resolve=>setTimeout(resolve,850));
                }
                recorder.stop();await ended;stream.getTracks().forEach(t=>t.stop());
                const reader=new FileReader();const result=new Promise(resolve=>reader.onload=()=>resolve(reader.result));
                reader.readAsDataURL(new Blob(chunks));return result;
            })()`);
            await writeFile('docs/media/playback-demo.webm', Buffer.from(movie.split(',')[1], 'base64'));
        }
        console.log('Detection, launch, playback, seek, close and native restoration passed.');
        const manager = await page('edge://extensions/');
        await evaluate(manager, `chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(new URL(base).host)},incognitoAccess:true})`);
        await until(async () => (await targets()).find(t => t.type === 'service_worker' && t.url === base + '/background/engine.js'), 'worker after access change');
        controls = await page(base + '/popup/popup.html');
        library = await page(base + '/popup/library.html');
        await until(() => evaluate(controls, 'chrome.extension.isAllowedIncognitoAccess()'), 'private extension permission');
        const privateWindow = await evaluate(controls, `chrome.windows.create({incognito:true,url:${JSON.stringify(site + '/private')}}).then(w=>({id:w.id,tab:w.tabs[0].id}))`);
        const privateStream = await until(async () => (await send({action:'GET_STREAMS',tabId:privateWindow.tab})).streams[0], 'private stream detection');
        assert.equal((await send({action:'LAUNCH_PLAYER',tabId:privateWindow.tab,streamId:privateStream.id})).ok,true);
        const privateFrame = await until(async () => (await targets()).find(t=>t.url.startsWith(base + '/player/player.html?session=')), 'private player');
        const privatePlayer = await attach(privateFrame.targetId);
        await until(() => evaluate(privatePlayer, media + '?.readyState >= 2'), 'private player ready');
        await evaluate(privatePlayer, shadow + '.querySelector(".btn-studio").click()');
        await evaluate(privatePlayer, shadow + '.querySelector("#st-tab-tools").click()');
        await evaluate(privatePlayer, shadow + '.querySelector("#tl-bm").click()');
        assert.equal(await evaluate(privatePlayer, `(async()=>{
            await VelostreamLocal.save({id:'only-private',name:'private.mp4',time:3});
            return (await VelostreamLocal.get('only-private')).time===3;
        })()`), true);
        const privateExport = await evaluate(privatePlayer, `new Promise((resolve,reject)=>{
            const params=new URLSearchParams(location.search);
            const port=chrome.runtime.connect({name:'velostream-player'});
            let received=0;
            port.onMessage.addListener(m=>{
                if(m.type==='INIT') port.postMessage({type:'REQUEST',reqId:'cache',kind:'segment',url:m.stream.url,zeroCopy:true});
                if(m.type==='RESPONSE' && m.reqId==='cache') {
                    if(!m.ok || m.inCache || !m.data) { reject(Error('Private segment was not returned inline')); return; }
                    port.postMessage({type:'EXPORT_START',title:'private-export-fixture'});
                }
                if(m.type==='EXPORT_CHUNK') {
                    received+=VelostreamShared.unpackBinary(m.data).byteLength;
                    port.postMessage({type:'EXPORT_ACK',jobId:m.jobId,sequence:m.sequence});
                }
                if(m.type==='EXPORT_COMPLETE') resolve(received);
                if(m.type==='EXPORT_ERROR' || m.type==='FATAL') reject(Error(m.error));
            });
            port.postMessage({type:'HELLO',sessionId:params.get('session'),streamId:params.get('stream')});
        })`);
        assert.equal(privateExport,video.length);
        const diskState = await evaluate(library, `(async()=>{
            const {openDB}=await import('../background/buffer-manager.js');
            const db=await openDB();
            const rows=await new Promise((resolve,reject)=>{
                const req=db.transaction('meta').objectStore('meta').index('byTab').count(${privateWindow.tab});
                req.onsuccess=()=>resolve(req.result);
                req.onerror=()=>reject(req.error);
            });
            const {downloadStore}=await import('../background/download-store.js');
            return {rows,jobs:(await downloadStore.listSummaries()).map(j=>j.id)};
        })()`);
        assert.deepEqual(diskState,{rows:0,jobs:['fixture']});
        await evaluate(controls, `chrome.windows.remove(${privateWindow.id})`);
        const privateKeys = await evaluate(library, `(async()=>{
            const all=await chrome.storage.local.get(null);
            return {bookmarks:Object.keys(all).filter(k=>k.startsWith('fs_bm_')).sort(),
                privateFile:!!(await VelostreamLocal.get('only-private')),
                privateHistory:Object.values(all.fs_history).some(v=>v.page?.endsWith('/private'))};
        })()`);
        assert.deepEqual(privateKeys,{bookmarks:['fs_bm_foundation'],privateFile:false,privateHistory:false});
        console.log('Private cache and export delivered fixture bytes without persistent rows. Bookmarks, local records and history stayed isolated.');
    });
} finally {
    server.closeAllConnections();
    server.close();
    await rm(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
