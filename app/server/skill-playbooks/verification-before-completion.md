Evidence before assertions, always:

- Before claiming "done", "fixed", or "passing" — run the actual verification (tests, build, the repro, the live app) and look at the output.
- Quote the evidence in your report: the passing test count, the command output, the observed behavior. "Should work" is not a status.
- If verification fails, report that honestly with the failure output — never soften it to "mostly working".
- If you couldn't verify something (no access, no time, blocked), say exactly what is unverified and why.

The standard: a teammate reading your report should be able to trust it without re-checking your work.
