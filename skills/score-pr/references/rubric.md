# Risk rubric

Pick the band, then place the point inside it. Go toward the top of a band when tests around the change
are thin, the change is new territory for the codebase, it involves concurrency or time, or the safety fact
is unproven. Go toward the bottom when the change is mechanical and its tests would catch a mistake.

## Blast radius (0-60): who notices when it is wrong

| Points | Word | The change can break |
|---|---|---|
| 0-5 | cosmetic | nothing that runs: docs, comments, formatting, test-only changes |
| 6-20 | component | one component, screen, function or job, and only what calls it inside the same feature |
| 21-35 | module | one module's or app's internals; no contract another module or app depends on |
| 36-45 | cross-module | several modules or apps, a shared library, shared configuration, the build or CI every change goes through |
| 46-60 | contract / data / auth | consumers outside the repo (public API, wire formats, files other systems read), stored data, authentication or authorization, every user at once |

Use the word as the PR's **Blast Radius** line. A profile may name better words for its repo.

## Door (0-40): what it costs to walk back

| Points | Door | After a revert and redeploy |
|---|---|---|
| 0 | two-way | everything is as it was; no data was written in a new shape, nobody adapted |
| 5-15 | two-way, costly | everything is as it was, but only after coordination: regenerated clients, several units redeployed, caches cleared, a job re-run, users told |
| 20-30 | one-way, recoverable | something outlives the revert but can be repaired: data written in a new shape with a way back, a published contract others may already use, a notification sent |
| 31-40 | one-way, destructive | nothing brings it back: data dropped or overwritten, keys or hashes changed so issued credentials stop matching, side effects in external systems, deletions |

## Calibration

| Change | Radius | Door | Bounds | Score | Tier |
|---|---|---|---|---|---|
| Typo in a README | cosmetic 0 | 0 | cap 10 | 0 | trivial |
| Button label plus its translations | component 10 | 0 | | 10 | trivial |
| Unit tests for an existing parser | cosmetic 3 | 0 | cap 20 | 3 | trivial |
| Bug fix inside one module's service, with a test | module 24 | 0 | | 24 | low |
| New read-only endpoint plus regenerated clients | module 28 | costly 10 | floor 40 | 40 | medium |
| Patch upgrade of a framework in every frontend | cross-module 40 | costly 8 | floor 25 | 48 | medium |
| Remove a route external callers may still use | contract 52 | recoverable 25 | floor 55 | 77 | high |
| Store an identifier in a new canonical form everywhere | data 55 | recoverable 25 | | 80 | high |
| Migration that drops a column after copying its data | data 56 | destructive 40 | floor 75 | 96 | critical |

## Traps

- **Big is not dangerous.** A 3,000-line generated-client refresh can be two-way and mechanical; a
  one-line default change in an auth handler is not.
- **Deletion is not automatically safe.** Removing code is two-way only if nothing outside the repo
  called it and no data depended on it.
- **"Behind a flag" counts only if the flag is off in production** and turning it on is the reversible step.
- **Not live yet lowers the radius**, because nobody notices, but a migration is still applied to the
  shared database, so it does not lower the door.
