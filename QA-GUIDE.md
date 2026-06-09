# Bridge — QA Guide

Prefilled text + a one-command script so you don't have to type or speak a new
project every time you test the kickoff / build / run flow.

## Prerequisites

- **Server up:** `npm run server` (listens on `:4317`).
- **Agent replies need a key:** `OPENROUTER_API_KEY` in `app/server/.env` — without it the PM can't draft a kickoff plan.
- **Voice (optional):** `npm run stt` for the Parakeet sidecar.
- **"Run it" build loop (optional):** a Docker daemon — `colima start` (no Docker Desktop needed).

---

## Fast path — seed a whole project from one command

Skips the capture UI entirely (roles → topology → name → objective → features),
creates the project, and triggers the PM kickoff. You land straight on the plan
bubble.

```bash
npm run qa:new -- trading        # or: recipes | iot   (default: trading)
# equivalently:
bash scripts/qa-new-project.sh trading
```

Override any field via env (handy for edge cases — long names, empty features, odd role mixes):

```bash
QA_NAME="My Test App" \
QA_GOAL="A short objective sentence." \
QA_FEATURES="Feature one; feature two; feature three." \
QA_ROLES='["pm","sw_engineer","qa"]' \
QA_TOPOLOGY=feature-teams \
  npm run qa:new
```

Valid values:
- **roles:** `pm` (auto-added if omitted), `sw_engineer`, `hw_engineer`, `designer`, `qa`, `data_sci`, `security`, `ux_research`, `copywriter`, `marketing`, `legal`
- **topology:** `hub-and-spoke`, `feature-teams`, `mesh-mob`, `rotating-lead`, `async-pull`

**Delete a test project** (clean up between runs):

```bash
curl -s -X DELETE "http://localhost:4317/projects/<project-id>"   # e.g. p_2026_06_08_my-test-app
```

> Note: project ids are `p_<date>_<slug>`. Re-creating a same-name project the
> same day reuses the id but starts with a **fresh chat** (the scratchpad is
> cleared on create), so repeated QA runs of the same preset are clean.

---

## Manual path — prefilled text for the capture screens

If you're testing the **capture UI** itself, press **`/`** on each screen (Name,
Objective, Features) to open the type box, then paste the matching block below
and press **Enter** (it lands in the box for review; press **Continue** to advance).

### Preset: `trading` — Day Trading Mobile App

**Name**
```
Day Trading Mobile App
```
**Objective**
```
A beginner-friendly mobile app for day trading stocks: voice-driven order entry, bite-sized market tips, and an AI sell-time signal — runnable offline for demos.
```
**Top features**
```
Voice order entry; tiered order confirmation (small auto, large re-confirm); mock brokerage adapter; AI sell-time prediction with a clear 'not financial advice' disclaimer; biometric re-auth on order submit; a curated 'what to buy' discovery feed.
```

### Preset: `recipes` — Weeknight Recipe Planner

**Name**
```
Weeknight Recipe Planner
```
**Objective**
```
A web app that plans a week of dinners from what is already in your fridge, builds a shopping list, and scales recipes to household size.
```
**Top features**
```
Pantry-aware meal suggestions; auto shopping list; serving-size scaling; dietary filters (veg, gluten-free); one-tap 'cook tonight' with step timers.
```

### Preset: `iot` — Smart Home Energy Dashboard

**Name**
```
Smart Home Energy Dashboard
```
**Objective**
```
A dashboard that shows real-time home energy use per device and suggests concrete ways to save.
```
**Top features**
```
Per-device live usage; monthly cost projection; anomaly alerts; ranked savings suggestions; a weekly email/PDF report.
```

---

## Walkthrough — what to verify after seeding

1. **Plan bubble** — PM posts a single plan with A/B/C approval choices. It should be **plan-only** (no extra question crammed in).
2. **Approve** (A) or **"ask me clarifying questions first"** (B) → the PM asks **one question at a time**, ordered **high → low importance** (foundational/regulatory first; QA/marketing last). Optionless questions still offer **"Other — hold to talk"** + Skip.
3. **Team planning round** — each specialist asks one real, role-tagged question (*"Iris (Designer) asks…"*), in priority order; mentioned teammates are role-tagged too (*"…with Hollis (Legal)?"*).
4. **Build handoff** — the PM hands off to the software engineer with a **"Talk to <name> (<role>)"** button; the build plan + **Build it** live in the engineer's chat.
5. **Build it** → scaffolds + commits a source tree under `~/bridge-projects/<slug>/`.
6. **Run it** (needs `colima start`) → install/build/test in a sandbox, fix loop on failure. A failure shows a clean diagnosis (e.g. environment vs code).
7. **Docs** — Explorer shows `PRD.md` (seeded then expanded), `milestones.md` (no week timing), loose top-level docs (no "Notes"/"Plans" folder), and **Roles** with each charter carrying a `## Plan` section.

## Notes

- The fast-path script and the manual prefilled text are kept **in sync** with the same three presets.
- The script needs the server reachable on `:4317`; it prints a clear error and exits if not.
