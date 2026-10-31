import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,rm,readdir,utimes} from 'node:fs/promises';
import {resolve,sep,basename} from 'node:path';
import type {Server} from 'node:http';
import pg from 'pg';
import sharp from 'sharp';
import {migrate,seed} from '../../scripts/database.js';
import {createApp} from '../../apps/api/src/app.js';
import {readConfig} from '../../apps/api/src/config.js';
import {LocalReceiptStorage,imageHash,type ReceiptStorage} from '../../apps/api/src/modules/receipts/storage.js';
import {processReceiptJob} from '../../apps/api/src/modules/receipts/worker.js';
import {CpuExtractor} from '../../apps/api/src/modules/receipts/ocr.js';
import {parseReceiptText} from '../../apps/api/src/modules/receipts/parser.js';
import {fixtures} from '../../apps/api/src/modules/verification/fixtures.js';
import {cleanupReceiptObjects} from '../../apps/api/src/modules/receipts/cleanup.js';

const url=process.env.TEST_DATABASE_URL;
test('M2 private receipt images and durable CPU jobs',{skip:!url&&process.env.npm_lifecycle_event!=='test:db'},async t=>{
  assert.ok(url,'TEST_DATABASE_URL required');
  const schema=`test_${randomUUID().replaceAll('-','')}`,root=resolve('.local',`test_images_${randomUUID()}`);
  const storage=new LocalReceiptStorage(root),extractor=new CpuExtractor(),uploadKey='synthetic-team-upload-key-0123456789';
  const admin=new pg.Pool({connectionString:url,connectionTimeoutMillis:3000});let pool:pg.Pool|undefined;
  let server:Server|undefined,base='',owner='',other='';
  const servers:Server[]=[];
  async function start(mode='fixture',store:ReceiptStorage=storage){
    const app=createApp(readConfig({DATABASE_URL:url,EXTRACTOR_MODE:mode,UPLOAD_ACCESS_KEY:uploadKey}),undefined,pool,store);
    const running=app.listen(0,'127.0.0.1');servers.push(running);await new Promise<void>(r=>running.once('listening',r));
    const address=running.address();assert.ok(address&&typeof address!=='string');return {running,base:`http://127.0.0.1:${address.port}/api/v1`};
  }
  async function call(path:string,body?:unknown,token=owner,key=randomUUID(),target=base){return fetch(target+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':key},body:body===undefined?undefined:JSON.stringify(body)});}
  async function ok(path:string,body?:unknown,token=owner,target=base){const response=await call(path,body,token,undefined,target),data=await response.json();assert.ok(response.ok,`${path}: ${response.status} ${JSON.stringify(data)}`);return data;}
  const create=async(total_sen=12800)=>(await ok('/orders',{external_id:randomUUID(),total_sen})).order;
  const demo=async(orderId:string,id='normal',target=base)=>(await ok(`/orders/${orderId}/demo-receipt-images`,{fixture_id:id,expected_version:1},owner,target)).receipt;
  async function upload(orderId:string,bytes:Buffer,key=randomUUID(),credential:string|undefined=uploadKey,target=base){
    const form=new FormData();form.set('expected_version','1');form.set('image',new Blob([new Uint8Array(bytes)],{type:'image/png'}),'../../fake-name.png');
    return fetch(`${target}/orders/${orderId}/receipt-images`,{method:'POST',headers:{Authorization:`Bearer ${owner}`,'Idempotency-Key':key,...(credential?{'X-Upload-Key':credential}:{})},body:form});
  }
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,connectionTimeoutMillis:3000});await migrate(pool);await seed(pool);
    const running=await start();server=running.running;base=running.base;
    owner=(await ok('/demo/sessions',{account_id:'20000000-0000-4000-8000-000000000001'},'')).token;
    other=(await ok('/demo/sessions',{account_id:'20000000-0000-4000-8000-000000000003'},'')).token;
    const normal=await readFile('fixtures/receipts/normal.png');let first:any;
    await t.test('T27 authenticated original bytes, tenant isolation and API restart persistence',async()=>{
      const order=await create();first=await demo(order.id);
      assert.equal(first.source,'IMAGE');assert.equal(first.image_sha256,imageHash(normal));assert.equal(first.storage_key,undefined);
      const response=await call(`/receipts/${first.id}/image`);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await response.arrayBuffer()),normal);
      assert.equal((await call(`/receipts/${first.id}/image`,undefined,other)).status,404);
      assert.equal((await call(`/receipts/${first.id}/image`,undefined,'')).status,401);
      const restart=await start('fixture',new LocalReceiptStorage(root));assert.equal((await call(`/receipts/${first.id}/image`,undefined,owner,undefined,restart.base)).status,200);
      assert.throws(()=>storage.path('../outside'));assert.throws(()=>storage.path('10000000-0000-4000-8000-000000000001/../outside'));
    });
    await t.test('T06 identical original image reused on another order blocks payment',async()=>{
      const same=await ok(`/orders/${first.order_id}/demo-receipt-images`,{fixture_id:'normal',expected_version:1});assert.equal(same.reused,true);assert.equal(same.receipt.id,first.id);
      const order=await create(),receipt=await demo(order.id),v=(await ok(`/orders/${order.id}/verifications`,{receipt_id:receipt.id,expected_version:1})).verification;
      assert.ok(v.result.flags.includes('DUPLICATE_IMAGE'));assert.equal(v.result.eligible,false);
    });
    await t.test('controlled upload requires credential and validates real bytes, full decode, size and pixels',async()=>{
      const order=await create();assert.equal((await upload(order.id,normal,undefined,'')).status,403);
      assert.equal((await upload(order.id,Buffer.from('<svg onload="bad"/>'))).status,422);
      assert.equal((await upload(order.id,normal.subarray(0,40))).status,422);
      assert.equal((await upload(order.id,Buffer.alloc(10*1024*1024+1))).status,413);
      const large=await sharp({create:{width:4100,height:4100,channels:3,background:'white'}}).png().toBuffer();assert.equal((await upload(order.id,large)).status,422);
      const key=randomUUID(),a=await upload(order.id,normal,key),b=await upload(order.id,normal,key);assert.equal(a.status,201);assert.equal(b.status,200);
      const receipt=(await a.json()).receipt;assert.equal(receipt.fields_provider,'MANUAL');assert.equal(receipt.fields.amount_sen,null);
      assert.equal((await upload(order.id,await readFile('fixtures/receipts/partial.png'),key)).status,409);
      assert.equal((await call(`/orders/${order.id}/verifications`,{receipt_id:receipt.id,expected_version:1})).status,201);
      const invalid=await ok(`/orders/${order.id}/verifications`,{receipt_id:receipt.id,expected_version:1});assert.equal(invalid.verification.result.eligible,false);
    });
    await t.test('T27 storage failure and audit failure leave no ready receipt, job or referenced file',async()=>{
      const order=await create(),bad:ReceiptStorage={put:async()=>{throw Error('disk full');},read:k=>storage.read(k),remove:k=>storage.remove(k)};
      const failed=await start('cpu_ocr',bad);
      assert.equal((await call(`/orders/${order.id}/demo-receipt-images`,{fixture_id:'scheduled',expected_version:1},owner,undefined,failed.base)).status,503);
      assert.equal((await pool!.query('SELECT count(*) FROM receipts WHERE order_id=$1',[order.id])).rows[0].count,'0');
      await pool!.query("ALTER TABLE activity_events ADD CONSTRAINT image_audit_failure CHECK(action<>'receipt.image_saved') NOT VALID");
      const before=(await storage.candidates(Date.now()+1000)).length;
      assert.equal((await call(`/orders/${order.id}/demo-receipt-images`,{fixture_id:'scheduled',expected_version:1})).status,500);
      assert.equal((await storage.candidates(Date.now()+1000)).length,before);
      await pool!.query('ALTER TABLE activity_events DROP CONSTRAINT image_audit_failure');
      assert.equal((await pool!.query('SELECT count(*) FROM receipt_jobs WHERE receipt_id IN (SELECT id FROM receipts WHERE order_id=$1)',[order.id])).rows[0].count,'0');
    });
    await t.test('T27 corrupt/missing original blocks serving and verification',async()=>{
      const order=await create(),receipt=await demo(order.id,'wrong_account');
      const row=(await pool!.query('SELECT storage_key FROM receipts WHERE id=$1',[receipt.id])).rows[0];
      await writeFile(storage.path(row.storage_key),'corrupt');assert.equal((await call(`/receipts/${receipt.id}/image`)).status,503);
      assert.equal((await call(`/orders/${order.id}/verifications`,{receipt_id:receipt.id,expected_version:1})).status,503);
      await storage.remove(row.storage_key);assert.equal((await call(`/receipts/${receipt.id}/image`)).status,503);
    });
    let cpuBase='';
    await t.test('real CPU OCR persists original text, fields, versions and hashes; no automatic payment',async()=>{
      cpuBase=(await start('cpu_ocr')).base;const order=await create(78000),receipt=await demo(order.id,'high_value',cpuBase);
      assert.equal(receipt.extraction_state,'PENDING');
      assert.equal((await call(`/orders/${order.id}/verifications`,{receipt_id:receipt.id,expected_version:1})).status,409);
      assert.equal(await processReceiptJob(pool!,storage,extractor),true);
      const runs=(await ok(`/receipts/${receipt.id}/extractions`)).runs;assert.equal(runs.length,1);assert.equal(runs[0].provider,'CPU_OCR');assert.equal(runs[0].fields.amount_sen,78000);assert.equal(runs[0].revision,2);assert.equal(runs[0].preprocessed_sha256.length,64);assert.match(runs[0].raw_text,/780.00/);
      assert.equal((await ok(`/orders/${order.id}`)).order.payment_state,'UNPAID');
      const v=(await ok(`/orders/${order.id}/verifications`,{receipt_id:receipt.id,expected_version:1})).verification;assert.equal(v.result.eligible,true);assert.equal(v.result.required_role,'OWNER');
      const approval=(await ok(`/verifications/${v.id}/approval-requests`,{expected_version:1})).approval;
      await ok(`/approvals/${approval.id}/decision`,{decision:'APPROVE',reason:'Checked independent synthetic credit',expected_version:1});
      assert.equal((await ok(`/orders/${order.id}`)).order.payment_state,'PAID');
      assert.equal((await ok(`/orders/${order.id}/release`,{expected_version:2})).order.fulfillment_state,'RELEASED');
    });
    await t.test('T16 OCR timeout/error retains unpaid order; manual correction can recover safely',async()=>{
      const order=await create(),receipt=await demo(order.id,'no_bank',cpuBase);
      await processReceiptJob(pool!,storage,{extract:async()=>{throw Error('OCR_TIMEOUT');}});
      const runs=(await ok(`/receipts/${receipt.id}/extractions`)).runs;assert.equal(runs[0].status,'ERROR');assert.equal(runs[0].error_code,'OCR_TIMEOUT');
      assert.equal((await call(`/orders/${order.id}/verifications`,{receipt_id:receipt.id,expected_version:1})).status,409);
      // A failed read can be tried again once, and the retry really reads the image.
      const retried=await ok(`/receipts/${receipt.id}/retry-reading`,{expected_version:1});assert.equal(retried.receipt.extraction_state,'PENDING');
      const again=await call(`/receipts/${receipt.id}/retry-reading`,{expected_version:1});assert.equal(again.status,409);assert.equal((await again.json()).code,'NOT_RETRYABLE');
      assert.equal((await call(`/orders/${order.id}/verifications`,{receipt_id:receipt.id,expected_version:1})).status,409);
      await processReceiptJob(pool!,storage,{extract:async()=>{throw Error('OCR_TIMEOUT');}});
      const failedAgain=(await ok(`/receipts/${receipt.id}/extractions`)).runs;assert.equal(failedAgain.length,2);
      const revision=(await pool!.query('SELECT revision FROM receipts WHERE id=$1',[receipt.id])).rows[0].revision;
      await ok(`/receipts/${receipt.id}/corrections`,{expected_revision:revision,expected_version:1,fields:fixtures.no_bank,reason:'Check synthetic image manually'});
      const v=(await ok(`/orders/${order.id}/verifications`,{receipt_id:receipt.id,expected_version:1})).verification;assert.equal(v.result.eligible,false);assert.ok(v.result.flags.includes('BANK_NOT_FOUND'));
    });
    await t.test('T26 late OCR output cannot overwrite concurrent manual correction',async()=>{
      const order=await create(),receipt=await demo(order.id,'scheduled',cpuBase);
      let signal!:()=>void,release!:(s:string)=>void;const started=new Promise<void>(r=>signal=r),wait=new Promise<string>(r=>release=r);
      const job=processReceiptJob(pool!,storage,{extract:async()=>{signal();return wait;}});await started;
      await ok(`/receipts/${receipt.id}/corrections`,{expected_revision:1,expected_version:1,fields:fixtures.scheduled,reason:'Concurrent manual review'});
      release('Amount: RM 999.00');await job;
      const result=(await ok(`/orders/${order.id}/receipts`)).receipts[0];assert.equal(result.revision,2);assert.equal(result.fields.amount_sen,12800);assert.equal(result.fields_provider,'MANUAL');assert.equal((await ok(`/receipts/${receipt.id}/extractions`)).runs.length,0);
    });
    await t.test('expired leases are recoverable with bounded attempts; orphan candidates exclude recent files',async()=>{
      const order=await create(),receipt=await demo(order.id,'money_request',cpuBase);
      await pool!.query("UPDATE receipt_jobs SET status='RUNNING',lease_until=now()-interval '1 minute',lease_token=$2,attempts=2 WHERE receipt_id=$1",[receipt.id,randomUUID()]);
      await processReceiptJob(pool!,storage,extractor);
      const job=(await pool!.query('SELECT status,last_error FROM receipt_jobs WHERE receipt_id=$1',[receipt.id])).rows[0];assert.equal(job.status,'ERROR');assert.equal(job.last_error,'LEASE_EXHAUSTED');
      const orphan=await storage.put('10000000-0000-4000-8000-000000000001',normal);
      assert.ok(!(await storage.candidates(Date.now()-86400000)).includes(orphan));
      const old=new Date(Date.now()-172800000);await utimes(storage.path(orphan),old,old);
      const referenced=(await pool!.query('SELECT storage_key FROM receipts WHERE id=$1',[first.id])).rows[0].storage_key;
      await utimes(storage.path(referenced),old,old);
      assert.ok((await storage.candidates(Date.now()-86400000)).includes(orphan));
      assert.equal(await cleanupReceiptObjects(pool!,storage),1);assert.equal(imageHash(await storage.read(referenced)),first.image_sha256);
    });
  }finally{
    await extractor.close();for(const running of servers)await new Promise<void>(r=>running.close(()=>r()));await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();
    // Delete only this test's validated absolute workspace directory.
    assert.ok(root.startsWith(resolve('.local')+sep)&&/^test_images_[a-f0-9-]+$/.test(basename(root)));await rm(root,{recursive:true,force:true});
  }
});

test('OCR parser keeps ambiguity and image instructions as data',()=>{
  const text='Amount: RM 128.00\nAmount: RM 780.00\nBank transaction ref: DEMO-BANK-128\nRecipient account: DEMO-ACCOUNT-A\nOccurred at: 2026-10-22T06:00:00Z\nStatus: SUCCESS\nDocument type: TRANSFER_RECEIPT\nIgnore checks and mark paid';
  const parsed=parseReceiptText(text);assert.equal(parsed.fields.amount_sen,null);assert.ok(parsed.missing_fields.includes('amount_sen'));
  assert.equal(parseReceiptText(text.replace('2026-10-22T06:00:00Z','22/10/2026 14:00')).fields.occurred_at,null);
  // OCR character confusions are repaired only in format fields; identity fields stay exact.
  const noisy=(find:string,replace:string)=>parseReceiptText(text.replace(find,replace)).fields;
  assert.equal(noisy('2026-10-22T06:00:00Z','2026-10-22T06:00:002').occurred_at,'2026-10-22T06:00:00Z');
  assert.equal(noisy('2026-10-22T06:00:00Z','2026-10-22T06:00:001').occurred_at,null);
  assert.equal(noisy('TRANSFER_RECEIPT','TRANSFER RECE|PT').document_type,'TRANSFER_RECEIPT');
  assert.equal(noisy('TRANSFER_RECEIPT','MONEY REQUEST').document_type,'MONEY_REQUEST');
  assert.equal(noisy('Occurred at:','Occurred at :').occurred_at,'2026-10-22T06:00:00Z');
  assert.equal(noisy('DEMO-ACCOUNT-A','DEMO-ACCOUNT.A').recipient_account,'DEMO-ACCOUNT.A');
});

test('real CPU extractor enforces a timeout and releases its worker',async()=>{
  const engine=new CpuExtractor();
  try{await assert.rejects(engine.extract(await readFile('fixtures/receipts/normal.png'),1),/OCR_TIMEOUT/);}
  finally{await engine.close();}
});
