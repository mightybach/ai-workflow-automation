# FlowPilot Booking

FlowPilot Booking explores AI-assisted appointment booking and repetitive administration for small businesses. The current demo is a fictional salon with two employees in `Australia/Brisbane`, synthetic customers and appointments built from consecutive 30-minute slots.

## Why it exists

Small businesses spend time answering availability questions and coordinating appointments. This project separates natural-language assistance from the rules that control availability, ownership and confirmation. PostgreSQL owns booking state; a future AI interpreter will only suggest intent and parameters.

It is also a portfolio project for full-stack development, concurrency-safe reservations and reliable automation. No real customers, payments, external reservations or messages are involved.

## Current status

**Phase 3 — customer booking UI and deterministic mock chat are implemented and locally validated.**

- Owner/staff dashboard with business-scoped staff, services and slot inventory.
- Anonymous customer sessions, active service/staff lists and duration-aware availability.
- Customer-selected 30-minute increments under a business maximum, default 120 minutes.
- Immutable five-minute proposals; a proposal does not hold inventory.
- Separate explicit confirmation that atomically claims every required slot and records booking, links, action and audit together.
- Scoped idempotent retries, customer-owned booking reads and safe conflict responses.
- UTC appointment instants, IANA business timezones and dd-mm-yyyy user-facing dates.
- Retained legacy request demo with its original data and permissions.

The web app includes the customer booking page at **http://127.0.0.1:5173/book**, the read-only business dashboard and legacy requests. The scripted mock assistant asks for missing details; it cannot book or confirm. Real AI is Phase 4. Cancellation, schedule/settings editors and notifications remain later work.

## Run locally

Requirements: **Node 24.22.3**, **pnpm 10.34.9**, and Docker with its Linux engine running. Versions are pinned in `.node-version` and `package.json`.

After installing the pinned Node version:

```sh
npm install --global pnpm@10.34.9
node --version
pnpm --version
```

Clone this repository and enter its folder. Copy `.env.example` to `.env`:

```powershell
Copy-Item .env.example .env
```

On macOS/Linux use `cp .env.example .env`. Then run:

```sh
pnpm install --frozen-lockfile
pnpm infra:up
pnpm db:deploy
pnpm db:generate
pnpm db:seed
pnpm dev
```

Keep that terminal running. Open **http://127.0.0.1:5173**. The API runs at **http://127.0.0.1:3001**; `/api/v1/health/ready` checks its database connection. Stop the app with `Ctrl+C`.

If `pnpm` is missing or `node --version` reports Node 18, install the pinned versions and reopen the IDE terminal. The app cannot run with the old system Node installation.

### Dashboard accounts

Use `DEMO_PASSWORD` from `.env`; the example password is `flowpilot_demo_only`.

| Account | Access |
| --- | --- |
| `owner@flowpilot.test` | OWNER membership: inspect salon staff, services and inventory |
| `staff@flowpilot.test` | STAFF membership: inspect the same salon |
| `client@flowpilot.test` | Legacy requests: submit/read its own records |
| `reviewer@flowpilot.test` | Legacy requests: submit/read all demo records |
| `admin@flowpilot.test` | Legacy requests: submit/read all demo records |

Dashboard access requires an active business membership; legacy roles alone grant none. Enter dates as **dd-mm-yyyy** and inspect local times, staff/state filters and pagination. The dashboard shows RESERVED inventory but has no booking/schedule mutation controls. **Legacy requests** retains its own access rules and no edit/delete actions.

### Book through the customer page

Open **http://127.0.0.1:5173/book**, or choose **Book a synthetic appointment** on the home page. Start with business **demo-salon**; no staff login is required.

1. Choose an active service, future seeded weekday as **dd-mm-yyyy**, duration and optional staff. View actual available appointments and select one.
2. Review the server proposal: service, staff, full interval, local timezone/UTC offset and five-minute expiry. Selection holds no slots.
3. Keep the fictional name and example.test email; separately click **Confirm appointment**. Success shows the server reference.
4. Reload to restore the owned booking. After a lost response, **Retry same confirmation** preserves the exact key/details across reload and token rotation; it never creates a replacement automatically.

The optional mock assistant accepts **Haircut tomorrow**, asks for duration, then accepts **60 minutes with Alex**. Choose **Use suggested details**, then query actual availability/select/review. Typing yes/confirm never books. Unknown or ambiguous requests, unsupported time expressions and cancellation/rescheduling require clarification/manual fallback.

Chat transcript is browser-memory-only (20 entries), clears on reload/end/session rejection, and is never stored/logged by the server. A minimal synthetic retry draft lives in tab session storage; server replay/owned reads verify it. Ending the customer session removes access, not booking history. Confirmed appointments remain RESERVED: two base slots for 60 minutes, four for 120.

### Optional PowerShell API check

With `pnpm dev` running, use the tracked PowerShell client:

```powershell
.\scripts\check-booking-confirmation.ps1 -Date 18-11-2026 -DurationMinutes 60
```

Choose a **future seeded weekday**, replacing the example date when necessary. Omitting `-Date` chooses tomorrow. `-DurationMinutes 120` tests a two-hour appointment.

1. Review the displayed service, employee, business-local date/time and duration.
2. Enter anything except `CONFIRM` to stop without a booking.
3. On a new run, type `CONFIRM` to reserve the displayed synthetic appointment.
4. Expect create **201**, identical retry **200**, and owned booking read **200**.
5. Refresh the dashboard, select that date and filter RESERVED: 60 minutes occupies two slots, 120 minutes occupies four.

The script uses synthetic customer details, checks that the booked start disappears from availability, and logs out its temporary customer session. A successful run leaves the booking and audit history in the local demo. Cancellation is not implemented yet. A booking reference is a label, not a credential for access after logout.

### Seed and infrastructure behavior

The salon seed adds 14 calendar days of weekday 09:00–17:00 inventory excluding 12:00–13:00, starting on today's Brisbane date. `SEED_START_DATE=YYYY-MM-DD` selects a reproducible anchor. Run `pnpm db:seed` to extend the window; existing passwords, memberships, service/staff settings and RESERVED/BLOCKED inventory are preserved. Changing `DEMO_PASSWORD` does not reset seeded passwords. All active staff currently provide all active services.

PostgreSQL is required; RabbitMQ is optional and unused until the automation phase. `pnpm infra:automation` starts both through the Compose profile. `pnpm infra:down` stops services while retaining their data volumes. Example credentials are local-only; update corresponding URLs if changing ports/credentials.

## API and architecture

A TypeScript modular monolith: React/Vite in `apps/web`, Fastify in `apps/api`, browser-safe Zod contracts in `packages/contracts`, and PostgreSQL/Prisma in `packages/db`.

See [API contracts](packages/contracts/README.md) for exact bodies, limits, errors, ownership and retry semantics. Under `/api/v1/customer`:

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/sessions` | Bootstrap/rotate an anonymous business-scoped customer session |
| GET | `/session` | Restore metadata, expiry, local today and current duration maximum |
| POST | `/logout` | Revoke the presented customer token |
| GET | `/services`, `/staff` | Active scoped catalog with pagination |
| GET | `/availability` | Future complete appointment starts for date/service/duration |
| POST | `/chat/messages` | Scoped scripted preferences/clarification; no availability or booking authority |
| POST | `/booking-proposals` | Save immutable selection; no hold |
| POST | `/bookings` | Explicitly confirm an owned proposal and reserve all required slots |
| GET | `/bookings/:id` | Read only the live customer's owned booking |

Customer cookies are separate from dashboard login and expire after eight hours. POSTs require the exact configured `Origin` and `X-Flowpilot-Client: web`. Proposal/confirmation writes require stable `Idempotency-Key` headers. Same scoped key/normalized input returns the original result; changed input returns 409. A proposal or availability response never guarantees inventory; confirmation revalidates current state. No model/tool path is authorized to confirm.

API calendar dates remain `yyyy-mm-dd`, timestamps remain UTC ISO strings, and human-facing clients convert to dd-mm-yyyy in the business timezone. The customer UI also shows the UTC offset to distinguish repeated local times.

Edit schema in `packages/db/prisma/schema.prisma`. Review its migrations too: SQL checks, partial active-claim uniqueness and deferred complete-coverage triggers supplement Prisma. `pnpm db:validate`, `pnpm db:generate` and `pnpm db:studio` provide inspection/development tools. For new schema work use `pnpm db:migrate --name describe_change`; review and commit the new migration without rewriting applied history or resetting data. `pnpm db:deploy` applies existing migrations.

## Validation

From the repository root:

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm infra:config
pnpm test:integration
```

Integration tests create/migrate only the dedicated local `flowpilot_test` database from `TEST_DATABASE_URL` and clean their own tagged fixtures. Keep it separate from `DATABASE_URL`. They cover tenant/customer isolation, complete multi-slot claims, parallel conflicting confirmations, exact retries, rollback, expiry, policy/resource changes, DST, a discarded response followed by actual API restart/replay, and request-log redaction. They retain legacy regression coverage.

For browser regression, seed the demo and keep `pnpm dev` running:

```sh
pnpm --filter @flowpilot/web exec playwright install chromium
pnpm --filter @flowpilot/web test:ui
```

Browser checks cover dashboard/legacy requests and the customer flow: explicit confirmation, lost-response/reload/rotation recovery, clarification/manual fallback, expiry/conflicts, session cleanup and mobile layout. Customer checks use a tagged synthetic business and clean only its fixtures; the legacy browser check leaves one synthetic request in the running demo. CI includes these suites; hosted execution remains unverified.

## Scope and next phase

This is a loopback-only development/test demo, not a public production booking service. Customer identity is session-based with no account recovery. Rate limits are local/in-memory; no production load or uptime claims are made. Current booking reads expose CONFIRMED lifecycle only. Arbitrary durations/alignment, multi-location, service-specific staff eligibility, cancellation/rescheduling, policy editors, retention/recovery workflows and integrations need later scoped work.

**Next: Phase 4 validated local AI intent extraction behind the mock interface.** Admin changes follow in Phase 5; mock notification delivery in Phase 6. The backend stays a modular monolith until an actual need justifies extraction. The current mock supports a small English grammar, not arbitrary conversation; it has a 100-item service/staff catalog cap (manual lists cap at 1000), and no persisted transcript recovery. No real AI provider or delivery integration is installed.
