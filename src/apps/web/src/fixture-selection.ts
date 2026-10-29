import type {ReceiptFields} from '../../../packages/contracts/src/index.js';
export type FixtureChoice={id:string;label?:string;amount_sen?:number|null;fields?:Pick<ReceiptFields,'amount_sen'|'bank_transaction_ref'|'customer_reference'>};
export function defaultFixture(order:{external_id:string;total_sen:number},fixtures:FixtureChoice[]){
 const reference=order.external_id.trim().toUpperCase();
 const exact=fixtures.filter(f=>[f.fields?.bank_transaction_ref,f.fields?.customer_reference].some(value=>value?.trim().toUpperCase()===reference));
 if(exact.length===1)return exact[0].id;
 const amount=fixtures.filter(f=>(f.amount_sen??f.fields?.amount_sen)===order.total_sen);
 if(amount.length===1)return amount[0].id;
 return fixtures.find(f=>f.id==='normal')?.id??fixtures[0]?.id??'';
}
