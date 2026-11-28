/** Read an untrusted response incrementally, including responses without Content-Length. */
globalThis.AethvyrReadLimitedBody = async function readLimitedBody(response, limit) {
    if (!response.body) return new ArrayBuffer(0);
    const reader = response.body.getReader();
    const parts = [];
    let bytes = 0;
    try {
        if (Number(response.headers.get('content-length')) > limit) throw Error('Media response exceeds the export chunk limit.');
        for (;;) {
            const {done,value} = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > limit) throw Error('Media response exceeds the export chunk limit.');
            parts.push(value);
        }
        const result = new Uint8Array(bytes);
        let offset = 0;
        for (const part of parts) { result.set(part,offset); offset += part.byteLength; }
        return result.buffer;
    } catch (error) {
        await reader.cancel().catch(()=>{});
        throw error;
    } finally { reader.releaseLock(); }
};
