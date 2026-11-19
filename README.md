# FlowPilot Booking

FlowPilot Booking explores AI-assisted appointment booking and repetitive administration for small businesses. The current demo is a fictional salon with two employees in `Australia/Brisbane`, synthetic customers and appointments built from consecutive 30-minute slots.

## Why it exists

Small businesses spend time answering availability questions and coordinating appointments. This project separates natural-language assistance from the rules that control availability, ownership and confirmation. PostgreSQL owns booking state; the optional local AI interpreter only suggests intent and parameters.

It is also a portfolio project for full-stack development, concurrency-safe reservations and reliable automation. No real customers, payments, external reservations or messages are involved.

## Current status

**Phases 1–4 are implemented and locally validated, including optional Ollama intent extraction and manual fallback.**

**Phases 1–5 are implemented locally:** owners manage duration limits, dated working time, closures and cancellations; customers explicitly book, cancel and reschedule future appointments. OWNER/STAFF dashboards include scoped booking and redacted audit views. Staff have read-only access; only owners can change business schedules or cancel on the business's behalf. Recurring weekly templates and automated notifications are separate future work.

- Owner/staff dashboard with business-scoped staff, services and slot inventory, plus OWNER-only booking duration settings.
- Anonymous customer sessions, active service/staff lists and duration-aware availability.
- Customer-selected 30-minute increments under a business maximum, default 120 minutes.
- Immutable five-minute proposals; a proposal does not hold inventory.
- Separate explicit confirmation that atomically claims every required slot and records booking, links, action and audit together.
- Scoped idempotent retries, customer-owned booking reads and safe conflict responses.
- UTC appointment instants, IANA business timezones and dd-mm-yyyy user-facing dates.
- Retained legacy request demo with its original data and permissions.

The web app includes the customer booking page at **http://127.0.0.1:5173/book**, the business dashboard and legacy requests. Choose the default scripted mock or optional local AI assistant; neither can book, cancel, reschedule or confirm. Customers review and explicitly confirm changes through dedicated controls. Owners manage duration limits, dated inventory, closures and business cancellations. Notifications remain Phase 6 work.

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
| `owner@flowpilot.test` | Inspect salon setup/bookings/audits, edit duration limits and dated schedules/closures, cancel future bookings |
| `staff@flowpilot.test` | Read the same salon's setup, bookings and redacted audits |
| `client@flowpilot.test` | Legacy requests: submit/read its own records |
| `reviewer@flowpilot.test` | Legacy requests: submit/read all demo records |
| `admin@flowpilot.test` | Legacy requests: submit/read all demo records |

Dashboard access requires an active business membership; legacy roles alone grant none. Enter dates as **dd-mm-yyyy** and inspect local times, staff/state filters and pagination. RESERVED inventory cannot be changed through schedule controls. **Legacy requests** retains its own access rules and no edit/delete actions.

Under **Booking settings**, owners can save a maximum appointment length from 30 to 1,440 minutes in 30-minute increments. Staff see the current value without editing controls. Existing bookings keep their duration; new availability, proposals and confirmations enforce the current maximum, even for proposals created before it was lowered. In an open customer page, use **Refresh customer setup** to update its duration choices. A stale owner editor must refresh before saving; after a lost response, **Retry same save** reuses the original request.

### Manage breaks and existing open times

OWNER users have a Breaks and closures editor. Pick a future seeded date in dd-mm-yyyy and optional staff filter, select existing times, choose Block selected times or Reopen selected times, review and Apply schedule change. Past/reserved slots cannot be edited; any reserved slot in an API batch rejects the whole batch. STAFF retain read-only inventory. Stable retries, stale-editor conflicts and transactional audit protect edits; blocked base slots also remove longer appointments that would cross them.

This editor changes existing inventory. The view is capped at 500 slots; use a staff filter for a larger day. The separate inventory table keeps its own date/staff/state filters. Active closure rules prevent reopening their covered slots.

### Add working time and closure rules

Under **Working hours and closure rules**, choose a future date as dd-mm-yyyy and times in 30-minute steps. **Add working time** requires a staff member and creates only missing slots, preserving existing states. **Create closure** applies to one staff member or the entire business, including inventory generated later. Review first, then **Apply schedule policy**. Times use the business timezone; 24:00 means the end of that date. Ambiguous or nonexistent DST boundaries require another time.

A closure overlapping reserved time fails without changes. Otherwise covered inventory becomes BLOCKED, including slots added later. **Review lift closure** removes that rule but leaves slots blocked. Refresh **Breaks and closures** and explicitly reopen the desired times after every covering rule is lifted. This preserves manual blocks. These are dated windows; recurring weekly schedules and automatic cancellation are not implemented. After an uncertain response, use **Retry same policy change**; stale editors must refresh.

### Book through the customer page

Open **http://127.0.0.1:5173/book**, or choose **Book a synthetic appointment** on the home page. Start with business **demo-salon**; no staff login is required.

1. Choose an active service, future seeded weekday as **dd-mm-yyyy**, duration and optional staff. View actual available appointments and select one.
2. Review the server proposal: service, staff, full interval, local timezone/UTC offset and five-minute expiry. Selection holds no slots.
3. Keep the fictional name and example.test email; separately click **Confirm booking**. Success shows the server reference.
4. Reload to restore the owned booking. After a lost response, **Retry same confirmation** preserves the exact key/details across reload and token rotation; it never creates a replacement automatically.

The optional mock assistant accepts **Haircut tomorrow**, asks for duration, then accepts **60 minutes with Alex**. Complete validated preferences automatically fill the form, including the named staff member. View available times, choose one, then review and click **Confirm booking**. Typing yes/confirm never books. Unknown or ambiguous requests, unsupported time expressions and cancellation/rescheduling require clarification/manual fallback.

Chat transcript is browser-memory-only (20 entries), clears on reload/end/session rejection, and is never stored/logged by the server. A minimal synthetic retry draft lives in tab session storage; server replay/owned reads verify it. Ending the customer session removes access, not booking history. Confirmed appointments remain RESERVED: two base slots for 60 minutes, four for 120.

### Cancel a synthetic appointment

On the confirmed appointment, choose **Review cancellation**, inspect its reference, staff and interval, then **Confirm cancellation**. **Keep appointment** abandons review without a request. The local demo allows cancellation before the appointment starts, with no fee or additional notice period. Started appointments require operator follow-up; no staff override is implemented.

Cancellation retains the reference and booking/slot/audit history while releasing the entire appointment atomically. Active closures or inactive staff keep released inventory blocked. After a lost response or rate limit, **Retry same cancellation** keeps the exact operation across reload and live session rotation. Reload only reads current status; it never submits cancellation. Resolve an uncertain cancellation before ending the session or starting another booking. Access still depends on the live customer session; a reference alone cannot restore an expired identity. Chat cancellation requests remain manual fallback.

### Reschedule a synthetic appointment

On a confirmed appointment choose **Choose replacement time**. Enter the replacement date as dd-mm-yyyy, service, duration and optional staff, then **View replacement times**. Your own reserved slots are included so a new interval may overlap the current one. Select a replacement and review both intervals before **Confirm rescheduling**. **Keep original appointment** abandons the review without changing it.

Browsing/review never releases the original. Confirmation replaces it in one transaction: the old booking and slot links remain in history, and the new confirmed appointment has a new reference linked to its predecessor. An unavailable, expired or invalid replacement leaves the original intact. After an uncertain response use **Retry same rescheduling**, including after reload; the app never submits that confirmation automatically. Started or cancelled appointments cannot be newly rescheduled. The current business duration maximum and active service/staff rules apply to the replacement. No fee or delivery is involved.

### Inspect and cancel business bookings

In **Bookings and history**, OWNER/STAFF users can filter their business's appointments by date, staff and status. Clear the booking date to inspect all dates; use pagination for more results. **View history for …** filters the redacted audit view to that booking; **View previous appointment history** follows a replacement's predecessor. Audit date filters refer to when events occurred, rather than the appointment date. Raw audit metadata, credentials and customer messages are not returned in this view.

Owners can **Review cancellation for …**, verify the exact reference/interval, then **Confirm business cancellation**. Staff have no cancellation controls. The same before-start policy and atomic release rules apply, including when the customer session has expired. Uncertain owner writes retain an actor/business-scoped retry in tab storage; **Retry same business cancellation** resolves it after reload. No action cancels a replacement by following an old reference automatically. History is retained; there is no booking deletion.

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

The script uses synthetic customer details, checks that the booked start disappears from availability, and logs out its temporary customer session. A successful run leaves the booking and audit history in the local demo. The script does not cancel it; cancellation requires its owning live customer session. A booking reference is a label, not a credential for access after logout.

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

For the full browser regression, build and seed the demo first, then run:

```sh
pnpm --filter @flowpilot/web test:ui:all
```

This uses an installed Playwright browser and starts isolated mock API/Vite instances on loopback, with a separate dependency cache and fresh rate limits per script. It closes them afterward and does not change a running Ollama-mode app. On this Windows machine the installed Edge channel was used: set `$env:FLOWPILOT_BROWSER_CHANNEL='msedge'` in PowerShell before the command; no browser download is needed here. The existing `test:ui` still targets a separately running app. To run individual isolated checks, append known script names, for example `pnpm --filter @flowpilot/web test:ui:all -- rescheduling.mjs booking-admin.mjs`.

Browser checks cover dashboard/legacy requests and the customer flow: explicit confirmation, lost-response/reload/rotation recovery, clarification/manual fallback, expiry/conflicts, session cleanup and mobile layout. Customer checks use a tagged synthetic business and clean only its fixtures; the legacy browser check leaves one synthetic request in the running demo. CI includes these suites; hosted execution remains unverified.

## Scope and next phase

See [the local AI setup guide](scripts/LOCAL_AI_SETUP.md) for Ollama and the exact `qwen3:4b-instruct-2507-q4_K_M` candidate. This development machine keeps runtime, models, temporary files and logs on D:. No model files, hosted provider, new application dependency or database migration are included in this feature.

The default `.env.example` uses `AI_PROVIDER=mock`. For local AI, start Ollama, set these values in `.env`, then restart `pnpm dev`:

```dotenv
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
AI_TIMEOUT_MS=20000
```

Only the API contacts the loopback model endpoint. The model returns verbatim preference evidence; strict Zod/semantic checks map active catalog names and resolve supported dates/durations through the server's business clock. Responses contain application-written text, never model-generated claims of availability or confirmation. Expiry/catalog changes, invalid output, busy runtime and timeouts require clarification or manual form fallback. There is one in-flight AI request per API process and no automatic mock retry.

In chat, use day-month (22-11 or 22-4), dd-mm-yyyy, today/tomorrow, day after tomorrow or in N days, and a numeric/word duration such as 60 minutes or one hour. Weekdays, time-of-day preferences, negation and alternatives currently require clarification/manual selection. A context-aware domain spell-checker compares date/unit words by insertion, deletion, substitution and adjacent-letter swaps, with bounded edit distance and a unique closest match. It handles unseen typos such as tomoral, tomorrrow and minuit and corrects spelling silently. For a date without a year, the server uses this year unless that day-month has passed in the business timezone, then uses next year; the reply shows the chosen full date. Today stays in this year, explicit years are preserved and invalid dates require clarification. Units are matched only after a duration amount; catalog words, numbers and numeric dates are preserved. Ties and distant words require clarification. Availability questions reuse known chat preferences and fetch real starts from PostgreSQL; missing details are requested one at a time. Chat shows typing/checking feedback and a next-action summary. Only synthetic text is supported. Messages are sent to the API/local model; transcripts are not persisted by the app.

Run `pnpm ai:evaluate` for the opt-in real-model synthetic evaluation. With the local app running in Ollama mode, `pnpm --filter @flowpilot/web test:ai:ui` checks the actual browser/API/model path. Default tests need no model. The Phase 4 baseline passed 22 fixed cases, with targeted unit/integration/real-browser coverage for later typo and conversation refinements; this small evaluation does not establish production accuracy, safety or load capacity. Low free RAM can prevent model loading; use the manual booking form or explicitly choose mock mode.

This is a loopback-only development/test demo, not a public production booking service. Customer identity is session-based with no account recovery. Rate limits are local/in-memory; no production load or uptime claims are made. Booking reads expose CONFIRMED/CANCELLED status and replacement ancestry. Arbitrary durations/alignment, multi-location, service-specific staff eligibility, delegated STAFF writes, recurring weekly schedules, catalog editors, retention/recovery workflows and integrations need later scoped work. The customer UI restores its current booking; it has no booking-history list or reference-based lookup. Services/employees remain seeded demo setup.

**Next: Phase 6 transactional outbox, worker and mock notifications.** Phase 5's local implementation is complete for dated inventory, scoped booking administration and explicit customer changes; manual owner acceptance remains a separate review. The backend stays a modular monolith until an actual need justifies extraction. The mock has a small English grammar; the AI path also deliberately limits supported preference forms. Chat has a 100-item catalog cap (manual lists cap at 1000), plus a stricter AI prompt-size budget and no persisted transcript recovery. No delivery integration or public production deployment is included.
