import {intakeRouter,type IntakeAdapters} from './modules/intake/router.js';
import {buildCommit} from './build-version.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Health } from '../../../packages/contracts/src/index.js';
import {APP_STAGE} from '../../../packages/contracts/src/index.js';
import type pg from 'pg';
import { businessRouter, apiErrorHandler } from './business.js';
import { checkReady } from './ready.js';
import {LocalReceiptStorage,type ReceiptStorage} from './modules/receipts/storage.js';
import {createReceiptStorage} from './modules/receipts/storage-factory.js';
import {resolve,sep} from 'node:path';

export function createApp(config: Config, webRoot?: string, pool?: pg.Pool,storage?:ReceiptStorage,intakeAdapters?:IntakeAdapters) {
  const receiptStorage=storage??createReceiptStorage(config);
  if(webRoot&&receiptStorage instanceof LocalReceiptStorage){
    const normalize=(path:string)=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
    const privateRoot=normalize(receiptStorage.root),publicRoot=normalize(webRoot);
    if(privateRoot===publicRoot||privateRoot.startsWith(publicRoot+sep))throw Error('Private receipt storage must be outside the public web directory');
  }
  const app = express();
  app.disable('x-powered-by');
  app.get('/api/v1/ready', async (_req,res) => {
    res.set('Cache-Control','no-store');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!pool) throw new Error('Database required');
      await Promise.race([checkReady(pool),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timeout')),2500);})]);
      res.json({status:'ready',stage:APP_STAGE});
    } catch { res.status(503).json({code:'NOT_READY',message:'Database or migrations not ready',correlation_id:randomUUID()}); }
    finally {clearTimeout(timer);}
  });
  app.get('/api/v1/health', (_req, res) => {
    const health: Health = {
      status: 'ok', service: 'paysah-api', stage:APP_STAGE, demo: true,
      commit:buildCommit(),
      extractor_mode: config.EXTRACTOR_MODE,
      database: config.DATABASE_URL ? 'not_checked' : 'not_configured',
      business_features: pool ? 'identity_orders_verification' : 'database_required',
    };
    res.set('Cache-Control', 'no-store').json(health);
  });
  if(pool)app.use('/api/v1/intake',intakeRouter(pool,config,receiptStorage,intakeAdapters));
  app.use(express.json({ limit: '16kb' }));
  if (pool) app.use('/api/v1', businessRouter(pool,config,receiptStorage));
  else app.use('/api/v1', (_req, res) => {
    res.status(503).json({ code: 'DATABASE_REQUIRED', message: 'Configure the database, then run migrations and seeds', correlation_id: randomUUID() });
  });
  app.use('/api', (_req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', message: 'API route not found', correlation_id: randomUUID() });
  });
  if (webRoot) app.use(express.static(webRoot));
  app.use(apiErrorHandler);
  return app;
}
