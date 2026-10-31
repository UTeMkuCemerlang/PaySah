import express from 'express';
import {timingSafeEqual} from 'node:crypto';
import type pg from 'pg';
import type {Config} from '../../config.js';
import type {ReceiptStorage} from '../receipts/storage.js';
import {ApiError} from '../../business.js';
import {receiveTelegram,telegramNotifier,type TelegramDownloader} from './telegram.js';
import {receiveGoogleForm} from './google-form.js';
import {mockPaymentEnabled,receiveMockPayment,validMockSignature} from './mock-payment.js';
export type IntakeAdapters={now?:()=>number;telegramDownload?:TelegramDownloader;telegramFetch?:typeof fetch};
export function intakeRouter(pool:pg.Pool,config:Config,storage:ReceiptStorage,adapters:IntakeAdapters={}){
 const router=express.Router();let inFlight=0;const buckets=new Map<string,{count:number;until:number}>();
 function gate(enabled:boolean,header:string,secret:string|undefined):express.RequestHandler{
  return(req,res,next)=>{
   res.set('Cache-Control','no-store');
   if(!enabled){next(new ApiError(404,'NOT_FOUND','Channel unavailable'));return;}
   const given=Buffer.from(req.get(header)??''),expected=Buffer.from(secret??'');
   if(!expected.length||given.length!==expected.length||!timingSafeEqual(given,expected)){next(new ApiError(401,'UNAUTHENTICATED','Invalid channel credential'));return;}
   const now=(adapters.now??Date.now)();for(const [key,b] of buckets)if(b.until<=now)buckets.delete(key);
   const key=req.path,b=buckets.get(key)??{count:0,until:now+60000};
   if(inFlight>=2||b.count>=60){res.set('Retry-After','5');next(new ApiError(429,'INTAKE_BUSY','Reception busy'));return;}
   b.count++;buckets.set(key,b);inFlight++;let released=false;const release=()=>{if(!released){released=true;inFlight--;}};
   res.locals.intakeRelease=release;res.locals.intakeProcessing=false;
   res.once('finish',release);res.once('close',()=>{if(!res.locals.intakeProcessing)release();});next();
  };
 }
 router.post('/mock-payment',express.raw({type:'application/json',limit:'32kb'}),async(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!mockPaymentEnabled(config))throw new ApiError(404,'NOT_FOUND','Channel unavailable');
  const raw=Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0);
  if(!validMockSignature(config,raw,req.get('X-Mock-Signature')))throw new ApiError(401,'UNAUTHENTICATED','Invalid channel credential');
  res.json(await receiveMockPayment(pool,raw));
 });
 router.post('/telegram',gate(config.TELEGRAM_ENABLED==='true','X-Telegram-Bot-Api-Secret-Token',config.TELEGRAM_WEBHOOK_SECRET),express.json({limit:'1mb'}),async(req,res)=>{
  // Bounded per-sender buckets, after the global gate and body limit. IDs never enter durable logs.
  const sender=String(req.body?.message?.from?.id??'invalid'),key='sender:'+sender,now=(adapters.now??Date.now)(),b=buckets.get(key)??{count:0,until:now+60000};
  if(b.count>=15||buckets.size>=1000)throw new ApiError(429,'INTAKE_BUSY','Reception busy');b.count++;buckets.set(key,b);
  res.locals.intakeProcessing=true;
  try{res.json(await receiveTelegram(pool,config,storage,req.body,adapters.telegramDownload,telegramNotifier(config,adapters.telegramFetch)));}finally{res.locals.intakeRelease();}
 });
 router.post('/google-form',gate(config.GOOGLE_FORM_ENABLED==='true','X-Intake-Key',config.GOOGLE_FORM_INGEST_KEY),express.json({limit:'15mb'}),async(req,res)=>{
  res.locals.intakeProcessing=true;try{res.json(await receiveGoogleForm(pool,config,storage,req.body));}finally{res.locals.intakeRelease();}
 });
 return router;
}
