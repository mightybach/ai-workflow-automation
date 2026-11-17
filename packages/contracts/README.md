# API contracts

## Booking Phase 1 — implemented read-only business setup

All paths use `/api/v1` and the existing traceable error envelope. The authenticated user must have an active business membership and active business; legacy `User.role` alone grants no business access. Both OWNER and STAFF can inspect the setup. The current membership model supports one business per user; the server derives it, rather than accepting a browser-provided businessId.

| Method | Path | Input | Response |
| --- | --- | --- | --- |
| GET | /admin/business | No query fields | BusinessSetupResponseSchema: business, membership role and business-local today |
| GET | /admin/staff | AdminListQuerySchema | StaffListResponseSchema: items and pagination |
| GET | /admin/services | AdminListQuerySchema | ServiceListResponseSchema: items and pagination |
| GET | /admin/slots | AdminSlotQuerySchema | AdminSlotListResponseSchema: items, pagination, local date and timezone |

Staff/service pagination defaults to page 1 / size 10, maximum size 50. Slot queries require a real YYYY-MM-DD calendar date between 2000 and 2100; optional staffId and state (AVAILABLE, RESERVED, BLOCKED) filters use the same limits. The date is interpreted in the authenticated business time zone, not UTC. An unknown or other-business staffId returns the same 404. Unknown fields (including businessId) are rejected. Lists and counts are scoped identically and read in a consistent snapshot. Sort staff by displayName/id, services by name/id and slots by startAt/staffId/id.

BusinessDateSchema validates calendar dates; BusinessTimezoneSchema validates supported time-zone identifiers. Slot instants are UTC ISO strings and duration is exactly 30 minutes. Service DTOs use literal durationMinutes=30. No schedule, service or staff mutation routes, customer availability, booking confirmation, customer chat or AI contracts are implemented in this phase.

Audit DTOs now permit a null runId only with a business/entity subject. Legacy workflow events remain supported. No audit mutation or generic audit-read endpoint is introduced.

## Legacy request-management contracts — retained

These are shared Zod schemas and inferred TypeScript types for the implemented Phase 1 HTTP boundary. Route handlers separately enforce authentication, permissions and transactional persistence. Validation alone does not grant authorization, execute workflows or replace database constraints.

Import through `@flowpilot/contracts`. The package remains browser-safe and does not import Prisma or database credentials.

## Implemented endpoints

Base path: `/api/v1`.

| Method | Path | Input | Success response |
| --- | --- | --- | --- |
| GET | /health/live | None | 200 HealthResponseSchema |
| GET | /health/ready | None | 200 { status: "ok" }; 503 if PostgreSQL is unavailable |
| POST | /auth/login | LoginBodySchema | 200 SessionResponseSchema + HttpOnly cookie |
| GET | /auth/me | Session cookie | 200 SessionResponseSchema |
| POST | /auth/logout | Session cookie | 200 LogoutResponseSchema |
| POST | /requests | CreateRequestBodySchema + IdempotencyHeadersSchema | 202 CreateRequestResponseSchema |
| GET | /requests | RequestListQuerySchema | 200 RequestListResponseSchema |
| GET | /requests/:id | IdParamsSchema | 200 RequestDetailSchema |
| GET | /workflows/:id | IdParamsSchema | 200 WorkflowResponseSchema |

All request/workflow routes require authenticated access. The server derives creator identity from the opaque session cookie. CLIENT may submit and read its own requests/workflows; ADMIN and REVIEWER may submit and read all requests/workflows. Ownership scope applies before list filtering/counting/pagination. Other users' request/workflow identifiers return 404 to CLIENT. Current user activity and role are read from PostgreSQL on each request.

Unsafe requests (including login/logout) require an exact `Origin` matching WEB_ORIGIN and `X-Flowpilot-Client: web`. The browser supplies Origin for POSTs; API clients must set it explicitly. No cross-origin CORS access is enabled. Login accepts only email/password, rotates any current session, and is limited to ten attempts per minute per IP. The raw token exists only in an HttpOnly SameSite=Strict cookie; its SHA-256 hash is stored in PostgreSQL. Sessions expire after eight hours; logout deletes the session record. The entry point is restricted to loopback development/test mode and explicitly enabled demo auth.

UserResponseSchema is used by authenticated session responses. AuditEventResponseSchema and MockOrderResponseSchema remain DTOs for later authorized reads; no general user/admin/audit/order endpoints are exposed. Approval, execution, cancellation and retry endpoints are deferred to later phases.

## Create a request

```http
POST /api/v1/requests
Content-Type: application/json
Idempotency-Key: demo-request-001
Origin: http://127.0.0.1:5173
X-Flowpilot-Client: web

{"rawText":"My synthetic order 12345 arrived damaged."}
```

The body accepts only rawText: 1–10,000 characters with at least one non-whitespace character. Preserve original text exactly. Identity, role, timestamps, status, category and approvals cannot be supplied in the body. No source or payloadHash field is invented for the migrated schema.

The required key is 1–128 characters from letters, digits, period, underscore, colon or hyphen. It is scoped by the authenticated creator, matching the database's composite unique constraint. Same creator/key and identical rawText must return the original request and initial run identifiers without creating another run/audit event. A different rawText with that key must return 409 IDEMPOTENCY_CONFLICT. This must be implemented transactionally; parsing alone does not provide idempotency. A replay may report the existing run's current status, while a new run starts PENDING.

Example response:

```json
{
  "requestId": "c27a63c1-2459-47bb-8d5c-f3fc15bd1ddd",
  "workflowRunId": "8c21b672-d7ac-4dd1-805d-bd37bad90483",
  "status": "PENDING"
}
```

Fastify normalizes header names to lowercase. Parse the selected header, not the entire framework headers object, because the schema is strict:

```ts
const body = CreateRequestBodySchema.parse(request.body);
const headers = IdempotencyHeadersSchema.parse({
  'idempotency-key': request.headers['idempotency-key'],
});
```

## List and detail

List query fields:

| Field | Rule |
| --- | --- |
| page | Positive integer or digit string; default 1, maximum 100000 |
| pageSize | Positive integer or digit string; default 10, maximum 50 |
| search | Optional trimmed nonblank text, maximum 200 characters |
| status | Optional WorkflowStatus enum |
| category | Optional WorkflowCategory enum |

Unknown query fields and invalid coercions (booleans, null, arrays, fractions, blanks) are rejected. Search should match rawText without case sensitivity. Combine filters with AND; when status and category are both provided, the same workflow must match both. Sort by createdAt descending then id descending. Total counts matching requests, not workflow runs. Apply authorization scope before counting or paginating.

The response is `{ items: RequestSummary[], pagination: { page, pageSize, total } }`. Each summary contains id, createdById, createdAt and a workflows array. One request may have multiple runs; no single latest run is implied. Order embedded runs by createdAt ascending, then id ascending for a deterministic result.

Detail adds rawText. Lists omit full text; both responses omit idempotency keys. The application uses these routes for saved requests. Original draft-preview components remain separate examples and do not provide edit/delete behavior for persisted records.

## Serialization and errors

- Use UUID strings for IDs and UTC ISO-8601 strings for timestamps; convert Date objects with toISOString().
- Nullable fields are explicit null, not omitted.
- Workflow responses include version for concurrency control, plus nullable category/completedAt.
- User DTOs exclude passwordHash and password. Select fields explicitly before parsing instead of passing full Prisma records.
- Audit metadata must be redacted by server code. Validation checks JSON shape and actor identity consistency, not whether its text contains secrets.
- Serialize mock-order amounts with Decimal.toFixed(2). Decimal(12,2) values are nonnegative strings with up to 10 whole digits and exactly two decimal places. Three uppercase letters validate currency format, not ISO currency membership.
- Existing OTHER category means unsupported/unclear input and must route to manual review during workflow implementation. It does not authorize an executable fallback workflow.
- Submitted requests and audit history have no generic update/delete contracts. The disposable draft CRUD preview does not define lifecycle behavior for persisted workflows.

Error shape: `{ code, message, traceId }`. Suggested codes for future route handlers: VALIDATION_ERROR (400), UNAUTHENTICATED (401), FORBIDDEN (403), NOT_FOUND (404), IDEMPOTENCY_CONFLICT (409), INTERNAL_ERROR (500). Return redacted messages and never expose database errors, credentials or stack traces.

## Checks

```sh
pnpm --filter @flowpilot/contracts test
```

The tests build the package, check security-sensitive validation cases and compare enum values against the Prisma schema. Root `pnpm test` runs these tests followed by the existing API tests.


## Booking Phase 2 Step 1 — contracts only, endpoints not implemented

`bookings.ts` defines the shared boundary below; customer route handlers and transactional services implement it. Parsing alone does not authorize consent, query availability or reserve inventory. Step 1 introduced no migration; Step 2 added persistence. The initial specification below is now implemented through Step 5; later sections record exact runtime behavior/status.

| Method | Proposed path under /api/v1 | Input | Success |
| --- | --- | --- | --- |
| POST | /customer/sessions | CreateCustomerSessionBodySchema | 201 CustomerSessionResponseSchema + customer cookie |
| GET | /customer/availability | CustomerAvailabilityQuerySchema | 200 CustomerAvailabilityResponseSchema |
| POST | /customer/booking-proposals | CreateBookingProposalBodySchema + IdempotencyHeadersSchema | 201 BookingProposalResponseSchema |
| POST | /customer/bookings | ConfirmBookingBodySchema + IdempotencyHeadersSchema | 201 BookingResponseSchema (200 on replay) |
| GET | /customer/bookings/:id | IdParamsSchema | 200 BookingResponseSchema |

Owner-approved policy defaults (duration clarification below): anonymous customer sessions last eight hours; proposals last five minutes; all active staff provide all active services; appointments span consecutive 30-minute base slots. Only synthetic customer names and example.test emails are accepted. The confirmation body contains proposalId and customer details, never a consent boolean or editable selection. Customer details are trimmed; email is lowercased before fingerprinting.

Session bootstrap accepts a public business slug, not staff credentials or authority. Resolve only active businesses, rate-limit bootstrap, issue a separate HttpOnly SameSite=Strict cookie scoped to /api/v1/customer, and store only its opaque token hash. All subsequent customer routes derive business/session ownership from that cookie and check expiry with the injected server clock. An active staff login does not authorize customer requests. Keep existing origin/client-header protections for unsafe requests. No raw token appears in a DTO, URL or log. Session creation is intentionally not a booking effect; repeated bootstrap rotates the current customer token rather than creating duplicate appointments.

Availability requires a business-local date and serviceId, with optional staffId and bounded pagination. Require durationMinutes (positive 30-minute increments, technical ceiling 1440); reject values above the current business maximum with 409 DURATION_NOT_ALLOWED. Return only starts with complete consecutive future AVAILABLE base slots whose business/service/staff are active and eligible. Sort by startAt/staffId/slotId; list/count use the same scoped snapshot. asOf is the server reference clock, not a hold guarantee. Returned names/time zone let the future confirmation UI display the actual selection without extra privileged reads.

Proposal creation revalidates selection and persists an immutable, session-owned selection. Expiry is server-calculated; a proposal never holds a slot. Repeating its key/payload returns the original proposal (including original expiry), without extending it. A confirmation is a dedicated explicit customer interaction on that selection. Zod parsing alone cannot prove consent: trusted orchestration must keep this write path separate from any future model/tool execution, and the future UI must display the proposal before the customer confirms.

Confirmation must authenticate the customer, resolve its proposal, and revalidate active resources, eligibility and future time. Recheck the current business maximum and conditionally claim every required base slot AVAILABLE -> RESERVED and create Booking, successful BookingAction result, proposal consumption and redacted audit in one transaction. Enforce at most one active claim per base slot in PostgreSQL. The Step 2 partial unique index and deferred coverage triggers require complete same-staff coverage; claim counts must equal durationMinutes / 30 or the entire transaction rolls back. Any failure rolls back all effects. Customers read bookings only by owning session; a reference is a display label, never a credential.

Scope idempotency by business, session and operation. Fingerprint parsed, normalized input (including customer details for confirmation); stable keys are mandatory on both proposal and confirmation writes. Identical successful retries return the original result even after proposal expiry/consumption, so resolve a matching persisted success before checking a new execution's expiry. Conflicting key reuse returns 409. Concurrent identical requests converge on one result; another key cannot consume the same proposal again. Failures are not persisted as successful actions. Retain successful action/proposal associations with booking history; session expiry still denies access, including replays. A client must retain its key across a lost response.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | VALIDATION_ERROR | Invalid fields, formats or synthetic customer details |
| 401 | UNAUTHENTICATED | Missing, invalid or expired customer session |
| 404 | NOT_FOUND | Unknown/inaccessible business, resource, proposal or booking; foreign-session IDs use the same response |
| 409 | PROPOSAL_EXPIRED | Owned proposal has expired; choose again |
| 409 | PROPOSAL_ALREADY_USED | Owned proposal already consumed under a different key |
| 409 | SLOT_UNAVAILABLE | Slot is no longer available or is no longer in the future |
| 409 | SELECTION_UNAVAILABLE | Business/service/staff is no longer active or eligible |
| 409 | DURATION_NOT_ALLOWED | Requested duration exceeds the current business maximum |
| 409 | IDEMPOTENCY_CONFLICT | Scoped key reused with different normalized input |
| 429 | RATE_LIMITED | Customer request limit exceeded |
| 500 | INTERNAL_ERROR | Redacted unexpected failure |

All use { code, message, traceId }. Existing framework origin-check errors remain applicable. A conflict does not include a fabricated replacement slot: query availability again. No cancellation, rescheduling, chat, model integration, notification or generic booking update/delete contract is introduced.


Step 2 duration clarification: slotId identifies the first base slot, while startAt/endAt describe the entire appointment. Availability and proposal bodies require durationMinutes; proposal/booking DTOs preserve it. Session/proposal expiry defaults from Step 1 are approved. Business.maxBookingDurationMinutes defaults to 120, in 30-minute increments, with a technical ceiling of 1440. This ceiling is a bound, not a promise that every duration has inventory. Runtime APIs must enforce the current business value at availability/proposal/confirmation. Phase 5 adds an OWNER-only settings editor. Reducing the maximum preserves existing bookings but rejects new confirmations of over-limit proposals. Service.durationMinutes remains the 30-minute base unit for compatibility; appointment duration belongs to the proposal. BookingStatus in the database includes CANCELLED to preserve history; the Phase 2 public DTO still exposes only CONFIRMED because no cancellation API exists.

## Phase 2 Step 3 — implemented customer reads and session lifecycle

The following routes are now implemented (all under /api/v1):

| Method | Path | Input | Response |
| --- | --- | --- | --- |
| POST | /customer/sessions | CreateCustomerSessionBodySchema; no query fields | 201 CustomerSessionResponseSchema + HttpOnly customer cookie |
| GET | /customer/session | No query fields; customer cookie | 200 CustomerSessionResponseSchema |
| POST | /customer/logout | Empty/absent body and no query fields | 200 LogoutResponseSchema; revoke token and clear scoped cookie |
| GET | /customer/services | CustomerCatalogQuerySchema; customer cookie | 200 ServiceListResponseSchema, active scoped services only |
| GET | /customer/staff | CustomerCatalogQuerySchema; customer cookie | 200 StaffListResponseSchema, active scoped staff only |
| GET | /customer/availability | CustomerAvailabilityQuerySchema; customer cookie | 200 CustomerAvailabilityResponseSchema |

CustomerSessionResponse now includes businessId, businessName, timezone, today, maxBookingDurationMinutes and expiresAt. It excludes session ID, raw token and token hash. Metadata/catalog routes let the future customer UI discover IDs and duration limits without a dashboard login. Catalog pagination matches existing defaults/limits and stable name/id ordering. All active staff currently provide all active services.

Bootstrap issues a separate flowpilot_customer_session cookie (HttpOnly, SameSite=Strict, Path=/api/v1/customer, Max-Age=28800, secure=false for the existing loopback-only demo). A live same-business bootstrap rotates the secret while retaining the session ID/booking ownership; a simultaneous stale-token rotation cannot overwrite the winning secret. A new/expired/revoked identity or business switch creates a new session; switching businesses revokes the presented prior token. Retain old ownership rows rather than deleting history. GET /customer/session restores metadata without rotating/renewing expiry; logout is repeatable and revokes only the presented customer token. Dashboard cookies never authorize customer routes. Invalid/expired/revoked tokens or an inactive scoped business return 401 UNAUTHENTICATED; bootstrap hides unknown/inactive businesses behind 404 NOT_FOUND.

Bootstrap is limited to 10 requests/minute/IP; every other customer route to 60/minute/IP per route, plus existing global limits. POSTs use the existing exact configured Origin and X-Flowpilot-Client: web protection. Tokens/cookies/query values/customer bodies are not logged. These are local in-memory request limits, not a distributed rate-limiting claim.

Availability checks service and optional staff ownership/activity, the current business maximum, future starts and complete consecutive fixed base inventory. Invalid/inactive/foreign resource IDs share 404 NOT_FOUND. Valid increments above the maximum return 409 DURATION_NOT_ALLOWED; malformed or missing duration returns 400 VALIDATION_ERROR. Only start times belong to the requested local calendar day; a full appointment can end the following day if every required consecutive slot exists. Count and paginated starts share one repeatable-read snapshot with scope/resource checks. All timestamps serialize as UTC; timezone and asOf describe display/reference context. Results do not hold slots and may become stale immediately; proposal/confirmation must revalidate later.

No schema change, booking writes, proposal creation, chat/AI or customer UI is included. Local manual check: start pnpm dev and run `.\docs\check-customer-availability.ps1 -Date DD-MM-YYYY` for a future seeded weekday. The script prints scoped metadata/catalog and 30/60/90/120-minute starts without showing cookies, and logs out in finally. It creates/revokes a customer session but does not change inventory. UTC timestamps should be interpreted using the returned business timezone.


Date presentation: user-facing calendar dates use dd-mm-yyyy. The dashboard and manual script convert those dates to the existing yyyy-mm-dd API date contract; UTC appointment timestamps and database storage retain ISO formats. Future customer UI must use dd-mm-yyyy too.

## Phase 2 Step 4 contract

Implement POST /api/v1/customer/booking-proposals with the existing CreateBookingProposalBodySchema, selected IdempotencyHeadersSchema and BookingProposalResponseSchema. No query fields are accepted. Return 201 for a new proposal and 200 with the exact original DTO on an identical retry. Normalize UUID case before fingerprinting. Scope stable keys to verified business/customer session/PROPOSE. Same key with different normalized selection returns 409 IDEMPOTENCY_CONFLICT. Authenticate a current active customer session before replay; check persisted success before checking current inventory, resource activity or proposal expiry. Replay never extends expiry. A new execution validates active owned service/staff, future starting slot, current maximum and all consecutive available base slots. No slot holds or bookings are created. Saved proposal/action/minimal audit are atomic; failures leave none of those effects. Missing/invalid key is 400, invalid session 401, inaccessible resources 404, unavailable/past/incomplete runs 409 SLOT_UNAVAILABLE and over-limit durations 409 DURATION_NOT_ALLOWED. Existing Origin/client-header and local rate limits apply. Proposal lifetime is five minutes from the trusted server creation clock; confirmation must independently reject elapsed appointments/expired proposals even when the original response can be replayed. No confirmation or proposal-update/delete contract is added.

## Phase 2 Step 5 contract

POST /api/v1/customer/bookings is the dedicated explicit customer-confirmation interaction. Use existing strict ConfirmBookingBodySchema (proposalId + synthetic customer), selected IdempotencyHeadersSchema and BookingResponseSchema; no query fields or consent/status/selection overrides. Return 201 new / 200 exact successful replay / 409 IDEMPOTENCY_CONFLICT for different normalized input. Normalize UUID/email case and trim customer fields before fingerprinting. Customer identity/business must be live before replay; resolve prior success before expiry/consumption/current resource checks. New execution locks its owned proposal, rejects another key's prior consumption (PROPOSAL_ALREADY_USED), expiry (PROPOSAL_EXPIRED), inactive/ineligible resources (SELECTION_UNAVAILABLE), current maximum violation (DURATION_NOT_ALLOWED), elapsed/unavailable/incomplete inventory (SLOT_UNAVAILABLE), and atomically claims all required slots with booking/link/action/audit writes. Missing/inaccessible proposals are identical 404 NOT_FOUND. An LLM/chat/tool path must never invoke this endpoint as proof of consent; a trusted client explicitly submits the saved selection after customer review. The API accepts that dedicated authenticated request as the confirmation interaction; Phase 3 adds its customer UI. GET /api/v1/customer/bookings/:id uses IdParamsSchema + BookingResponseSchema, no query fields, and returns only the live session's business-owned booking (unknown/other customer/business IDs all 404). A reference alone never grants access. Existing Origin/client-header protections and local request limits apply. No cancellation/rescheduling, outbound effects or AI tools are added.


Step 5 runtime notes: confirmation is limited to 30/minute/IP, owned reads to 60/minute/IP under existing global limits. READ COMMITTED scoped key serialization and unique action guards preserve successful retries; proposal row locking and unique proposal consumption prevent another key creating another booking. Service/staff/business/session locks coordinate activity/policy/revocation; base-slot locks are ordered before conditional claims. Recheck time/expiry after waits; require every slot, with rollback on partial claim/action/audit failure. Confirmation audit metadata contains duration only, not customer details. Customer name/email appear only in their owned booking DTO and required persistence; never log them. Cancellation lifecycle remains outside the public CONFIRMED-only contract until Phase 5. The manual script docs/check-booking-confirmation.ps1 displays the saved selection in business-local dd-mm-yyyy time and requires typing CONFIRM before writing. It checks replay/read/availability and then revokes its temporary session; the synthetic booking/history remains.


## Phase 2 final validation status

The deterministic booking API is complete and locally validated through Step 6. The tracked cross-platform booking-http.integration.test.ts verifies an actual API process restart after discarding the first confirmation response, exact idempotent recovery, persisted ownership/claims/actions/audit and actual request-log redaction. The standard integration command and CI configuration include this test; hosted CI execution remains unverified. For manual acceptance use scripts/check-booking-confirmation.ps1 (tracked), with dd-mm-yyyy dates, synthetic details and an explicit CONFIRM prompt. Customer web/chat UI remains Phase 3; no cancellation, AI or delivery behavior is claimed. The step sections above document behavior introduced in each ticket, not additional unimplemented booking endpoints.
