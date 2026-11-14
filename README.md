# FlowPilot

FlowPilot is an AI-assisted workflow automation project for handling everyday customer requests, such as refund enquiries, technical support, invoice requests and general questions.

The goal is to turn an incoming message into a clear, trackable process: understand the request, check the relevant information, follow business rules and ask a person to approve sensitive actions.

## Why this project exists

Operations teams often spend time reading requests, looking up records and repeating the same steps across different systems. FlowPilot explores how AI can help interpret those messages while application code controls what happens next.

It is also a portfolio project for learning and demonstrating full-stack development, reliable background processing, human approval flows and safe AI integration. Development uses synthetic data and mock services only.

## Current status

FlowPilot is in early development. The foundation currently includes:

- Demo sign-in with persistent sessions and role-based access.
- Saved synthetic requests with search, filters, pagination and request/workflow details.
- A Fastify API with liveness and database-readiness endpoints.
- Shared TypeScript types and runtime validation schemas.
- Validated API contracts and implemented request submission/list/detail and workflow reads.
- PostgreSQL persistence through Prisma, versioned migrations and repeatable demo seeds.
- Docker Compose configuration for PostgreSQL and RabbitMQ.
- Build, typecheck, lint and API test commands, plus a GitHub Actions CI workflow.

Phase 1 is implemented. Submitting a request atomically saves its text, a pending workflow and an audit event. Repeated submissions using the same key and text return the original result. Data and sessions survive API restarts. AI classification, workflow execution and human approval actions are planned; workflows remain pending for now.

## Run locally

### Requirements

- Node.js **24.22.3** (also recorded in `.node-version`).
- pnpm **10.34.9**.
- Docker with a running Linux engine for PostgreSQL (required) and RabbitMQ (reserved for a later phase).

After installing Node.js, install the pinned package manager:

```sh
npm install --global pnpm@10.34.9
```

### Start the app

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
| `client@flowpilot.test` | Submit requests and read only its own requests/workflows |
| `reviewer@flowpilot.test` | Submit requests and read all demo requests/workflows |
| `admin@flowpilot.test` | Submit requests and read all demo requests/workflows |

Enter a made-up message and choose **Submit request**. Open **View** to inspect saved text and pending workflows. Use search, status/category filters and page controls to find records. Refreshing the page preserves saved requests and restores your session. **Sign out** revokes the session. Submitted records have no edit/delete actions; their original text and audit history are retained.

Seed commands retain existing users, passwords and orders. Changing `DEMO_PASSWORD` after seeding does not reset existing accounts. Demo order delivery dates are fixed synthetic fixtures. The sign-in flow is deliberately local-only: the server accepts loopback hosts, requires `DEMO_AUTH_ENABLED=true`, and refuses production mode. Public deployment needs a separate authentication/deployment design.

The API runs at **http://127.0.0.1:3001**. You can check it directly at `/api/v1/health/live`, which returns:

```json
{"status":"ok","service":"flowpilot-api"}
```

Press `Ctrl+C` in the terminal to stop the app.

### Local infrastructure

PostgreSQL is required for sign-in and requests; RabbitMQ is not used for processing yet. To validate and start the configured services, run:

```sh
pnpm infra:config
pnpm infra:up
```

The startup command waits for both services to become healthy. RabbitMQ's management interface is available at **http://127.0.0.1:15672**, using the local credentials in `.env`.

To stop the services while retaining their data volumes:

```sh
pnpm infra:down
```

The example credentials are for local development. If you change service credentials or ports, update the corresponding connection URLs in `.env` too.

## Design the database schema

The Prisma 7.10.1 setup lives in `packages/db`. Edit models and relationships in **`packages/db/prisma/schema.prisma`**. It defines `User`, `Session`, `Request`, `Workflow`, `AuditEvent` and `MockOrder`. Committed migrations create these tables and the API uses them for Phase 1 persistence.

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

The API uses the `@flowpilot/db` client factory and shared API contracts. Every request-creation transaction saves its initial workflow and audit event together. Sessions store a hash of an opaque browser token; passwords are hashed with scrypt. Session cookies are HttpOnly and SameSite=Strict, expire after eight hours, and are checked against current database user permissions.

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

To check the complete request flow in a browser, seed the demo and start `pnpm dev` in another terminal, then run:

```sh
pnpm --filter @flowpilot/web exec playwright install chromium
pnpm --filter @flowpilot/web test:ui
```

The UI check covers sign-in, validation, a retry after a committed response is lost, request/workflow reads, filters, safe text rendering, mobile layout, session restoration and logout. It leaves one clearly synthetic sample request in the database used by the running app. Integration tests cover pagination, concurrent submissions, authorization, transaction rollback and actual API-process restart. CI runs both suites. Browser binaries are separate from `pnpm install`.

## Technology

| Area | Technology |
| --- | --- |
| Frontend | React, TypeScript, Vite |
| API | Fastify, TypeScript |
| Shared validation | Zod |
| Local infrastructure | PostgreSQL, RabbitMQ through Docker Compose |
| Workspace and CI | pnpm, GitHub Actions |

## Planned experience

A user will submit a synthetic request, inspect its classification and supporting evidence, then follow its progress through a predefined workflow. Refunds and outbound communication will require a recorded human approval. Ambiguous requests will go to manual review.

The first complete scenario will be a mock refund, followed by support tickets, invoices and FAQ responses.
