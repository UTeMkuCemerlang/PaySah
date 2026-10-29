-- Explicit opt-in synthetic RM300 Bakery order for the two-shop policy demo. Never run this automatically in production.
-- Pairs with fixtures/receipts/bakery_300.png; Laundry C uses its own receipt, reference and credit.
INSERT INTO orders(id,tenant_id,external_id,total_sen) VALUES
('41000000-0000-4000-8000-000000000300','10000000-0000-4000-8000-000000000001','FINAL-BAKERY-300',30000) ON CONFLICT DO NOTHING;
INSERT INTO bank_transactions(id,tenant_id,account_id,provider_tx_id,bank_transaction_ref,amount_sen,currency,direction,status,booked_at,source_kind) VALUES
('61000000-0000-4000-8000-000000000300','10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','FINAL-BAKERY-300','FINAL-BAKERY-300',30000,'MYR','CREDIT','BOOKED','2026-10-22T06:00:00Z','SYNTHETIC_FEED') ON CONFLICT DO NOTHING;
