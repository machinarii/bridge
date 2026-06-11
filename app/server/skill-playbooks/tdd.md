RED → GREEN → REFACTOR, strictly in that order:

1. **RED** — write one failing test that captures the next small behavior. Run it and watch it fail for the RIGHT reason (assertion failure, not setup error).
2. **GREEN** — write the minimum code to pass. Resist building ahead of the test.
3. **REFACTOR** — clean up names, duplication, and structure while everything stays green.

Rules: never write production code without a failing test demanding it; one behavior per test; test behavior through the public interface, not internals. If you can't write the test, you don't understand the requirement yet — stop and clarify. Anti-patterns to refuse: tests written after the code to "lock it in", tests that assert mocks were called instead of outcomes, and deleting a failing test instead of fixing the code.
