Designer's-eye QA on shipped UI: find what looks off, then fix it with evidence. Audit first, fix in priority order, prove each fix.

**Audit pass — hunt for these, by frequency:**
1. **Inconsistency** — colors/radii/shadows/spacing that don't trace to a token; the same element styled two ways across screens.
2. **Spacing & alignment** — off-grid padding, uneven gaps, things not aligned to a shared edge, cramped or floating elements.
3. **Hierarchy** — weak or wrong visual emphasis: the most important thing isn't the most prominent; competing focal points; flat type scale.
4. **AI-slop patterns** — generic gradients, evenly-symmetric template layouts, empty filler cards, emoji-as-icons, placeholder-grade copy, every-corner-rounded sameness.
5. **Interaction feel** — missing hover/press/focus states, no loading/empty/error states, janky or gratuitous animation, sluggish (>100ms) feedback.

**Fix loop (one concern at a time):**
- Capture the **before** (screenshot / current values), make the smallest change that resolves it, capture the **after**.
- Commit each fix **atomically** with a one-line rationale — never a giant "design pass" blob — so each change is reviewable and revertible.
- Re-check the fix didn't shift neighbors; verify at the real breakpoints and in dark mode.

**Bar:** every visual value traces to the design system, hierarchy reads in a 3-second squint test, and interactions respond within ~100ms. Show before/after, don't assert "polished." Source: github.com/garrytan/gstack
