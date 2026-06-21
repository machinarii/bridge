Design-intelligence playbook for web/mobile UI — fix things in priority order; never decorate randomly.

**Workflow:** (1) Read the request — product type, audience, style keywords, target stack. (2) Lock a design system FIRST, before any component code: one style family, a semantic color-token set, a heading/body font pairing, a 4/8px spacing scale, and one elevation/shadow scale — then keep it consistent across every page. (3) Build to that system. (4) Review against the checklist.

**Priority order (1 = fix first):**
1. **Accessibility** — contrast ≥4.5:1, visible focus rings, alt text, aria-labels on icon-only buttons, full keyboard nav, color is never the only signal.
2. **Touch & interaction** — ≥44×44pt targets with 8px spacing, press feedback within ~100ms, loading state on async actions, don't rely on hover.
3. **Performance** — WebP/AVIF + lazy load, reserve space for async/media to avoid layout shift (CLS), virtualize 50+ item lists, `font-display: swap`.
4. **Style selection** — match the style to the product; SVG icons, never emoji-as-icon; one icon family; blur/shadow/radius consistent with the chosen style.
5. **Layout & responsive** — mobile-first with systematic breakpoints (375/768/1024/1440), 16px min body text, no horizontal scroll, never disable zoom, consistent max-width.
6. **Typography & color** — a real type scale + line-height ~1.5; semantic color tokens, not raw hex in components; design light/dark together and verify dark contrast separately.
7. **Animation** — 150–300ms, animate transform/opacity only, motion must convey meaning, honor `prefers-reduced-motion`, exit shorter than enter.
8. **Forms & feedback** — visible labels (not placeholder-only), errors below the field, validate on blur, submit/loading/success states, confirm destructive actions.
9. **Navigation** — predictable back with preserved scroll/state, bottom nav ≤5 with labels, highlight the active location, deep-linkable screens.
10. **Charts & data** — match chart type to data, always show legends + tooltips, don't encode meaning in color alone, provide a table fallback.

**Pre-delivery check:** test at 375px and in landscape, with reduced-motion on and dynamic type at max, dark-mode contrast checked independently, and all targets ≥44pt clear of safe areas.

**Power tool (optional, when a shell is available):** the source skill ships a searchable CSV database (pure Python, no deps). `python3 search.py "<product> <industry> <keywords>" --design-system` emits a full recommended system (style, palette, fonts, effects, anti-patterns); `--domain style|color|typography|ux|chart|product|landing` deep-dives one dimension; `--stack react|nextjs|vue|svelte|swiftui|flutter|...` adds stack-specific guidance. Source: github.com/nextlevelbuilder/ui-ux-pro-max-skill
