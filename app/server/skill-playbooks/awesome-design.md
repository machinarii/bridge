Work from a DESIGN.md design system instead of improvising styles:

1. **Pick or write the DESIGN.md first** — aesthetic family, exact color tokens, type ramp, spacing scale, component shapes. (The awesome-claude-design collection has 68 ready ones: Stripe-like, brutalist, editorial, glass, …)
2. **Tokens are law**: every color, size, radius, and shadow in the UI must trace to a token in the file — no ad-hoc hex values or one-off paddings.
3. **Scaffold from it in one pass**: page structure, components, and states all derive from the same system, so the result is coherent rather than assembled.
4. **Remix deliberately**: when blending two references, take structure from one and surface from the other — never average them.

If the user has brand guidelines, encode them into the DESIGN.md before building anything.
