import test from 'node:test';
import assert from 'node:assert/strict';
import '../content/episode-adapters.js';

const resolve = (links,explicit=true) => globalThis.AethvyrEpisodes.findNext({
    querySelectorAll:()=>links.map(raw=>({textContent:'Next episode',getAttribute:()=>raw}))
},'https://source.test/ep/1',[{selector:'a',explicit}]);

test('episode adapters skip unsafe, self and malformed candidates and preserve publisher URLs',()=>{
    const next=resolve(['#comments','javascript:void(0)','http://[','https://user@source.test/next','../ep/1','./2']);
    assert.equal(next.url,'https://source.test/ep/2');
    assert.equal(next.certain,true);
    assert.equal(resolve(['https://other.test/episode']).certain,false);
    assert.equal(resolve(['./2'],false).certain,false);
    assert.equal(resolve([]),null);
});
