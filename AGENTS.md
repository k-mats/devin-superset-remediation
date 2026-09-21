# AGENTS.md

## Repository Structure

```
devin-superset-remediation/
├── src/
│   ├── index.ts              # Application entry point
│   ├── config.ts             # Configuration (zod schemas)
│   ├── db/                   # Database
│   │   ├── schema.ts         # Drizzle schema definitions
│   │   ├── client.ts         # Database client singleton
│   │   └── task-state.ts     # Persistent task and attempt state
│   ├── devin/                # Devin API
│   │   ├── client.ts         # Devin v3 Organization API client
│   │   └── structured-output.ts # Structured output contract (Issue #10)
│   ├── dispatch/             # Devin session dispatch
│   │   └── devin-dispatcher.ts # Pending-attempt claim and session dispatch (Issues #8, #9)
│   ├── github/               # GitHub API
│   │   └── client.ts         # GitHub issue API client
│   ├── intake/               # GitHub issue intake
│   │   └── github-intake.ts  # Issue polling and task creation (Issue #7)
│   ├── outcome/              # Session outcome collection
│   │   ├── collect-structured-output.ts # One-shot structured output collection (Issue #10)
│   │   └── verify-pull-request.ts # Agent PR verification (Issue #11)
│   ├── tracking/
│   │   ├── session-tracker.ts # Devin session and PR lifecycle tracking (Issue #11)
│   │   └── normalized-task-state.ts # Derived normalized task-state projection (Issue #14)
│   ├── reporting/
│   │   ├── report-model.ts    # Task and attempt observability report (Issue #15)
│   │   └── render-dashboard.ts # Server-rendered reporting dashboard (Issue #15)
│   ├── verification/         # Independent remediation verification (Issue #13)
│   │   ├── spec.ts           # Issue `## Verification` section parser and spec hashing
│   │   ├── approval.ts       # Candidate vs approved spec status derivation
│   │   ├── runner.ts         # Sandboxed shell command runner (env allowlist, timeouts)
│   │   ├── git-workspace.ts  # Per-repo workspace clone and exact-SHA checkout
│   │   ├── repo-setup.ts     # Repository setup adapters (superset uv venv, noop)
│   │   ├── github-checks.ts  # Check-run/combined-status evaluation
│   │   └── verify-remediation.ts # Verification orchestration per poll
│   └── routes/               # Fastify routes
│       ├── health.ts         # Health check endpoint
│       └── report.ts         # JSON report and HTML dashboard (Issue #15)
├── scripts/
│   ├── devin-smoke.ts        # Devin API smoke test (Issue #5)
│   ├── state-restart-demo.ts # Persistent state restart demo (Issue #6)
│   ├── intake-demo.ts        # Single GitHub intake pass demo (Issue #7)
│   ├── dispatch-demo.ts      # Single Devin dispatch pass demo (Issues #8, #9)
│   ├── structured-output-demo.ts       # Single structured output collection demo (Issue #10)
│   └── tracking-demo.ts       # Single session and PR tracking pass demo (Issue #11)
│   ├── verification-demo.ts   # Single independent verification pass demo (Issue #13)
│   ├── adopt-session-demo.ts  # Attach an existing Devin session to a pending attempt
│   ├── verification-show.ts   # Inspect an attempt's verification spec and history
│   ├── verification-approve.ts# Approve a pending verification spec by sha256
│   └── verification-propose.ts# Propose a verification spec as the operator
├── docs/
│   └── evidence/             # Verification evidence artifacts
├── tests/
│   ├── setup.ts              # Test configuration
│   ├── health.test.ts        # Health endpoint test
│   ├── database.test.ts      # Database integration test
│   ├── task-state.test.ts    # Persistent task state tests
│   ├── session-tracker.test.ts # Session and PR tracking tests
│   └── normalized-task-state.test.ts # Normalized task-state projection tests
│   ├── report-model.test.ts # Reporting model tests
│   └── report-routes.test.ts # Reporting route tests
├── drizzle/                  # Drizzle migrations
├── package.json              # pnpm configuration
├── tsconfig.json             # TypeScript configuration
├── tsconfig.build.json       # TypeScript build configuration
├── eslint.config.mjs         # ESLint flat config
├── drizzle.config.ts         # Drizzle Kit configuration
├── .env.example              # Environment variables template
└── AGENTS.md, REVIEW.md, architecture.md, product.md
```

## Development Conventions

- **Language**: TypeScript with Node.js 24 LTS (24.21.0)
- **Framework**: Fastify for web server
- **Database**: SQLite with Drizzle ORM and better-sqlite3
- **Package Manager**: pnpm
- **Code Style**: Prettier for formatting, ESLint for linting
- **Type Safety**: Strict TypeScript mode with no implicit any
- **Testing**: Vitest for unit and integration tests
- Follow existing code style conventions
- Prefer small, reviewable changes

## Commands

### Verification

- `pnpm check` - Run comprehensive code quality checks (format, lint, type-check, test, build)

### Application Execution

- `pnpm dev` - Start development server with hot reload
- `pnpm build` - Build TypeScript to JavaScript
- `pnpm start` - Start production server (requires build first)

### Tests

- `pnpm test` - Run all tests
- `pnpm test:coverage` - Run tests with coverage report

### Linting

- `pnpm lint` - Run ESLint
- `pnpm lint:fix` - Run ESLint with auto-fix
- `pnpm format` - Format code with Prettier
- `pnpm format:check` - Check code formatting

### Type Checking

- `pnpm type-check` - Run TypeScript type checking

### Database

- `pnpm db:generate` - Generate Drizzle migrations from schema
- `pnpm db:migrate` - Apply migrations to the database
- `pnpm demo:restart` - Demonstrate state recovery across process restart

## Safety Rules

1. **Never commit secrets or credentials** - This includes API keys, tokens, passwords, or any sensitive configuration
2. **Do not modify the Apache Superset fork** unless a task explicitly requires it
3. **Do not claim functionality is verified** unless it has actually been exercised in a real run
4. **Prefer small, reviewable changes** - Make incremental improvements that can be easily reviewed
5. **Preserve evidence needed for the take-home** - Maintain logs, test results, and verification artifacts

## Repository Boundaries

- This repository contains the orchestration application only
- The Apache Superset fork is a separate repository and should not be modified unless explicitly required
- Focus on the event-driven automation layer that uses the Devin API

## Expected Workflow

1. Read the relevant GitHub issue to understand the task
2. Explore the codebase to understand current state
3. Make changes following existing conventions
4. Run `pnpm check` to verify code quality before committing
5. Create focused pull requests linked to issues
6. Verify changes meet acceptance criteria

## Notes

- This is a take-home project for Cognition's Deployed Engineer role
- The project will be an event-driven automation using the Devin API to remediate selected issues in a fork of Apache Superset
- This repository contains the orchestration application itself
