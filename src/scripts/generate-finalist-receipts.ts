import sharp from 'sharp';
import {writeFile} from 'node:fs/promises';
import {fixtures} from '../apps/api/src/modules/verification/fixtures.js';
for(const id of ['bakery_300','laundry_300']){
 const f=fixtures[id],lines=['PAYSAH SYNTHETIC RECEIPT','Bank: DEMO BANK',`Amount: RM ${((f.amount_sen??0)/100).toFixed(2)}`,`Bank transaction ref: ${f.bank_transaction_ref}`,`Customer reference: ${f.customer_reference}`,`Recipient account: ${f.recipient_account}`,`Occurred at: ${f.occurred_at}`,`Status: ${f.status}`,`Document type: ${f.document_type}`,'Synthetic example only'];
 const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="720"><rect width="100%" height="100%" fill="white"/>${lines.map((line,i)=>`<text x="50" y="${60+i*62}" font-family="Arial" font-size="30" fill="black">${escape(line)}</text>`).join('')}</svg>`;
 await writeFile(`fixtures/receipts/${id}.png`,await sharp(Buffer.from(svg)).png().toBuffer());
}
console.log('Generated two independent synthetic RM300 receipts.');
