Ship to production safely — pick a strategy for the risk, make every change rollback-able.

**Strategies.**
- **Rolling (default):** replace instances gradually, zero downtime — but two versions run at once, so changes MUST be backward-compatible (DB + API). Pair with expand/contract migrations.
- **Blue-green:** stand up the new version alongside, cut over, keep the old for instant rollback. Costs 2× infra during the switch; use for critical, low-tolerance services.
- **Canary:** route a small % of real traffic to the new version, watch metrics, then ramp. Use for high-traffic or risky changes; needs traffic-splitting + monitoring (often gated behind feature flags).

**Docker.** Multi-stage build (deps → build → slim runtime); run as non-root; pin base image digests; no secrets in layers/build args; add a `HEALTHCHECK`.

**Health & rollback.** Expose `/health` (liveness) and a readiness check that verifies real dependencies (DB, cache, downstreams); the orchestrator must gate traffic on readiness. Every deploy needs a one-command rollback (previous image/release) and a known-good version pinned. Migrations deploy **before** the code that needs them and stay backward-compatible.

**Production-readiness checklist:** migrations applied & backward-compatible · env/secrets present (not hardcoded) · health/readiness green · logging + error tracking wired · rate limits & timeouts set · rollback path tested · alerts on error-rate/latency.

Pairs with **Database migrations**. Source: github.com/affaan-m/ECC
