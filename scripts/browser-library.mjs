import assert from 'node:assert/strict';

export async function verifyLibrary({browser, library, site, until, screenshot}) {
    const {evaluate,call} = browser;
    await call('Page.bringToFront',{},library);
    const click = async selector => {
        await until(()=>evaluate(library,'!!document.querySelector('+JSON.stringify(selector)+')'),selector);
        await evaluate(library,'document.querySelector('+JSON.stringify(selector)+').click()');
    };
    const has = text => until(()=>evaluate(library,'document.querySelector("#view").innerText.includes('+JSON.stringify(text)+')'),text);
    const fixture = Object.fromEntries([1,2,3].map(n=>['fixture-ep'+n,{
        title:'Observatory · Episode '+n,page:site+'/episode/'+n,url:site+'/pattern.mp4',t:n,d:12,updatedAt:Date.now()+n,
        pageMeta:{kind:'series',showTitle:'Observatory',season:1,episode:n,seriesIdentity:'https://example.test/series/observatory'}
    }]));
    await evaluate(library,`(async()=>{const s=await chrome.storage.local.get('fs_history');await chrome.storage.local.set({fs_history:{...s.fs_history,...${JSON.stringify(fixture)}}});})()`);
    await click('[data-view="recent"]');
    for (const n of [1,2,3]) await click('[data-action="queue-add"][data-key="fixture-ep'+n+'"]');
    await click('[data-view="queue"]');
    await has('Observatory · Episode 3');
    await click('[data-action="queue-up"][data-key="fixture-ep2"]');
    await until(()=>evaluate(library,'document.querySelector("#view ol li strong").textContent.endsWith("2")'),'queue reordered');
    await click('[data-action="queue-remove"][data-key="fixture-ep3"]');
    await click('[data-action="queue-repeat"]');
    await has('Repeat: on');
    await click('[data-action="queue-clear"]');
    await until(()=>evaluate(library,'!document.querySelector("#view ol")'),'empty queue');
    await click('[data-action="queue-restore"]');
    await has('Observatory · Episode 2');
    await call('Page.reload',{},library);
    await has('Repeat: on');
    assert.deepEqual(await evaluate(library,'[...document.querySelectorAll("#view ol strong")].map(e=>e.textContent)'),['Observatory · Episode 2','Observatory · Episode 1']);
    await screenshot(browser,library,'phase4-queue.png');
    await click('[data-view="series"]');
    await has('Observatory');
    await click('#view details summary');
    await has('Ep 3');
    await evaluate(library,`const edit=document.querySelector('form[data-episode-edit="fixture-ep3"]');
        edit.elements.season.value=0;edit.elements.episode.value=0.5;edit.requestSubmit();`);
    await has('Specials');
    await has('Ep 0.5');
    await evaluate(library,`const edit2=document.querySelector('form[data-episode-edit="fixture-ep2"]');
        edit2.elements.episode.value=1;edit2.requestSubmit();`);
    await has('Episodes (2)');
    await click('#list-layout');
    assert.equal(await evaluate(library,'document.body.classList.contains("library-list")'),true);
    await click('[data-view="statistics"]');
    await click('[data-action="stats-toggle"]');
    await has('Disable statistics');
    await click('[data-view="offline"]');
    await click('[data-batch="fixture"]');
    await has('Export selected (1)');
    await screenshot(browser,library,'phase4-vault.png');
    console.log('Phase 4 Library UI: added three episodes, reordered and removed entries, restored queue and repeat after reload, opened episode list, changed layout, enabled statistics and selected a Vault job.');
}
