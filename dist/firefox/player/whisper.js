/* Study controls for the player transcript. All model operations require a user click. */
(() => {
    const markup = `<details class="study"><summary>Whisper · Language learning</summary>
        <div class="study-controls">
        <button data-study="previous">Previous line</button><button data-study="next">Next line</button>
        <button data-study="sentence">Play sentence</button><button data-study="bookmark">Bookmark sentence</button>
        <label>At sentence end <select data-field="boundary"><option>Pause</option><option>Repeat</option></select></label>
        <label><input type="checkbox" data-field="hide"> Hide primary subtitles</label>
        <label>Secondary text <input type="color" value="#ffffff" data-field="color"></label>
        <label>Word or phrase <input data-field="term" maxlength="160" placeholder="Select or type a word"></label>
        <button data-study="save">Save word</button><button data-study="remove">Remove saved word</button><button data-study="dictionary">Open Wiktionary</button>
        <button data-study="export">Export flashcards (.tsv)</button>
        <label>Subtitle / audio language <input data-field="from" value="en" maxlength="32"></label>
        <label>Translation language <input data-field="to" value="es" maxlength="32"></label>
        <button data-study="translate">Translate subtitle track locally</button>
        <button data-study="speech">Transcribe playback locally</button><button data-study="stop">Stop processing</button>
        <p>Uses installed browser language packs. Availability, storage size and speed vary by language and device. Review generated text for errors.</p>
        <output role="status" aria-live="polite"></output></div></details>`;
    function bind(p, download) {
        const panel = p.$('.study');
        const field = name => panel.querySelector('[data-field="'+name+'"]');
        const status = text => { panel.querySelector('output').textContent = text; };
        const api = globalThis.VelostreamShared.api;
        const privateWords = new Map();
        let sentence, recognition, stream, job;
        const cues = () => p.subs.activeCues() || [];
        const current = () => {
            const t = p.subs.cueTime(p.video.currentTime);
            return Math.max(0,cues().findLastIndex(c=>c.start<=t));
        };
        function stop() {
            job?.abort();
            job = null;
            if (recognition) { recognition.onend = recognition.onresult = recognition.onerror = null; recognition.abort(); recognition = null; }
            stream?.getTracks().forEach(track=>track.stop());
            stream = null;
        }
        p.listen(p.video,'timeupdate',()=>{
            if (!sentence || p.video.paused) return;
            if (sentence.track !== cues()) { sentence = null; return; }
            if (p.video.currentTime < p.cueMediaTime(sentence.cue.end)) return;
            if (field('boundary').value === 'Repeat') p.seekTo(p.cueMediaTime(sentence.cue.start),false);
            else { sentence = null; p.video.pause(); }
        });
        p.listen(p.video,'seeking',()=>{ if (recognition) { stop(); status('Transcription stopped after seeking.'); } });
        p.listen(p.video,'pause',()=>{ if (recognition) { stop(); status('Transcription stopped when playback paused.'); } });
        p.listen(p.video,'emptied',()=>{ sentence = null; stop(); });
        p.listen(field('hide'),'change',()=>{ p.subs.layer.style.visibility = field('hide').checked?'hidden':''; });
        p.listen(field('color'),'input',()=>{ p.subs.topLayer.style.setProperty('--study-secondary',field('color').value); });
        p.listen(p.$('.tr-list'),'pointerup',()=>{
            const selected = (p.shadow.getSelection?.() || window.getSelection())?.toString().trim();
            if (selected) field('term').value = selected.slice(0,160);
        });
        const safeCell = value => String(value).replace(/[\t\r\n]+/g,' ').replace(/^[=+@-]/,"'$&");
        async function act(action) {
            const track = cues();
            const idx = current();
            const cue = track[idx];
            const term = field('term').value.trim();
            const lang = field('from').value.trim();
            if (action === 'stop') { stop(); sentence = null; return status('Stopped.'); }
            if (action === 'dictionary') {
                if (!term) return status('Select or enter a word first.');
                window.open('https://en.wiktionary.org/wiki/'+encodeURIComponent(term),'_blank','noopener,noreferrer');
                return;
            }
            if (action === 'save' || action === 'remove') {
                if (!term) return status('Select or enter a word first.');
                const row = [term,cue?.text || '',lang];
                const key = 'fs_whisper_word_'+JSON.stringify([lang,term]);
                if (action === 'remove') {
                    if (api.extension?.inIncognitoContext) privateWords.delete(key);
                    else await api.storage.local.remove(key);
                    return status('Removed '+term+' from saved words.');
                }
                if (api.extension?.inIncognitoContext) privateWords.set(key,row);
                else await api.storage.local.set({[key]:row});
                return status('Saved '+term+'.');
            }
            if (action === 'export') {
                const rows = api.extension?.inIncognitoContext ? [...privateWords.values()] :
                    Object.entries(await api.storage.local.get(null)).filter(([k])=>k.startsWith('fs_whisper_word_')).map(([,v])=>v);
                if (!rows.length) return status('Save a word before exporting.');
                await download(new Blob([rows.map(r=>r.map(safeCell).join('\t')).join('\n')],{type:'text/tab-separated-values'}),'aethvyr-flashcards.tsv');
                return status('Exported '+rows.length+' flashcards.');
            }
            if (action === 'speech') {
                stop();
                const R = window.SpeechRecognition || window.webkitSpeechRecognition;
                if (!R?.available || !('processLocally' in R.prototype) || !p.video.captureStream || p.video.mediaKeys)
                    return status('Local playback transcription is unavailable in this player.');
                const work = job = new AbortController();
                if (await R.available({langs:[lang],processLocally:true}) !== 'available') return status('No installed local speech pack for '+lang+'.');
                if (work.signal.aborted) return;
                stream = p.video.captureStream();
                const audio = stream.getAudioTracks()[0];
                if (p.video.paused || !audio || audio.readyState !== 'live') { stop(); return status('Play media with a capturable audio track first.'); }
                const r = recognition = new R();
                r.processLocally = true; r.lang = lang; r.continuous = true;
                let start = p.video.currentTime;
                const result = [];
                r.onresult = event => {
                    for (let i=event.resultIndex;i<event.results.length;i++) {
                        if (!event.results[i].isFinal) continue;
                        const end = p.video.currentTime;
                        if (end>start) result.push({start:p.subs.cueTime(start),end:p.subs.cueTime(end),text:event.results[i][0].transcript});
                        start=end;
                    }
                    if (result.length) {
                        p.subs.externalCues=result; p.subs.externalName='Local transcription'; p.subs.capturedIndex=null;
                        p.selectSubtitle('external'); p.renderTranscript(true);
                    }
                };
                r.onerror = e => { stop(); status('Local transcription stopped: '+e.error); };
                r.onend = () => { stop(); status('Local transcription finished.'); };
                try { r.start(audio); } catch (error) { stop(); throw error; }
                return status('Transcribing playback on this device.');
            }
            if (!cue) return status('Choose a subtitle track or load a subtitle file first.');
            if (action === 'translate') {
                stop();
                const T = window.Translator;
                if (!T?.availability) return status('Local translation is unavailable in this player.');
                const options = {sourceLanguage:lang,targetLanguage:field('to').value.trim()};
                const work = job = new AbortController();
                if (await T.availability(options) !== 'available') return status('No installed translation pack for this language pair.');
                work.signal.throwIfAborted();
                const translator = await T.create({...options,signal:work.signal});
                try {
                    const translated=[];
                    for (const c of track.slice()) {
                        work.signal.throwIfAborted();
                        if (track !== cues()) return status('Subtitle source changed.');
                        translated.push({...c,text:await translator.translate(c.text,{signal:work.signal})});
                        status('Translated '+translated.length+' of '+track.length+' lines.');
                    }
                    work.signal.throwIfAborted();
                    if (track !== cues()) return;
                    p.subs.secondaryCues=translated; p.subs.secondaryIndex=-1; p.subs.secondaryName=options.targetLanguage;
                    p.subs.render(p.video.currentTime);
                } finally { translator.destroy(); }
                return;
            }
            if (action === 'bookmark') { p.seekTo(p.cueMediaTime(cue.start),false); p.addBookmark(cue.text); return status('Bookmarked this sentence.'); }
            sentence = null;
            const index = action==='previous'?Math.max(0,idx-1):action==='next'?Math.min(track.length-1,idx+1):idx;
            p.seekTo(p.cueMediaTime(track[index].start)+0.001,false);
            if (action==='sentence') { sentence={cue,track}; await p.video.play(); }
        }
        p.listen(panel,'click',event=>{
            const button=event.target.closest('[data-study]');
            if (button) act(button.dataset.study).catch(error=>{ if (error.name!=='AbortError') status(error.message || 'Operation unavailable.'); });
        });
        return stop;
    }
    window.AethvyrWhisper = {markup,bind};
})();
