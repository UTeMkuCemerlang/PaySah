import {z} from 'zod';
export const studyRowSchema=z.object({participant:z.string().regex(/^P\d{2}$/),case_id:z.string().min(1).max(60),pair_id:z.string().min(1).max(60),condition:z.enum(['MANUAL','PAYSAH']),commit:z.string().regex(/^[0-9a-f]{40}$/),active_seconds:z.number().positive(),elapsed_seconds:z.number().positive(),manual_file_actions:z.number().int().nonnegative(),correct:z.boolean(),team_member:z.boolean()}).strict();
export function median(values:number[]){const a=[...values].sort((x,y)=>x-y);return a.length?a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2:null;}
export function scoreStudy(input:unknown){
 const rows=z.array(studyRowSchema).min(1).parse(input),seen=new Set<string>();
 for(const r of rows){const key=`${r.participant}/${r.pair_id}/${r.condition}`;if(seen.has(key))throw Error('Duplicate participant/pair/condition');seen.add(key);if(r.active_seconds>r.elapsed_seconds)throw Error('Active time cannot exceed elapsed time');}
 const groups=new Map<string,typeof rows>();for(const row of rows){const key=`${row.participant}/${row.pair_id}`;groups.set(key,[...(groups.get(key)??[]),row]);}
 const pairs=[...groups.entries()].filter(([,r])=>r.length===2).map(([id,rs])=>{const m=rs.find(r=>r.condition==='MANUAL')!,p=rs.find(r=>r.condition==='PAYSAH')!;return {id,manual_seconds:m.active_seconds,paysah_seconds:p.active_seconds,reduction_percent:(m.active_seconds-p.active_seconds)/m.active_seconds*100};});
 const manual=median(pairs.map(p=>p.manual_seconds)),paysah=median(pairs.map(p=>p.paysah_seconds));
 return {observations:rows.length,participants:new Set(rows.map(r=>r.participant)).size,paired_cases:pairs.length,unpaired_groups:groups.size-pairs.length,manual_active_median_seconds:manual,paysah_active_median_seconds:paysah,active_time_reduction_percent:manual&&paysah!==null?(manual-paysah)/manual*100:null,paired_reduction_median_percent:median(pairs.map(p=>p.reduction_percent)),incorrect:rows.filter(r=>!r.correct).length,manual_file_actions:rows.filter(r=>r.condition==='MANUAL').reduce((s,r)=>s+r.manual_file_actions,0),paysah_file_actions:rows.filter(r=>r.condition==='PAYSAH').reduce((s,r)=>s+r.manual_file_actions,0),pairs};
}
// Spreadsheet export: header row with the schema's column names; extra columns (notes, timestamps) stay in raw evidence and are ignored here.
export function parseStudyCsv(text:string){
 const [header,...lines]=text.replace(/^﻿/,'').split(/\r?\n/).filter(l=>l.trim()&&!/^[,\s]*$/.test(l)).map(l=>l.split(',').map(c=>c.trim()));
 if(!header)throw Error('Empty CSV');
 const bool=(v:string)=>/^(true|yes|y|1)$/i.test(v)?true:/^(false|no|n|0)$/i.test(v)?false:v;
 const num=(v:string)=>v===''?v:Number(v);
 return lines.map(cells=>{const row:Record<string,unknown>={};
  for(const key of Object.keys(studyRowSchema.shape)){const v=cells[header.indexOf(key)]??'';
   row[key]=['active_seconds','elapsed_seconds','manual_file_actions'].includes(key)?num(v):['correct','team_member'].includes(key)?bool(v):key==='condition'?v.toUpperCase():v;}
  return row;});
}
