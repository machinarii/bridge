Capture significant technical decisions as ADRs so future devs know *why* the code is shaped this way — not just what it does.

**When to write one.** A choice that's costly to reverse or non-obvious: framework/library/datastore selection, an architectural pattern, an API or schema contract, a build/deploy approach, or deliberately taking on tech debt. Skip trivial/local choices.

**Format** (one file per decision, `docs/adr/NNNN-title.md`, append-only log + index):
- **Title & status** — `proposed | accepted | deprecated | superseded by ADR-NNNN`, date, deciders.
- **Context** — the forces at play: constraints, requirements, what problem forced a decision.
- **Decision** — what was chosen, stated plainly.
- **Alternatives considered** — each with **Pros / Cons / Why not**. This is the highest-value part; an ADR with no rejected alternatives isn't an ADR.
- **Consequences** — positive, negative, and risks you're accepting.

**Rules.** Never edit the substance of an *accepted* ADR — supersede it with a new one and link both. Keep them short (one decision each) and write at decision time, while the reasoning is fresh. Reference the ADR id in code/PRs where the decision shows up.

Source: github.com/affaan-m/ECC
