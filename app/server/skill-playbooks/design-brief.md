Before touching pixels, resolve a vague request into an explicit **DESIGN.md** — ambiguity ("make it clean / professional") is where design goes wrong.

**Pin all 8 dimensions, each with a concrete value (no adjectives left undefined):**
1. **Palette** — base, surface, and accent as named tokens (e.g. `navy / off-white / coral`), plus state colors. Resolve light AND dark.
2. **Typography** — a display/heading font + a body font (a real pairing), and a type scale.
3. **Layout** — model (single-column / sidebar / grid), max content width, and section rhythm.
4. **Mood** — the emotional target in 2–3 words, with one or two reference products it should feel like.
5. **Density** — spacious vs compact, expressed as a spacing scale (4/8px) and section gaps.
6. **Depth / elevation** — flat, soft-shadow, or layered; one shadow/border scale used consistently.
7. **Component style** — corner radius, border treatment, button/input shape — one shape language.
8. **Constraints & anti-patterns** — dos and don'ts: name the things to avoid (generic AI gradients, empty cards, template symmetry, emoji-as-icon, vague copy).

**Output:** write the resolved spec to `DESIGN.md` so every downstream skill (and component) builds from the same source of truth. When a dimension is genuinely open, present a small recommended-default choice instead of asking an open question, then continue.

Treat this as the contract: if it isn't decided here, it shouldn't be improvised later. Source: github.com/nexu-io/open-design
