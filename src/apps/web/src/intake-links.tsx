import {useState} from 'react';
import {ApiClient} from './api.js';
import {useResource} from './hooks.js';
import {Notice} from './ui.js';
import {time} from './copy.js';
export function IntakeLinks({api,id,version,unpaid}:{api:ApiClient;id:string;version:number;unpaid:boolean}){
 const links=useResource(s=>api.get<{channels:string[];links:Array<{link_id:string;channel:string;expires_at:string;revoked_at:string|null}>}>(`/orders/${id}/intake-links`,s),[api,id,version],10000);
 const [url,setUrl]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[notice,setNotice]=useState('');
 async function create(channel:string){setBusy(true);setError(undefined);setUrl('');setNotice('');try{const result=await api.write<{url:string|null}>(`/orders/${id}/intake-links`,{expected_version:version,channel});setUrl(result.url??'');if(!result.url)setNotice('This link was already created. Generate a new link to replace it.');links.refresh();}catch(e){setError(e);}finally{setBusy(false);}}
 if(!links.value)return null;
 if(!links.value.channels.length)return <section className="intake-links" aria-label="Receipt submission links"><h3>Or let the customer send it</h3><p className="muted">Telegram and Google Form are not connected to this shop. On the live demo they are connected to Demo Kedai A.</p></section>;
 return <section className="intake-links" aria-label="Receipt submission links"><h3>Or let the customer send it</h3><p className="muted">Team synthetic receipts only. Receiving a receipt does not confirm payment.</p><Notice error={error??links.error}/>{notice&&<p role="status">{notice}</p>}
 {unpaid&&<div className="heading-actions">{links.value.channels.map(ch=><button className="button ghost small" key={ch} disabled={busy} onClick={()=>void create(ch)}>Create {ch==='TELEGRAM'?'Telegram':'Google Form'} link</button>)}</div>}
 {url&&<div className="form-stack"><label>Copy receipt submission link<input readOnly value={url} onFocus={e=>e.target.select()}/></label><button className="button secondary small" onClick={async()=>{try{await navigator.clipboard.writeText(url);setNotice('Submission link copied.');}catch{setNotice('Select and copy the link above.');}}}>Copy submission link</button><p className="muted">New links replace older links for the same channel. Keep this URL private.</p></div>}
 {links.value.links.filter(l=>!l.revoked_at&&Date.parse(l.expires_at)>Date.now()).map(l=><div className="intake-link-row" key={l.link_id}><span>{l.channel==='TELEGRAM'?'Telegram':'Google Form'} · expires {time(l.expires_at)} MYT</span>{unpaid&&<button className="button ghost small" disabled={busy} onClick={async()=>{setBusy(true);setError(undefined);try{await api.write(`/orders/${id}/intake-links/${l.link_id}/revoke`,{expected_version:version});setUrl('');setNotice('Submission link revoked.');links.refresh();}catch(e){setError(e);}finally{setBusy(false);}}}>Revoke {l.channel==='TELEGRAM'?'Telegram':'Google Form'} link</button>}</div>)}
 </section>;
}
