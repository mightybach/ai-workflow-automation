# FlowPilot

FlowPilot is an AI-assisted workflow automation project for handling everyday customer requests, such as refund enquiries, technical support, invoice requests and general questions.

The goal is to turn an incoming message into a clear, trackable process: understand the request, check the relevant information, follow business rules and ask a person to approve sensitive actions.

## Why this project exists

Operations teams often spend time reading requests, looking up records and repeating the same steps across different systems. FlowPilot explores how AI can help interpret those messages while application code controls what happens next.

It is also a portfolio project for learning and demonstrating full-stack development, reliable background processing, human approval flows and safe AI integration. Development uses synthetic data and mock services only.

## Current status

FlowPilot is in early development. The foundation currently includes:

- A React interface that checks the API connection.
- A Fastify API with a liveness endpoint.
- Shared TypeScript types and runtime validation schemas.
- Docker Compose configuration for PostgreSQL and RabbitMQ.
- Build, typecheck, lint and API test commands, plus a GitHub Actions CI workflow.

Request submission, database persistence, AI classification, workflow execution and human approvals are planned. The current app lets you check the development setup; it does not process customer requests yet.

## Run locally

### Requirements

- Node.js **24.22.3** (also recorded in `.node-version`).
- pnpm **10.34.9**.
- Docker with a running Linux engine if you want to start PostgreSQL and RabbitMQ.

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

Install dependencies and start the development servers:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open **http://127.0.0.1:5173**. The page should display **API connected**. Use **Check connection** to try again if the API was still starting.

The API runs at **http://127.0.0.1:3001**. You can check it directly at `/api/v1/health/live`, which returns:

```json
{"status":"ok","service":"flowpilot-api"}
```

Press `Ctrl+C` in the terminal to stop the app.

### Optional: start local infrastructure

The current UI and API work without PostgreSQL or RabbitMQ. To start those services for development, run:

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

## Development checks

Run these commands from the repository root. Build first so the shared contracts are available to the other packages:

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm dev` builds the shared contracts automatically. Restart it after editing those contracts.

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
