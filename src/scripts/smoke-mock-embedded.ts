import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import assert from 'node:assert/strict';
import pg from 'pg';
import {migrate,seed} from './database.js';

// The compiled deployment entry, from another folder, on a disposable local schema: the same start-up the host uses.
const url=process.env.TEST_DATABASE_URL;if(!url)throw Error('A dedicated TEST_DATABASE_URL is required');
const parsed=new URL(url);if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))throw Error('Local only');
const port=()=>new Promise<number>(done=>{const s=createServer().listen(0,'127.0.0.1',()=>{const a=s.address();s.close(()=>done(typeof a==='object'&&a?a.port:0));});});
const admin=new pg.Pool({connectionString:url}),schema=`mock_${randomUUID().replaceAll('-','')}`,storage=await mkdtemp(join(tmpdir(),'paysah-mock-'));
const appPort=await port(),localPort=await port(),site=`http://127.0.0.1:${appPort}`,api=`${site}/api/v1`;
parsed.searchParams.set('options',`-c search_path=${schema}`);
await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:parsed.toString()});await migrate(pool);await seed(pool);
const group=spawn(process.execPath,[resolve('dist/apps/api/src/deployment.js')],{cwd:tmpdir(),windowsHide:true,stdio:'ignore',env:{...process.env,DATABASE_URL:parsed.toString(),RECEIPT_STORAGE_DIR:storage,STORAGE_DRIVER:'local',EXTRACTOR_MODE:'fixture',HOST:'127.0.0.1',PORT:String(appPort),MOCK_PAY_URL:`http://127.0.0.1:${localPort}`,MOCK_PAY_PUBLIC_URL:site,MOCK_PAY_API_KEY:'synthetic-mock-key',MOCK_PAY_WEBHOOK_SECRET:'synthetic-mock-secret'}});
try{
 let ready=false;for(let i=0;i<100&&!ready;i++){ready=(await fetch(`${site}/pay/00000000-0000-4000-8000-000000000000`).catch(()=>null))?.status===404;if(!ready)await wait(200);}
 assert.ok(ready,'simulator page not reachable through the API');
 const call=async(path:string,token:string,body?:unknown)=>{const r=await fetch(api+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const token=(await call('/demo/sessions','',{account_id:'20000000-0000-4000-8000-000000000001'})).body.token;
 const order=(await call('/orders',token,{external_id:`EMBED-${randomUUID()}`,total_sen:12800})).body.order;
 const link=await call(`/orders/${order.id}/payment-links`,token,{expected_version:1});assert.equal(link.status,201);assert.ok(link.body.url.startsWith(`${site}/pay/`));
 assert.match(await (await fetch(link.body.url)).text(),/MOCK PAYMENT/);
 const paid=await fetch(`${link.body.url}/complete`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'amount=128.00'});assert.equal(paid.status,200);assert.match(await paid.text(),/accepted by the configured PaySah callback/);
 const review=(await call(`/orders/${order.id}/review`,token)).body;assert.equal(review.receipts[0].fixture_id,'MOCK_PAYMENT');assert.equal(review.order.payment_state,'UNPAID');
 assert.equal((await fetch(`${api}/health`)).status,200);
 console.log('PASS: compiled deployment entry ran the simulator; customer paid through /pay; order stays unpaid for a person to confirm (local).');
}finally{group.kill();await wait(800);await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();await rm(storage,{recursive:true,force:true});}
