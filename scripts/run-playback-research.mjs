import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const binary=process.argv[2];
if (!binary) throw Error('Pass the path to Edge or Firefox.');
const profile=await mkdtemp(path.join(tmpdir(),'aethvyr-research-'));
const secret='/'+randomUUID();
const script=await readFile(new URL('research-playback.mjs',import.meta.url));
const media=await readFile(new URL('fixtures/seek-video.mp4',import.meta.url));
let finish;
const result=new Promise(resolve=>{finish=resolve;});
const server=createServer(async(req,res)=>{
    if(req.url===secret && req.method==='POST') {
        let body='';
        for await(const chunk of req) {body+=chunk;if(body.length>65536){res.writeHead(413).end();return;}}
        res.end();finish(JSON.parse(body));return;
    }
    if(req.url==='/fixture.mp4') {
        const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        const start=match?Number(match[1]):0;
        const last=match?.[2]?Math.min(media.length-1,Number(match[2])):media.length-1;
        if(start>last){res.writeHead(416).end();return;}
        const headers={'Content-Type':'video/mp4','Content-Length':last-start+1,'Accept-Ranges':'bytes'};
        if(match) headers['Content-Range']=`bytes ${start}-${last}/${media.length}`;
        res.writeHead(match?206:200,headers).end(media.subarray(start,last+1));return;
    }
    if(req.url==='/probe.js') {res.writeHead(200,{'Content-Type':'text/javascript'}).end(script);return;}
    if(![secret,'/peer'].includes(req.url)){res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':'text/html'}).end('<!doctype html><title>Aethvyr playback research</title><script type="module" src="/probe.js"></script>');
});
server.listen(0,'127.0.0.1');
await once(server,'listening');
const url='http://127.0.0.1:'+server.address().port+secret;
const args=/firefox/i.test(path.basename(binary))?['-headless','-no-remote','-profile',profile,url]:
    ['--headless=new','--no-first-run','--disable-background-networking','--user-data-dir='+profile,url];
const child=spawn(binary,args,{windowsHide:true,stdio:'ignore'});
const ended=once(child,'exit');
let timer;
try {
    const data=await Promise.race([result,ended.then(()=>{throw Error('Browser exited early');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Research probe timed out')),60000);})]);
    if(data.error) throw Error(data.error);
    console.log(JSON.stringify(data,null,2));
} finally {
    clearTimeout(timer);child.kill();await ended;server.closeAllConnections();server.close();
    await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:250});
}
