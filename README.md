# devin-superset-remediation

Event-driven orchestration service for Devin API to remediate selected issues in a fork of Apache Superset.

## Overview

This project implements an automated system that:

- Detects selected issues in a fork of Apache Superset
- Invokes the Devin API to perform remediation
- Tracks Devin sessions and resulting pull requests
- Verifies and reports remediation results
- Preserves idempotency, failure handling, and evidence suitable for evaluation

## Technology Stack

- **Language**: TypeScript 6.0.3
- **Runtime**: Node.js 24 LTS (24.21.0)
- **Framework**: Fastify 5
- **Database**: SQLite with Drizzle ORM and better-sqlite3
- **Package Manager**: pnpm 12.4.2
- **Testing**: Vitest 5
- **Linting**: ESLint 10 with typescript-eslint
- **Formatting**: Prettier

## Development

### Prerequisites

- Node.js 24.21.0
- pnpm 12.4.2

### Installation

```bash
pnpm install
```

### Commands

#### Verification

- `pnpm check` - Run comprehensive code quality checks (format, lint, type-check, test, build)

#### Application Execution

- `pnpm dev` - Start development server with hot reload
- `pnpm build` - Build TypeScript to JavaScript
- `pnpm start` - Start production server (requires build first)

#### Tests

- `pnpm test` - Run all tests
- `pnpm test:coverage` - Run tests with coverage report

#### Linting

- `pnpm lint` - Run ESLint
- `pnpm lint:fix` - Run ESLint with auto-fix
- `pnpm format` - Format code with Prettier
- `pnpm format:check` - Check code formatting

#### Type Checking

- `pnpm type-check` - Run TypeScript type checking

#### Database

- `pnpm db:generate` - Generate Drizzle migrations from schema
- `pnpm db:migrate` - Apply migrations to the database
- `DATABASE_PATH=./data/demo.db pnpm demo:restart` - Demonstrate persistent state across process restart; `DATABASE_PATH` is optional and sets the SQLite file path (default `./data/orchestrator.db`), so any path works and `./data/demo.db` keeps demo data separate from the real database

### Environment Variables

Create a `.env` file based on `.env.example`:

```env
NODE_ENV=development
PORT=3000
DATABASE_PATH=./database.db
LOG_LEVEL=info
```

### Devin API smoke test (Issue #5)

A reusable Devin v3 Organization API client lives in `src/devin/client.ts`. To
verify API connectivity end-to-end, run the smoke-test script:

```bash
DEVIN_API_KEY=... DEVIN_ORG_ID=... pnpm smoke:devin
```

It creates a minimal session, polls until it reaches a terminal status, and
prints a sanitized JSON summary (optionally persisted via `SMOKE_OUTPUT_PATH`).
See [docs/evidence/issue-5-devin-smoke.md](docs/evidence/issue-5-devin-smoke.md)
for details and recorded evidence.

### Health Endpoints

- `GET /health` - Process liveness check
- `GET /ready` - Application readiness check with database connectivity

## Architecture

The system follows an event-driven architecture:

```
GitHub issue/event
    ↓
orchestrator
    ↓
Devin API
    ↓
pull request
    ↓
verification/reporting
```

See [architecture.md](architecture.md) for detailed architectural information.

## Development Conventions

- Strict TypeScript mode with no implicit any
- Type-safe database operations with Drizzle ORM
- Comprehensive testing for external side effects
- Idempotent event processing
- Evidence preservation for evaluation
