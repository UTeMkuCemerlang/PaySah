import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type pg from 'pg';

// Shared by the npm db:migrate / db:seed commands and the optional start-up step of the deployment launcher.
// SQL files are read from `root` (the project root), so this works from any working directory.
export async function migrate(pool: pg.Pool, root = process.cwd()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7215001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of (await readdir(join(root, 'db/migrations'))).filter(n => n.endsWith('.sql')).sort()) {
      const sql = await readFile(join(root, 'db/migrations', name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = await client.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (prior.rowCount) {
        if (prior.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)', [name, checksum]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function seed(pool: pg.Pool, root = process.cwd()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const name of (await readdir(join(root, 'db/seeds'))).filter(n => n.endsWith('.sql')).sort()) {
      await client.query(await readFile(join(root, 'db/seeds', name), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

// Demo-only: clears one synthetic tenant's business records and re-applies the seeds, so used demo orders become new again.
// Users and sessions stay; other tenants keep their data because every seed insert is ON CONFLICT DO NOTHING.
export async function resetDemoTenant(pool: pg.Pool, tenantId: string, root = process.cwd()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`m2:${tenantId}`]);
    const tenant = await client.query('SELECT 1 FROM tenants WHERE id=$1 AND is_demo FOR UPDATE', [tenantId]);
    if (!tenant.rowCount) throw new Error('Only synthetic demo tenants can be reset');
    await client.query('UPDATE orders SET current_receipt_id=NULL WHERE tenant_id=$1', [tenantId]);
    await client.query('UPDATE receipts SET intake_message_id=NULL WHERE tenant_id=$1', [tenantId]);
    // A public demo reset must not refund receipt-processing quotas. Keep only
    // the current budget window's hashed identity/idempotency ledger, detached
    // from deleted evidence. Late downloads cannot revive the rejected lease.
    await client.query(`UPDATE intake_messages SET status='REJECTED',reason='DEMO_RESET_IMAGE',receipt_id=NULL,link_id=NULL,order_id=NULL,lease_token=NULL,lease_until=NULL
      WHERE tenant_id=$1 AND channel='TELEGRAM' AND created_at>now()-interval '24 hours'
      AND (receipt_id IS NOT NULL OR status IN ('RECEIVING','RETRYABLE') OR reason IN ('IMAGE_INVALID','ATTEMPTS_EXHAUSTED','DEMO_RESET_IMAGE'))`,[tenantId]);
    for (const table of ['intake_bindings', 'verification_jobs', 'receipt_jobs', 'extraction_runs', 'receipt_corrections', 'payment_allocations', 'approvals',
      'intake_messages', 'verifications', 'receipts', 'intake_links', 'activity_events', 'idempotency_keys', 'bank_transactions', 'orders', 'merchant_accounts', 'customers'])
      await client.query(`DELETE FROM ${table} WHERE tenant_id=$1${table==='intake_messages'?" AND (reason IS DISTINCT FROM 'DEMO_RESET_IMAGE' OR created_at<=now()-interval '24 hours')":''}`, [tenantId]);
    for (const name of (await readdir(join(root, 'db/seeds'))).filter(n => n.endsWith('.sql')).sort()) {
      await client.query(await readFile(join(root, 'db/seeds', name), 'utf8'));
    }
    if(tenantId==='10000000-0000-4000-8000-000000000003')await client.query(await readFile(join(root,'fixtures/finalist/laundry.sql'),'utf8'));
    const orders = (await client.query('SELECT count(*)::int AS n FROM orders WHERE tenant_id=$1', [tenantId])).rows[0].n as number;
    await client.query('COMMIT');
    return { orders };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
