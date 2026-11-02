# Risk rubric

Pick the band on each axis and answer the factors; `scripts/score.mjs` places the points. Every band starts
a quarter of the way up. Each factor that holds moves both points 3/16 of their band higher:

- `thinTests`: tests around the change are thin, or would not fail if it were wrong;
- `newTerritory`: the change is new territory for this codebase;
- `concurrencyOrTime`: it involves concurrency, ordering, time zones or clocks;
- the safety fact is unproven (`safeBecauseProven: false`).

All four reach the top of the band. `mechanical` (a mechanical change whose tests would catch a mistake,
and `thinTests` is false) puts both points at the bottom. Answer each factor on its own; never pick answers
to reach a score.

## Blast radius (0-60): who notices when it is wrong

| Points | Word | The change can break |
|---|---|---|
| 0-5 | cosmetic | nothing that runs: docs, comments, formatting, test-only changes |
| 6-20 | component | one component, screen, function or job, and only what calls it inside the same feature |
| 21-35 | module | one module's or app's internals; no contract another module or app depends on |
| 36-45 | cross-module | several modules or apps, a shared library, shared configuration, the build or CI every change goes through |
| 46-60 | contract / data / auth | consumers outside the repo (public API, wire formats, files other systems read), stored data, authentication or authorization, every user at once |

Answer `radius` with the id: `cosmetic`, `component`, `module`, `cross-module`, `contract-data-auth`. Use the
word as the PR's **Blast Radius** line; a profile may name a better word for its repo (`radiusWord`).

## Door (0-40): what it costs to walk back

| Points | Door | After a revert and redeploy |
|---|---|---|
| 0 | two-way | everything is as it was; no data was written in a new shape, nobody adapted |
| 5-15 | two-way, costly | everything is as it was, but only after coordination: regenerated clients, several units redeployed, caches cleared, a job re-run, users told |
| 20-30 | one-way, recoverable | something outlives the revert but can be repaired: data written in a new shape with a way back, a published contract others may already use, a notification sent |
| 31-40 | one-way, destructive | nothing brings it back: data dropped or overwritten, keys or hashes changed so issued credentials stop matching, side effects in external systems, deletions |

Answer `door` with the id: `two-way`, `costly`, `recoverable`, `destructive`.

## Calibration

Computed by `score.mjs` from the answers shown (factors that hold; "unproven" = `safeBecauseProven: false`).

| Change | Radius | Door | Factors | Bounds | Score | Tier |
|---|---|---|---|---|---|---|
| Typo in a README | cosmetic 0 | two-way 0 | mechanical | cap 10 | 0 | trivial |
| Button label plus its translations | component 6 | two-way 0 | mechanical | | 6 | trivial |
| Unit tests for an existing parser | cosmetic 1 | two-way 0 | | cap 20 | 1 | trivial |
| Bug fix inside one module's service, with a test | module 24 | two-way 0 | | | 24 | low |
| New read-only endpoint plus regenerated clients | module 27 | costly 9 | new territory | floor 40 | 40 | medium |
| Patch upgrade of a framework in every frontend | cross-module 36 | costly 5 | mechanical | floor 25 | 41 | medium |
| Remove a route external callers may still use | contract-data-auth 52 | recoverable 24 | unproven | floor 55 | 76 | high |
| Store an identifier in a new canonical form everywhere | contract-data-auth 54 | recoverable 26 | thin tests, unproven | | 80 | high |
| Migration that drops a column after copying its data | contract-data-auth 49 | destructive 33 | | floor 75 | 82 | critical |

## Traps

- **Big is not dangerous.** A 3,000-line generated-client refresh can be two-way and mechanical; a
  one-line default change in an auth handler is not.
- **Deletion is not automatically safe.** Removing code is two-way only if nothing outside the repo
  called it and no data depended on it.
- **"Behind a flag" counts only if the flag is off in production** and turning it on is the reversible step.
- **Not live yet lowers the radius**, because nobody notices, but a migration is still applied to the
  shared database, so it does not lower the door.
