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

## Owner review limit (2026-10-31)

`POST /api/v1/tenant/settings` with `{owner_review_threshold_sen,expected_policy_version,reason}` and an `Idempotency-Key` changes the session shop's Owner review limit. Owner only (403 otherwise); 0 to RM 1,000,000 in integer sen (422 otherwise); a stale version returns 409 `STALE_POLICY`. It increments `policy_version`, so earlier checks and open approvals become `STALE_APPROVAL` and existing payments are unchanged. It records `policy.changed` with before, after and reason. The release limit is separate and not changed here. An Owner demo reset restores the shop's default limit. Eligibility rules are unaffected: missing or invalid bank evidence stays blocked at any limit. The route needs migration `007_policy_audit.sql`; without it the route returns 503 `POLICY_CHANGE_UNAVAILABLE` and the rest of the application keeps working, so readiness does not require 007.

## Reading retry (2026-10-31)

`POST /api/v1/receipts/:id/retry-reading` with `{expected_version}` and an `Idempotency-Key` queues a failed reading again. It requires an unpaid order, the current receipt and `extraction_state=ERROR`; otherwise it returns 409 (`NOT_RETRYABLE`, `STALE_RECEIPT`, or the existing version and payment errors). It writes `receipt.retry_requested` and changes no schema. The parser is `labelled-receipt.v2`: it repairs known OCR confusions in format fields only (space before a label colon, a trailing `2` or `7` read for `Z` in a timestamp, spaces or `|` in the document type). References, accounts and amounts stay exact. The verification rules are unchanged.

## Live review fixes (2026-10-30)

Health and readiness use the shared `APP_STAGE = FINALIST`. Build identity resolves a valid explicit `PAYSAH_BUILD_COMMIT`, then clean Git HEAD, then an archive `.build-commit` only when Git metadata is unavailable. A dirty or unverifiable Git checkout remains `unknown` without an explicit override; a stale archive marker cannot make it look clean. Invalid explicit values fail closed to `unknown`. Build metadata records and logs its source (`env`, `git`, `file`, `unknown`). Explicit injection is the deployer's assertion about verified source, not a remote-main lookup.

`GET /demo/receipt-fixtures` retains id/fields and adds a readable `label` and `amount_sen`. Fixture IDs and selection values are unchanged. The browser initially selects the single reference match, then the single amount match, then normal. It never attaches automatically and preserves a manual choice until the order changes.

`GET /orders/:id/reply-draft` retains `text`, `source:SYNTHETIC_DEMO`, `sent:false` and adds `state`: MISSING_EVIDENCE, CHECKING, BLOCKED, MATCHED, PAID or RELEASED. A read-only repeatable snapshot checks the current receipt, verification activity/versions, policy and evidence fingerprint before calling a match current. Changed bank/account evidence also makes the draft CHECKING. It does not enqueue extraction, call a model, write business state or send messages. Blocked text omits internal evidence reasons. Paid/released wording comes from persisted payment/fulfilment states.
