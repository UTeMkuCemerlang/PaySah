import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {RunpodVisionExtractor,RunpodError,RUNPOD_PARSER_VERSION,RUNPOD_PROMPT_VERSION,fieldDisagreements} from '../apps/api/src/modules/receipts/runpod.js';
import {verify,type BankRow} from '../apps/api/src/modules/verification/rules.js';
import {loadEvaluationInputs,evaluateSample,summarize} from './runpod/evaluation.js';
import type {JobResult} from './runpod/client.js';

// Paired GPU-vs-CPU diagnostic on the same 36 synthetic receipts, through the same extractor the app uses in runpod mode.
// Usage: npm run eval:runpod-vlm -- --limit=1   (first, to warm up and check the contract), then --limit=36.
// Sequential, no retries, stops after 3 failures in a row. Writes no application data. Never prints the key.
const key=process.env.RUNPOD_API_KEY,endpoint=process.env.RUNPOD_ENDPOINT_ID,model=process.env.RUNPOD_MODEL??'Qwen/Qwen2.5-VL-7B-Instruct';
if(!key||!endpoint)throw Error('Set RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID in .env (never in chat or reports).');
const limit=Number(process.argv.find(a=>a.startsWith('--limit='))?.slice(8)??1);
// Cold start (model download/load) can take minutes on the first request; later requests are seconds.
const timeoutMs=Number(process.env.RUNPOD_EVAL_TIMEOUT_MS??240000);
const dataset=await loadEvaluationInputs(limit);
const extractor=new RunpodVisionExtractor({apiKey:key,endpointId:endpoint,model,timeoutMs});
const started=new Date(),dir=resolve('evaluation/runpod-vlm',started.toISOString().replaceAll(':','-').replace('.','-'));
await mkdir(dir,{recursive:true});
const rows:ReturnType<typeof evaluateSample>[]=[];
// Same two diagnostic credits as runpod/evaluation.ts; adds the app's GPU-vs-CPU cross-check (MODEL_UNCONFIRMED -> Owner).
const credits:BankRow[]=[12800,78000].map(amount=>({id:`diagnostic-${amount}`,account_identifier:'DEMO-ACCOUNT-A',active:true,version:1,bank_transaction_ref:`DEMO-BANK-${amount===12800?'128':'780'}`,amount_sen:amount,currency:'MYR',direction:'CREDIT',status:'BOOKED',booked_at:'2026-10-22T06:00:00Z',allocated:false}));
const checked:Array<{id:string;disagreements:string[];uncertain_fields:string[];wrong_fields:string[];eligible:boolean;required_role:string;expected_eligible:boolean;cashier_wrongly_eligible:boolean}>=[];let failuresInRow=0,status='FINISHED';
const save=async()=>writeFile(resolve(dir,'results.json'),JSON.stringify({kind:'RunPod GPU vision vs CPU OCR, synthetic receipts only',checked_at:started.toISOString(),status,endpoint_id:endpoint,model,
  prompt_version:RUNPOD_PROMPT_VERSION,parser_version:RUNPOD_PARSER_VERSION,manifest_sha256:dataset.manifest_sha256,cpu_baseline_checked_at:dataset.cpu_checked_at,
  note:'Same 36-image diagnostic set as the CPU run; not a held-out set. Wall time includes network and RunPod queue/cold start, so it is not a fair speed comparison.',
  summary:summarize(rows,limit),model_self_report:{note:'The model naming its own doubts; a low count here does not make a reading safe',receipts_flagged:checked.filter(c=>c.uncertain_fields.length).length,receipts_with_wrong_fields:checked.filter(c=>c.wrong_fields.length).length,wrong_fields_total:checked.reduce((n,c)=>n+c.wrong_fields.length,0),wrong_fields_flagged:checked.reduce((n,c)=>n+c.wrong_fields.filter(k=>c.uncertain_fields.includes(k)).length,0),correct_fields_flagged:checked.reduce((n,c)=>n+c.uncertain_fields.filter(k=>!c.wrong_fields.includes(k)).length,0)},with_cpu_cross_check:{rule:'GPU field differs from CPU reading -> MODEL_UNCONFIRMED -> Owner review',cashier_wrongly_eligible:checked.filter(c=>c.cashier_wrongly_eligible).length,owner_routed_by_cross_check:checked.filter(c=>c.disagreements.length).length,rows:checked},rows},null,2).replaceAll(key,'[REDACTED]')+'\n');
for(const sample of dataset.samples){
  const t=Date.now();let result:JobResult,uncertain:string[]=[];
  try{
    const r=await extractor.extractFields(sample.bytes,sample.mime_type);uncertain=r.uncertain_fields;
    result={job_id:r.request_id,state:'COMPLETED',error:null,output:{protocol_version:'paysah-extraction.v1',model_id:r.model,model_revision:'served-by-endpoint',device:'cuda',gpu_name:'see RunPod dashboard',fields:r.fields} as JobResult['output'],raw:r.raw_text.slice(0,4000),events:[],cancellation:'NOT_NEEDED'};
    failuresInRow=0;
  }catch(e){
    result={job_id:null,state:'FAILED',error:e instanceof RunpodError?e.reason+(e.httpStatus?' HTTP '+e.httpStatus:''):'UNEXPECTED',output:null,raw:null,events:[],cancellation:'NOT_NEEDED'};
    failuresInRow++;
  }
  rows.push(evaluateSample(sample,result,Date.now()-t));
  if(result.output){
    const disagreements=fieldDisagreements(result.output.fields,sample.cpu.actual);
    const rule=verify({total_sen:sample.total_sen,fields:result.output.fields,accounts:['DEMO-ACCOUNT-A'],transactions:credits,duplicate_evidence:false,duplicate_reference:false,manual:false,model_unconfirmed:disagreements.length>0,model_unsure:uncertain.length>0});
    checked.push({id:sample.id,disagreements,uncertain_fields:uncertain,wrong_fields:fieldDisagreements(result.output.fields,sample.expected),eligible:rule.eligible,required_role:rule.required_role,expected_eligible:sample.expected_eligible,cashier_wrongly_eligible:!sample.expected_eligible&&rule.eligible&&rule.required_role==='CASHIER'});
  }
  console.log(`${sample.id}: ${result.state}${result.error?' '+result.error:''} · ${rows.at(-1)!.correct_fields}/7 fields (CPU ${sample.cpu.correct_fields}/7) · ${Date.now()-t} ms`);
  await save();
  if(failuresInRow>=3){status='STOPPED_AFTER_3_FAILURES';break;}
}
if(status==='FINISHED'&&rows.some(r=>!r.output))status='FINISHED_WITH_FAILURES';
await save();
const s=summarize(rows,limit);
console.log(`${status}: GPU ${s.correct_fields}/${s.total_fields} fields vs CPU ${s.cpu_paired_correct_fields}/${s.total_fields}; exact ${s.exact_samples}/${s.attempted}; wrongly eligible ${s.false_eligible} without cross-check, ${checked.filter(c=>c.cashier_wrongly_eligible).length} for a Cashier with the CPU cross-check (${checked.filter(c=>c.disagreements.length).length} sent to Owner). Report: ${dir}`);
if(status!=='FINISHED')process.exitCode=1;
