import {IntakeLinks} from './intake-links.js';
import {defaultFixture,type FixtureChoice} from './fixture-selection.js';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {receiptFieldsSchema,type ReceiptFields} from '../../../packages/contracts/src/index.js';
import {ApiClient} from './api.js';
import {useResource} from './hooks.js';
import {money,label,time,fixtureLabels,parseSen} from './copy.js';
import type {Actor,Review,Receipt,Extraction} from './types.js';
import {Badge,Notice,Empty,EventList} from './ui.js';

function ReceiptImage({api,receipt}:{api:ApiClient;receipt:Receipt}){
  const [url,setUrl]=useState(''),[error,setError]=useState<unknown>();
  useEffect(()=>{
    const controller=new AbortController();let objectUrl='';setUrl('');setError(undefined);
    if(receipt.source==='IMAGE')api.image(receipt.id,controller.signal).then(blob=>{if(!controller.signal.aborted){objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);}}).catch(e=>{if(!controller.signal.aborted)setError(e);});
    return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[api,receipt.id,receipt.source]);
  if(receipt.source!=='IMAGE')return <div className="receipt-image-placeholder">Structured fields only. No original image was attached.</div>;
  return <div className="receipt-preview"><Notice error={error}/>{url?<img src={url} alt="Original synthetic receipt"/>:!error&&<p className="loading" role="status">Loading private receipt…</p>}</div>;
}

function FieldEditor({receipt,disabled,onSave,onCancel}:{receipt:Receipt;disabled:boolean;onSave:(fields:ReceiptFields,revision:number,reason:string)=>Promise<boolean>;onCancel:()=>void}){
  const [original]=useState(receipt),[fields,setFields]=useState({...receipt.fields}),[amount,setAmount]=useState(receipt.fields.amount_sen===null?'':(receipt.fields.amount_sen/100).toFixed(2)),[reason,setReason]=useState(''),[error,setError]=useState<unknown>();
  function field<K extends keyof ReceiptFields>(key:K,value:ReceiptFields[K]){setFields(old=>({...old,[key]:value}));}
  async function save(e:FormEvent){e.preventDefault();setError(undefined);try{
    if(reason.trim().length<3)throw Error();
    const checked=receiptFieldsSchema.parse({...fields,amount_sen:amount.trim()?parseSen(amount):null});
    if(await onSave(checked,original.revision,reason.trim()))onCancel();
  }catch{setError(Error('Check the amount, reference and time with timezone, and add a correction reason.'));}}
  return <form className="form-stack correction-form" onSubmit={save}>
    <div className="panel-heading"><h3>Correct receipt fields</h3><button type="button" className="button ghost small" onClick={onCancel} disabled={disabled}>Cancel</button></div>
    <p className="muted">Original readings are kept. Corrections require a new check and Owner review.</p>
    {original.revision!==receipt.revision&&<div className="notice">The receipt changed while you were editing. Cancel and reopen to load the latest fields.</div>}<Notice error={error}/>
    <div className="field-grid"><label>Receipt amount (MYR)<input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)}/></label>
      <label>Bank transaction reference<input maxLength={100} value={fields.bank_transaction_ref??''} onChange={e=>field('bank_transaction_ref',e.target.value||null)}/></label>
      <label>Receiving account<input maxLength={100} value={fields.recipient_account??''} onChange={e=>field('recipient_account',e.target.value||null)}/></label>
      <label>Customer note<input maxLength={100} value={fields.customer_reference??''} onChange={e=>field('customer_reference',e.target.value||null)}/></label>
      <label className="span-2">Transfer time with timezone<input value={fields.occurred_at??''} onChange={e=>field('occurred_at',e.target.value||null)} placeholder="2026-10-22T14:00:00+08:00"/><span className="field-help">Keep the source timezone. Leave unknown fields empty.</span></label>
      <label>Transfer status<select value={fields.status} onChange={e=>field('status',e.target.value as ReceiptFields['status'])}>{['SUCCESS','PENDING','SCHEDULED','FAILED','UNKNOWN'].map(v=><option key={v} value={v}>{label(v)}</option>)}</select></label>
      <label>Document type<select value={fields.document_type} onChange={e=>field('document_type',e.target.value as ReceiptFields['document_type'])}>{['TRANSFER_RECEIPT','MONEY_REQUEST','OTHER','UNKNOWN'].map(v=><option key={v} value={v}>{label(v)}</option>)}</select></label></div>
    <label>Correction reason<textarea required minLength={3} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} placeholder="What did you check and why did you change it?"/></label>
    <button className="button primary" disabled={disabled||original.revision!==receipt.revision}>Save correction</button>
  </form>;
}

export function OrderDetail({api,actor,id}:{api:ApiClient;actor:Actor;id:string}){
  const resource=useResource(s=>api.get<Review>(`/orders/${id}/review`,s),[api,id],5000);
  const fixtures=useResource(s=>api.get<{fixtures:FixtureChoice[]}>('/demo/receipt-fixtures',s),[api]);
  const [chosen,setChosen]=useState('normal'),[selected,setSelected]=useState(''),[editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[message,setMessage]=useState(''),[attested,setAttested]=useState(false),[reason,setReason]=useState(''),[copied,setCopied]=useState(false);
  const [editorReceipt,setEditorReceipt]=useState<Receipt>(),[editorVersion,setEditorVersion]=useState(1);
  const [newEvidence,setNewEvidence]=useState(false),seenReceipt=useRef<string|null|undefined>(undefined);
  const pending=useRef(false),data=resource.value,order=data?.order;
  const fixtureOrder=useRef(id),fixtureManual=useRef(false);
  useEffect(()=>{
    if(fixtureOrder.current!==id){fixtureOrder.current=id;fixtureManual.current=false;}
    if(order?.id===id&&fixtures.value&&!fixtureManual.current)setChosen(defaultFixture(order,fixtures.value.fixtures));
  },[id,order?.id,order?.external_id,order?.total_sen,fixtures.value]);
  useEffect(()=>{setAttested(false);},[order?.version,data?.verification?.id,data?.settings.policy_version,data?.receipts[0]?.revision]);
  useEffect(()=>{
    if(!data)return;
    const latest=data.receipts[0]?.id??null;
    if(seenReceipt.current!==undefined&&latest!==seenReceipt.current&&latest){setNewEvidence(true);if(!editing)setSelected('');}
    seenReceipt.current=latest;
    const timer=setTimeout(()=>setNewEvidence(false),6000);return()=>clearTimeout(timer);
  },[data?.receipts[0]?.id]);
  const preferred=data?.verification&&(data.verification.active||order?.payment_state==='PAID')?data.verification.receipt_id:data?.receipts[0]?.id;
  const receipt=editing&&editorReceipt?(data?.receipts.find(r=>r.id===editorReceipt.id)??editorReceipt):(data?.receipts.find(r=>r.id===(selected||preferred))??data?.receipts[0]);
  const verification=data?.verification?.receipt_id===receipt?.id?data?.verification:null;
  const current=!!verification?.active&&verification.order_version===order?.version&&verification.evidence_revision===receipt?.revision&&verification.result.policy_version===data?.settings.policy_version;
  const approval=data?.approvals.find(a=>a.verification_id===verification?.id&&a.status==='PENDING');
  const waiting=!!receipt&&['PENDING','RUNNING'].includes(receipt.extraction_state);

  useEffect(()=>{setAttested(false);},[verification?.id,verification?.active,order?.version,receipt?.id,receipt?.revision]);
  const extractions=useResource(s=>receipt?api.get<{runs:Extraction[]}>(`/receipts/${receipt.id}/extractions`,s):Promise.resolve({runs:[]}),[api,receipt?.id,receipt?.revision]);
  const reply=useResource(s=>api.get<{text:string;sent:boolean}>(`/orders/${id}/reply-draft`,s),[api,id,order?.version,receipt?.id,receipt?.revision,verification?.id,verification?.active,data?.settings.policy_version],5000);
  async function act(task:()=>Promise<unknown>,success:string){
    if(pending.current)return false;pending.current=true;setBusy(true);setError(undefined);setMessage('');
    try{await task();setMessage(success);setAttested(false);setReason('');resource.refresh();return true;}
    catch(err){setError(err);resource.refresh();return false;}
    finally{pending.current=false;setBusy(false);}
  }
  const disabled=busy||resource.loading||!!resource.error;
  if(!data)return <><a className="back-link" href="#orders">← Back to orders</a><Notice error={resource.error}/>{resource.loading?<div className="loading" role="status">Loading order evidence…</div>:<button className="button ghost" onClick={resource.refresh}>Retry</button>}</>;
  const o=data.order,editable=o.payment_state==='UNPAID';
  const matched=data.bank_transactions.find(t=>t.id===verification?.result.matched_transaction_id);
  const bankAmount=data.allocations.length?data.allocations.reduce((sum,a)=>sum+a.amount_sen,0):current&&verification?.result.eligible?matched?.amount_sen:null;
  const eligible=editable&&current&&!!verification?.result.eligible;
  const canConfirm=eligible&&verification?.result.required_role==='CASHIER';
  const workflowStep=o.fulfillment_state==='RELEASED'?4:o.payment_state==='PAID'?3:current&&eligible?2:receipt?1:0;
  const nextStep=o.fulfillment_state==='RELEASED'?'Complete — payment and release are recorded.':o.payment_state==='PAID'?(o.total_sen>data.settings.release_owner_threshold_sen&&actor.role!=='OWNER'?'Payment confirmed. An Owner must release this high-value order.':'Payment confirmed. Review the order, then release it separately.'):!receipt?'Choose a synthetic receipt below to start this review.':waiting?'Reading the receipt. You can review the image while you wait.':!current?'Review the receipt fields, then run checks against bank evidence.':!eligible?'Payment is blocked. Review the reasons below and obtain valid evidence.':approval&&actor.role!=='OWNER'?'Sent for Owner review. Keep this order on hold.':verification?.result.required_role==='OWNER'?'Owner review required. Review the evidence and record a decision.':'Evidence matched. Review the details before confirming payment.';
  async function attach(){await act(async()=>{const result=await api.write<{receipt:Receipt}>(`/orders/${id}/demo-receipt-images`,{fixture_id:chosen,expected_version:o.version});setSelected(result.receipt.id);setEditing(false);},'Synthetic receipt attached. Check its fields and independent evidence.');}
  async function runChecks(){if(receipt)await act(()=>api.write(`/orders/${id}/verifications`,{receipt_id:receipt.id,expected_version:o.version}),'Checks completed. Payment has not been confirmed.');}
  async function decide(decision:'APPROVE'|'REJECT'){
    if(!approval)return;if(reason.trim().length<3){setError(Error('Add a reason before recording your decision.'));return;}
    if(decision==='APPROVE'&&(!attested||!eligible))return;
    await act(()=>api.write(`/approvals/${approval.id}/decision`,{decision,reason:reason.trim(),expected_version:approval.version}),decision==='APPROVE'?'Payment confirmed. Release is a separate action.':'Receipt review rejected. The order balance is unchanged.');
  }
  return <>
    <a className="back-link" href="#orders">← Back to orders</a>
    <div className="page-heading detail-heading"><div><span className="eyebrow">Verify receipt / Order details</span><h1>{o.external_id}</h1><p className="muted">Created {time(o.created_at)} MYT · {data.settings.business_type} · Owner review above {money(data.settings.owner_review_threshold_sen)}</p></div><div className="heading-actions"><Badge value={o.payment_state}/><Badge value={o.fulfillment_state}/><button className="button ghost small" onClick={resource.refresh} disabled={busy||resource.loading}>{resource.loading?'Refreshing…':'Refresh evidence'}</button></div></div>
    <nav className="detail-jumps" aria-label="Order sections">{[['Evidence','.review-grid'],['Decision','.decision-panel'],['Order details','.order-activity']].map(([name,selector])=><button key={name} className="button ghost small" onClick={()=>{const section=document.querySelector<HTMLElement>(selector);section?.setAttribute('tabindex','-1');section?.focus({preventScroll:true});section?.scrollIntoView({block:'start'});}}>{name}</button>)}</nav>
    {resource.updatedAt&&<p className="fine-print">Last updated {time(resource.updatedAt)} MYT{resource.error?' · Connection interrupted; showing saved evidence.':''}</p>}<Notice error={resource.error??error}/>{message&&<div className="notice success" role="status">{message}</div>}
    {newEvidence&&<div className="notice success" role="status">New receipt received. Review the latest evidence before confirming payment.</div>}
    {editing&&editorReceipt&&data.receipts[0]?.id!==editorReceipt.id&&<div className="notice" role="status">New evidence received. Your correction draft is preserved; cancel editing to review the latest receipt.</div>}
    <IntakeLinks api={api} id={id} version={o.version} unpaid={o.payment_state==='UNPAID'}/>
    <section className="workflow-guide" aria-label="Payment review progress">
      <ol>{['Add receipt','Check evidence','Confirm payment','Release order'].map((step,index)=><li key={step} className={workflowStep>index?'complete':workflowStep===index?'current':''} aria-current={workflowStep===index?'step':undefined}><span aria-hidden="true">{workflowStep>index?'✓':index+1}</span><strong>{step}</strong><span className="sr-only">{workflowStep>index?'Completed':workflowStep===index?'Current step':'Not completed'}</span></li>)}</ol>
      <p aria-live="polite"><strong>Next step</strong>{nextStep}</p>
    </section>
    <div className="evidence-summary"><div><span className="eyebrow">Order amount</span><strong data-testid="order-amount">{money(o.total_sen)}</strong><p>The amount this order needs</p></div><div><span className="eyebrow">Receipt amount</span><strong data-testid="receipt-amount">{money(receipt?.fields.amount_sen)}</strong><p>{receipt?label(receipt.fields_provider):'Attach a synthetic receipt'}</p></div><div className={bankAmount?'bank-evidence':'no-evidence'}><span className="eyebrow">Bank credit</span><strong data-testid="bank-amount">{money(bankAmount)}</strong><p>{data.allocations.length?'Allocated to this order':bankAmount?'Demo bank credit found · not yet confirmed':'A receipt alone cannot establish this'}</p></div></div>
    <div className="review-grid"><div className="review-primary">
      <section className="panel"><div className="panel-heading"><div><h2>Receipt evidence</h2><p className="muted">Original image and the fields it claims</p></div>{receipt&&<Badge value={receipt.extraction_state}/>}</div>
        {editable&&<div className="receipt-picker"><label>Synthetic receipt<select aria-label="Synthetic receipt" value={chosen} onChange={e=>{fixtureManual.current=true;setChosen(e.target.value);}} disabled={disabled||fixtures.loading}>{fixtures.value?.fixtures.map(f=><option value={f.id} key={f.id}>{f.label??fixtureLabels[f.id]??'Synthetic receipt'}</option>)}</select></label><button className="button secondary" onClick={attach} disabled={disabled||fixtures.loading||!!fixtures.error}>Attach synthetic receipt</button></div>}
        <Notice error={fixtures.error}/>
        {data.receipts.length>1&&<label className="receipt-select">Attached receipt<select value={receipt?.id??''} onChange={e=>{setSelected(e.target.value);setEditing(false);}}>{data.receipts.map((r,index)=><option key={r.id} value={r.id}>Receipt {data.receipts.length-index} · {label(r.fields_provider)} · {time(r.created_at)}</option>)}</select></label>}
        {receipt?<>
          {receipt.intake_channel!=='DASHBOARD'&&<div className="notice" role="status">{waiting?'Receipt received · reading image':current?(verification?.result.eligible?(verification.result.required_role==='OWNER'?'Needs Owner review · still unpaid':'Ready for human confirmation · still unpaid'):'More evidence needed · payment remains blocked'):'Receipt received · awaiting checks or correction'}</div>}
          <div className="provider-note"><strong>{label(receipt.fields_provider)}</strong><span>{receipt.fields_provider==='FIXTURE'?'These fields are predefined, not OCR results.':receipt.fields_provider==='CPU_OCR'?'Read from the image using local CPU OCR.':receipt.fields_provider==='RUNPOD_VLM'?'Read from the image by a vision model on a RunPod GPU. Still check the bank record.':'These fields were entered or corrected by a person.'}</span></div>
          <p className="muted" data-testid="intake-source">Source: {receipt.intake_channel==='TELEGRAM'?'Telegram':receipt.intake_channel==='GOOGLE_FORM'?'Google Form':'Dashboard'} · Received {time(receipt.created_at)} MYT</p><ReceiptImage api={api} receipt={receipt}/>
          {extractions.value?.runs[0]?.fallback_reason&&<details><summary>Receipt reading details</summary><p className="muted">GPU reading was unavailable; CPU fallback was used. Reason: {extractions.value.runs[0].fallback_reason}</p></details>}
          <dl className="field-list"><div><dt>Receipt amount</dt><dd>{money(receipt.fields.amount_sen)}</dd></div><div><dt>Bank reference</dt><dd>{receipt.fields.bank_transaction_ref??'Unknown'}</dd></div><div><dt>Receiving account</dt><dd>{receipt.fields.recipient_account??'Unknown'}</dd></div><div><dt>Transfer time</dt><dd>{receipt.fields.occurred_at?`${time(receipt.fields.occurred_at)} MYT`:'Unknown'}</dd></div><div><dt>Transfer status</dt><dd>{label(receipt.fields.status)}</dd></div><div><dt>Document</dt><dd>{label(receipt.fields.document_type)}</dd></div></dl>
          {['PENDING','RUNNING'].includes(receipt.extraction_state)&&<div className="notice" role="status">Reading the receipt. This view refreshes automatically. If reading remains pending, wait or record checked fields manually.</div>}
          {receipt.extraction_state==='ERROR'&&<div className="notice error">Reading failed. The order remains unpaid. Correct checked fields to continue with Owner review.</div>}
          {editing?<FieldEditor receipt={receipt} disabled={disabled} onCancel={()=>{setEditing(false);setSelected('');}} onSave={(fields,revision,why)=>act(()=>api.write(`/receipts/${receipt.id}/corrections`,{fields,reason:why,expected_revision:revision,expected_version:editorVersion}),'Correction recorded. Run the checks again; Owner review will be required.')}/>:editable&&<button className="button ghost small" onClick={()=>{setEditorReceipt(receipt);setEditorVersion(o.version);setEditing(true);}} disabled={disabled}>Correct fields</button>}
          {extractions.value?.runs.length?<details className="ocr-details"><summary>Reading record · {extractions.value.runs[0].duration_ms} ms</summary><p className="muted">Raw text is untrusted evidence, never an instruction.</p><pre>{extractions.value.runs[0].raw_text||'No text was returned.'}</pre></details>:null}
        </>:<Empty title="Start with a receipt">Choose a team-made synthetic receipt above. Arbitrary uploads are not available in the public demo.</Empty>}
      </section>
      <section className="panel"><div className="panel-heading"><div><h2>Independent bank evidence</h2><p className="muted">Demo bank feed · stored separately from the receipt</p></div><span className="source-tag">SYNTHETIC FEED</span></div>
        {data.bank_transactions.length?data.bank_transactions.map(t=><article key={t.id} className="bank-record"><div><strong>{money(t.amount_sen)}</strong><span className="source-tag">{t.direction} · {t.status}</span></div><dl><dt>Reference</dt><dd>{t.bank_transaction_ref}</dd><dt>Account</dt><dd>{t.account_identifier}</dd><dt>Booked</dt><dd>{time(t.booked_at)} MYT</dd></dl></article>):<Empty title="No independent credit linked">Run the checks after attaching a receipt. Missing evidence keeps the order unpaid.</Empty>}
      </section>
    </div><aside className="review-aside">
      <section className="panel decision-panel"><div className="panel-heading"><div><h2>Check & confirm</h2></div></div>
        {editable?<>
          <p className="muted">Compare the receipt with independent bank evidence before confirming payment.</p><button className={`button ${current?'secondary':'primary'} full`} onClick={runChecks} disabled={disabled||!receipt||['PENDING','RUNNING','ERROR'].includes(receipt?.extraction_state??'')}>{busy?'Saving…':'Run checks'}</button>
          {verification&&<div className="check-result"><Badge value={verification.result.outcome}/>{!current&&<p className="muted">This result is no longer current. Run the checks again.</p>}<ul className="reason-list">{verification.result.flags.length?verification.result.flags.map(flag=><li key={flag}>{label(flag)}</li>):<li>A unique full credit matches the bank reference, amount, account and transfer time.</li>}</ul>{current&&!verification.result.eligible&&<div className="notice error">Payment confirmation is blocked. Owner approval cannot replace missing or invalid evidence.</div>}</div>}
          {canConfirm&&<div className="confirm-actions"><label className="checkbox"><input type="checkbox" checked={attested} onChange={e=>setAttested(e.target.checked)} disabled={disabled}/>I checked the independent demo bank credit.</label><button className="button primary full" disabled={disabled||!attested} onClick={()=>act(()=>api.write(`/verifications/${verification!.id}/confirm`,{expected_version:o.version}),'Payment confirmed. Release is a separate action.')}>Confirm payment</button></div>}
          {current&&!eligible&&<p className="muted" data-testid="evidence-follow-up">Identify the blocking reason, keep this order unpaid and on hold, and obtain valid evidence. Sending it to the Owner does not clear the payment block.</p>}
          {current&&!approval&&<button className="button ghost full" disabled={disabled} onClick={()=>act(()=>api.write(`/verifications/${verification!.id}/approval-requests`,{expected_version:o.version}),eligible?'Owner review requested. The order remains on hold.':'Evidence sent for review. Payment and release remain blocked.')}>{eligible?'Request Owner review':'Send evidence to Owner'}</button>}
          {approval&&<div className="owner-decision"><h3>{eligible?'Owner review pending':'Evidence review pending'}</h3>{actor.role==='OWNER'?<><label>Decision reason<textarea value={reason} maxLength={500} onChange={e=>setReason(e.target.value)} placeholder="What evidence supports this decision?"/></label>{eligible&&<label className="checkbox"><input type="checkbox" checked={attested} onChange={e=>setAttested(e.target.checked)} disabled={disabled}/>I checked the independent demo bank credit.</label>}<button className="button primary full" onClick={()=>decide('APPROVE')} disabled={disabled||!eligible||!attested||reason.trim().length<3}>Approve & confirm payment</button><button className="button danger-text full" onClick={()=>decide('REJECT')} disabled={disabled||reason.trim().length<3}>Reject receipt review</button></>:<p className="muted">{eligible?'An Owner must review this order. Switch to your shop’s Owner account to continue.':'Keep this order unpaid and on hold. The Owner can review evidence, but cannot bypass the payment block.'}</p>}</div>}
        </>:o.payment_state==='PAID'?<>
          <div className="payment-confirmed"><span aria-hidden="true">✓</span><h3>{label(o.payment_state)}</h3><p>Confirmed from independent demo bank evidence.</p></div>
          {o.fulfillment_state==='ON_HOLD'?<><p className="muted">Payment is confirmed. Releasing the order is a separate decision.</p><button className="button primary full" disabled={disabled||(o.total_sen>data.settings.release_owner_threshold_sen&&actor.role!=='OWNER')} onClick={()=>act(()=>api.write(`/orders/${id}/release`,{expected_version:o.version}),'Order released. The action has been recorded.')}>Release order</button>{o.total_sen>data.settings.release_owner_threshold_sen&&actor.role!=='OWNER'&&<p className="muted">Only an Owner can release this high-value order.</p>}</>:<div className="notice success">Order released. Both payment and fulfilment actions are recorded separately.</div>}
        </>:<div className="notice">This payment state requires further review. Full payment and release cannot be confirmed in this demo branch.</div>}
        <p className="fine-print">All payment and release permissions are checked by the server.</p>
      </section>
      <section className="panel reply-panel"><h2>Reply draft</h2><p className="muted">Copy a draft after reviewing its current payment status. Nothing is sent automatically.</p><Notice error={reply.error}/><textarea aria-label="Reply draft" readOnly value={reply.value?.text??'Loading draft…'}/><button className="button ghost full" disabled={!reply.value||reply.loading} onClick={async()=>{try{await navigator.clipboard.writeText(reply.value!.text);setCopied(true);setTimeout(()=>setCopied(false),2500);}catch{setError(Error('Copy is unavailable. Select the draft text and copy it manually.'));}}}>{copied?'Copied':'Copy draft'}</button></section>
    </aside></div>
    <section className="panel order-activity"><div className="panel-heading"><div><h2>Order activity</h2><p className="muted">Most recent 20 actions · times in MYT</p></div></div><EventList events={data.events}/></section>
  </>;
}
