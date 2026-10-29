# Finalist API additions

All routes retain bearer demo sessions, tenant isolation and no-store responses.

## Activity

`GET /api/v1/activity?limit=20&offset=0&order_id=<uuid>` keeps the existing `{events,limit,offset}` response. `order_id` is optional and includes linked receipt, verification and approval events. A missing or other-shop order returns 404; malformed UUID returns 422.

`after_seq=<nonnegative integer>` selects increasing sequence order and returns `last_seq`, the last event actually returned (or the supplied cursor for an empty page). A nonzero offset with a cursor returns 422. Normal pagination remains descending. Events contain actual actor, payload, timestamp and correlation ID. Historical before/after values are available only when recorded.

## Approval gate

An authenticated same-shop denied `confirm`, `decision` or `release` writes `access.denied` after the original transaction rolls back. Its payload contains only enumerated route, server role and error code. No denial event is written for another shop's object. Audit failure does not change the denied response. Repeated denied requests may each produce an event; business idempotency semantics are unchanged.

Owner `APPROVE` atomically confirms payment; `release` is a separate request using the returned order version. Evidence eligibility is always required.

## Local evidence

From `src/`, set a dedicated local `TEST_DATABASE_URL`, then run `npm run demo:gate`. The script creates and removes a random isolated schema and uses new synthetic orders. It does not contact production, OCR, RunPod or messaging services. Reports are labelled `LOCAL_FIXTURE`, not channel or visual accuracy evidence.

## Tenant policies

`GET /api/v1/tenant/settings` returns `{settings:{business_type,owner_review_threshold_sen,release_owner_threshold_sen,policy_version}}` for the session tenant; no tenant selector is accepted. The review snapshot also includes `settings`. Values are integer sen and positive policy version, read only through this API.

Verification `result` now includes `policy_version` and `owner_review_threshold_sen`; rule version is `rules.v2-tenant-policy`. Confirm/approval reevaluate the policy within the existing tenant write transaction. Changed policy produces `STALE_APPROVAL` for old verification results; callers must request a new verification. After payment, release reads the current independent release threshold. Existing payment is never undone by a policy change. A missing policy returns 503 `POLICY_UNAVAILABLE`.

Readiness now requires migration 006 and its exact checksum. Health also returns `commit`, build-time clean source Git SHA or `unknown`. This is additive; existing session/write/version/idempotency responses are retained.
