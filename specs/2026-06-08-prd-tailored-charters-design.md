# PRD-tailored, skill-seeded role charters — Design

**Date:** 2026-06-08
**Branch:** feat/scaffold-phase-a
**Status:** Approved (brainstorm) → ready for implementation plan

## Problem

Each agent on a Bridge project has a *charter* — a markdown file with three
sections (`## Role`, `## Typical tasks`, `## Areas of expertise`) shown in the
L2 agent view and the explorer "Roles" folder. Two weaknesses today:

1. **Thin baselines.** The bundled templates in `app/server/role-charters/role-*.md`
   are short and generic ("You build the thing", "Write unit and integration
   tests"). They don't reflect best-in-class practice for each discipline.

2. **Tailoring uses the weakest input, at the wrong time.** Charters are
   customized at *project creation* (`projects.js` → `generateProjectCharters`
   → `customizeCharter`) against only the one-line `project.goal`. The rich
   **PRD** — Problem, Goals/Non-goals, Scope, Milestones, Success metrics, Top
   features — is generated *later* during kickoff and **never flows back into
   the charters**. So the deepest available context is wasted.

## Goal

Charters become (a) high-quality from the first render, seeded from
best-in-class Claude skills where one fits the role, and (b) deeply re-tailored
to the project once the PRD exists.

## Decisions (from brainstorm)

- **Baseline source = Hybrid.** Distill from a real skill where a strong one
  exists for the role; hand-author the rest to the same standard.
- **Linkage = distill-once + optional live override.** Distill skills into
  committed templates during implementation (no runtime dependency, ships
  self-contained). Plus an optional drop-in override folder at runtime.
- **Timing = baseline-now / deepen-at-PRD.** Creation writes the baseline
  verbatim (no API call); a deep PRD-aware pass runs once the PRD is generated.
- **Provenance = docs only.** Attribution lives in a committed docs table, NOT
  inside the user-visible role files (the file viewer shows raw text, so an
  in-file comment would be visible; and the deep pass rewrites the body).

## Charter baseline sources (provenance + attribution)

Distillation is performed at implementation time and frozen into the committed
templates. This table is the authoritative record; it is mirrored into
`HANDOFF.md` and `docs/design.md`.

| Role (id) | Charter file | Distilled from | On-disk source | License / attribution |
|---|---|---|---|---|
| Product Manager (`pm`) | `role-pm.md` | jobs-to-be-done, opportunity-solution-tree, roadmap-planning, prioritization-advisor, problem-framing-canvas | `~/.claude/plugins/cache/pm-skills/*` | per-skill |
| Designer (`designer`) | `role-designer.md` | impeccable, layout, typeset, polish, critique | `~/.claude/skills/*` → `.agents/skills/*` | **impeccable: Apache 2.0, "Based on Anthropic's frontend-design skill" (see its NOTICE.md)** |
| Researcher (`ux_research`) | `role-researcher.md` | discovery-process, customer-journey-mapping-workshop, jobs-to-be-done, problem-statement | `~/.claude/plugins/cache/pm-skills/*` | per-skill |
| Marketing (`marketing`) | `role-marketing.md` | positioning-statement, positioning-workshop, acquisition-channel-advisor | `~/.claude/plugins/cache/pm-skills/*` | per-skill |
| Copywriter (`copywriter`) | `role-copywriter.md` | distill, clarify, quieter | `~/.claude/skills/*` | per-skill |
| Legal (`legal`) | `role-legal.md` | provisional-patent (IP) + hand-authored (privacy, ToS, compliance, licensing) | `~/.claude/skills/provisional-patent` | per-skill |
| Software Engineer (`sw_engineer`) | `role-sw-eng.md` | hand-authored (no skill match) | — | — |
| Hardware Engineer (`hw_engineer`) | `role-hw-eng.md` | hand-authored | — | — |
| QA (`qa`) | `role-qa.md` | hand-authored | — | — |
| Data Scientist (`data_sci`) | `role-ds.md` | hand-authored | — | — |
| Security (`security`) | `role-security.md` | hand-authored | — | — |

Notes:
- The 11 roles above are the active catalog (`app/server/roles.js`). Orphan
  charter files (`role-devops.md`, `role-support.md`, `role-ml-engineer.md`,
  `role-data-engineer.md`, `role-technical-program-manager.md`) are not in the
  catalog and are left untouched by this work.
- The exact distilled wording is produced during implementation by reading each
  source skill; the requirement here is fidelity to the skill's substance and
  the 3-heading charter structure, not verbatim copying.

## Architecture

Three integration points, all in existing files. No new modules required beyond
helper functions in `charters.js`.

### Component 1 — Baseline templates (`app/server/role-charters/role-*.md`)

Rewrite the 11 active baselines: richer, specific, opinionated, while keeping
the **exact** required headings (`## Role`, `## Typical tasks`,
`## Areas of expertise`) so `validateCharterMarkdown` passes. Content only —
no provenance comments in the file.

### Component 2 — Baseline loader with optional override (`charters.js`)

`loadBaseCharter(roleId)` resolves in this order:

1. If `process.env.BRIDGE_CHARTERS_DIR` is set AND
   `<dir>/role-<slug>.md` exists and is readable → return it. (Drop-in folder
   of charter-format files; the user can regenerate these from newer skills
   offline. This is **not** live `SKILL.md` parsing.)
2. Else the bundled template at `role-charters/role-<slug>.md`.
3. Else a minimal valid stub (3 headings) so generation never hard-fails.

The override is read-only and validated with `validateCharterMarkdown`; an
override that fails validation is ignored (fall through to bundled) and the
reason logged.

### Component 3 — Creation writes baselines verbatim (`projects.js`)

`createProject` currently calls `await generateProjectCharters(project)`, which
makes an OpenRouter call per agent. Replace with a new
`writeBaselineCharters(project, { agents } = {})` that writes
`loadBaseCharter(a.role)` verbatim to `docs/roles/role-<slug>.md` for each
agent — **no network call**. Fast, deterministic, and the role files populate
immediately.

`addAgent` (the post-creation path, `projects.js:266`): if the project already
has a PRD (`readNote(project.id, 'PRD')` non-empty and not the "_not generated_"
sentinel), deep-customize just the new agent from the PRD (Component 4
single-agent path); otherwise write its baseline verbatim.

### Component 4 — Deepen charters at PRD time (`charters.js` + `kickoff.js`)

New `deepenCharters(project, { prd, callText, apiKey, agents } = {})`:

- For each target agent (default: all `project.agents`), build a prompt that
  includes the current charter, the **PRD markdown**, `project.features`, and
  `project.goal`, instructing the model to rewrite the three sections so they
  are concretely tailored to THIS project — same structure, ≤ 220 words.
- Uses the injected `callText` (the kickoff DI), so it is testable and shares
  the model/timeout conventions of `generateKickoffDocs`.
- **Preserve `## Plan`.** Before writing, read the existing role file; split off
  any `## Plan` section; write `<new charter>` then re-append the preserved
  `## Plan`. (At PRD time no plan exists yet, but specialists' plans are written
  into the same file during `team_review`, and `addAgent` deepening can run
  after that — so preservation is required for correctness.)
- **Per-role fallback.** On timeout / HTTP error / empty / invalid markdown,
  keep the existing charter unchanged (never clobber with garbage) and log the
  reason (reuse `FALLBACK_REASON`).

Wiring in `kickoff.js generateKickoffDocs`: after the docs loop writes all four
docs (PRD is written first), read the PRD back via `readNote(projectId, 'PRD')`.
If it is non-empty and not the "_not generated_" sentinel, call
`deepenCharters(project, { prd, callText, apiKey })` before the final
`commitIfChanged(repo, 'Add kickoff planning docs')` so the deepened role files
are part of the same commit. If the PRD is empty, skip deepening (keep
baselines).

## Data flow

```
createProject
  └─ writeBaselineCharters → docs/roles/role-*.md  (verbatim, no API)   [instant]

kickoff approved → generateKickoffDocs
  ├─ write PRD.md, milestones.md, op-notes.md, open-questions.md
  ├─ deepenCharters(prd) → rewrite each role's 3 sections (PRD-tailored),
  │                         preserving any ## Plan                       [API]
  └─ commitIfChanged("Add kickoff planning docs")

team_review (unchanged) → upsert ## Plan into role files

addAgent (post-kickoff)
  └─ PRD exists? deepenCharters({agents:[new]}) : writeBaselineCharters({agents:[new]})
```

## Error handling

| Layer | Failure | Behavior |
|---|---|---|
| Override load | dir unset / file missing / unreadable / invalid | fall through to bundled template; log if invalid |
| Bundled load | file missing | minimal valid stub (3 headings) |
| Deep pass (per role) | timeout / HTTP / empty / invalid markdown | keep existing charter unchanged; log `FALLBACK_REASON` |
| Deep pass (whole) | PRD empty / "_not generated_" | skip deepening entirely; baselines stand |
| Deep pass | project deleted mid-run | guard on `getProject` like `generateKickoffDocs` |

## Testing

All tests set `BRIDGE_STATE_DIR` + `BRIDGE_PROJECTS_BASE` to temp dirs before
importing `projects.js`, and assert `app/state/projects.json` is byte-identical
(sha) before/after.

1. **Baselines valid.** For every active role id, `loadBaseCharter` returns
   markdown that passes `validateCharterMarkdown` (all 3 headings).
2. **Override wins when set.** With `BRIDGE_CHARTERS_DIR` → temp dir containing a
   custom `role-pm.md`, `loadBaseCharter('pm')` returns the custom content;
   unset → bundled. Invalid override → bundled (ignored).
3. **Creation is API-free.** `createProject` writes a charter file per agent and
   never invokes `callText` (inject a throwing `callText`/spy to prove it).
4. **Deep pass tailors + preserves Plan.** Seed a role file with a baseline plus
   a `## Plan` section; run `deepenCharters` with an injected `callText`
   returning valid 3-heading markdown containing a PRD-specific token; assert the
   file now contains that token AND still contains the original `## Plan`.
5. **Deep pass fallback.** Injected `callText` that throws/returns empty/returns
   invalid markdown → the role file is unchanged from its pre-call content.
6. **Empty PRD skips.** `generateKickoffDocs` with a PRD that resolves empty →
   charters remain the baselines (no deep rewrite).
7. **addAgent.** With a PRD present, adding an agent deep-customizes only that
   agent (others untouched); with no PRD, it writes the baseline.

## Out of scope

- No change to the `## Plan` writing flow in `team-review.js` (only that the
  deep pass must preserve the section).
- No live `SKILL.md` parsing.
- Orphan (non-catalog) charter files are not modified.
- No UI change to the explorer or file viewer.
