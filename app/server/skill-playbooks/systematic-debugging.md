Four phases, no skipping — works for code and hardware bring-up alike:

1. **Reproduce** — get a minimal, reliable repro before touching anything. If it won't reproduce, instrument until it does.
2. **Isolate** — bisect the failure: halve the input, the code path, the signal chain, or the time window until the fault is cornered. Change ONE variable at a time.
3. **Hypothesize & test** — state the root-cause hypothesis explicitly, predict what evidence would confirm or kill it, then check. A fix you can't explain is a coincidence, not a fix.
4. **Fix & verify** — fix the root cause (not the symptom), re-run the original repro, and check for the same bug class elsewhere.

Never stack speculative fixes; if two changes went in and the bug vanished, back one out to learn which mattered.
