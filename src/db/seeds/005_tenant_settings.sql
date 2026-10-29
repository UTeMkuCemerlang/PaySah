-- Defaults only; never overwrite an existing shop policy.
INSERT INTO tenant_settings(tenant_id,business_type,owner_review_threshold_sen,release_owner_threshold_sen)
SELECT id,CASE WHEN id='10000000-0000-4000-8000-000000000001'::uuid THEN 'BAKERY' ELSE 'GENERAL' END,50000,50000 FROM tenants
ON CONFLICT DO NOTHING;
