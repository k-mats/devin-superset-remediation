# REVIEW.md

## Review Expectations

### Correctness

- Changes must solve the stated problem without introducing regressions
- Code should handle edge cases appropriately
- Business logic should match requirements in the GitHub issue

### Tests

- **Implemented**: Code has test coverage
- **Tested with mocks**: Tests use mocks for external dependencies
- **Verified in a real run**: Functionality has been exercised against real systems

### Static Typing

- All code should pass type checking once a type system is selected
- Use type annotations to improve code clarity and catch errors early
- TBD - type system not yet selected

### Failure Handling

- External API calls should have appropriate error handling
- Database operations should handle connection failures and constraints
- Background jobs should have retry logic where appropriate
- Error messages should be actionable and informative

### Idempotency

- Operations should be idempotent where possible
- Re-running the same operation should not cause unintended side effects
- State changes should be atomic or have clear rollback mechanisms

### External Side Effects

For operations that create resources or incur cost (e.g., creating a Devin session):

- **Verify duplicate processing cannot trigger the operation twice**
- **Test the number of external calls, not only resulting database rows**
- **Consider failures between the external call and local persistence**
- Implement deduplication mechanisms at the appropriate layer
- Use idempotent operations where possible

### Persistence

- Database transactions should be used for multi-step operations
- Data should be validated before persistence
- Consider data consistency requirements across operations
- TBD - persistence layer not yet selected

### Security

- Never commit secrets or credentials
- Use environment variables or secret management for sensitive data
- Validate and sanitize all external inputs
- Follow principle of least privilege for API access
- Audit logging for security-relevant operations

### Observability

- Key operations should be logged for debugging
- Use structured logging where appropriate
- Metrics should be collected for critical paths
- Errors should be logged with sufficient context
- TBD - observability stack not yet selected

## Verification Levels

- **Implemented**: Code exists and appears correct
- **Tested with mocks**: Unit/integration tests pass with mocked dependencies
- **Verified in a real run**: Functionality confirmed against real external systems

## Review Checklist

- [ ] Code solves the stated problem
- [ ] No regressions introduced
- [ ] Tests added/updated
- [ ] Type checking passes (once type system selected)
- [ ] Error handling is appropriate
- [ ] External side effects are idempotent or protected
- [ ] No secrets committed
- [ ] Logging is sufficient for debugging
- [ ] Changes are small and reviewable
