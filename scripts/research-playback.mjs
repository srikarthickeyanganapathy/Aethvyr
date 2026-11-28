/* Research fixture only. Runs on loopback and is excluded from extension builds. */
const size = 320, height = 180;
const round = x => Math.round(x * 1000) / 1000;
const median = xs => [...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
const check = (condition,message) => { if (!condition) throw Error(message); };
const error = (a,b) => a.reduce((sum,v,i)=>sum+Math.abs(v-b[i]),0)/a.length;
function timed(fn) {
    fn();
    const samples=[];
    let value;
    for(let i=0;i<5;i++) {
        const start=performance.now();
        value=fn();
        samples.push(round(performance.now()-start));
    }
    return {value,medianMs:median(samples),samples};
}
function frame(pixel) {
    return Uint8Array.from({length:size*height},(_,i)=>pixel(i%size,Math.floor(i/size)));
}
function denoise(input) {
    const output=input.slice();
    const window=new Uint8Array(9);
    for(let y=1;y<height-1;y++) for(let x=1;x<size-1;x++) {
        let n=0;
        for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) window[n++]=input[(y+dy)*size+x+dx];
        output[y*size+x]=window.sort()[4];
    }
    return output;
}
function restoration() {
    const clean=frame((x,y)=>x%32<16 ? 40+y%64 : 175+y%64);
    let seed=18239;
    const noisy=clean.map(v=>{
        seed=(Math.imul(seed,1664525)+1013904223)>>>0;
        return seed%100<8 ? (seed&256?255:0) : v;
    });
    // Single-pixel strokes are common in animation, subtitles and screen recordings.
    const strokes=frame(x=>x%6===2?255:0);
    const run=timed(()=>denoise(noisy));
    const source=clean.map((v,i)=>i%size%13===0?255:v);
    function corrupt(image) {
        return image.map(v=>{
            seed=(Math.imul(seed,1664525)+1013904223)>>>0;
            return seed%100<8 ? (seed&256?255:0) : v;
        });
    }
    const prev=corrupt(shifted(source,-4)), mid=corrupt(source), next=corrupt(shifted(source,4));
    function temporal(first,center,last) {
        const a=shifted(first,displacement(first,center));
        const b=shifted(last,displacement(last,center));
        return center.map((v,i)=>v+a[i]+b[i]-Math.max(v,a[i],b[i])-Math.min(v,a[i],b[i]));
    }
    const aligned=timed(()=>temporal(prev,mid,next));
    const flash=source.map(v=>255-v);
    return {inputMAE:round(error(noisy,clean)),filteredMAE:round(error(run.value,clean)),
        cleanStrokeMAE:round(error(denoise(strokes),strokes)),medianMs:run.medianMs,samplesMs:run.samples,
        temporal:{inputMAE:round(error(mid,source)),filteredMAE:round(error(aligned.value,source)),
            spatialBaselineMAE:round(error(denoise(mid),source)),cleanFlashMAE:round(error(temporal(source,flash,source),flash)),
            medianMs:aligned.medianMs,samplesMs:aligned.samples}};
}
function shifted(a,dx,opposed=false) {
    return frame((x,y)=>a[y*size+(x-(opposed && y>=height/2?-dx:dx)+size)%size]);
}
function displacement(a,b) {
    let best=Infinity, shift=0;
    for(let dx=-12;dx<=12;dx++) {
        let sum=0;
        for(let y=0;y<height;y+=3) for(let x=12;x<size-12;x+=3)
            sum+=Math.abs(a[y*size+x]-b[y*size+x+dx]);
        if(sum<best) {best=sum;shift=dx;}
    }
    return shift;
}
function motion() {
    const a=frame((x,y)=>(Math.imul(x,37)^Math.imul(y,73)^(x*y))&255);
    const rows=[];
    for(const opposed of [false,true]) {
        const b=shifted(a,8,opposed),truth=shifted(a,4,opposed);
        const run=timed(()=>shifted(a,Math.round(displacement(a,b)/2)));
        const blend=a.map((v,i)=>(v+b[i])/2);
        rows.push({scene:opposed?'opposing motion':'single pan',holdMAE:round(error(a,truth)),blendMAE:round(error(blend,truth)),motionMAE:round(error(run.value,truth)),medianMs:run.medianMs});
    }
    return rows;
}
function toneMap() {
    const pq = code => {
        const p=(code/1023)**(32/2523);
        return 10000*(Math.max(0,p-3424/4096)/(2413/128-2392/128*p))**(16384/2610);
    };
    const mapped = Array.from({length:1024},(_,code)=>{
        const light=pq(code)/100;
        const linear=light/(1+light);
        return Math.round(255*(linear<=0.0031308?12.92*linear:1.055*linear**(1/2.4)-0.055));
    });
    check(mapped.every((v,i)=>!i||v>=mapped[i-1]),'nonmonotonic output');
    check(Math.abs(pq(1023)-10000)<0.01 && pq(0)===0,'PQ endpoints');
    return {hdrDisplayReported:matchMedia('(dynamic-range: high)').matches,distinct8bitLevels:new Set(mapped).size,
        samples:[0,256,512,768,1023].map(code=>({code,nits:round(pq(code)),sdr:mapped[code]}))};
}
async function gpu(video) {
    const adapter=await navigator.gpu?.requestAdapter();
    if (!adapter) return {available:false};
    const d=await adapter.requestDevice();
    try {
        const w=video.videoWidth,h=video.videoHeight,stride=Math.ceil(w*4/256)*256;
        const tex=d.createTexture({size:[w,h],format:'rgba8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
        const output=d.createBuffer({size:stride*h,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        const samples=[];
        let dynamicRange=0;
        for(let i=0;i<6;i++) {
            const start=performance.now();
            d.queue.copyExternalImageToTexture({source:video},{texture:tex},[w,h]);
            const encoder=d.createCommandEncoder();
            encoder.copyTextureToBuffer({texture:tex},{buffer:output,bytesPerRow:stride},[w,h]);
            d.queue.submit([encoder.finish()]);
            await output.mapAsync(GPUMapMode.READ);
            if(i) samples.push(round(performance.now()-start));
            const bytes=new Uint8Array(output.getMappedRange());
            let min=255,max=0;
            for(let y=0;y<h;y++) for(let x=0;x<w;x++) {const r=bytes[y*stride+x*4];min=Math.min(min,r);max=Math.max(max,r);}
            dynamicRange=max-min;
            output.unmap();
        }
        check(dynamicRange>8,'blank GPU readback');
        return {available:true,description:adapter.info?.description,fallback:adapter.info?.isFallbackAdapter,medianMs:median(samples),samplesMs:samples,redRange:dynamicRange};
    } finally {d.destroy();}
}
async function localMedia(video) {
    const bytes=await (await fetch('fixture.mp4')).blob();
    const file=new File([bytes],'lesson.mp4',{type:'video/mp4'});
    const url=URL.createObjectURL(file);
    const ready=new Promise((res,rej)=>{video.onloadeddata=res;video.onerror=()=>rej(Error('MP4 decode unavailable'));});
    video.src=url;
    try {
        await ready;
        const samples=[];
        for(const t of [2,7,3,8,4]) {
            const start=performance.now();
            const done=new Promise(res=>video.addEventListener('seeked',res,{once:true}));
            video.currentTime=t;
            await done;
            check(Math.abs(video.currentTime-t)<0.1,'local seek missed target');
            samples.push(round(performance.now()-start));
        }
        let webgpu;
        try {webgpu=await gpu(video);} catch(e){webgpu={available:false,error:e.message};}
        return {bytes:file.size,resolution:[video.videoWidth,video.videoHeight],seekMedianMs:median(samples),seekSamplesMs:samples,webgpu};
    } finally {video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
}
async function watchTogether() {
    const token=crypto.randomUUID(), channel=new BroadcastChannel(token);
    const peer=document.createElement('iframe');
    peer.src='/peer#'+token;
    const sample=[];
    try {
        const received=()=>new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error('peer timeout')),5000);
            channel.onmessage=e=>{clearTimeout(timer);resolve(e.data);};
        });
        const ready=received();
        document.body.append(peer);
        check((await ready).ready,'peer unavailable');
        for(const pos of [2,7,3,8,4]) {
            const start=performance.now(), response=received();
            channel.postMessage({position:pos,paused:true});
            const ack=await response;
            check(Math.abs(ack.position-pos)<0.1 && ack.paused,'peer seek mismatch: '+ack.position+' vs '+pos);
            sample.push(round(performance.now()-start));
        }
        return {sameOriginOnly:true,medianAckMs:median(sample),samplesMs:sample};
    } finally {channel.close();peer.remove();}
}
async function run() {
    const video=document.createElement('video');
    video.muted=true;document.body.append(video);
    const result={browser:navigator.userAgent,fixtureResolution:[size,height],restoration:restoration(),motion:motion(),toneMap:toneMap()};
    result.local=await localMedia(video);
    result.sync=await watchTogether();
    return result;
}
if(location.pathname==='/peer') {
    const channel=new BroadcastChannel(location.hash.slice(1));
    const v=document.createElement('video');
    v.muted=true;v.src='/fixture.mp4';document.body.append(v);
    v.onloadeddata=()=>channel.postMessage({ready:true});
    channel.onmessage=({data})=>{
        if(!Number.isFinite(data.position)||data.paused!==true) return;
        v.pause();
        v.addEventListener('seeked',()=>channel.postMessage({position:v.currentTime,paused:v.paused}),{once:true});
        v.currentTime=data.position;
    };
} else {
    run().catch(e=>({error:e.message})).then(result=>fetch(location.pathname,{method:'POST',body:JSON.stringify(result)}));
}
