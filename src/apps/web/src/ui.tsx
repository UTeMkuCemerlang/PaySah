import {useEffect,useRef,useState,type ReactNode} from 'react';
import {errorMessage} from './api.js';
import {label,time} from './copy.js';
import type {ActivityEvent} from './types.js';
export function Badge({value}:{value:string}){const tone=['PAID','RELEASED','APPROVED','COMPLETED','MATCHED'].includes(value)?'good':['UNPAID','PENDING','ON_HOLD','NEEDS_REVIEW','AWAITING_BANK','RUNNING'].includes(value)?'warm':['INVALID_EVIDENCE','ERROR','REJECTED','RECONCILIATION_REQUIRED'].includes(value)?'bad':'quiet';return <span className={`badge ${tone}`}>{label(value)}</span>;}
export function Notice({error}:{error:unknown}){return error?<div className="notice error" role="alert">{errorMessage(error)}</div>:null;}
export function Empty({title,children}:{title:string;children?:ReactNode}){return <div className="empty"><span className="empty-mark" aria-hidden="true">↗</span><h3>{title}</h3>{children&&<p>{children}</p>}</div>;}
export function Pager({page,hasNext,onPage,loading=false}:{page:number;hasNext:boolean;onPage:(n:number)=>void;loading?:boolean}){return <nav className="pager" aria-label="Page navigation"><span>Page {page+1}</span><div><button className="button ghost small" disabled={loading||page===0} onClick={()=>onPage(page-1)}>Previous</button><button className="button ghost small" disabled={loading||!hasNext} onClick={()=>onPage(page+1)}>Next</button></div></nav>;}
function eventTitle(e:ActivityEvent){
 if(e.action==='intake.received'&&e.payload.reused===true&&e.payload.current===false)return 'Older receipt resubmitted; current evidence unchanged.';
 if(e.action==='receipt.extracted')return e.payload.fallback_reason?'Receipt read by CPU fallback':e.payload.provider==='RUNPOD_VLM'?'Receipt read by RunPod GPU':e.payload.provider==='CPU_OCR'?'Receipt read by CPU OCR':'Receipt read';
 if(e.action==='approval.decided')return `Owner decision: ${typeof e.payload.decision==='string'?label(e.payload.decision):'recorded'}`;
 return label(e.action);
}
export function EventList({events}:{events:ActivityEvent[]}){
 const previous=useRef<Set<string>|null>(null),[fresh,setFresh]=useState<Set<string>>(new Set());
 useEffect(()=>{const next=new Set(events.map(e=>e.id));const added=previous.current?new Set([...next].filter(id=>!previous.current!.has(id))):new Set<string>();previous.current=next;setFresh(added);const timer=setTimeout(()=>setFresh(new Set()),3000);return()=>clearTimeout(timer);},[events]);
 return events.length?<ol className="timeline">{events.map(e=><li key={e.id} className={fresh.has(e.id)?'event-new':undefined}><span className="timeline-dot"/><div><strong>{eventTitle(e)}</strong><p>{e.actor_name} <span aria-hidden="true">·</span> <time dateTime={e.created_at}>{time(e.created_at)} MYT</time></p>{e.external_id&&<a href={`#orders/${e.order_id}`}>{e.external_id}</a>}{typeof e.payload.reason==='string'&&<blockquote>{e.payload.reason}</blockquote>}{typeof e.payload.fallback_reason==='string'&&<p>Fallback reason: {e.payload.fallback_reason}</p>}{e.action==='access.denied'&&<p>{String(e.payload.role??'User')} · {String(e.payload.code??'FORBIDDEN')}</p>}{typeof e.payload.before==='string'&&typeof e.payload.after==='string'&&<p>{label(e.payload.before)} → {label(e.payload.after)}</p>}{Array.isArray(e.payload.flags)&&e.payload.flags.length>0&&<p>{e.payload.flags.map((code:string)=>label(code)).join(' ')}</p>}</div></li>)}</ol>:<Empty title="No activity yet">New actions will appear here with the person and time.</Empty>;
}
