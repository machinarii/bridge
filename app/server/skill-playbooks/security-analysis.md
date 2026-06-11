Hunt vulnerabilities systematically (Trail of Bits methodology):

1. **Map the attack surface first**: entry points, trust boundaries, secrets, and data flows — untargeted scanning wastes time.
2. **Static analysis with intent**: run the right rulesets (Semgrep/CodeQL-style patterns) for the stack; triage by exploitability, not raw finding count.
3. **Differential review**: on changes, ask what NEW capability an attacker gains — new inputs, new parsers, weakened checks, leaked errors.
4. **The classics, every time**: injection (SQL/command/path), authn/authz gaps, SSRF, deserialization, secrets in code/logs, dependency CVEs.
5. **Report like an engineer**: each finding gets severity, a concrete exploit scenario, affected file:line, and a specific fix — "be careful with input" is not a finding.

Distinguish proven (you traced it) from theoretical (pattern match) — never present pattern matches as confirmed vulnerabilities.
