import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {withFinalistEnvironment} from '../../scripts/finalist-environment.js';
import {readConfig} from '../../apps/api/src/config.js';
import {receiveTelegram} from '../../apps/api/src/modules/intake/telegram.js';
import {digest} from '../../apps/api/src/modules/intake/transaction.js';
import {LocalReceiptStorage} from '../../apps/api/src/modules/receipts/storage.js';
import {resetDemoTenant} from '../../apps/api/src/database-setup.js';

const tenant='10000000-0000-4000-8000-000000000001';
const env={EXTRACTOR_MODE:'cpu_ocr',TELEGRAM_ENABLED:'true',TELEGRAM_TENANT_ID:tenant,TELEGRAM_BOT_TOKEN:'synthetic-token-only',TELEGRAM_BOT_USERNAME:'paysah_test_bot',TELEGRAM_WEBHOOK_SECRET:'synthetic-secret-only-0123456789012345',INTAKE_HMAC_SECRET:'synthetic-hmac-only-012345678901234567'};
test('Telegram requires explicit demo_link mode; absent allowlist never opens by accident',()=>{
 assert.throws(()=>readConfig(env));assert.throws(()=>readConfig({...env,TELEGRAM_INTAKE_MODE:'public'}));
 assert.equal(readConfig({...env,TELEGRAM_INTAKE_MODE:'demo_link'}).TELEGRAM_INTAKE_MODE,'demo_link');
 assert.throws(()=>readConfig({...env,TELEGRAM_INTAKE_MODE:'demo_link',TELEGRAM_MAX_IMAGES_PER_HOUR:'0'}));
});
for(const quota of ['sender','tenant','global'] as const)test(`demo_link ${quota} quota is durable, atomic and checked before download`,{skip:!process.env.TEST_DATABASE_URL},async()=>{
 await withFinalistEnvironment(async(_base,pool)=>{
  const root=await mkdtemp(join(tmpdir(),'paysah-tg-demo-')),storage=new LocalReceiptStorage(root);
  try{
   const config=readConfig({...env,TELEGRAM_INTAKE_MODE:'demo_link',TELEGRAM_MAX_IMAGES_PER_HOUR:quota==='sender'?'1':'10',TELEGRAM_MAX_TENANT_IMAGES_PER_DAY:quota==='tenant'?'1':'100',TELEGRAM_MAX_GLOBAL_IMAGES_PER_DAY:quota==='global'?'1':'200'});
   const order=randomUUID(),token=randomBytes(32).toString('base64url'),link=randomUUID();
   await pool.query("INSERT INTO orders(id,tenant_id,external_id,total_sen) VALUES ($1,$2,$3,1900)",[order,tenant,`TG-DEMO-${randomUUID()}`]);
   await pool.query("INSERT INTO intake_links(id,tenant_id,order_id,channel,connector_id,token_hash,expires_at,created_by) VALUES ($1,$2,$3,'TELEGRAM','team-bot',$4,now()+interval '1 hour','20000000-0000-4000-8000-000000000001')",[link,tenant,order,digest(token)]);
   let downloads=0;const sent:string[]=[];
   const download=async()=>{downloads++;return sharp({create:{width:32,height:32,channels:3,background:{r:downloads,g:40,b:60}}}).png().toBuffer();};
   const notify=async(_chat:number,text:string)=>{sent.push(text);};
   const body=(sender:number,id:number,text?:string)=>({update_id:id,message:{message_id:id,from:{id:sender},chat:{id:sender,type:'private'},...(text?{text}:{photo:[{file_id:`sample-${id}`} ]})}});
   const receive=(b:unknown)=>receiveTelegram(pool,config,storage,b,download,notify);
   const a=await receive(body(987,1,`/start ${token}`));assert.equal(a.status,'ACCEPTED');assert.match(sent[0],/not real bank receipts/);
   if(quota!=='sender')assert.equal((await receive(body(654,2,`/start ${token}`))).status,'ACCEPTED');
   const first=body(987,3),second=body(quota==='sender'?987:654,4);
   const results=quota==='sender'?[await receive(first),await receive(second)]:await Promise.all([receive(first),receive(second)]);
   assert.equal(results.filter(r=>r.status==='ACCEPTED').length,1);assert.equal(results.filter(r=>r.reason==='RATE_LIMITED').length,1);assert.equal(downloads,1);
   const accepted=results[0].status==='ACCEPTED'?first:second;
   const replay=await receive(accepted);assert.equal(replay.replayed,true);assert.equal(downloads,1);
   assert.equal((await pool.query("SELECT count(*)::int AS n FROM receipt_jobs WHERE tenant_id=$1",[tenant])).rows[0].n,1);
   assert.equal((await pool.query("SELECT count(*)::int AS n FROM activity_events WHERE action='intake.rejected' AND payload->>'reason'='RATE_LIMITED'")).rows[0].n,1);
   const group=body(987,5,`/start ${token}`);group.message.chat.type='group';assert.equal((await receive(group)).status,'IGNORED');
   const closed=readConfig({...env,TELEGRAM_ALLOWED_SENDERS:'111'});assert.equal((await receiveTelegram(pool,closed,storage,body(987,6,`/start ${token}`),download,notify)).status,'IGNORED');
   await pool.query('UPDATE intake_links SET revoked_at=now() WHERE id=$1',[link]);assert.equal((await receive(body(222,7,`/start ${token}`))).reason,'LINK_INVALID');
   await pool.query("UPDATE intake_links SET revoked_at=NULL,expires_at=now()-interval '1 second' WHERE id=$1",[link]);assert.equal((await receive(body(333,8,`/start ${token}`))).reason,'LINK_INVALID');
   assert.equal((await receive(body(444,9))).reason,'LINK_INVALID');assert.equal(downloads,1);
   const tight=readConfig({...env,TELEGRAM_INTAKE_MODE:'demo_link',TELEGRAM_MAX_STARTS_PER_HOUR:'1'});
   const limited=body(222,10,`/start ${token}`);assert.equal((await receiveTelegram(pool,tight,storage,limited,download,notify)).reason,'RATE_LIMITED');
   assert.equal((await receiveTelegram(pool,tight,storage,limited,download,notify)).replayed,true);
   await resetDemoTenant(pool,tenant);
   assert.equal((await pool.query("SELECT count(*)::int AS n FROM intake_messages WHERE reason='DEMO_RESET_IMAGE'")).rows[0].n,1);
   assert.equal((await receive(accepted)).status,'REJECTED');
   await pool.query("INSERT INTO orders(id,tenant_id,external_id,total_sen) VALUES ($1,$2,$3,1900)",[order,tenant,`TG-RESET-${randomUUID()}`]);
   await pool.query("INSERT INTO intake_links(id,tenant_id,order_id,channel,connector_id,token_hash,expires_at,created_by) VALUES ($1,$2,$3,'TELEGRAM','team-bot',$4,now()+interval '1 hour','20000000-0000-4000-8000-000000000001')",[link,tenant,order,digest(token)]);
   assert.equal((await receive(body(987,12,`/start ${token}`))).status,'ACCEPTED');
   assert.equal((await receive(body(987,13))).reason,'RATE_LIMITED');assert.equal(downloads,1);
   await pool.query('UPDATE tenants SET is_demo=false WHERE id=$1',[tenant]);
   await assert.rejects(receive(body(555,11,`/start ${token}`)),/demo shop/);
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
