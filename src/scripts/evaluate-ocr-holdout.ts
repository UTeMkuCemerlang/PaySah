import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import sharp from 'sharp';
import {CpuExtractor} from '../apps/api/src/modules/receipts/ocr.js';
import {parseReceiptText,PARSER_VERSION} from '../apps/api/src/modules/receipts/parser.js';
import {verify,type BankRow} from '../apps/api/src/modules/verification/rules.js';
import type {ReceiptFields} from '../packages/contracts/src/index.js';
import {layouts,renderReceipt} from './ocr-dataset.js';

// Checks parser changes on receipts the parser was not changed against: same renderer and layouts, new values.
// Images are made in memory and stay synthetic. Layouts are shared with the diagnostic set, so this is not a new-format test.
const values=[
 {amount_sen:23640,bank_transaction_ref:'DEMO-BANK-236',customer_reference:'HOLD-ORDER-1',occurred_at:'2026-11-03T02:15:30Z'},
 {amount_sen:9150,bank_transaction_ref:'DEMO-BANK-915',customer_reference:'HOLD-ORDER-2',occurred_at:'2026-11-07T09:41:05Z'},
 {amount_sen:45075,bank_transaction_ref:'DEMO-BANK-450',customer_reference:'HOLD-ORDER-3',occurred_at:'2026-11-12T13:20:48Z'},
];
const account='DEMO-ACCOUNT-Q';
const base=(v:typeof values[number]):ReceiptFields=>({...v,currency:'MYR',recipient_account:account,status:'SUCCESS',document_type:'TRANSFER_RECEIPT'});
const transactions:BankRow[]=values.map(v=>({id:`hold-${v.bank_transaction_ref}`,account_identifier:account,active:true,version:1,bank_transaction_ref:v.bank_transaction_ref,amount_sen:v.amount_sen,currency:'MYR',direction:'CREDIT',status:'BOOKED',booked_at:v.occurred_at,allocated:false}));
type Condition='clear'|'blur'|'rotation'|'low_resolution';
async function image(svg:string,condition:Condition){
 const png=await sharp(Buffer.from(svg)).png().toBuffer();
 if(condition==='blur')return sharp(png).blur(1.2).png().toBuffer();
 if(condition==='rotation')return sharp(png).rotate(4,{background:'white'}).png().toBuffer();
 if(condition==='low_resolution')return sharp(png).resize({width:430}).jpeg({quality:45}).toBuffer();
 return png;
}
const samples:Array<{id:string;layout:string;condition:string;fields:ReceiptFields;total_sen:number;expected_eligible:boolean}>=[];
for(const layout of layouts)values.forEach((v,index)=>{
 for(const condition of ['clear','blur','rotation','low_resolution'] as Condition[])samples.push({id:`${layout}-${index}-${condition}`,layout,condition,fields:base(v),total_sen:v.amount_sen,expected_eligible:true});
 samples.push({id:`${layout}-${index}-partial`,layout,condition:'should_block',fields:base(v),total_sen:v.amount_sen+5000,expected_eligible:false});
 samples.push({id:`${layout}-${index}-wrong_account`,layout,condition:'should_block',fields:{...base(v),recipient_account:'DEMO-WRONG-ACCOUNT'},total_sen:v.amount_sen,expected_eligible:false});
 samples.push({id:`${layout}-${index}-scheduled`,layout,condition:'should_block',fields:{...base(v),status:'SCHEDULED'},total_sen:v.amount_sen,expected_eligible:false});
 samples.push({id:`${layout}-${index}-money_request`,layout,condition:'should_block',fields:{...base(v),document_type:'MONEY_REQUEST'},total_sen:v.amount_sen,expected_eligible:false});
 samples.push({id:`${layout}-${index}-no_bank`,layout,condition:'should_block',fields:{...base(v),bank_transaction_ref:`DEMO-NOT-BOOKED-${index}`},total_sen:v.amount_sen,expected_eligible:false});
});
const keys=['amount_sen','bank_transaction_ref','customer_reference','recipient_account','occurred_at','status','document_type'] as const;
const extractor=new CpuExtractor();
const rows:Array<{id:string;layout:string;condition:string;expected_eligible:boolean;eligible:boolean;flags:string[];correct_fields:number;false_eligible:boolean;valid_but_blocked:boolean;eligible_with_field_errors:boolean}>=[];
try{
 for(const s of samples){
  const drawing=renderReceipt(s.layout as typeof layouts[number],s.fields);
  const bytes=await image(drawing.svg,s.condition==='should_block'?'clear':s.condition as Condition);
  const output=await extractor.extract(bytes),parsed=parseReceiptText(typeof output==='string'?output:output.text);
  const result=verify({total_sen:s.total_sen,fields:parsed.fields,accounts:[account],transactions,duplicate_evidence:false,duplicate_reference:false,manual:false});
  const correct=keys.filter(k=>parsed.fields[k]===s.fields[k]).length;
  rows.push({id:s.id,layout:s.layout,condition:s.condition,expected_eligible:s.expected_eligible,eligible:result.eligible,flags:result.flags,correct_fields:correct,false_eligible:!s.expected_eligible&&result.eligible,valid_but_blocked:s.expected_eligible&&!result.eligible,eligible_with_field_errors:result.eligible&&correct<keys.length});
 }
}finally{await extractor.close();}
assert.equal(rows.length,samples.length);
const group=(subset:typeof rows)=>({samples:subset.length,correct_fields:subset.reduce((n,r)=>n+r.correct_fields,0),total_fields:subset.length*keys.length,expected_valid:subset.filter(r=>r.expected_eligible).length,expected_blocked:subset.filter(r=>!r.expected_eligible).length,valid_but_blocked:subset.filter(r=>r.valid_but_blocked).length,false_eligible:subset.filter(r=>r.false_eligible).length,eligible_with_field_errors:subset.filter(r=>r.eligible_with_field_errors).length});
const report={run_id:new Date().toISOString().replaceAll(':','-'),parser:PARSER_VERSION,kind:'CPU OCR, synthetic receipts with new values and the same three layouts; rule check only, no approval or release executed',summary:group(rows),by_condition:Object.fromEntries([...new Set(rows.map(r=>r.condition))].map(c=>[c,group(rows.filter(r=>r.condition===c))])),by_layout:Object.fromEntries(layouts.map(l=>[l,group(rows.filter(r=>r.layout===l))])),rows};
await mkdir('evaluation/finalist/ocr-holdout',{recursive:true});
await writeFile(`evaluation/finalist/ocr-holdout/${PARSER_VERSION}-${report.run_id}.json`,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({parser:report.parser,run_id:report.run_id,summary:report.summary,by_condition:report.by_condition,by_layout:report.by_layout}));
