import type pg from 'pg';
import {ApiError} from '../../business.js';
export async function tenantPolicy(db:pg.Pool|pg.PoolClient,tenant:string){
 const row=(await db.query('SELECT business_type,owner_review_threshold_sen,release_owner_threshold_sen,policy_version FROM tenant_settings WHERE tenant_id=$1',[tenant])).rows[0];
 if(!row)throw new ApiError(503,'POLICY_UNAVAILABLE','Shop policy is not configured');
 return row as {business_type:'BAKERY'|'LAUNDRY'|'GENERAL';owner_review_threshold_sen:number;release_owner_threshold_sen:number;policy_version:number};
}
