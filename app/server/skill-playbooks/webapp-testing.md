Test web apps end-to-end with browser automation (Playwright):

1. **Test user journeys, not pages** — sign up, do the core task, see the result. Each test should fail for exactly one user-visible reason.
2. **Selectors**: prefer role/label/text selectors (what the user sees) over CSS classes or test-ids; brittle selectors are the #1 flake source.
3. **Waits**: await conditions (element visible, network idle, URL changed) — never sleep fixed milliseconds.
4. **Cover the unhappy paths**: validation errors, empty data, slow network, double-submit, back-button.
5. **On failure**: capture a screenshot and the console/network logs; report the repro steps, not "test red".

Keep tests independent (fresh state each), and quarantine flaky tests immediately — a sometimes-red suite trains everyone to ignore it.
