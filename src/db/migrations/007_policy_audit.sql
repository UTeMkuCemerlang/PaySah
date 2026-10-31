-- Lets the activity log record shop policy changes, which belong to no order. Everything else matches 005.
ALTER TABLE activity_events DROP CONSTRAINT activity_events_entity_type_check;
ALTER TABLE activity_events ADD CONSTRAINT activity_events_entity_type_check CHECK(entity_type IN ('order','receipt','verification','approval','bank_transaction','intake','intake_link','tenant_settings'));
CREATE OR REPLACE FUNCTION validate_activity_entity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked_order uuid; valid boolean;
BEGIN
  IF NEW.entity_type='order' THEN
    NEW.order_id := NEW.entity_id;
    SELECT EXISTS(SELECT 1 FROM orders WHERE tenant_id=NEW.tenant_id AND id=NEW.entity_id) INTO valid;
  ELSIF NEW.entity_type='bank_transaction' THEN
    SELECT EXISTS(SELECT 1 FROM bank_transactions WHERE tenant_id=NEW.tenant_id AND id=NEW.entity_id) INTO valid;
    IF NEW.order_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid activity order' USING ERRCODE='23503'; END IF;
  ELSIF NEW.entity_type='intake' THEN
    SELECT EXISTS(SELECT 1 FROM intake_messages WHERE tenant_id=NEW.tenant_id AND id=NEW.entity_id AND order_id IS NOT DISTINCT FROM NEW.order_id) INTO valid;
  ELSIF NEW.entity_type='intake_link' THEN
    SELECT EXISTS(SELECT 1 FROM intake_links WHERE tenant_id=NEW.tenant_id AND id=NEW.entity_id AND order_id=NEW.order_id) INTO valid;
  ELSIF NEW.entity_type='tenant_settings' THEN
    valid := NEW.entity_id=NEW.tenant_id AND NEW.order_id IS NULL;
  ELSE
    IF NEW.entity_type='receipt' THEN SELECT order_id INTO linked_order FROM receipts WHERE tenant_id=NEW.tenant_id AND id=NEW.entity_id;
    ELSIF NEW.entity_type='verification' THEN SELECT order_id INTO linked_order FROM verifications WHERE tenant_id=NEW.tenant_id AND id=NEW.entity_id;
    ELSE SELECT order_id INTO linked_order FROM approvals WHERE tenant_id=NEW.tenant_id AND id=NEW.entity_id; END IF;
    valid := linked_order IS NOT NULL AND NEW.order_id IS NOT NULL AND NEW.order_id=linked_order;
  END IF;
  IF valid IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid activity entity' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
