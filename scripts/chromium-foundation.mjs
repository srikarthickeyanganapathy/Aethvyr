import { verifyLibrary } from './browser-library.mjs';
// Run from the repository root with Node 22+, Python 3 and a Chromium browser.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
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
const server = createServer(async (req, res) => {
    if (req.url.startsWith('/phase3/')) {
        const name = req.url.slice('/phase3/'.length);
        console.log('Fixture read', name, 'credential present:', !!req.headers.authorization);
        const parts = ['s0.m4s','s1.m4s','s2.m4s'];
        if (name === 'index.m3u8' || name === 'index.mpd') {
            if (req.headers.authorization !== 'Bearer local-fixture') return res.writeHead(401).end();
            if (name.endsWith('.m3u8')) return res.writeHead(200, {'Content-Type':'application/vnd.apple.mpegurl'}).end(
                '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI="init.mp4"\n' +
                parts.map(part => '#EXTINF:4,\n' + part + '\n').join('') + '#EXT-X-ENDLIST\n');
            return res.writeHead(200, {'Content-Type':'application/dash+xml'}).end(
                '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S" minBufferTime="PT1S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" codecs="avc1.42c00a" width="64" height="48" bandwidth="20000"><SegmentList duration="4"><Initialization sourceURL="init.mp4"/>' +
                parts.map(part => '<SegmentURL media="' + part + '"/>').join('') + '</SegmentList></Representation></AdaptationSet></Period></MPD>');
        }
        // The Authorization header belongs to the playlist only.
        if (req.headers.authorization) return res.writeHead(403).end();
        const index = ['init.mp4', ...parts].indexOf(name);
        if (index < 0) return res.writeHead(404).end();
        const offsets = [0, 788, 10748, 21033, 30959];
        return res.writeHead(200, {'Content-Type':'video/mp4'}).end(video.subarray(offsets[index], offsets[index + 1]));
    }
    if (req.url.endsWith('.mp4')) {
        if (req.url.startsWith('/slow')) await delay(1200);
        const start = Number(/^bytes=(\d+)-/.exec(req.headers.range)?.[1] || 0);
        if (start >= video.length) { res.writeHead(416).end(); return; }
        const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': video.length - start };
        if (req.headers.range) headers['Content-Range'] = `bytes ${start}-${video.length - 1}/${video.length}`;
        headers['Cache-Control'] = 'public, max-age=600';
        mediaBytes += video.length - start;
        res.writeHead(req.headers.range ? 206 : 200, headers).end(video.subarray(start));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Playback test pattern</title><style>*{margin:0}video{width:100vw;height:100vh;background:black}</style><video controls loop muted autoplay src="pattern.mp4"></video><a href="/episode/next">Next episode</a>');
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
    const child = spawn(binary, ['--headless=new', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
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
            const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, session).catch(err => { throw new Error(expression.slice(0,160), { cause: err }); });
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
            return r.result.value;
        }
        const worker = await until(async () => (await targets()).find(t => t.type === 'service_worker' && /\/background\/(engine|service-worker)\.js$/.test(t.url)), 'extension worker');
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
        await cp('dist/chrome', extension, { recursive: true, filter: src => path.basename(src) !== '_metadata' });
        await browser.call('Extensions.loadUnpacked', {path:extension});
    });
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
        if (process.argv.includes('--organizer')) await verifyLibrary({browser,library,site,until,screenshot});
        if (process.argv.includes('--library')) {
            await verifyLibrary({browser,library,site,until,screenshot});
            await browser.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:work});
            await evaluate(library,`(async()=>{
                const {downloadStore}=await import('../background/download-store.js');
                for (const id of ['phase4-job','phase4-second']) await downloadStore.save({id,base:id,tabId:1,stream:{id:'fixture',type:'progressive',url:${JSON.stringify(site+'/slow.mp4')}},parts:[],status:'paused',bytes:0,completedCount:0});
            })()`);
            await evaluate(library,"location.reload()");
            await until(()=>evaluate(library,`!!document.querySelector('[data-device-open="phase4-job"]')`),'vault job');
            for (const id of ['phase4-job','phase4-second']) {
                await evaluate(library,`document.querySelector('[data-batch="${id}"]').click()`);
            }
            await evaluate(library,'document.querySelector("[data-batch-start]").click()');
            const batchTab = await until(async()=>(await targets()).find(t=>t.url.includes('mode=offline&id=phase4-job')),'selected export queue');
            const vaultPage = await attach(batchTab.targetId);
            await until(()=>evaluate(vaultPage,'!!document.querySelector("[data-resume]")'),'standalone Vault export');
            await evaluate(vaultPage,'document.querySelector("[data-resume]").click()');
            await until(()=>evaluate(vaultPage,'document.querySelector("[data-pause]").disabled === false'),'active transfer');
            await evaluate(vaultPage,'document.querySelector("[data-pause]").click()');
            await until(()=>evaluate(vaultPage,'!document.querySelector("[data-resume]").disabled'),'paused transfer');
            await evaluate(vaultPage,'document.querySelector("[data-resume]").click()');
            await until(()=>evaluate(vaultPage,"location.search.includes('id=phase4-second')"),'second selected export started');
            await until(()=>evaluate(vaultPage,'document.querySelector("[role=status]")?.textContent.includes("Saved")'),'saved export');
            const savedFile = await until(async()=>{
                const matches = [];
                for (const entry of await readdir(work,{withFileTypes:true})) {
                    if (entry.isFile() && !entry.name.endsWith('.crdownload')) {
                        const bytes = await readFile(path.join(work,entry.name));
                        if (bytes.equals(video)) matches.push(entry.name);
                    }
                }
                return matches.length === 2 ? matches : null;
            },'two matching downloaded MP4 files');
            console.log('Verified completed fixture output',savedFile);
            await until(()=>evaluate(library,`import('../background/download-store.js').then(async m=>(await m.downloadStore.get('phase4-second')).savedAt>0)`),'confirmed output history');
            library = await page(base+'/popup/library.html#offline');
            await evaluate(library,`import('../background/download-store.js').then(async m=>{await m.downloadStore.remove('phase4-job');await m.downloadStore.remove('phase4-second')})`);
            console.log('Vault batch paused and resumed, then automatically exported the second selected job. Both downloaded MP4 files matched the fixture byte for byte.');
        }
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
        if (process.argv.includes('--experience')) {
            await until(()=>evaluate(controls,'document.querySelector("#restore-field").options.length'), 'settings initialized');
            await evaluate(controls,`document.querySelector('[data-panel="settings-panel"]').click();
                const search=document.querySelector('#settings-search');search.value='rewind';search.dispatchEvent(new Event('input'));`);
            assert.deepEqual(await evaluate(controls,"[...document.querySelectorAll('fieldset:not([hidden]) legend')].map(e=>e.textContent)"), ['Engine']);
            await send({action:'SETTINGS_PATCH',patch:{gestures:{enabled:false},seekStep:15}});
            await evaluate(controls,"document.querySelector('#restore-field').value='gestures.enabled';document.querySelector('#restore-default').click()");
            await until(()=>evaluate(controls,"chrome.storage.local.get('fs_settings').then(r=>r.fs_settings?.gestures.enabled && r.fs_settings.seekStep===15)"), 'single setting reset');
        }
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
        const cinema = action => evaluate(worker, `chrome.tabs.sendMessage(${tabId},{action:${JSON.stringify(action)}},{frameId:0})`);
        assert.equal((await cinema('CINEMA_TOGGLE')).active, true);
        const shade = await evaluate(worker, `chrome.tabs.sendMessage(${tabId},{action:'CINEMA_SHADE',shade:'black'},{frameId:0})`);
        assert.equal(shade.shade, 'black');
        await evaluate(watch, "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
        assert.equal((await cinema('CINEMA_STATE')).active, false);
        const help = await evaluate(controls, 'document.querySelector("#empty-state a").href');
        const helpPage = await page(help);
        assert.equal(await evaluate(helpPage, 'document.activeElement.id'), 'guide-start');
        await call('Page.bringToFront', {}, watch);
        const nativeMessage = message => evaluate(worker, `chrome.tabs.sendMessage(${tabId},${JSON.stringify(message)},{frameId:0})`);
        const original = await evaluate(watch, '[document.querySelector("video").playbackRate, document.querySelector("video").style.filter]');
        assert.ok((await nativeMessage({action:'NATIVE_MODE', mode:'light'})).ok);
        await evaluate(watch, "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:']',bubbles:true}))");
        assert.equal(await evaluate(watch, 'document.querySelector("video").playbackRate'), original[0]+0.25);
        assert.ok((await nativeMessage({action:'NATIVE_CONTROL',command:'toggle'})).ok);
        assert.equal(await evaluate(watch, 'document.querySelector("video").paused'), true);
        assert.ok((await nativeMessage({action:'NATIVE_CONTROL',command:'toggle'})).ok);
        assert.ok((await nativeMessage({action:'NATIVE_MODE', mode:'enhance'})).ok);
        assert.match(await evaluate(watch, 'document.querySelector("video").style.filter'), /contrast/);
        assert.ok((await nativeMessage({action:'NATIVE_MODE', mode:'original'})).ok);
        assert.deepEqual(await evaluate(watch, '[document.querySelector("video").playbackRate,document.querySelector("video").style.filter]'), original);
        console.log('Lightweight shortcuts, native controls, enhancement and restoration passed.');
        console.log('Cinema toggle, Escape restoration and playback help focus passed.');
        const stream = await until(async () => (await send({ action: 'GET_STREAMS', tabId })).streams.find(s=>s.url.endsWith('pattern.mp4')), 'stream detection');
        assert.equal((await send({ action: 'LAUNCH_PLAYER', tabId, streamId: stream.id })).ok, true);
        const frame = await until(async () => (await targets()).find(t=>t.url.startsWith(base + '/player/player.html?session=')), 'mounted player');
        const player = await attach(frame.targetId);
        const shadow = 'document.getElementById("velostream-host")?.shadowRoot';
        if (process.argv.includes('--audio')) {
            console.log('Offline audio measurements', await evaluate(player, `(async()=>{
                const {AudioFx,AUDIO_PRESETS}=await import('./audio-fx.js');
                const results=[];
                for (const preset of ['normal','cinema','voice','night','music','bass','custom']) {
                    const ctx=new OfflineAudioContext(2,48000,48000);
                    const source=ctx.createBufferSource();
                    const buffer=ctx.createBuffer(2,48000,48000);
                    for(let i=4800;i<48000;i++) buffer.getChannelData(0)[i]=0.9*Math.sin(i*Math.PI/24);
                    source.buffer=buffer;
                    ctx.createMediaElementSource=()=>source;
                    const fx=new AudioFx({currentSrc:'blob:fixture'},function(){return ctx;});
                    if(!fx.ensure() || !fx.ensure()) throw Error('Audio graph initialization');
                    const settings={...VelostreamShared.DEFAULT_SETTINGS.audio};
                    fx.apply({...settings,preset:'voice',crossfeed:true});
                    fx.apply({...settings,preset,channels:'left',boost:preset==='normal'?100:300,delayMs:50});
                    source.start();
                    const rendered=await ctx.startRendering();
                    const left=rendered.getChannelData(0),right=rendered.getChannelData(1);
                    let peak=0,first=-1;
                    for(let i=0;i<left.length;i++){
                        if(left[i]!==right[i]) throw Error('Channel isolation mismatch');
                        peak=Math.max(peak,Math.abs(left[i]));
                        if(first<0 && Math.abs(left[i])>0.001) first=i;
                    }
                    if(!(peak>0 && peak<=1 && first>=4800)) throw Error('Audio level or timing');
                    const delayMs=first/48-100;
                    if (delayMs<48 || delayMs>66) throw Error('Unexpected processing delay '+delayMs);
                    if (preset==='normal' && Math.abs(peak-0.9)>0.01) throw Error('Flat gain changed');
                    results.push([AUDIO_PRESETS[preset].label,+peak.toFixed(3),+(first/48-100).toFixed(1)]);
                    ctx.close=async()=>{};
                    fx.destroy();
                    if(fx.active || fx.nodes) throw Error('Audio graph retained');
                }
                return results;
            })()`));
        }
        const media = shadow + '?.querySelector("video")';
        await until(() => evaluate(player, media + '?.readyState >= 2'), 'extension playback');
        await evaluate(player, media + '.play()');
        await until(() => evaluate(player, media + '.currentTime > 0.1'), 'extension time advances');
        if (process.argv.includes('--whisper')) {
            const ui = expr => evaluate(player,`(()=>{const root=${shadow};const q=s=>root.querySelector(s);return ${expr}})()`);
            const click = selector => ui('q('+JSON.stringify(selector)+').click()');
            await evaluate(player,media+'.pause()');
            await click('.btn-cc');
            await ui(`(()=>{const f=new File(['WEBVTT\\n\\n00:00:01.000 --> 00:00:02.000\\nHello world\\n\\n00:00:04.000 --> 00:00:05.000\\n<ruby>日<rt>にち</rt></ruby>'], 'lesson.vtt');const dt=new DataTransfer();dt.items.add(f);const input=q('#cc-file');input.files=dt.files;input.dispatchEvent(new Event('change'));})()`);
            await until(()=>ui('!!q("#cc-transcript")'),'transcript control');
            await click('#cc-transcript');
            await until(()=>ui('root.querySelectorAll(".tr-row").length===2'),'two parsed captions');
            await click('.study summary');
            await click('.tr-row[data-i="0"]');
            await click('[data-study="next"]');
            await until(()=>evaluate(player,media+'.currentTime >= 4'),'next line');
            assert.match(await ui(`q('.tr-row[data-i="1"]').textContent`),/にち/);
            await click('[data-study="previous"]');
            await click('[data-study="sentence"]');
            await until(()=>evaluate(player,media+'.paused && '+media+'.currentTime >= 2'),'sentence auto-pause');
            await ui(`q('[data-field="boundary"]').value='Repeat'`);
            await click('[data-study="sentence"]');
            await delay(1600);
            assert.ok(await evaluate(player,media+'.currentTime < 2.1 && !'+media+'.paused'),'sentence repeated');
            await click('[data-study="stop"]');
            await evaluate(player,media+'.pause()');
            await click('[data-study="bookmark"]');
            await ui(`q('[data-field="term"]').value='Hello'`);
            await click('[data-study="save"]');
            await until(()=>ui('q(".study output").textContent.includes("Saved Hello")'),'word saved');
            await browser.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:work});
            await click('[data-study="export"]');
            await until(()=>ui('q(".study output").textContent.includes("Exported 1")'),'flashcard download');
            let verified=false;
            for (const f of await readdir(work,{withFileTypes:true})) if(f.isFile() && (await readFile(path.join(work,f.name),'utf8')).includes('Hello\tHello world\ten')) verified=true;
            assert.ok(verified,'flashcard content');
            for(const op of ['translate','speech']){
                await click('[data-study="'+op+'"]');
                await until(()=>ui('q(".study output").textContent !== "Exported 1 flashcards."'),'capability feedback');
                await delay(300);
                console.log(op,await ui('q(".study output").textContent'));
            }
            await screenshot(browser,watch,'phase5-whisper.png');
            // Deterministic provider responses exercise success paths independently of installed packs.
            await ui(`(()=>{window.testProviderClosed=false; Object.defineProperty(window,'Translator',{configurable:true,value:{
                availability:async()=>'available',create:async()=>({translate:async text=>'translated '+text,destroy:()=>{window.testProviderClosed=true;}})}});})()`);
            await click('[data-study="translate"]');
            await until(()=>ui('window.testProviderClosed'),'translator released');
            await click('.tr-row[data-i="0"]');
            await until(()=>ui('q(".subs-top").textContent.includes("translated Hello world")'),'timed secondary subtitles');
            await ui(`(()=>{const input=q('[data-field="color"]');input.value='#11aa55';input.dispatchEvent(new Event('input'));})()`);
            assert.equal(await ui('getComputedStyle(q(".subs-top .cue-line")).color'),'rgb(17, 170, 85)');
            await click('[data-field="hide"]');
            assert.equal(await ui('getComputedStyle(q(".subs:not(.subs-top)")).visibility'),'hidden');
            await click('[data-field="hide"]');
            await ui(`(()=>{class LocalSpeech {
                static available(){return Promise.resolve('available');}
                get processLocally(){return this.local;}
                set processLocally(v){this.local=v;}
                start(track){if(!this.local || track.kind!=='audio')throw Error('Local audio track required');window.testSpeech=this;}
                abort(){window.testSpeech=null;}
            }
            Object.defineProperty(window,'SpeechRecognition',{configurable:true,value:LocalSpeech});
            const ctx=new AudioContext();
            const source=ctx.createMediaStreamDestination();
            q('video').captureStream=()=>source.stream;
            })()`);
            await evaluate(player,media+'.play()');
            await click('[data-study="speech"]');
            await until(()=>ui('!!window.testSpeech'),'local recognition received audio track');
            await delay(350);
            await ui(`window.testSpeech.onresult({resultIndex:0,results:[{isFinal:true,0:{transcript:'Local recognition fixture'}}]})`);
            await until(()=>ui('q(".tr-list").textContent.includes("Local recognition fixture")'),'final transcription inserted');
            await click('[data-study="stop"]');
            assert.equal(await ui('window.testSpeech'),null);
            console.log('Controlled provider responses verified dual subtitle timing and styling, local track capture, cue insertion and stop.');
            await click('.tr-close');
            await evaluate(player,media+'.play()');
            console.log('Whisper UI verified file import, ruby reading, sentence controls, bookmarking and downloaded TSV contents.');
        }
        const center = await send({ action:'PLAYBACK_SESSIONS', privateContext:false });
        assert.ok(center.sessions.some(s=>s.tabId===tabId));
        for (const paused of [true,false]) {
            assert.ok((await send({action:'PLAYER_CONTROL',tabId,command:'toggle',privateContext:false})).ok);
            await until(()=>evaluate(player, media + '.paused === ' + paused), 'remote play/pause');
        }
        console.log('Full-player session selection and remote play/pause passed.');
        if (process.argv.includes('--library')) {
            await evaluate(player, '(' + media + ').currentTime = '+ media + '.duration - 0.2');
            await until(()=>evaluate(player,shadow+'.querySelector(".next-offer")?.textContent.includes("Episode 2")'),'queue end-of-playback offer');
            await screenshot(browser,watch,'phase4-up-next.png');
            await evaluate(player,shadow+'.querySelector(".next-offer button:last-child").click()');
            assert.equal(await evaluate(player,shadow+'.querySelector(".next-offer")'),null);
            await evaluate(player,'('+media+').currentTime = 0');
            await evaluate(player,media+'.play()');
            // Remove the queued fixtures through the Library UI, leaving the page adapter to offer the next link.
            await evaluate(library,"location.hash='queue'");
            for (const key of ['fixture-ep2','fixture-ep1']) {
                const selector = '[data-action="queue-remove"][data-key="'+key+'"]';
                await until(()=>evaluate(library,'!!document.querySelector('+JSON.stringify(selector)+')'),'remove queue fixture');
                await evaluate(library,'document.querySelector('+JSON.stringify(selector)+').click()');
            }
            await until(()=>evaluate(library,'!document.querySelector("[data-action=queue-remove]")'),'empty queue');
            await evaluate(watch,"document.querySelector('a[href=\"/episode/next\"]').style.cssText='position:fixed;top:0;left:0'");
            await call('Page.bringToFront',{},watch);
            await evaluate(player,'('+media+').currentTime = '+media+'.duration - 0.2');
            await until(()=>evaluate(player,shadow+'.querySelector(".next-offer")?.textContent.includes("Next episode")'),'page link confirmation');
            await evaluate(player,shadow+'.querySelector(".next-offer button").click()');
            await until(async()=>(await targets()).some(t=>t.url===site+'/episode/next'),'explicit next episode navigation');
            const opened = (await targets()).find(t=>t.url===site+'/episode/next');
            await call('Target.closeTarget',{targetId:opened.targetId});
            await call('Page.bringToFront',{},watch);
            await evaluate(player,'('+media+').currentTime = 0');
            await evaluate(player,media+'.play()');
            await until(()=>evaluate(player, media+'.currentTime >= 4 && !'+media+'.paused'),'four seconds of continuous playback');
            await evaluate(player, media+'.pause()');
            await delay(1500);
            console.log('Playback sample',await evaluate(library,"chrome.storage.local.get('fs_watch_stats')"),'seconds counted on device');
            await evaluate(player, media+'.play()');
            console.log('Explicit next-episode link opened only after Play next was clicked.');
            console.log('Phase 4 playback UI: real media end displayed queued episode, Cancel dismissed the offer and playback resumed.');
        }
        if (process.argv.includes('--benchmark') || process.argv.includes('--vision')) {
            console.log('Aethvyr warm seeks', JSON.stringify(await benchmarkVideo(evaluate, player, media)));
            if (process.argv.includes('--vision')) console.log('Vision samples', await evaluate(player, `(async()=>{
                const video=${media}, canvas=document.createElement('canvas');
                const pipeline=new VelostreamShaders.VideoShaderPipeline(video,canvas);
                const samples=[];
                try {
                    video.pause();
                    for (const height of [720,2160]) {
                        pipeline.layout(height*16/9,height,'contain');
                        const reference=document.createElement('canvas');
                        reference.height=height;reference.width=Math.round(height*video.videoWidth/video.videoHeight);
                        const ctx=reference.getContext('2d');
                        ctx.drawImage(video,0,0,reference.width,height);
                        const native=ctx.getImageData(0,0,reference.width,height).data;
                        for (const strength of [15,75]) {
                            if (!pipeline.configure({preset:'cas',strength,maxRenderRes:height})) throw Error('CAS unavailable');
                            const gl=pipeline.gl;
                            gl.finish();
                            const start=performance.now();
                            const pixel=new Uint8Array(4);
                            for(let i=0;i<4;i++) {
                                pipeline.renderOnce();
                                gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
                            }
                            gl.finish();
                            const elapsed=(performance.now()-start)/4;
                            const bytes=new Uint8Array(canvas.width*canvas.height*4);
                            gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
                            const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).slice(0,8).join('.');
                            let difference=0;
                            for(let y=0;y<height;y+=8) for(let x=0;x<canvas.width;x+=8) {
                                const a=(y*canvas.width+x)*4, b=((height-1-y)*canvas.width+x)*4;
                                difference+=Math.abs(native[a]-bytes[b]);
                            }
                            samples.push({height:canvas.height,strength,ms:elapsed,hash,outputBytes:bytes.length,
                                meanRedDelta:difference/(Math.ceil(height/8)*Math.ceil(canvas.width/8))});
                        }
                    }
                    if(samples[0].hash===samples[1].hash) throw Error('Strength did not affect output');
                    return samples;
                } finally {pipeline.destroy(); await video.play();}
            })()`));
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
        if (process.argv.includes('--experience')) {
            await call('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]}, player);
            assert.equal(await evaluate(player, shadow + '.querySelector(".btn-fs").ownerDocument.defaultView.matchMedia("(prefers-reduced-motion: reduce)").matches'), true);
            assert.equal(await evaluate(player, 'getComputedStyle(' + shadow + '.querySelector(".btn-fs")).transitionDuration'), '0s');
            for (const [width,height,mobile] of [[390,844,true],[320,240,false]]) {
                await call('Emulation.setDeviceMetricsOverride', {width,height,mobile,deviceScaleFactor:1}, watch);
                await delay(250);
                assert.equal(await evaluate(player, shadow + '.querySelector(".btn-fs").getBoundingClientRect().width > 0'), true);
            }
            await screenshot(browser, watch, 'phase5-small-player.png');
            await call('Emulation.setDeviceMetricsOverride', {width:1280,height:800,mobile:false,deviceScaleFactor:1}, watch);
            await evaluate(player, shadow + '.querySelector(".btn-fs").click()');
            await until(()=>evaluate(player,'!!document.fullscreenElement'), 'fullscreen entry');
            await evaluate(player,'document.exitFullscreen()');
        }
        if (capture) demo.push(await screenshot(browser, watch));
        await evaluate(player, shadow + '.querySelector(".btn-studio").click()');
        if (process.argv.includes('--experience')) {
            await delay(350);
            const before = await evaluate(player, shadow + '.querySelector("[role=tab][aria-selected=true]").id');
            await evaluate(player, shadow + '.querySelector("[role=tab][aria-selected=true]").focus()');
            await call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight'},watch);
            await call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight'},watch);
            await until(()=>evaluate(player, shadow + '.activeElement?.matches("[role=tab][aria-selected=true]") && ' + shadow + '.activeElement.id !== ' + JSON.stringify(before)), 'keyboard Studio tab navigation');
            await screenshot(browser, watch, 'phase5-studio.png');
        }
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
        if (process.argv.includes('--library')) {
            await call('Page.bringToFront',{},library);
            await evaluate(library,"location.hash='statistics'");
            await until(()=>evaluate(library,"chrome.storage.local.get('fs_watch_stats').then(r=>r.fs_watch_stats?.seconds>0)"),'measured playback statistics');
            await evaluate(library,'document.querySelector("[data-action=stats-toggle]").click()');
            await until(()=>evaluate(library,'document.querySelector("#result-count").textContent==="Off"'),'disabled statistics');
            await evaluate(library,'document.querySelector("[data-action=stats-clear]").click()');
            await evaluate(library,'document.querySelector("#dialog-ok").click()');
            await until(()=>evaluate(library,"chrome.storage.local.get('fs_watch_stats').then(r=>!r.fs_watch_stats)"),'erased statistics');
            console.log('Statistics recorded actual playback, then disabled and deleted through the Library UI.');
        }
        console.log('Detection, launch, playback, seek, close and native restoration passed.');
        if (process.argv.includes('--vault')) {
            await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:work});
            for (const type of ['hls','dash']) {
                const name='vault-'+type;
                const parts=[{name,role:'main',...(type==='dash'?{ext:'mp4',mime:'video/mp4'}:{}),
                    segs:[0,1,2].map(i=>({uri:site+'/phase3/s'+i+'.m4s',start:i*4,duration:4,map:{uri:site+'/phase3/init.mp4'}}))}];
                const job={id:name,base:name,stream:{id:name,type,url:site+'/phase3/'+(type==='hls'?'index.m3u8':'index.mpd')},
                    parts,tabId:0,totalSegments:3,status:'paused',bytes:0,completedCount:0};
                await evaluate(library,`import('../background/download-store.js').then(m=>m.downloadStore.save(${JSON.stringify(job)}))`);
                const vault=await page(base+'/player/player.html?mode=offline&id='+name);
                const previous=new Set(await readdir(work));
                await evaluate(vault,'document.querySelector("[data-resume]").click()');
                    const file = await until(async()=> (await readdir(work,{withFileTypes:true})).find(f=>f.isFile()&&!previous.has(f.name)&&!f.name.endsWith('.crdownload'))?.name,name+' export');
                    const bytes = await readFile(path.join(work,file));
                    const result = await evaluate(library,`(async()=>{
                        const blob=new Blob([Uint8Array.from(atob('${bytes.toString('base64')}'),c=>c.charCodeAt(0))],{type:'video/mp4'});
                        const url=URL.createObjectURL(blob);
                        const video=document.createElement('video');
                        video.muted=true;video.src=url;
                        try {await video.play();video.currentTime=8;await new Promise(r=>video.addEventListener('seeked',r,{once:true}));return video.duration;}
                        finally {video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
                    })()`);
                    assert.ok(result>=12);
                    console.log(name,'export decoded and sought to 8 seconds',bytes.length,'bytes');
            }
        }
        if (process.argv.includes('--security')) {
            for (const name of ['index.m3u8', 'index.mpd']) {
                const url = site + '/phase3/' + name;
                assert.equal(await evaluate(watch, `fetch(${JSON.stringify(url)}, {headers:{Authorization:'Bearer local-fixture'}}).then(r=>r.status)`), 200);
                const item = await until(async () => (await send({action:'GET_STREAMS',tabId})).streams.find(s => s.url === url), name);
                assert.equal((await send({action:'LAUNCH_PLAYER',tabId,streamId:item.id})).ok, true);
                const target = await until(async () => (await targets()).find(t => t.url.startsWith(base+'/player/player.html?session=')), 'media iframe');
                const active = await attach(target.targetId);
                await until(() => evaluate(active, media + '?.readyState >= 2'), name + ' decode');
                await evaluate(active, media + '.play()');
                await until(() => evaluate(active, media + '.currentTime > 0.2'), name + ' playing');
                assert.equal((await send({action:'CLOSE_PLAYER',tabId})).ok, true);
                await until(() => evaluate(watch, '!document.querySelector("iframe")'), 'media iframe closed');
                console.log(name, 'played with exact-resource fixture authorization');
            }
        }
        const manager = await page('edge://extensions/');
        await evaluate(manager, `chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(new URL(base).host)},incognitoAccess:true})`);
        await until(async () => (await targets()).find(t => t.type === 'service_worker' && t.url === base + '/background/engine.js'), 'worker after access change');
        controls = await page(base + '/popup/popup.html');
        library = await page(base + '/popup/library.html');
        await until(() => evaluate(controls, 'chrome.extension.isAllowedIncognitoAccess()'), 'private extension permission');
        const regularBookmarks = await evaluate(library,"chrome.storage.local.get(null).then(r=>Object.keys(r).filter(k=>k.startsWith('fs_bm_')).sort())");
        assert.ok(regularBookmarks.includes('fs_bm_foundation'));
        if (process.argv.includes('--whisper')) assert.equal(regularBookmarks.length,2,'sentence bookmark persisted');
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
        assert.deepEqual(privateKeys,{bookmarks:regularBookmarks,privateFile:false,privateHistory:false});
        console.log('Private cache and export delivered fixture bytes without persistent rows. Bookmarks, local records and history stayed isolated.');
    });
} finally {
    server.closeAllConnections();
    server.close();
    await rm(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
