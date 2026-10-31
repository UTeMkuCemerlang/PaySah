import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve,sep} from 'node:path';
import {rm,mkdir,copyFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import sharp from 'sharp';
import type {Server} from 'node:http';
import {migrate,seed} from '../../scripts/database.js';
import {createApp} from '../../apps/api/src/app.js';
import {readConfig} from '../../apps/api/src/config.js';
import {LocalReceiptStorage} from '../../apps/api/src/modules/receipts/storage.js';
import {processReceiptJob} from '../../apps/api/src/modules/receipts/worker.js';
import {processVerificationJob} from '../../apps/api/src/modules/verification/worker.js';
import {digest} from '../../apps/api/src/modules/intake/transaction.js';
import {telegramDownloader,telegramNotifier} from '../../apps/api/src/modules/intake/telegram.js';

const tenant='10000000-0000-4000-8000-000000000001',url=process.env.TEST_DATABASE_URL;
const secret='synthetic-channel-secret-0123456789012345';
const env={TELEGRAM_ENABLED:'true',TELEGRAM_TENANT_ID:tenant,TELEGRAM_BOT_TOKEN:'synthetic-token-only',TELEGRAM_BOT_USERNAME:'paysah_test_bot',TELEGRAM_WEBHOOK_SECRET:secret,TELEGRAM_ALLOWED_SENDERS:'123',INTAKE_HMAC_SECRET:secret,GOOGLE_FORM_ENABLED:'true',GOOGLE_FORM_TENANT_ID:tenant,GOOGLE_FORM_INGEST_KEY:secret,GOOGLE_FORM_PREFILL_URL:'https://docs.google.com/forms/d/e/synthetic/viewform?entry.1={token}',EXTRACTOR_MODE:'cpu_ocr'};
const reading='Amount: RM 19.00\nBank transaction ref: INTAKE-ONLY\nRecipient account: INTAKE-ACCOUNT\nOccurred at: 2026-10-23T00:00:00Z\nStatus: SUCCESS\nDocument type: TRANSFER_RECEIPT';

test('intake configuration is explicit and disabled without secrets',()=>{
 assert.equal(readConfig({}).TELEGRAM_ENABLED,'false');assert.throws(()=>readConfig({TELEGRAM_ENABLED:'true'}));
 assert.throws(()=>readConfig({GOOGLE_FORM_ENABLED:'true'}));assert.equal(readConfig(env).TELEGRAM_ENABLED,'true');
});
test('Telegram download rejects redirects, unsafe paths, oversized streams and hides credentials',async()=>{
 const config=readConfig(env);let calls=0;
 const fetcher=(async(_url:unknown,init:any)=>{calls++;assert.equal(init.redirect,'error');return new Response(JSON.stringify({ok:true,result:{file_path:'../private'}}));}) as typeof fetch;
 await assert.rejects(telegramDownloader(config,fetcher)('id'),/Unsupported file/);assert.equal(calls,1);
 let step=0;await assert.rejects(telegramDownloader(config,(async()=>++step===1?new Response(JSON.stringify({ok:true,result:{file_path:'photos/a.png'}})):new Response(new Uint8Array(10485761))) as typeof fetch)('id'),/File too large/);
 await assert.rejects(telegramDownloader(config,(async()=>{throw Error('synthetic-token-only');}) as typeof fetch)('id'),e=>e instanceof Error&&!e.message.includes('synthetic-token-only'));
});
test('P1-5 notifier targets only the configured allowlist and sends only chat_id/text without redirects',async()=>{
 const calls:any[]=[],notify=telegramNotifier(readConfig(env),(async(url,init)=>{calls.push({url,init});return new Response('{"ok":true}');}) as typeof fetch);
 await notify(456,'not sent');assert.equal(calls.length,0);await notify(123,'synthetic acknowledgement');assert.equal(calls.length,1);
 assert.equal(calls[0].init.redirect,'error');assert.deepEqual(JSON.parse(calls[0].init.body),{chat_id:123,text:'synthetic acknowledgement'});
 assert.match(String(calls[0].url),/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/);
});

test('005 upgrades an existing four-migration database without rewriting history',{skip:!url},async()=>{
 assert.ok(url);const schema='test_upgrade_'+randomUUID().replaceAll('-',''),root=resolve('.local','upgrade_'+randomUUID());
 const admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);await mkdir(resolve(root,'db/migrations'),{recursive:true});await mkdir(resolve(root,'db/seeds'),{recursive:true});
  for(const file of (await readdir('db/migrations')).filter(x=>/^00[1-4]_/.test(x)))await copyFile(resolve('db/migrations',file),resolve(root,'db/migrations',file));
  for(const file of ['001_demo.sql','002_verification.sql'])await copyFile(resolve('db/seeds',file),resolve(root,'db/seeds',file));
  await migrate(pool,root);await seed(pool,root);const before=(await pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
  await migrate(pool);await seed(pool);
  const after=(await pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;assert.deepEqual(after.slice(0,4),before);assert.equal(after.length,8);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE role='SYSTEM'")).rows[0].n,2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders WHERE payment_state='UNPAID'")).rows[0].n,6);
 }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();assert.ok(root.startsWith(resolve('.local')+sep));await rm(root,{recursive:true,force:true});}
});

test('I0/I1 tenant isolation, durable intake and human-only payment',{skip:!url},async t=>{
 assert.ok(url);const schema='test_'+randomUUID().replaceAll('-',''),root=resolve('.local','test_intake_'+randomUUID()),storage=new LocalReceiptStorage(root);
 const admin=new pg.Pool({connectionString:url,connectionTimeoutMillis:3000});let pool:pg.Pool|undefined,server:Server|undefined,base='',owner='',other='',downloadCount=0,color=0,updateId=1;
 let fakeNow=Date.now();
 let ackProbe:string|undefined,ackFailure=false;const acknowledgements:any[]=[];
 let download:(id:string)=>Promise<Buffer>=async()=>png();
 const config=readConfig(env);
 const png=()=>sharp({create:{width:24,height:24,channels:3,background:{r:++color%255,g:20,b:30}}}).png().toBuffer();
 const call=(path:string,body?:unknown,token=owner,key:string=randomUUID())=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':key},body:body===undefined?undefined:JSON.stringify(body)});
 const ok=async(path:string,body?:unknown,token=owner,key?:string)=>{const r=await call(path,body,token,key),b=await r.json();assert.ok(r.ok,JSON.stringify(b));return b;};
 const order=async()=> (await ok('/orders',{external_id:'INTAKE-'+randomUUID(),total_sen:1900})).order;
 const link=async(id:string,channel='TELEGRAM')=>{const r=await ok(`/orders/${id}/intake-links`,{expected_version:1,channel});return {...r,token:new URL(r.url).searchParams.get(channel==='TELEGRAM'?'start':'entry.1')!};};
 const update=(text?:string):any=>({update_id:updateId++,message:{message_id:updateId,from:{id:123},chat:{id:123,type:'private'},...(text?{text}:{document:{file_id:'synthetic-image',mime_type:'image/png'}})}});
 const telegram=(body:unknown,credential=secret)=>fetch(base+'/intake/telegram',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':credential},body:JSON.stringify(body)});
 const form=(body:unknown)=>fetch(base+'/intake/google-form',{method:'POST',headers:{'Content-Type':'application/json','X-Intake-Key':secret},body:JSON.stringify(body)});
 const query=async(sql:string,args:unknown[]=[])=>pool!.query(sql,args);
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,connectionTimeoutMillis:3000});
  await migrate(pool);await seed(pool);
  const app=createApp(config,undefined,pool,storage,{now:()=>fakeNow+=60001,telegramDownload:async id=>{downloadCount++;return download(id);},telegramFetch:(async(_url,init)=>{
   const body=JSON.parse(String(init?.body)),committed=!ackProbe||!!(await query("SELECT id FROM intake_messages WHERE channel='TELEGRAM' AND external_id=$1 AND status IN ('ACCEPTED','REJECTED')",[ackProbe])).rowCount;
   acknowledgements.push({...body,committed});if(ackFailure)throw Error('synthetic-token-only must never enter a log');return new Response('{"ok":true}');
  }) as typeof fetch});server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server!.once('listening',r));const address=server.address();assert.ok(address&&typeof address!=='string');base=`http://127.0.0.1:${address.port}/api/v1`;
  owner=(await ok('/demo/sessions',{account_id:'20000000-0000-4000-8000-000000000001'},'')).token;other=(await ok('/demo/sessions',{account_id:'20000000-0000-4000-8000-000000000003'},'')).token;
  // Every payment target and incoming credit in these checks is independent from DEMO-A orders/credits.
  const account=randomUUID();await query('INSERT INTO merchant_accounts(id,tenant_id,account_identifier) VALUES ($1,$2,$3)',[account,tenant,'INTAKE-ACCOUNT']);
  await query("INSERT INTO bank_transactions(id,tenant_id,account_id,provider_tx_id,bank_transaction_ref,amount_sen,currency,direction,status,booked_at,source_kind) VALUES ($1,$2,$3,'INTAKE-ONLY','INTAKE-ONLY',1900,'MYR','CREDIT','BOOKED','2026-10-23T00:00:00Z','SYNTHETIC_FEED')",[randomUUID(),tenant,account]);
  await t.test('SYSTEM is hidden, cannot login or restore a forged old session, including payment endpoints',async()=>{
   const system=(await query("SELECT id FROM users WHERE tenant_id=$1 AND role='SYSTEM'",[tenant])).rows[0];
   assert.equal((await ok('/demo/accounts')).accounts.length,4);assert.equal((await call('/demo/sessions',{account_id:system.id},'')).status,404);
   const token='x'.repeat(43);await query("INSERT INTO demo_sessions(token_hash,tenant_id,user_id,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')",[digest(token),tenant,system.id]);
   for(const path of ['/session','/orders/'+randomUUID()+'/release','/verifications/'+randomUUID()+'/confirm','/approvals/'+randomUUID()+'/decision'])assert.equal((await call(path,path==='/session'?undefined:{expected_version:1},token)).status,401);
  });
  await t.test('link tokens are one-time response only, human/version/tenant protected and revoked by regeneration',async()=>{
   const o=await order(),key=randomUUID(),body={expected_version:1,channel:'TELEGRAM'};
   const a=await ok(`/orders/${o.id}/intake-links`,body,owner,key),token=new URL(a.url).searchParams.get('start');assert.ok(token);
   const b=await ok(`/orders/${o.id}/intake-links`,body,owner,key);assert.equal(b.link_id,a.link_id);assert.equal(b.url,null);
   assert.equal((await call(`/orders/${o.id}/intake-links`,body,other)).status,404);assert.equal((await call(`/orders/${o.id}/intake-links`,{...body,expected_version:2})).status,409);
   assert.ok(!JSON.stringify((await query('SELECT * FROM idempotency_keys')).rows).includes(token));assert.ok(!JSON.stringify((await query('SELECT * FROM activity_events')).rows).includes(token));
   await link(o.id);const rejected=await (await telegram(update('/start '+token))).json();assert.equal(rejected.status,'REJECTED');
  });
  let accepted:any;
  await t.test('mock Telegram image is idempotent under concurrent redelivery and auto-checks after OCR without paying',async()=>{
   const o=await order(),l=await link(o.id);assert.equal((await (await telegram(update('/start '+l.token))).json()).status,'ACCEPTED');
   const image=await png();download=async()=>image;const body=update();const responses=await Promise.all([telegram(body),telegram(body)]);assert.ok(responses.some(r=>r.status===200));
   const repeat=await (await telegram(body)).json();assert.equal(repeat.status,'ACCEPTED');assert.equal(repeat.replayed,true);
   const rows=(await query('SELECT * FROM receipts WHERE order_id=$1',[o.id])).rows;assert.equal(rows.length,1);accepted=rows[0];assert.equal(accepted.intake_channel,'TELEGRAM');
   assert.equal((await query('SELECT count(*)::int AS n FROM receipt_jobs WHERE receipt_id=$1',[accepted.id])).rows[0].n,1);
   await processReceiptJob(pool!,storage,{extract:async()=>reading});assert.equal((await query('SELECT count(*)::int AS n FROM verification_jobs WHERE receipt_id=$1',[accepted.id])).rows[0].n,1);
   // Recover a claimed verification after an artificial restart/expired lease.
   await query("UPDATE verification_jobs SET status='RUNNING',lease_token=$2,lease_until=now()-interval '1 second' WHERE receipt_id=$1",[accepted.id,randomUUID()]);
   assert.equal(await processVerificationJob(pool!,storage),true);
   const review=await ok(`/orders/${o.id}/review`);assert.equal(review.order.payment_state,'UNPAID');assert.equal(review.order.fulfillment_state,'ON_HOLD');assert.ok(review.verification.result.eligible);
   const manual=await ok(`/orders/${o.id}/verifications`,{receipt_id:accepted.id,expected_version:1});assert.equal(manual.verification.id,review.verification.id);assert.equal(manual.reused,true);
   const conflict=structuredClone(body);conflict.message.document.file_id='changed';assert.equal((await telegram(conflict)).status,409);
   const message=(await query("SELECT id,status FROM intake_messages WHERE channel='TELEGRAM' AND external_id=$1",[String(body.update_id)])).rows[0];
   assert.equal(message.status,'ACCEPTED');assert.equal((await query("SELECT count(*)::int AS n FROM activity_events WHERE entity_id=$1 AND payload->>'reason'='IDEMPOTENCY_CONFLICT'",[message.id])).rows[0].n,1);
   assert.equal((await query('SELECT count(*)::int AS n FROM payment_allocations')).rows[0].n,0);
  });
  await t.test('authentication runs before channel JSON parsing',async()=>{
   const r=await fetch(base+'/intake/telegram',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':'wrong'},body:'not json'});assert.equal(r.status,401);
  });
  const ignoredOrder=await order(),ignoredLink=await link(ignoredOrder.id);await telegram(update('/start '+ignoredLink.token));
  const ignoredCases:Array<[string,()=>unknown]>=[
   ['edited_message',()=>({update_id:updateId++,edited_message:{message_id:1,text:'edited'}})],
   ['my_chat_member',()=>({update_id:updateId++,my_chat_member:{}})],
   ['missing message',()=>({update_id:updateId++})],
   ['malformed message',()=>({update_id:updateId++,message:{text:'missing sender'}})],
   ['group chat',()=>({...update(),message:{...update().message,chat:{id:-1,type:'group'}}})],
   ['chat and sender mismatch',()=>{const b=update();b.message.chat.id=124;return b;}],
   ['non-allowlisted private sender',()=>{const b=update();b.message.from.id=456;b.message.chat.id=456;return b;}],
   ['ordinary text',()=>update('Hello team')],
   ['sticker',()=>({update_id:updateId++,message:{message_id:updateId,from:{id:123},chat:{id:123,type:'private'},sticker:{file_id:'synthetic-sticker'}}})],
  ];
  for(const [name,body] of ignoredCases)await t.test(`P0-2 ignored ${name}: 200 without durable side effects`,async()=>{
   const before=(await query('SELECT (SELECT count(*) FROM intake_messages)::int AS messages,(SELECT count(*) FROM activity_events)::int AS events')).rows[0];
   const bindings=(await query('SELECT * FROM intake_bindings ORDER BY sender_hash')).rows;
   const sent=acknowledgements.length,result=await telegram(body());assert.equal(result.status,200);assert.deepEqual(await result.json(),{status:'IGNORED'});assert.equal(acknowledgements.length,sent);
   assert.deepEqual((await query('SELECT (SELECT count(*) FROM intake_messages)::int AS messages,(SELECT count(*) FROM activity_events)::int AS events')).rows[0],before);
   assert.deepEqual((await query('SELECT * FROM intake_bindings ORDER BY sender_hash')).rows,bindings);
  });
  await t.test('P1-5 acknowledgements follow commit, failures preserve HTTP result, replay does not resend',async st=>{
   const o=await order(),l=await link(o.id),start=update('/start '+l.token);ackProbe=String(start.update_id);
   assert.equal((await (await telegram(start)).json()).status,'ACCEPTED');assert.deepEqual(acknowledgements.at(-1),{chat_id:123,text:`Connected to order ${o.external_id}. This is a demo. Send only sample receipt images, not real bank receipts.`,committed:true});
   download=async()=>png();const image=update();ackProbe=String(image.update_id);assert.equal((await (await telegram(image)).json()).status,'ACCEPTED');assert.deepEqual(acknowledgements.at(-1),{chat_id:123,text:'Receipt received. The shop will check it. This does not mean the payment is confirmed.',committed:true});
   const sent=acknowledgements.length;assert.equal((await (await telegram(image)).json()).replayed,true);assert.equal(acknowledgements.length,sent);
   const warn=st.mock.method(console,'warn',()=>{}),next=update();ackProbe=String(next.update_id);ackFailure=true;
   const response=await telegram(next);assert.equal(response.status,200);assert.equal((await response.json()).status,'ACCEPTED');assert.equal(acknowledgements.length,sent+1);assert.equal(warn.mock.calls.length,1);assert.ok(!JSON.stringify(warn.mock.calls.map(c=>c.arguments)).includes('synthetic-token-only'));assert.equal(acknowledgements.at(-1).committed,true);
   ackFailure=false;download=async()=>Buffer.from('bad image');const bad=update();ackProbe=String(bad.update_id);assert.equal((await (await telegram(bad)).json()).reason,'IMAGE_INVALID');assert.deepEqual(acknowledgements.at(-1),{chat_id:123,text:'Could not accept this: the image is invalid or not supported.',committed:true});
   const invalid=update('/start '+'a'.repeat(43));ackProbe=String(invalid.update_id);assert.equal((await (await telegram(invalid)).json()).reason,'LINK_INVALID');assert.match(acknowledgements.at(-1).text,/submission link is invalid or has expired/);assert.equal(acknowledgements.at(-1).committed,true);ackProbe=undefined;
  });
  await t.test('retry preserves original order binding during /start rebind and rejects out-of-order messages',async()=>{
   const a=await order(),b=await order(),la=await link(a.id),lb=await link(b.id);
   await telegram(update('/start '+la.token));const body=update();download=async()=>{throw Error('network');};assert.equal((await telegram(body)).status,503);
   await telegram(update('/start '+lb.token));download=async()=>png();assert.equal((await (await telegram(body)).json()).status,'ACCEPTED');
   assert.equal((await query('SELECT order_id FROM intake_messages WHERE external_id=$1 AND channel=$2',[String(body.update_id),'TELEGRAM'])).rows[0].order_id,a.id);
   const old=update('/start '+la.token);old.update_id=body.update_id-1;assert.equal((await telegram(old)).status,409);
   const stale=update();stale.message.message_id=1;assert.equal((await (await telegram(stale)).json()).reason,'STALE_MESSAGE');
  });
  await t.test('downloads run outside tenant locks; revoke or payment during download rejects without saving',async()=>{
   for(const action of ['revoke','paid']){
    const o=await order(),l=await link(o.id);await telegram(update('/start '+l.token));let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);download=async()=>{entered();await hold;return png();};
    const receiving=telegram(update());await started;
    if(action==='revoke')await ok(`/orders/${o.id}/intake-links/${l.link_id}/revoke`,{expected_version:1});else await query("UPDATE orders SET payment_state='PAID' WHERE id=$1",[o.id]);release();
    assert.equal((await (await receiving).json()).status,'REJECTED');assert.equal((await query('SELECT count(*)::int AS n FROM receipts WHERE order_id=$1',[o.id])).rows[0].n,0);
   }
  });
  await t.test('R-01: seven-second storage upload does not block a same-tenant employee write',async()=>{
   const a=await order(),b=await order(),l=await link(a.id,'GOOGLE_FORM'),bytes=await png();
   const original=storage.put.bind(storage);let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
   storage.put=async(tenant,bytes)=>{entered();await new Promise(r=>setTimeout(r,7000));return original(tenant,bytes);};
   let pending:Promise<Response>|undefined;
   try{
    pending=form({response_id:'slow_storage',submission_token:l.token,mime_type:'image/png',image_base64:bytes.toString('base64')});await started;
    const before=performance.now();await link(b.id,'GOOGLE_FORM');assert.ok(performance.now()-before<1000,'employee link creation must finish within 1s');
    assert.equal((await (await pending).json()).status,'ACCEPTED');
   }finally{await pending?.catch(()=>{});storage.put=original;}
  });
  await t.test('R-01: revocation after upload deletes the unreferenced prepared object',async()=>{
   const o=await order(),l=await link(o.id,'GOOGLE_FORM'),bytes=await png(),before=(await storage.candidates(Date.now()+60000)).sort();
   const original=storage.put.bind(storage);let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
   storage.put=async(tenant,bytes)=>{const key=await original(tenant,bytes);entered();await hold;return key;};
   let pending:Promise<Response>|undefined;
   try{
    pending=form({response_id:'revoke_after_upload',submission_token:l.token,mime_type:'image/png',image_base64:bytes.toString('base64')});await started;
    await ok(`/orders/${o.id}/intake-links/${l.link_id}/revoke`,{expected_version:1});release();assert.equal((await (await pending).json()).status,'REJECTED');
    assert.deepEqual((await storage.candidates(Date.now()+60000)).sort(),before);
   }finally{release();await pending?.catch(()=>{});storage.put=original;}
  });
  await t.test('permanent bad image persists REJECTED and retries do not download it again',async()=>{
   const o=await order(),l=await link(o.id);await telegram(update('/start '+l.token));download=async()=>Buffer.from('bad');const body=update(),before=downloadCount;
   assert.equal((await (await telegram(body)).json()).reason,'IMAGE_INVALID');assert.equal((await (await telegram(body)).json()).replayed,true);assert.equal(downloadCount,before+1);
  });
  await t.test('a transaction failure after object save cleans up bytes and remains retryable',async()=>{
   const o=await order(),l=await link(o.id);await telegram(update('/start '+l.token));download=async()=>png();const body=update();
   const before=await storage.candidates(Date.now()+10000);
   await query(`CREATE FUNCTION synthetic_intake_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='intake.received' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$`);
   await query('CREATE TRIGGER synthetic_intake_failure BEFORE INSERT ON activity_events FOR EACH ROW EXECUTE FUNCTION synthetic_intake_failure()');
   assert.equal((await telegram(body)).status,503);await query('DROP TRIGGER synthetic_intake_failure ON activity_events');
   assert.deepEqual(await storage.candidates(Date.now()+10000),before);assert.equal((await query('SELECT count(*)::int AS n FROM receipts WHERE order_id=$1',[o.id])).rows[0].n,0);
   assert.equal((await (await telegram(body)).json()).status,'ACCEPTED');
  });
  await t.test('Google Form locked contract, strict MIME/base64 and independent connector idempotency',async()=>{
   const o=await order(),l=await link(o.id,'GOOGLE_FORM'),image=await png(),body={response_id:'response_1',submission_token:l.token,mime_type:'image/png',image_base64:image.toString('base64')};
   const r=await form(body);assert.equal(r.status,200);assert.equal((await r.json()).status,'ACCEPTED');assert.equal((await (await form(body)).json()).replayed,true);
   assert.equal((await form({...body,image_base64:body.image_base64+'\n'})).status,422);
   assert.equal((await form({...body,response_id:'mime_mismatch',mime_type:'image/jpeg'})).status,200);assert.equal((await query("SELECT reason FROM intake_messages WHERE external_id='mime_mismatch'")).rows[0].reason,'IMAGE_INVALID');
   assert.equal((await form({...body,image_base64:(await png()).toString('base64')})).status,409);
   assert.equal((await form({...body,response_id:'foreign_token',submission_token:'a'.repeat(43)})).status,200);
  });
  await t.test('old extraction output never supersedes a new receipt; old verification cannot override corrections',async()=>{
   await query("UPDATE receipt_jobs SET status='CANCELLED' WHERE status IN ('PENDING','RUNNING')");
   const o=await order(),l=await link(o.id);await telegram(update('/start '+l.token));download=async()=>png();await telegram(update());
   let entered!:()=>void,release!:(text:string)=>void;const start=new Promise<void>(r=>entered=r),hold=new Promise<string>(r=>release=r);
   const pending=processReceiptJob(pool!,storage,{extract:async()=>{entered();return hold;}});await start;
   await telegram(update());release(reading);await pending;
   const history=(await query('SELECT * FROM receipts WHERE order_id=$1 AND id<>(SELECT current_receipt_id FROM orders WHERE id=$1)',[o.id])).rows[0];
   assert.equal((await call(`/receipts/${history.id}/corrections`,{expected_revision:history.revision,expected_version:1,fields:history.fields,reason:'Old evidence must not change the current review'})).status,409);
   await assert.rejects(query('UPDATE orders SET current_receipt_id=$2 WHERE id=$1',[o.id,accepted.id]),e=>(e as {code?:string}).code==='23503');
   assert.equal((await query('SELECT extraction_state FROM receipts WHERE id=(SELECT current_receipt_id FROM orders WHERE id=$1)',[o.id])).rows[0].extraction_state,'PENDING');
   assert.equal((await query("SELECT count(*)::int AS n FROM verifications WHERE order_id=$1 AND active",[o.id])).rows[0].n,0);
   await processReceiptJob(pool!,storage,{extract:async()=>reading});
   const latest=(await query('SELECT * FROM receipts WHERE id=(SELECT current_receipt_id FROM orders WHERE id=$1)',[o.id])).rows[0];
   await ok(`/receipts/${latest.id}/corrections`,{expected_revision:latest.revision,expected_version:1,fields:{...latest.fields,status:'PENDING'},reason:'Independent synthetic correction'});
   while(await processVerificationJob(pool!,storage)){}
   assert.equal((await query("SELECT status FROM verification_jobs WHERE receipt_id=$1",[latest.id])).rows[0].status,'CANCELLED');
   assert.equal((await query('SELECT fields FROM receipts WHERE id=$1',[latest.id])).rows[0].fields.status,'PENDING');
  });
  await t.test('expired link is rejected and repeated transient failures exhaust bounded attempts',async()=>{
   const o=await order(),l=await link(o.id);await telegram(update('/start '+l.token));const body=update();download=async()=>{throw Error('offline');};
   for(let n=0;n<3;n++)assert.equal((await telegram(body)).status,503);assert.equal((await (await telegram(body)).json()).reason,'ATTEMPTS_EXHAUSTED');
   await query("UPDATE intake_links SET expires_at=now()-interval '1 second' WHERE id=$1",[l.link_id]);assert.equal((await (await telegram(update())).json()).reason,'LINK_INVALID');
  });
  await t.test('P1-6 R-05 invalid token persists only the rejected message, without staff activity',async()=>{
   const before=(await query('SELECT count(*)::int AS n FROM activity_events')).rows[0].n;
   const response=await form({response_id:'no_order_link',submission_token:'c'.repeat(43),mime_type:'image/png',image_base64:(await png()).toString('base64')});
   assert.equal(response.status,200);assert.equal((await response.json()).reason,'LINK_INVALID');
   const message=(await query("SELECT status,order_id FROM intake_messages WHERE external_id='no_order_link'")).rows[0];assert.equal(message.status,'REJECTED');assert.equal(message.order_id,null);
   assert.equal((await query('SELECT count(*)::int AS n FROM activity_events')).rows[0].n,before);
  });
  await t.test('P1-6 R-03 old image resubmission keeps the newer evidence and records reused/current flags',async()=>{
   const o=await order(),l=await link(o.id,'GOOGLE_FORM'),x=await png(),y=await png();
   const payload=(id:string,bytes:Buffer)=>({response_id:id,submission_token:l.token,mime_type:'image/png',image_base64:bytes.toString('base64')});
   assert.equal((await (await form(payload('old_x',x))).json()).status,'ACCEPTED');assert.equal((await (await form(payload('new_y',y))).json()).status,'ACCEPTED');
   const current=(await query('SELECT current_receipt_id FROM orders WHERE id=$1',[o.id])).rows[0].current_receipt_id;
   assert.deepEqual(await (await form(payload('old_x_again',x))).json(),{status:'ACCEPTED',reason:null,replayed:false});
   assert.equal((await query('SELECT current_receipt_id FROM orders WHERE id=$1',[o.id])).rows[0].current_receipt_id,current);
   assert.equal((await query('SELECT count(*)::int AS n FROM receipts WHERE order_id=$1',[o.id])).rows[0].n,2);
   const event=(await query("SELECT payload FROM activity_events WHERE action='intake.received' AND entity_id=(SELECT id FROM intake_messages WHERE external_id='old_x_again')")).rows[0].payload;assert.equal(event.reused,true);assert.equal(event.current,false);
  });
  await t.test('P1-6 C-01/C-02: 503 may omit Retry-After and the server stops at three reception attempts',async()=>{
   const o=await order(),l=await link(o.id);await telegram(update('/start '+l.token));const body=update(),before=downloadCount;download=async()=>{throw Error('temporary offline');};
   for(let i=0;i<3;i++){const response=await telegram(body);assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),null);await response.json();}
   assert.equal((await (await telegram(body)).json()).reason,'ATTEMPTS_EXHAUSTED');assert.equal(downloadCount,before+3);
   assert.equal((await query("SELECT attempts FROM intake_messages WHERE channel='TELEGRAM' AND external_id=$1",[String(body.update_id)])).rows[0].attempts,3);
  });
  await t.test('10MiB image boundary, JSON body limit and a real other-tenant token are enforced',async()=>{
   const o=await order(),l=await link(o.id,'GOOGLE_FORM'),image=await png(),bytes=Buffer.concat([image,Buffer.alloc(10485760-image.length)]);
   const body={response_id:'boundary',submission_token:l.token,mime_type:'image/png',image_base64:bytes.toString('base64')};
   assert.equal((await (await form(body)).json()).status,'ACCEPTED');
   assert.equal((await form({...body,response_id:'too_big',image_base64:Buffer.alloc(10485761).toString('base64')})).status,413);
   const oversized=await fetch(base+'/intake/google-form',{method:'POST',headers:{'Content-Type':'application/json','X-Intake-Key':secret},body:' '.repeat(15*1024*1024+1)});assert.equal(oversized.status,413);
   const foreign=(await ok('/orders',{external_id:'FOREIGN-'+randomUUID(),total_sen:1900},other)).order,token='b'.repeat(43);
   await query("INSERT INTO intake_links(id,tenant_id,order_id,channel,connector_id,token_hash,expires_at,created_by) VALUES ($1,$2,$3,'GOOGLE_FORM','team-form',$4,now()+interval '1 hour',$5)",[randomUUID(),'10000000-0000-4000-8000-000000000002',foreign.id,digest(token),'20000000-0000-4000-8000-000000000003']);
   assert.equal((await (await form({...body,response_id:'real_cross_tenant',submission_token:token,image_base64:image.toString('base64')})).json()).reason,'LINK_INVALID');
  });
 }finally{
  server?.closeAllConnections();if(server)await new Promise<void>(r=>server!.close(()=>r()));await pool?.end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();
  const allowed=resolve('.local')+sep;assert.ok(root.startsWith(allowed));await rm(root,{recursive:true,force:true});
 }
});
