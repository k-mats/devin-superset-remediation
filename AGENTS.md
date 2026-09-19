# AGENTS.md

## Repository Structure

```
devin-superset-remediation/
├── src/
│   ├── index.ts              # Application entry point
│   ├── config.ts             # Configuration (zod schemas)
│   ├── db/                   # Database
│   │   ├── schema.ts         # Drizzle schema definitions
│   │   └── client.ts         # Database client singleton
│   └── routes/               # Fastify routes
│       └── health.ts         # Health check endpoint
├── tests/
│   ├── setup.ts              # Test configuration
│   ├── health.test.ts        # Health endpoint test
│   └── database.test.ts      # Database integration test
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
