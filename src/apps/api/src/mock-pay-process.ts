import {spawn,type ChildProcess} from 'node:child_process';
import {request} from 'node:http';
import {join} from 'node:path';
import type {RequestHandler} from 'express';
import type {Config} from './config.js';
import {projectRoot} from './paths.js';

// Runs the team's payment simulator beside the API and serves its customer pages at /pay on the same address.
// The simulator gets only its own settings. If it stops, the API keeps running and it is started again.
export function startEmbeddedMockPay(config:Config,apiPort:number,restartMs=2000){
 const target=new URL(config.MOCK_PAY_URL!);
 const env={PATH:process.env.PATH??'',PORT:target.port,BASE_URL:config.MOCK_PAY_PUBLIC_URL!,MOCK_API_KEY:config.MOCK_PAY_API_KEY!,WEBHOOK_SECRET:config.MOCK_PAY_WEBHOOK_SECRET!,PAYSAH_WEBHOOK_URL:`http://127.0.0.1:${apiPort}/api/v1/intake/mock-payment`};
 let child:ChildProcess|undefined,stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
 const start=()=>{
  if(stopped)return;
  child=spawn(process.execPath,[join(projectRoot,'integrations','mock-payment','PaySah_Amount_Mock.cjs')],{env,stdio:'ignore',windowsHide:true});
  child.once('error',()=>console.error('Mock payment simulator could not start.'));
  child.once('exit',()=>{if(!stopped){console.error('Mock payment simulator stopped; restarting.');timer=setTimeout(start,restartMs);timer.unref();}});
 };
 start();
 const stop=()=>{stopped=true;clearTimeout(timer);child?.kill();};
 process.once('exit',stop);
 return {stop,kill:()=>child?.kill()};
}

export function mockPayProxy(config:Config):RequestHandler{
 const target=new URL(config.MOCK_PAY_URL!);
 return (req,res)=>{
  const upstream=request({host:target.hostname,port:target.port,method:req.method,path:req.originalUrl,headers:{'content-type':req.headers['content-type']??'','content-length':req.headers['content-length']??'0'},timeout:15000},reply=>{
   res.status(reply.statusCode??502);
   for(const name of ['content-type','cache-control','x-content-type-options']){const value=reply.headers[name];if(value)res.set(name,value);}
   reply.pipe(res);
  });
  const unavailable=()=>{if(!res.headersSent)res.status(503).type('text/plain').send('The mock payment page is restarting. Please try again shortly.');else res.destroy();};
  upstream.once('timeout',()=>upstream.destroy());
  upstream.once('error',unavailable);
  req.pipe(upstream);
 };
}
