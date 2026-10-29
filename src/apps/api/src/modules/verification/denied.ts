import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {ApiError,type Actor} from '../../business.js';

// Called only after the business transaction has rolled back. Audit failure must
// never change a denied response or leak the existence of another shop's object.
export async function auditDenied(db:pg.PoolClient,actor:Actor,path:string,error:unknown,correlation:string){
 if(!(error instanceof ApiError)||error.status!==403)return;
 const match=/^\/(orders|verifications|approvals)\/([0-9a-f-]{36})\/(confirm|decision|release)$/.exec(path);
 if(!match)return;
 const [,kind,id,action]=match;
 const table=kind==='orders'?'orders':kind;
 const column=kind==='orders'?'id':'order_id';
 try{
  await db.query('BEGIN');
  await db.query("SET LOCAL statement_timeout='1500ms'");
  const row=(await db.query(`SELECT r.${column} AS order_id,u.role FROM ${table} r JOIN users u ON u.tenant_id=r.tenant_id AND u.id=$3 AND u.active AND u.role IN ('OWNER','CASHIER') WHERE r.tenant_id=$1 AND r.id=$2`,[actor.tenant_id,id,actor.id])).rows[0];
  if(row)await db.query("INSERT INTO activity_events(id,tenant_id,actor_id,action,entity_type,entity_id,order_id,payload,correlation_id) VALUES ($1,$2,$3,'access.denied','order',$4,$4,$5,$6)",[randomUUID(),actor.tenant_id,actor.id,row.order_id,JSON.stringify({route:`${kind}.${action}`,role:row.role,code:error.code}),correlation]);
  await db.query('COMMIT');
 }catch{try{await db.query('ROLLBACK');}catch{}console.warn('Denied request audit unavailable');}
}
