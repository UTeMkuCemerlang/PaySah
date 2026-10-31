import {processVerificationJob} from './modules/verification/worker.js';
import pg from 'pg';
import {readConfig} from './config.js';
import {checkReady} from './ready.js';
import {createReceiptStorage} from './modules/receipts/storage-factory.js';
import {processReceiptJob} from './modules/receipts/worker.js';
import {createThirdReader} from './modules/receipts/third-reader.js';
import {CpuExtractor} from './modules/receipts/ocr.js';
import {RunpodVisionExtractor} from './modules/receipts/runpod.js';
import {runWorkerLoop} from './modules/receipts/worker-loop.js';

async function runReceiptWorker(once=false){
  const config=readConfig(process.env);
  if(!config.DATABASE_URL)throw Error('DATABASE_URL required');
  const pool=new pg.Pool({connectionString:config.DATABASE_URL,connectionTimeoutMillis:3000});
  const controller=new AbortController(),storage=createReceiptStorage(config),extractor=new CpuExtractor();
  const vision=config.EXTRACTOR_MODE==='runpod'?new RunpodVisionExtractor({apiKey:config.RUNPOD_API_KEY!,endpointId:config.RUNPOD_ENDPOINT_ID!,model:config.RUNPOD_MODEL,timeoutMs:config.RUNPOD_TIMEOUT_MS}):undefined;
  const third=vision?createThirdReader(config):undefined;
  const stop=()=>controller.abort();
  const message=(value:unknown)=>{if((value as {type?:string})?.type==='shutdown')stop();};
  const databaseError=()=>{console.error('Worker database connection interrupted.');process.exitCode=1;stop();};
  pool.on('error',databaseError);
  process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('message',message);
  try{
    await checkReady(pool);
    process.send?.({type:'ready',role:'worker'});
    await runWorkerLoop(async()=>{const verified=await processVerificationJob(pool,storage);const extracted=await processReceiptJob(pool,storage,extractor,vision,third);return verified||extracted;},controller.signal,config.WORKER_IDLE_MAX_MS,once);
  }finally{
    process.off('SIGINT',stop);process.off('SIGTERM',stop);process.off('message',message);
    await extractor.close();await pool.end();
    if(process.connected)process.disconnect();
  }
}
try{await runReceiptWorker(process.argv.includes('--once'));}
catch{console.error('Receipt worker failed; check configuration, database, migrations and private storage.');process.exitCode=1;if(process.connected)process.disconnect();}
