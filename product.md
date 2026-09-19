# product.md

## Problem Being Solved

Engineering teams using GitHub for issue tracking and pull requests need an automated way to remediate selected issues using the Devin AI coding agent. Currently, this requires manual intervention to create Devin sessions, track progress, and manage the resulting pull requests.

## Intended User

- Engineering teams or engineering leaders adopting Devin
- Teams that want to automate routine code remediation tasks
- Organizations using GitHub for their development workflow

## Expected Workflow (High Level)

1. A GitHub issue is created or updated that matches criteria for automated remediation
2. The orchestrator detects the issue (via GitHub webhook or event polling)
3. The orchestrator evaluates whether the issue should be automated
4. If approved, the orchestrator calls the Devin API to create a remediation session
5. Devin works on the issue and creates a pull request in the target repository
6. The orchestrator monitors the session and reports status
7. Verification and reporting are provided to the engineering team

## Success Criteria

- The orchestrator can reliably detect and process relevant GitHub issues
- Devin sessions are created successfully via the API
- Pull requests are generated for remediated issues
- Status and results are reported back to the team
- The system handles failures gracefully without creating duplicate work
- The take-home demonstrates a working vertical slice of this workflow

## Non-Goals

- Multi-repository support in the initial implementation
- Automatic merging of pull requests
- Complex approval workflows beyond basic issue selection
- Kubernetes deployment or complex infrastructure
- Kafka or other message queues in the initial implementation
- Enterprise-scale features (RBAC, multi-tenancy, etc.)
- Modifying the Apache Superset fork directly (except via Devin-generated PRs)

## Take-Home Context

This is a take-home project for Cognition's Deployed Engineer role. The project demonstrates:

- Integration with the Devin API
- Event-driven architecture
- GitHub webhook/event handling
- Orchestration of AI-powered code remediation
- Reliability and idempotency in automated workflows

The target repository for remediation is a fork of Apache Superset, but the orchestrator should be designed to work with other repositories as well.
