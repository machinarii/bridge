Evolve a schema without taking the app down. Default to the **expand → migrate → contract** pattern: add the new shape, backfill, switch reads/writes, then remove the old — never a destructive one-shot.

**Safety rules.**
- Every migration is **reversible** (or has an explicit, tested down path). Review the generated SQL before applying — never auto-apply blind.
- **Additive first.** Add columns nullable or with a default; don't add `NOT NULL` to a populated table in one step (add nullable → backfill → set `NOT NULL`).
- **Rename = expand/contract**, not `RENAME`: add new column, dual-write, backfill, move reads, drop old. Same for type changes.
- **Index online.** Postgres: `CREATE INDEX CONCURRENTLY` (outside a txn) so you don't lock the table.
- **Backfill in batches** (bounded by id/time, throttled), not one giant `UPDATE` that locks rows / blows up the WAL.
- **Drop late.** Remove old columns/tables only after all deployed code stops referencing them.

**Workflow.** Generate from schema (`prisma migrate dev` / `drizzle-kit generate`), inspect the SQL, test up **and** down on a copy, apply in prod with `migrate deploy` (never `db push`/reset against prod), regenerate the client. Keep migrations forward-only in history; fix-forward rather than editing an applied migration.

Pairs with **Deployment & CI/CD** (a schema change must be backward-compatible with the currently-running app version during a rolling deploy). Source: github.com/affaan-m/ECC
