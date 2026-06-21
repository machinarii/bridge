Build interfaces to WCAG 2.2 — accessibility is a baseline, not a polish pass. Anchor on **POUR**: Perceivable, Operable, Understandable, Robust.

**Method, per component:**
1. **Role** — use the native semantic element (`<button>`, `<a>`, `<nav>`, `<input>`, headings) before reaching for a `<div>` + ARIA. Native elements bring focus, keyboard, and role for free.
2. **Perceivable** — meaningful `alt`/labels; text contrast ≥ 4.5:1 (3:1 large/UI glyphs); never convey meaning by color alone (add icon/text); support text scaling without clipping.
3. **Operable** — everything reachable and usable by keyboard in a logical tab order; visible focus rings; ≥44×44pt targets; respect `prefers-reduced-motion`; provide escape/cancel in modals and skip-links.
4. **Understandable** — labels tied to inputs (`<label for>`); errors stated near the field with cause + fix; predictable, consistent navigation.
5. **Robust** — name/role/state exposed to the accessibility tree (`aria-label`, `aria-expanded`, `role`, `aria-live` for async updates); verify with a screen reader, not just by eye.

**Anti-patterns to flag:** div/span "buttons" without role + keyboard handler; placeholder used as the only label; focus traps or focus that doesn't move to opened dialogs/route changes; color-only error/status; removed focus outlines; icon-only controls with no accessible name.

**As a review:** walk the POUR checklist, list violations by impact (blocker → minor) with the specific element and the fix. Source: github.com/affaan-m/ECC
