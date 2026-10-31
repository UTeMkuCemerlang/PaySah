-- An order may now collect several bank credits; each credit still belongs to one order only.
ALTER TABLE payment_allocations DROP CONSTRAINT allocation_order_unique;
