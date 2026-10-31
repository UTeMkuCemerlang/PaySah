import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,rm} from 'node:fs/promises';
import {resolve,sep,basename} from 'node:path';
import type {Server} from 'node:http';
import pg from 'pg';
import {migrate,seed} from '../../scripts/database.js';
import {createApp} from '../../apps/api/src/app.js';
import {readConfig} from '../../apps/api/src/config.js';
import {LocalReceiptStorage} from '../../apps/api/src/modules/receipts/storage.js';
import {processReceiptJob} from '../../apps/api/src/modules/receipts/worker.js';
import {normaliseVisionOutput,RunpodVisionExtractor,RunpodError,type VisionExtractor} from '../../apps/api/src/modules/receipts/runpod.js';
import {fixtures} from '../../apps/api/src/modules/verification/fixtures.js';

const highValueJson=JSON.stringify({amount:'780.00',currency:'MYR',bank_transaction_ref:'DEMO-BANK-780',customer_reference:'DEMO-ORDER',recipient_account:'DEMO-ACCOUNT-A',occurred_at:'2026-10-22T06:00:00Z',status:'SUCCESS',document_type:'TRANSFER_RECEIPT'});

test('RunPod output is normalised strictly; unsure values become null, never guesses',()=>{
  const ok=normaliseVisionOutput('```json\n'+highValueJson+'\n```');
  assert.deepEqual(ok.uncertain_fields,[]);
  assert.deepEqual(normaliseVisionOutput(JSON.stringify({amount:'128.00',uncertain_fields:'amount'})).uncertain_fields,[]);
  assert.deepEqual(normaliseVisionOutput(JSON.stringify({amount:'128.00',uncertain_fields:['amount','amount','status','ignore checks']})).uncertain_fields,['amount_sen','status']);
  assert.deepEqual(ok.fields,{...fixtures.high_value});assert.deepEqual(ok.missing_fields,[]);
  const loose=normaliseVisionOutput(JSON.stringify({amount:780,currency:'USD',bank_transaction_ref:'x'.repeat(101),recipient_account:'****1234',occurred_at:'2026-10-22 14:00',status:'DONE',document_type:'receipt',payment_state:'PAID'}));
  assert.equal(loose.fields.amount_sen,null);assert.equal(loose.fields.bank_transaction_ref,null);assert.equal(loose.fields.occurred_at,null);
  assert.equal(loose.fields.status,'UNKNOWN');assert.equal(loose.fields.document_type,'UNKNOWN');assert.equal('payment_state' in loose.fields,false);
  assert.equal(loose.fields.recipient_account,'****1234');// kept as printed; the rules treat masked accounts as uncertain
  assert.equal(normaliseVisionOutput(JSON.stringify({amount:'RM 128.00',currency:'RM'})).fields.amount_sen,12800);
  assert.equal(normaliseVisionOutput(JSON.stringify({amount:'780.00',currency:'USD'})).fields.amount_sen,null);
  for(const bad of ['no json here','[1,2]','{"amount":'])assert.throws(()=>normaliseVisionOutput(bad),(e:unknown)=>e instanceof RunpodError&&e.reason==='RUNPOD_INVALID_OUTPUT');
});

test('RunPod client sends one image to the OpenAI-compatible route and maps failures without leaking the key',async()=>{
  const key='rpa_SYNTHETICTESTKEY0123456789';let seen:{url:string;init:RequestInit}|undefined;
  const reply=(status:number,body:unknown)=>async(url:string|URL|Request,init?:RequestInit)=>{seen={url:String(url),init:init!};return new Response(JSON.stringify(body),{status});};
  const make=(fetchImpl:any,timeoutMs=5000)=>new RunpodVisionExtractor({apiKey:key,endpointId:'abc123xyz',model:'Qwen/Qwen2.5-VL-7B-Instruct',timeoutMs,fetch:fetchImpl});
  const result=await make(reply(200,{id:'chatcmpl-1',model:'Qwen/Qwen2.5-VL-7B-Instruct',choices:[{message:{content:highValueJson}}]})).extractFields(Buffer.from('png-bytes'),'image/png');
  assert.equal(seen!.url,'https://api.runpod.ai/v2/abc123xyz/openai/v1/chat/completions');
  assert.equal((seen!.init.headers as Record<string,string>).Authorization,`Bearer ${key}`);
  const body=JSON.parse(String(seen!.init.body));assert.equal(body.model,'Qwen/Qwen2.5-VL-7B-Instruct');assert.equal(body.temperature,0);
  assert.equal(body.messages[1].content[1].image_url.url,`data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`);
  assert.equal(result.fields.amount_sen,78000);assert.equal(result.request_id,'chatcmpl-1');
  const reason=async(extractor:RunpodVisionExtractor)=>{try{await extractor.extractFields(Buffer.from('x'),'image/png');return 'none';}catch(e){assert.ok(!String((e as Error).message).includes(key));return (e as RunpodError).reason;}};
  assert.equal(await reason(make(reply(500,{error:'boom'}))),'RUNPOD_HTTP_ERROR');
  assert.equal(await reason(make(reply(200,{choices:[{message:{content:'I cannot read this'}}]}))),'RUNPOD_INVALID_OUTPUT');
  assert.equal(await reason(make(async()=>{throw new TypeError('fetch failed');})),'RUNPOD_UNAVAILABLE');
  const hang=async(url:string,init:RequestInit)=>url.endsWith('/models')?new Response('{}',{status:200}):new Promise<Response>((_,reject)=>init.signal!.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));
  assert.equal(await reason(make(hang,30)),'RUNPOD_TIMEOUT');
  // The vLLM console may serve the model id lower-cased; the client uses the served id when only case differs.
  let chatModel='';const served=async(url:string|URL|Request,init?:RequestInit)=>String(url).endsWith('/models')?new Response(JSON.stringify({data:[{id:'qwen/qwen2.5-vl-7b-instruct'}]})):(chatModel=JSON.parse(String(init!.body)).model,new Response(JSON.stringify({choices:[{message:{content:highValueJson}}]})));
  const extractor=make(served);await extractor.extractFields(Buffer.from('x'),'image/png');assert.equal(chatModel,'qwen/qwen2.5-vl-7b-instruct');
});

test('runpod mode requires server-side key and endpoint',()=>{
  assert.throws(()=>readConfig({EXTRACTOR_MODE:'runpod'}));
  assert.throws(()=>readConfig({EXTRACTOR_MODE:'runpod',RUNPOD_API_KEY:'',RUNPOD_ENDPOINT_ID:'abc123'}));
  const c=readConfig({EXTRACTOR_MODE:'runpod',RUNPOD_API_KEY:'rpa_SYNTHETICTESTKEY',RUNPOD_ENDPOINT_ID:'abc123'});
  assert.equal(c.RUNPOD_MODEL,'Qwen/Qwen2.5-VL-7B-Instruct');assert.ok(c.RUNPOD_TIMEOUT_MS<120000);
  assert.throws(()=>readConfig({EXTRACTOR_MODE:'runpod',RUNPOD_API_KEY:'rpa_SYNTHETICTESTKEY',RUNPOD_ENDPOINT_ID:'abc123',RUNPOD_TIMEOUT_MS:'120000'}));
});

const url=process.env.TEST_DATABASE_URL;
test('RunPod provider through the durable worker: GPU fields, CPU fallback, unchanged payment rules',{skip:!url&&process.env.npm_lifecycle_event!=='test:db'},async t=>{
  assert.ok(url,'TEST_DATABASE_URL required');
  const schema=`test_${randomUUID().replaceAll('-','')}`,root=resolve('.local',`test_images_${randomUUID()}`),storage=new LocalReceiptStorage(root);
  const admin=new pg.Pool({connectionString:url,connectionTimeoutMillis:3000});let pool:pg.Pool|undefined,server:Server|undefined,base='',owner='';
  const call=(path:string,body?:unknown)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${owner}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});
  const ok=async(path:string,body?:unknown)=>{const r=await call(path,body),d=await r.json();assert.ok(r.ok,`${path}: ${r.status} ${JSON.stringify(d)}`);return d;};
  // Labelled CPU text that reproduces the high-value fixture exactly, and one that misses the amount.
  const cpuText=(amount:string)=>['Amount: RM '+amount,'Bank transaction ref: DEMO-BANK-780','Customer reference: DEMO-ORDER','Recipient account: DEMO-ACCOUNT-A','Occurred at: 2026-10-22T06:00:00Z','Status: SUCCESS','Document type: TRANSFER_RECEIPT'].join('\n');
  const cpuAgrees={extract:async()=>cpuText('780.00')},cpuDiffers={extract:async()=>cpuText('')};
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,connectionTimeoutMillis:3000});await migrate(pool);await seed(pool);
    const app=createApp(readConfig({DATABASE_URL:url,EXTRACTOR_MODE:'runpod',RUNPOD_API_KEY:'rpa_SYNTHETICTESTKEY',RUNPOD_ENDPOINT_ID:'abc123'}),undefined,pool,storage);
    server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server!.once('listening',r));const address=server.address();assert.ok(address&&typeof address!=='string');base=`http://127.0.0.1:${address.port}/api/v1`;
    owner=(await (await fetch(base+'/demo/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account_id:'20000000-0000-4000-8000-000000000001'})})).json()).token;
    await t.test('GPU fields are stored with provider and request id; payment still needs Owner approval',async()=>{
      const order=(await ok('/orders',{external_id:randomUUID(),total_sen:78000})).order;
      const receipt=(await ok(`/orders/${order.id}/demo-receipt-images`,{fixture_id:'high_value',expected_version:1})).receipt;
      assert.equal(receipt.extraction_state,'PENDING');assert.equal(receipt.fields_provider,'RUNPOD_VLM');
      let sentMime='';const vision:VisionExtractor={engine:'runpod-vllm:test',extractFields:async(bytes,mime)=>{sentMime=mime;assert.deepEqual(bytes,await readFile('fixtures/receipts/high_value.png'));return {...normaliseVisionOutput(highValueJson),raw_text:highValueJson,request_id:'chatcmpl-test',model:'test'};}};
      assert.equal(await processReceiptJob(pool!,storage,cpuAgrees,vision),true);assert.equal(sentMime,'image/png');
      const run=(await ok(`/receipts/${receipt.id}/extractions`)).runs[0];
      assert.equal(run.provider,'RUNPOD_VLM');assert.equal(run.status,'COMPLETED');assert.equal(run.fields.amount_sen,78000);
      const stored=(await pool!.query('SELECT provider_request_id,fallback_reason FROM extraction_runs WHERE receipt_id=$1',[receipt.id])).rows[0];assert.equal(stored.provider_request_id,'chatcmpl-test');assert.equal(stored.fallback_reason,null);
      assert.equal((await ok(`/orders/${order.id}`)).order.payment_state,'UNPAID');
      const v=(await ok(`/orders/${order.id}/verifications`,{receipt_id:receipt.id,expected_version:1})).verification;
      assert.equal(v.result.eligible,true);assert.equal(v.result.required_role,'OWNER');assert.ok(!v.result.flags.includes('MANUAL_FIELDS'));assert.ok(!v.result.flags.includes('MODEL_UNCONFIRMED'));
      assert.deepEqual((await pool!.query('SELECT field_candidates FROM extraction_runs WHERE receipt_id=$1',[receipt.id])).rows[0].field_candidates.disagreements,[]);
    });
    await t.test('Third reader runs only on disagreement, gives advice only and cannot stop the review',async()=>{
      const reading=(amount:string)=>JSON.stringify({...JSON.parse(highValueJson),amount});
      const stub=(json:string)=>({engine:'stub',extractFields:async()=>({...normaliseVisionOutput(json),raw_text:json,request_id:null,model:'stub'})}) as VisionExtractor;
      const run=async(cpu:{extract:()=>Promise<string>},third:VisionExtractor)=>{
        const order=(await ok('/orders',{external_id:randomUUID(),total_sen:78000})).order,receipt=(await ok(`/orders/${order.id}/demo-receipt-images`,{fixture_id:'high_value',expected_version:1})).receipt;
        await processReceiptJob(pool!,storage,cpu,stub(highValueJson),third);
        const stored=(await ok(`/receipts/${receipt.id}/extractions`)).runs[0];
        return {order,stored,v:(await ok(`/orders/${order.id}/verifications`,{receipt_id:receipt.id,expected_version:1})).verification};
      };
      let calls=0;const counted:VisionExtractor={engine:'stub',extractFields:async()=>{calls++;throw Error('should not run');}};
      const agreed=await run(cpuAgrees,counted);assert.equal(calls,0);assert.equal(agreed.stored.field_candidates.third_reading,undefined);
      const backed=await run(cpuDiffers,stub(reading('780.00')));
      assert.equal(backed.stored.field_candidates.third_reading.status,'OK');assert.equal(backed.stored.field_candidates.third_reading.fields.amount_sen.supports,'GPU');
      assert.ok(backed.v.result.flags.includes('MODEL_UNCONFIRMED'));assert.equal(backed.v.result.required_role,'OWNER');
      assert.equal((await ok(`/orders/${backed.order.id}`)).order.payment_state,'UNPAID');
      const neither=await run(cpuDiffers,stub(reading('781.00')));assert.equal(neither.stored.field_candidates.third_reading.fields.amount_sen.supports,'NEITHER');assert.equal(neither.stored.fields.amount_sen,78000);
      const down=await run(cpuDiffers,{engine:'stub',extractFields:async()=>{throw new RunpodError('RUNPOD_TIMEOUT');}});
      assert.deepEqual(down.stored.field_candidates.third_reading,{status:'UNAVAILABLE',reason:'RUNPOD_TIMEOUT'});assert.equal(down.stored.status,'COMPLETED');assert.ok(down.v.result.flags.includes('MODEL_UNCONFIRMED'));
      const base={DATABASE_URL:url,EXTRACTOR_MODE:'runpod',RUNPOD_API_KEY:'rpa_SYNTHETICTESTKEY',RUNPOD_ENDPOINT_ID:'abc123'};
      assert.throws(()=>readConfig({...base,THIRD_READER_MODEL:'some-model'}));assert.throws(()=>readConfig({...base,THIRD_READER_BASE_URL:'http://example.test/v1',THIRD_READER_API_KEY:'synthetic-test-key',THIRD_READER_MODEL:'some-model'}));
    });
    await t.test('Model doubt sends a clean low-value receipt to the Owner, and cannot pass a blocked one',async()=>{
      const unsureJson=(ref:string)=>JSON.stringify({amount:'128.00',currency:'MYR',bank_transaction_ref:ref,customer_reference:'DEMO-ORDER',recipient_account:'DEMO-ACCOUNT-A',occurred_at:'2026-10-22T06:00:00Z',status:'SUCCESS',document_type:'TRANSFER_RECEIPT',uncertain_fields:['amount','not_a_field']});
      const cpu=(ref:string)=>({extract:async()=>['Amount: RM 128.00','Bank transaction ref: '+ref,'Customer reference: DEMO-ORDER','Recipient account: DEMO-ACCOUNT-A','Occurred at: 2026-10-22T06:00:00Z','Status: SUCCESS','Document type: TRANSFER_RECEIPT'].join('\n')});
      const read=async(ref:string,fixture_id:string)=>{
        const order=(await ok('/orders',{external_id:randomUUID(),total_sen:12800})).order,receipt=(await ok(`/orders/${order.id}/demo-receipt-images`,{fixture_id,expected_version:1})).receipt;
        const vision:VisionExtractor={engine:'runpod-vllm:test',extractFields:async()=>({...normaliseVisionOutput(unsureJson(ref)),raw_text:unsureJson(ref),request_id:null,model:'test'})};
        await processReceiptJob(pool!,storage,cpu(ref),vision);
        return {order,receipt,v:(await ok(`/orders/${order.id}/verifications`,{receipt_id:receipt.id,expected_version:1})).verification};
      };
      const clean=await read('DEMO-BANK-128','normal');
      assert.deepEqual(clean.v.result.flags,['MODEL_UNSURE']);assert.equal(clean.v.result.eligible,true);assert.equal(clean.v.result.required_role,'OWNER');
      assert.deepEqual((await ok(`/receipts/${clean.receipt.id}/extractions`)).runs[0].field_candidates.uncertain_fields,['amount_sen']);
      const blocked=await read('DEMO-NOT-BOOKED','no_bank');
      assert.equal(blocked.v.result.eligible,false);assert.ok(blocked.v.result.flags.includes('BANK_NOT_FOUND'));assert.ok(blocked.v.result.flags.includes('MODEL_UNSURE'));
    });
    await t.test('GPU value the CPU reading does not reproduce is flagged MODEL_UNCONFIRMED (Owner only), not blocked',async()=>{
      const order=(await ok('/orders',{external_id:randomUUID(),total_sen:78000})).order;
      const receipt=(await ok(`/orders/${order.id}/demo-receipt-images`,{fixture_id:'high_value',expected_version:1})).receipt;
      const vision:VisionExtractor={engine:'runpod-vllm:test',extractFields:async()=>({...normaliseVisionOutput(highValueJson),raw_text:highValueJson,request_id:null,model:'test'})};
      await processReceiptJob(pool!,storage,cpuDiffers,vision);
      assert.deepEqual((await pool!.query('SELECT field_candidates FROM extraction_runs WHERE receipt_id=$1',[receipt.id])).rows[0].field_candidates.disagreements,['amount_sen']);
      const v=(await ok(`/orders/${order.id}/verifications`,{receipt_id:receipt.id,expected_version:1})).verification;
      assert.ok(v.result.flags.includes('MODEL_UNCONFIRMED'));assert.equal(v.result.required_role,'OWNER');
    });
    await t.test('RunPod failure falls back to CPU and records why; nothing is marked paid',async()=>{
      const order=(await ok('/orders',{external_id:randomUUID(),total_sen:12800})).order;
      const receipt=(await ok(`/orders/${order.id}/demo-receipt-images`,{fixture_id:'scheduled',expected_version:1})).receipt;
      const down:VisionExtractor={engine:'runpod-vllm:test',extractFields:async()=>{throw new RunpodError('RUNPOD_TIMEOUT');}};
      await processReceiptJob(pool!,storage,{extract:async()=>'Status: SCHEDULED'},down);
      const run=(await pool!.query('SELECT provider,fallback_reason,status FROM extraction_runs WHERE receipt_id=$1',[receipt.id])).rows[0];
      assert.equal(run.provider,'CPU_OCR');assert.equal(run.fallback_reason,'RUNPOD_TIMEOUT');assert.equal(run.status,'NEEDS_REVIEW');
      assert.equal((await ok(`/orders/${order.id}/receipts`)).receipts[0].fields_provider,'CPU_OCR');
      assert.equal((await ok(`/orders/${order.id}`)).order.payment_state,'UNPAID');
    });
  }finally{
    await new Promise<void>(r=>server?server.close(()=>r()):r());await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();
    assert.ok(root.startsWith(resolve('.local')+sep)&&/^test_images_[a-f0-9-]+$/.test(basename(root)));await rm(root,{recursive:true,force:true});
  }
});

test('cross-check: a normal match goes to the Cashier only when GPU and CPU readings agree',async()=>{
  const {verify}=await import('../../apps/api/src/modules/verification/rules.js');
  const {fieldDisagreements}=await import('../../apps/api/src/modules/receipts/runpod.js');
  const credit={id:'c1',account_identifier:'DEMO-ACCOUNT-A',active:true,version:1,bank_transaction_ref:'DEMO-BANK-128',amount_sen:12800,currency:'MYR',direction:'CREDIT',status:'BOOKED',booked_at:'2026-10-22T06:00:00Z',allocated:false};
  const base={total_sen:12800,fields:fixtures.normal,accounts:['DEMO-ACCOUNT-A'],transactions:[credit],duplicate_evidence:false,duplicate_reference:false,manual:false};
  assert.equal(verify(base).required_role,'CASHIER');
  const differs=fieldDisagreements(fixtures.normal,{...fixtures.normal,status:'UNKNOWN'});assert.deepEqual(differs,['status']);
  const flagged=verify({...base,model_unconfirmed:differs.length>0});assert.equal(flagged.eligible,true);assert.equal(flagged.required_role,'OWNER');assert.ok(flagged.flags.includes('MODEL_UNCONFIRMED'));
});
