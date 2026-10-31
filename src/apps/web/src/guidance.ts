// Tells staff what is happening and what to do next. Wording only: permissions and eligibility stay on the server.
export interface GuidanceInput {
  payment_state:string;fulfillment_state:string;
  receipt:{extraction_state:string;fields_provider:string}|null;
  current:boolean;eligible:boolean;required_role:string|null;flags:string[];
  pending_approval:boolean;rejected:boolean;partial_eligible?:boolean;receipt_counted?:boolean;role:'OWNER'|'CASHIER';owner_must_release:boolean;
}
export interface Guidance {category:string;title:string;next:string;tone:'wait'|'fix'|'act'|'done'}
const has=(flags:string[],...codes:string[])=>codes.some(code=>flags.includes(code));
const read=(provider?:string)=>provider==='CPU_OCR'||provider==='RUNPOD_VLM';

// Blocking reasons, most useful first: unread details explain later bank failures, so they lead.
function blocked(flags:string[],provider?:string):Guidance{
  const machine=read(provider);
  if(has(flags,'RECIPIENT_UNCERTAIN'))return {category:'Missing details',title:'The full receiving account cannot be confirmed.',next:'Check the image and correct the field.',tone:'fix'};
  if(has(flags,'INVALID_RECEIPT'))return {category:'Missing details',title:'Some details could not be read from this receipt.',next:machine?'Check the image and correct the fields, or ask the customer for a clear, upright image.':'Enter the missing fields from the image.',tone:'fix'};
  if(has(flags,'WRONG_RECIPIENT'))return {category:'Evidence problem',title:'The receiving account does not match this shop.',next:machine?'Compare with the image. Correct the field if it was misread. If it is right, do not confirm.':'Do not confirm. Ask the customer for a receipt to the correct account.',tone:'fix'};
  if(has(flags,'MONEY_REQUEST','TRANSFER_NOT_COMPLETE'))return {category:'Evidence problem',title:'This does not show a completed transfer.',next:'Ask the customer for a receipt of the completed transfer.',tone:'fix'};
  if(has(flags,'PARTIAL_PAYMENT','OVERPAYMENT'))return {category:'Evidence problem',title:'The receipt amount does not match the order.',next:'Check the amount with the image, then ask the customer to resolve it.',tone:'fix'};
  if(has(flags,'DUPLICATE_IMAGE','DUPLICATE_EVIDENCE','TRANSACTION_ALREADY_USED'))return {category:'Evidence problem',title:'This evidence has already been used.',next:'Do not confirm. Check the other order or ask for different evidence.',tone:'fix'};
  if(has(flags,'BANK_NOT_FOUND','AMOUNT_MISMATCH','AMBIGUOUS_MATCH'))return {category:'No bank match',title:'No matching bank credit has been found yet.',next:'Check the evidence, or run the checks again later.',tone:'fix'};
  return {category:'Evidence problem',title:'This evidence cannot confirm payment.',next:'Review the reasons below and obtain valid evidence.',tone:'fix'};
}

export function guidanceFor(s:GuidanceInput):Guidance{
  if(s.fulfillment_state==='RELEASED')return {category:'Complete',title:'Payment and release are both recorded.',next:'Nothing more is needed.',tone:'done'};
  if(s.payment_state==='MANUALLY_CONFIRMED')return {category:'Waiting for release',title:'The Owner approved this order on their own responsibility.',next:s.role==='OWNER'?'Release the order when it is ready.':'Ask an Owner to release this order.',tone:'act'};
  if(s.payment_state==='PAID')return {category:'Waiting for release',title:'Payment is confirmed. The order has not been handed over.',next:s.owner_must_release&&s.role!=='OWNER'?'Ask an Owner to release this order.':'Release the order when it is ready.',tone:'act'};
  if(!s.receipt)return {category:'No receipt yet',title:'This order has no receipt.',next:'Add a receipt, or send the customer a submission link.',tone:'act'};
  if(['PENDING','RUNNING'].includes(s.receipt.extraction_state))return {category:'Reading',title:'Reading the receipt.',next:'Wait. This page updates by itself, so there is no need to send it again.',tone:'wait'};
  if(s.receipt.extraction_state==='ERROR')return {category:'Reading failed',title:'The receipt could not be read. The order stays unpaid.',next:'Try reading again, or check the image and enter the fields.',tone:'fix'};
  if(s.rejected)return {category:'Rejected',title:'The Owner rejected this. The order is still unpaid.',next:'See the reason, correct the fields or add new evidence, then run the checks again.',tone:'fix'};
  if(s.payment_state==='PARTIALLY_PAID'&&s.receipt_counted)return {category:'Part paid',title:'Part of this order is paid. The balance is still due.',next:s.role==='OWNER'?'Send another payment link, or approve it anyway on your own responsibility.':'Send another payment link, or ask the Owner.',tone:'act'};
  if(!s.current)return {category:'Ready to check',title:'This receipt has not been checked against bank evidence.',next:'Review the fields, then run the checks.',tone:'act'};
  if(!s.eligible&&s.partial_eligible)return {category:'Short payment',title:'The money arrived, but it is less than what is due.',next:s.role==='OWNER'?'Keep it and open another submission, reject it, or approve it anyway.':'Send it to the Owner to record or reject.',tone:'fix'};
  if(!s.eligible)return blocked(s.flags,s.receipt.fields_provider);
  if(s.required_role==='OWNER'&&s.role==='OWNER')return {category:'Ready to confirm',title:'The evidence matches. Look at the note below before you confirm.',next:'Check the bank credit, then confirm payment.',tone:'act'};
  if(s.required_role==='OWNER'){
    if(s.pending_approval)return {category:'Waiting for the Owner',title:'Sent for Owner review. The order stays on hold.',next:'Wait for the Owner, or switch to the Owner account.',tone:'wait'};
    return {category:'Needs the Owner',title:'The evidence meets the requirements, but the Owner must confirm.',next:'Request Owner review.',tone:'act'};
  }
  return {category:'Ready to confirm',title:'The evidence matches. Payment is not confirmed yet.',next:'Check the bank credit, then confirm payment.',tone:'act'};
}

// Plain story of an order for its record, oldest first. Internal events without business meaning are left out.
export function storyLine(events:Array<{action:string;actor_name:string;payload:Record<string,unknown>}>){
  const words=(e:{action:string;actor_name:string;payload:Record<string,unknown>})=>{
    switch(e.action){
      case 'order.created':return 'Order created';
      case 'mock_payment.received':return 'Customer paid by mock link';
      case 'intake.received':case 'receipt.image_saved':case 'receipt.created':return 'Receipt received';
      case 'receipt.corrected':return `${e.actor_name} corrected fields`;
      case 'verification.completed':return 'Evidence checked';
      case 'approval.requested':return `${e.actor_name} requested Owner review`;
      case 'access.denied':return `${e.actor_name} was blocked`;
      case 'approval.decided':return `${e.actor_name} ${e.payload.decision==='APPROVED'?'approved':'rejected'}`;
      case 'payment.partial_recorded':return 'Part payment recorded';
      case 'payment.shortfall_accepted':return `${e.actor_name} approved anyway`;
      case 'payment.confirmed':return 'Payment confirmed';
      case 'fulfillment.released':return `${e.actor_name} released the order`;
      default:return null;
    }
  };
  const steps=events.map(words).filter((s):s is string=>!!s);
  return steps.filter((s,i)=>s!==steps[i-1]);
}

export const fieldNames:Record<string,string>={amount_sen:'Amount',bank_transaction_ref:'Bank reference',customer_reference:'Customer note',recipient_account:'Receiving account',occurred_at:'Transfer time',status:'Transfer status',document_type:'Document type'};
