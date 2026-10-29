# Proposed Orbyte mock adapter

This is a team-defined contract and local demonstration, not an official Orbyte API or live integration.

Run `npm run mock:orbyte` from `src/` with a dedicated local `TEST_DATABASE_URL`. The script creates a disposable schema, uses synthetic demo identity and receipt fields, then removes only that schema. It creates a new order, repeats the same idempotency key, verifies a receipt, confirms payment and separately releases the order. No external messages or GPU calls are made.

| Proposed input | Existing PaySah field |
| --- | --- |
| external_order_id | external_id |
| amount_sen | total_sen, positive integer |
| currency | MYR |
| customer_ref | Not mapped: arbitrary references are not customer UUIDs. A real adapter must resolve the customer within its tenant. |

The mock authenticates as an existing synthetic shop user. It does not implement service-to-service credentials. Production integration would require separately reviewed authentication, tenant mapping, retry handling and an agreed official contract.

`GET /activity?order_id=...&after_seq=...` supplies ascending events. The mock persists its cursor in memory and deduplicates event IDs during a run; durable restart checkpoints remain future integration work. `verification.completed` never means paid. `payment.confirmed` and `fulfillment.released` are separate events. A missing historical entity version is emitted as null, not invented.
