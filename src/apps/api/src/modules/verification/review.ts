import type pg from 'pg';
import {ApiError} from '../../business.js';
import {tenantPolicy} from './policy.js';
import {publicReceipt} from '../receipts/router.js';

// A read-only snapshot prevents the review screen from mixing evidence versions.
export async function orderReview(pool:pg.Pool,tenant:string,id:string){
  const db=await pool.connect();
  try{
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const order=(await db.query('SELECT id,external_id,total_sen,currency,payment_state,fulfillment_state,version,created_at FROM orders WHERE tenant_id=$1 AND id=$2',[tenant,id])).rows[0];
    if(!order)throw new ApiError(404,'NOT_FOUND','Order not found');
    const receipts=(await db.query('SELECT * FROM receipts WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at DESC,id DESC LIMIT 20',[tenant,id])).rows.map(publicReceipt);
    const verification=(await db.query('SELECT * FROM verifications WHERE tenant_id=$1 AND order_id=$2 ORDER BY active DESC,created_at DESC,id DESC LIMIT 1',[tenant,id])).rows[0]??null;
    const approvals=(await db.query('SELECT * FROM approvals WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at DESC,id DESC LIMIT 20',[tenant,id])).rows;
    const allocations=(await db.query('SELECT bank_transaction_id,amount_sen FROM payment_allocations WHERE tenant_id=$1 AND order_id=$2',[tenant,id])).rows;
    const ids=[...new Set<string>([...(verification?.result.candidates??[]),...allocations.map(a=>a.bank_transaction_id)])];
    const bank_transactions=(await db.query('SELECT t.id,t.account_id,a.account_identifier,t.bank_transaction_ref,t.amount_sen,t.currency,t.direction,t.status,t.booked_at,t.source_kind FROM bank_transactions t JOIN merchant_accounts a ON a.tenant_id=t.tenant_id AND a.id=t.account_id WHERE t.tenant_id=$1 AND t.id=ANY($2::uuid[]) ORDER BY t.id',[tenant,ids])).rows;
    const events=(await db.query('SELECT e.id,e.action,e.entity_type,e.payload,e.created_at,e.seq,u.display_name AS actor_name FROM activity_events e JOIN users u ON u.tenant_id=e.tenant_id AND u.id=e.actor_id WHERE e.tenant_id=$1 AND e.order_id=$2 ORDER BY e.seq DESC LIMIT 20',[tenant,id])).rows;
    const settings=await tenantPolicy(db,tenant);
    await db.query('COMMIT');return {order,receipts,verification,approvals,allocations,bank_transactions,events,settings};
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
