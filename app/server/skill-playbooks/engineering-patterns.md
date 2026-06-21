Baseline engineering patterns for production code — apply regardless of framework.

**Code quality.** Readability first; KISS, DRY, YAGNI. Prefer immutable updates (spread/copy, no in-place mutation of shared state). Descriptive names (verbs for functions, nouns for values); no single-letter except loop indices. Keep functions small and single-purpose. Type everything at boundaries — no `any`/untyped public surfaces.

**API design (REST).** Resources are plural, lowercase, kebab-case nouns (`/api/users/{id}/orders`); verbs only for non-CRUD actions. Use HTTP status codes semantically: 200 read, 201 + `Location` on create, 204 no-content, 400/422 validation (with field-level detail), 401 vs 403, 404, 409 conflict, 429 rate-limit, 5xx server. Never 200-for-everything. Consistent envelope: `{ data, error, meta }`; paginate collections (cursor or page+limit) and return total/next. Version at the edge (`/v1`); validate every input server-side.

**Error handling.** Throw typed errors (an error class/hierarchy), not bare strings. Catch narrowly and add context as you bubble up; never swallow (`catch {}`). At the boundary, map internal errors to a clean user-facing message + a stable code — never leak stack traces or internals. Use retries with exponential backoff + jitter for transient failures, and a circuit breaker for repeatedly-failing dependencies. React/UI: wrap subtrees in error boundaries.

**Verification loop.** After any change, run the project's build + test + lint/typecheck and fix what breaks before claiming done — the loop is the contract, not an optional step.

Distinct concerns have their own skills: schema changes → Database migrations; shipping → Deployment & CI/CD; recording a decision → Architecture decision records. Source: github.com/affaan-m/ECC
