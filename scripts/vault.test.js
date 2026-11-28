import test from 'node:test';
import assert from 'node:assert/strict';
import '../common/limited-body.js';
import {VAULT_LIMIT,hasVaultSpace} from '../background/download-store.js';

test('Vault refuses an over-budget checkpoint without excluding the exact boundary',()=>{
    assert.equal(hasVaultSpace(VAULT_LIMIT-4,4),true);
    assert.equal(hasVaultSpace(VAULT_LIMIT-4,5),false);
    assert.equal(hasVaultSpace(VAULT_LIMIT+1,1),false);
});

test('unadvertised oversized bodies are cancelled before assembly',async()=>{
    let cancelled=false;
    const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(32));},cancel(){cancelled=true;}});
    await assert.rejects(globalThis.AethvyrReadLimitedBody(new Response(stream),40),/limit/);
    assert.equal(cancelled,true);
    assert.deepEqual(new Uint8Array(await globalThis.AethvyrReadLimitedBody(new Response(Uint8Array.of(3,4)),2)),Uint8Array.of(3,4));
});
