Review in passes, highest-stakes first:

1. **Correctness** — trace the happy path AND the failure paths. Check boundaries (empty, huge, zero, null, concurrent), error handling, and any state mutation.
2. **Clarity** — could the next person follow this without the author present? Flag misleading names and clever-but-opaque constructs.
3. **Fit** — does it match the codebase's existing patterns, or invent a parallel way to do the same thing?

Report findings with file:line, ranked by severity, and distinguish "must fix" (bugs, security, data loss) from "consider" (style, simplification). Verify claims before asserting them — read the called code, don't assume from the name. Praise what's genuinely good; don't pad with nitpicks to look thorough.
