import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {withFinalistEnvironment} from './finalist-environment.js';

if(process.argv.length>2)throw Error('Only isolated local fixture evaluation is supported');
let commit='unknown';try{commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();}catch{}
const cases=[['normal',true,12800],['high_value',true,78000],['wrong_account',false,12800],['scheduled',false,12800],['money_request',false,12800],['partial',false,12800],['no_bank',false,12800],['duplicate',false,12800]] as const;
const rows=[];
for(const [case_id,expected,total_sen]of cases){
 rows.push(await withFinalistEnvironment(async base=>{
  const started=new Date().toISOString(),start=performance.now();let token='';
  async function call(path:string,body?:unknown){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
  token=(await call('/demo/sessions',{account_id:'20000000-0000-4000-8000-000000000001'})).body.token;
  const order=(await call('/orders',{external_id:`EVAL-${randomUUID()}`,total_sen})).body.order;
  if(case_id==='duplicate'){
   const prior=(await call('/orders',{external_id:`EVAL-PRIOR-${randomUUID()}`,total_sen})).body.order;
   assert.equal((await call(`/orders/${prior.id}/receipts`,{source:'FIXTURE',fixture_id:'normal',expected_version:1})).status,201);
  }
  const receipt=(await call(`/orders/${order.id}/receipts`,{source:'FIXTURE',fixture_id:case_id==='duplicate'?'normal':case_id,expected_version:1})).body.receipt;
  const response=await call(`/orders/${order.id}/verifications`,{receipt_id:receipt.id,expected_version:1});assert.equal(response.status,201);
  const v=response.body.verification;let actionStatus:number;
  if(expected&&v.result.required_role==='CASHIER')actionStatus=(await call(`/verifications/${v.id}/confirm`,{expected_version:1})).status;
  else{const a=(await call(`/verifications/${v.id}/approval-requests`,{expected_version:1})).body.approval;actionStatus=(await call(`/approvals/${a.id}/decision`,{decision:'APPROVE',reason:'Known-answer synthetic evaluation',expected_version:1})).status;}
  const paid=(await call(`/orders/${order.id}`)).body.order;
  const release=await call(`/orders/${order.id}/release`,{expected_version:paid.version});
  const actual=(await call(`/orders/${order.id}`)).body.order;
  return {case_id,dataset_version:'team-structured-fixtures-v1',provider:'FIXTURE',channel:'DASHBOARD',started_at:started,ended_at:new Date().toISOString(),elapsed_ms:Math.round(performance.now()-start),active_seconds:null,extraction_ms:null,intake_to_verification_ms:null,manual_file_actions:null,expected_eligible:expected,actual_eligible:v.result.eligible,flags:v.result.flags,rule_version:v.rule_version,policy_version:v.result.policy_version,action_status:actionStatus,release_status:release.status,actual_released:actual.fulfillment_state==='RELEASED',retry_count:0};
 }));
}
const sorted=rows.map(r=>r.elapsed_ms).sort((a,b)=>a-b),percentile=(p:number)=>sorted[Math.ceil(p*sorted.length)-1];
const result={run_id:new Date().toISOString().replaceAll(':','-'),commit,mode:'LOCAL_FIXTURE_WORKFLOW',cases:rows.length,decision_correct:rows.filter(r=>r.expected_eligible===r.actual_eligible).length,false_admissions:rows.filter(r=>!r.expected_eligible&&r.actual_eligible).length,wrong_releases:rows.filter(r=>!r.expected_eligible&&r.actual_released).length,false_blocks:rows.filter(r=>r.expected_eligible&&!r.actual_eligible).length,skipped:0,fixture_workflow_p50_ms:percentile(.5),fixture_workflow_p90_ms:percentile(.9),visual_accuracy:'NOT RUN',gpu_cpu_latency:'NOT RUN',human_study:'NOT RUN',file_action_observation:'NOT RUN',rows};
await mkdir('evaluation/finalist/e2e',{recursive:true});await writeFile('evaluation/finalist/e2e/results.json',JSON.stringify(result,null,2)+'\n');
await writeFile('evaluation/finalist/e2e/summary.md',`# Local fixture workflow evaluation\n\nRun ${result.run_id}; source commit ${commit} (working tree may contain uncommitted evaluation changes).\n\n${result.decision_correct}/${result.cases} known-answer decisions; ${result.false_admissions} false admissions; ${result.wrong_releases} wrong releases; ${result.false_blocks} false blocks.\n\nThese are structured fixture API workflows, not OCR accuracy, real channel delivery, human processing time or business impact measurements. GPU/CPU, personnel study and observed file actions: NOT RUN. Fixture request latency includes local HTTP overhead and cannot be used as employee time.\n`);
assert.equal(result.false_admissions,0);assert.equal(result.wrong_releases,0);assert.equal(result.false_blocks,0);console.log(JSON.stringify({...result,rows:undefined},null,2));
