import {receiptFieldsSchema,type ReceiptFields} from '../../../../../packages/contracts/src/index.js';
import {emptyFields} from './fields.js';
export const PARSER_VERSION='labelled-receipt.v2';
// Only undoes known OCR character confusions in format fields. References, accounts and amounts stay exact, so a misread never matches a bank record.
const timeText=(value:string|null)=>value?.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})[27z]$/,'$1Z')??null;
const documentText=(value:string|null)=>value?.toUpperCase().replaceAll('|','I').replace(/\s+/g,'_')??null;
export function parseReceiptText(text:string){
  const lines=text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const candidates:Record<string,string[]>={};
  const get=(label:string)=>{
    const pattern=new RegExp(`^${label}\\s*:`,'i');
    const values=lines.filter(line=>pattern.test(line)).map(line=>line.replace(pattern,'').trim());
    candidates[label]=values;return values.length===1?values[0]:null;
  };
  const fields:ReceiptFields={...emptyFields};
  const amount=get('Amount');
  const monies=text.match(/\bRM\s*\d+(?:\.\d{2})?/gi)??[];
  if(amount&&/^RM\s*\d{1,8}\.\d{2}$/.test(amount)&&monies.length===1){
    const [whole,sen]=amount.replace(/^RM\s*/,'').split('.');
    const value=Number(whole)*100+Number(sen);if(value>0&&value<=2147483647)fields.amount_sen=value;
  }
  fields.bank_transaction_ref=get('Bank transaction ref');
  fields.customer_reference=get('Customer reference');
  fields.recipient_account=get('Recipient account');
  const time=timeText(get('Occurred at'));
  if(time&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(time)&&Number.isFinite(Date.parse(time)))fields.occurred_at=time;
  const status=get('Status');
  if(['SUCCESS','PENDING','SCHEDULED','FAILED'].includes(status??''))fields.status=status as ReceiptFields['status'];
  const document=documentText(get('Document type'));
  if(['TRANSFER_RECEIPT','MONEY_REQUEST','OTHER'].includes(document??''))fields.document_type=document as ReceiptFields['document_type'];
  const parsed=receiptFieldsSchema.safeParse(fields);
  const valid=parsed.success?parsed.data:{...emptyFields};
  const required=['amount_sen','bank_transaction_ref','recipient_account','occurred_at'] as const;
  const missing_fields:string[]=required.filter(key=>valid[key]===null);
  if(valid.status==='UNKNOWN')missing_fields.push('status');
  if(valid.document_type==='UNKNOWN')missing_fields.push('document_type');
  return {fields:valid,missing_fields,candidates,parser_version:PARSER_VERSION};
}
