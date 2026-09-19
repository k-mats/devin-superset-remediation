# AGENTS.md

## Repository Structure

This repository is currently empty except for this documentation. The application has not yet been implemented.

## Development Conventions

- TBD - will be established as the application stack is selected
- Follow existing code style conventions once implementation begins
- Prefer small, reviewable changes

## Commands

### Application Execution
- TBD - no application exists yet

### Tests
- TBD - no test framework selected yet

### Linting
- TBD - no linting tool selected yet

### Type Checking
- TBD - no type system selected yet

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
4. Run tests, linting, and type checking before committing
5. Create focused pull requests linked to issues
6. Verify changes meet acceptance criteria

## Notes

- This is a take-home project for Cognition's Deployed Engineer role
- The project will be an event-driven automation using the Devin API to remediate selected issues in a fork of Apache Superset
- This repository contains the orchestration application itself
