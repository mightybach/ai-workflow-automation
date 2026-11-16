# FlowPilot Booking

FlowPilot Booking is a project for AI-assisted appointment booking and workflow automation for small businesses. The first planned demo is a fictional salon with two employees and 30-minute appointments in `Australia/Brisbane`.

The goal is to let a customer describe an appointment in plain English, show slots verified by the backend, and reserve one only after explicit customer confirmation. A business dashboard will help owners and staff manage services, availability and bookings.

## Why this project exists

Small appointment-based businesses spend time answering availability questions, matching customers to staff and maintaining schedules. FlowPilot Booking explores how AI can reduce that repetitive work while deterministic application code controls availability, permissions and booking confirmation.

It is also a portfolio project for learning and demonstrating full-stack development, concurrency-safe reservations, reliable automation and safe AI integration. Development uses synthetic customers and mock external services only.

## Current status

Booking Phase 1 is implemented: an authenticated, read-only business dashboard backed by PostgreSQL. The current build includes:

- Demo sign-in with persistent sessions and role-based access.
- Business-scoped owner/staff memberships independent of legacy request roles.
- A seeded Brisbane salon, two employees, two services and fixed 30-minute slot inventory.
- Staff/service lists and date/staff/state filters with paginated inventory inspection.
- Saved synthetic requests with search, filters, pagination and request/workflow details.
- A Fastify API with liveness and database-readiness endpoints.
- Shared TypeScript types and runtime validation schemas.
- Validated API contracts and implemented request submission/list/detail and workflow reads.
- PostgreSQL persistence through Prisma, versioned migrations and repeatable demo seeds.
- Docker Compose configuration for PostgreSQL and RabbitMQ.
- Build, typecheck, lint and API test commands, plus a GitHub Actions CI workflow.

Customer booking confirmation, customer-facing availability, chat and AI remain planned. The dashboard inspects inventory; it does not create reservations or edit schedules. The earlier request-management demo is retained under **Legacy requests**, with its original data and migrations preserved.

## Run locally

### Requirements

- Node.js **24.22.3** (also recorded in `.node-version`).
- pnpm **10.34.9**.
- Docker with a running Linux engine for PostgreSQL. RabbitMQ is optional and reserved for a later phase.

After installing Node.js, install the pinned package manager:

```sh
npm install --global pnpm@10.34.9
```

### Start the app

These instructions launch the salon setup dashboard and retained legacy request demo.

Clone the repository and enter the project folder:

```sh
git clone https://github.com/mightybach/ai-workflow-automation.git
cd ai-workflow-automation
```

Copy the example environment file. In PowerShell:

```powershell
Copy-Item .env.example .env
```

On macOS or Linux:

```sh
cp .env.example .env
```

Install dependencies, start infrastructure, apply migrations and seed the demo:

```sh
pnpm install --frozen-lockfile
pnpm infra:up
pnpm db:deploy
pnpm db:seed
pnpm dev
```

Open **http://127.0.0.1:5173**. The page should display **API connected**. Use **Check connection** to try again if the API was still starting.

Sign in with one of these synthetic accounts, using `DEMO_PASSWORD` from your `.env` (the example value is `flowpilot_demo_only`):

| Account | Access |
| --- | --- |
| `owner@flowpilot.test` | OWNER membership: inspect the seeded salon's staff, services and slots |
| `staff@flowpilot.test` | STAFF membership: inspect the same salon setup |
| `client@flowpilot.test` | Submit requests and read only its own requests/workflows |
| `reviewer@flowpilot.test` | Submit requests and read all demo requests/workflows |
| `admin@flowpilot.test` | Submit requests and read all demo requests/workflows |

Sign in as the owner or staff user to open **Business setup**. Inspect employees and services, choose a date, filter slot inventory by staff/state and use the page controls. Times display in the salon's `Australia/Brisbane` time zone. Booking confirmation and schedule editing are not enabled yet. A legacy ADMIN/REVIEWER/CLIENT role alone does not grant business access.

For the older synthetic-request demo, choose **Legacy requests**, enter a made-up message and choose **Submit request**. Requests retain their original access rules and have no edit/delete actions. Refreshing restores your session; **Sign out** revokes it.

Seed commands retain existing users, passwords, services, employee settings and inventory states. The salon seed adds weekday slots from 9 am–5 pm, excluding noon–1 pm, for 14 calendar days starting today in Brisbane. Set `SEED_START_DATE=YYYY-MM-DD` for reproducible fixtures; re-run `pnpm db:seed` to extend the window. It never resets reserved/blocked slots or deletes old inventory. All active staff initially provide all active 30-minute services; working-hour editors and service eligibility rules are later work.

Changing `DEMO_PASSWORD` after seeding does not reset existing accounts. Legacy order delivery dates are fixed fixtures. Sign-in is local-only: the server accepts loopback hosts, requires `DEMO_AUTH_ENABLED=true`, and refuses production mode. Public deployment needs a separate authentication/deployment design.

The API runs at **http://127.0.0.1:3001**. You can check it directly at `/api/v1/health/live`, which returns:

```json
{"status":"ok","service":"flowpilot-api"}
```

Press `Ctrl+C` in the terminal to stop the app.

### Local infrastructure

PostgreSQL is required. The default helper starts PostgreSQL only; RabbitMQ is not needed to inspect salon setup. To validate and start it, run:

```sh
pnpm infra:config
pnpm infra:up
```

The startup command waits for PostgreSQL to become healthy. The existing RabbitMQ service is behind the `automation` Compose profile. `pnpm infra:automation` starts both services when needed; its management interface is **http://127.0.0.1:15672**. These commands retain existing volumes.

To stop the services while retaining their data volumes:

```sh
pnpm infra:down
```

The example credentials are for local development. If you change service credentials or ports, update the corresponding connection URLs in `.env` too.

## Design the database schema

The Prisma 7.10.1 setup lives in `packages/db`. Edit models and relationships in **`packages/db/prisma/schema.prisma`**. Booking setup adds `Business`, `BusinessMembership`, `Staff`, `Service` and `AvailabilitySlot` alongside the retained legacy tables. An additive migration preserves old rows and makes audit events capable of referencing business entities without a legacy workflow.

`packages/db/prisma7.config.ts` loads `DATABASE_URL` from the root `.env` (or the existing environment). Prisma can validate the schema and generate the client without a running database:

```sh
pnpm db:format
pnpm db:validate
pnpm db:generate
```

On a fresh database, start PostgreSQL and apply the existing migration:

```sh
pnpm infra:up
pnpm db:deploy
pnpm db:generate
```

For future schema changes, use `pnpm db:migrate --name describe_your_change` to create and apply a development migration. Review its generated SQL and commit the schema and migration files. Both migration commands change the database. Generated client files are ignored by Git and regenerated by `pnpm build`. To inspect a configured database, use `pnpm db:studio`; `pnpm db:deploy` applies existing migrations without creating new ones.

The API uses `@flowpilot/db` and shared API contracts. Business reads derive their scope from an active membership; a browser cannot select another business by supplying an ID. One business per dashboard user is supported for now. Foreign keys enforce staff/business consistency, and SQL checks plus unique staff/start keys constrain slots to a non-overlapping UTC-aligned 30-minute grid. Variable durations or other slot alignment require a new design.

Legacy request creation still saves its initial workflow and audit event in one transaction. Sessions store a hash of an opaque browser token; passwords use scrypt. HttpOnly, SameSite=Strict session cookies expire after eight hours, and current user/membership activity is checked server-side.

## Development checks

See [API contracts](packages/contracts/README.md) for implemented endpoint shapes, validation limits, permissions and serialization rules.

Run these commands from the repository root. Build first so the shared contracts are available to the other packages:

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
```

`pnpm dev` builds API dependencies automatically. Restart it after editing contracts or database-client code. Integration tests create/migrate the isolated local `flowpilot_test` database from `TEST_DATABASE_URL`; they never reset your main database. Keep that test URL separate from `DATABASE_URL`.

To check the business dashboard and retained request flow in a browser, seed the demo and start `pnpm dev` in another terminal, then run:

```sh
pnpm --filter @flowpilot/web exec playwright install chromium
pnpm --filter @flowpilot/web test:ui
```

Browser checks cover owner/staff setup, membership denial, slot filters/pagination, empty/error recovery, reload, mobile layout and the legacy request flow. The legacy check leaves one clearly synthetic request in the running database. Integration tests cover cross-business access and foreign keys, slot constraints, repeatable seeds, local-day boundaries, plus prior request concurrency/rollback/restart behavior. Unit tests include 23-/25-hour DST days. CI runs these suites; browser binaries are separate from `pnpm install`.

## Technology

| Area | Technology |
| --- | --- |
| Frontend | React, TypeScript, Vite |
| API | Fastify, TypeScript |
| Shared validation | Zod |
| Local infrastructure | PostgreSQL, RabbitMQ through Docker Compose |
| Workspace and CI | pnpm, GitHub Actions |

## Planned experience

A customer will ask for an appointment, review actual available slots, select one and explicitly confirm. The server will recheck availability and atomically reserve the slot. If another customer takes it first, the app will return a conflict and offer fresh availability. AI will interpret intent; it will not decide that a slot exists or authorize a booking.

The roadmap is business setup, deterministic booking, mock chat, then an Ollama-based intent extractor. Later work adds owner/staff administration, cancellation/rescheduling, mock reminders and SME workflows. Business access must be scoped on the backend, appointment instants stored in UTC, and display/relative dates resolved in the business time zone.

The first release targets a single fictional salon, two employees and fixed 30-minute appointments. Real payments, email/SMS delivery, calendar integrations and live commercial bookings are outside the MVP. The current validation covers business setup and legacy requests; concurrent booking confirmation and AI quality will be measured when those features exist.
