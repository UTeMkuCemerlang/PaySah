CREATE TABLE tenant_settings (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
 business_type text NOT NULL CHECK (business_type IN ('BAKERY','LAUNDRY','GENERAL')),
 owner_review_threshold_sen integer NOT NULL CHECK (owner_review_threshold_sen BETWEEN 0 AND 2147483647),
 release_owner_threshold_sen integer NOT NULL CHECK (release_owner_threshold_sen BETWEEN 0 AND 2147483647),
 policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0)
);
INSERT INTO tenant_settings(tenant_id,business_type,owner_review_threshold_sen,release_owner_threshold_sen)
SELECT id,CASE WHEN id='10000000-0000-4000-8000-000000000001'::uuid THEN 'BAKERY' ELSE 'GENERAL' END,50000,50000 FROM tenants;
