import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {APP_STAGE,healthSchema} from '../packages/contracts/src/index.js';

// Usage: npm run replit:cloud-check -- https://<deployment-url>            (first run)
//        npm run replit:cloud-check -- https://<deployment-url> --after-restart  (after Republish/restart)
// Uses only Demo Kedai B, which has no seeded bank credits, so the Demo Kedai A happy paths stay unused for judges.
const [rawUrl,flag]=process.argv.slice(2);
assert.ok(rawUrl&&/^(https:\/\/|http:\/\/127\.0\.0\.1:)/.test(rawUrl),'Pass the https deployment URL');
const site=rawUrl.replace(/\/+$/,''),base=`${site}/api/v1`,after=flag==='--after-restart';
const OWNER_B='20000000-0000-4000-8000-000000000003',CASHIER_A='20000000-0000-4000-8000-000000000002';
// A local dry run (http://127.0.0.1) never writes into the proof folder.
const dir=resolve(site.startsWith('https://')?'submission/proof/replit':'.local/cloud-check-dry-run'),latest=resolve(dir,'cloud-check-latest.json');
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const steps:Array<{name:string;status:'PASS'|'FAIL';detail:string;ms:number}>=[];
async function step(name:string,run:()=>Promise<string>){
  const t=Date.now();
  try{steps.push({name,status:'PASS',detail:await run(),ms:Date.now()-t});}
  catch(e){steps.push({name,status:'FAIL',detail:(e as Error).message.slice(0,200),ms:Date.now()-t});throw e;}
}
async function login(account:string){const r=await fetch(base+'/demo/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account_id:account})});assert.equal(r.status,201,`login ${r.status}`);return (await r.json()).token as string;}
const call=(token:string,path:string,body?:unknown)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});
async function ok(token:string,path:string,body?:unknown){const r=await call(token,path,body);assert.ok(r.ok,`${path} ${r.status}`);return r.json();}
const sha=(b:ArrayBuffer)=>createHash('sha256').update(Buffer.from(b)).digest('hex');

let mode='';
let ids:{order_id:string;receipt_id:string;image_sha256:string}|undefined;
try{
  await step('public page and readiness',async()=>{
    const page=await fetch(site+'/');assert.equal(page.status,200);assert.match(await page.text(),/<div id="root">|PaySah/);
    const readiness=await fetch(base+'/ready');assert.equal(readiness.status,200);assert.equal((await readiness.json()).stage,APP_STAGE);
    const health=healthSchema.parse(await (await fetch(base+'/health')).json());assert.ok(['runpod','cpu_ocr'].includes(health.extractor_mode),'deployment is not in a real reading mode');mode=health.extractor_mode;
    return `page 200, ready 200, extractor_mode ${mode}`;
  });
  const owner=await login(OWNER_B);
  if(!after){
    await step('attach synthetic image and wait for real CPU OCR',async()=>{
      const order=(await ok(owner,'/orders',{external_id:`CLOUD-CHECK-${Date.now()}`,total_sen:12800})).order;
      const receipt=(await ok(owner,`/orders/${order.id}/demo-receipt-images`,{fixture_id:'normal',expected_version:1})).receipt;
      assert.equal(receipt.extraction_state,'PENDING','image was not queued for OCR');
      let run:any;const t=Date.now();
      while(Date.now()-t<180000){run=(await ok(owner,`/receipts/${receipt.id}/extractions`)).runs[0];if(run&&run.status!=='RUNNING')break;await pause(2000);}
      assert.ok(run,'no extraction run after 180 s; is the worker running?');assert.equal(run.status,'COMPLETED');
      ids={order_id:order.id,receipt_id:receipt.id,image_sha256:receipt.image_sha256};
      if(mode==='runpod'&&run.provider!=='RUNPOD_VLM')throw Error(`RunPod not used: provider ${run.provider}, fallback ${run.fallback_reason??'unknown'}`);
      return `${run.provider} ${run.duration_ms} ms; amount ${run.fields.amount_sen}; ref ${run.fields.bank_transaction_ref}`;
    });
  }else{
    ids=JSON.parse(await readFile(latest,'utf8')).ids;assert.ok(ids,'run the first check before --after-restart');
  }
  await step('private image read back with matching SHA-256',async()=>{
    const r=await call(owner,`/receipts/${ids!.receipt_id}/image`);assert.equal(r.status,200);
    assert.equal(sha(await r.arrayBuffer()),ids!.image_sha256);assert.equal(r.headers.get('cache-control'),'no-store');
    return 'image 200, hash matches, no-store';
  });
  await step('rules run; Kedai B evidence stays blocked and unpaid',async()=>{
    const v=(await ok(owner,`/orders/${ids!.order_id}/verifications`,{receipt_id:ids!.receipt_id,expected_version:1})).verification;
    assert.equal(v.result.eligible,false);
    const order=(await ok(owner,`/orders/${ids!.order_id}`)).order;assert.equal(order.payment_state,'UNPAID');
    return `blocked: ${v.result.flags.join(', ')}; order UNPAID`;
  });
  await step('other tenant cannot read this order or image',async()=>{
    const other=await login(CASHIER_A);
    assert.equal((await call(other,`/orders/${ids!.order_id}`)).status,404);assert.equal((await call(other,`/receipts/${ids!.receipt_id}/image`)).status,404);
    return 'Kedai A Cashier gets 404 for both';
  });
}catch{/* recorded in steps */}
const report={kind:after?'replit cloud check after restart':'replit cloud check',url:site,at:new Date().toISOString(),passed:steps.filter(s=>s.status==='PASS').length,total:steps.length,ids,steps};
await mkdir(dir,{recursive:true});
await writeFile(resolve(dir,`cloud-check${after?'-after-restart':''}-${report.at.replaceAll(':','-').replace('.','-')}.json`),JSON.stringify(report,null,2)+'\n');
if(!after&&report.passed===report.total)await writeFile(latest,JSON.stringify(report,null,2)+'\n');
for(const s of steps)console.log(`${s.status}: ${s.name} — ${s.detail}`);
const failed=steps.some(s=>s.status==='FAIL');
console.log(failed?'FAIL. Report saved in '+dir:`PASS ${report.passed}/${report.total}. Report saved in ${dir}`);
if(failed)process.exitCode=1;
