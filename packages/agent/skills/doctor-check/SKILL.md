---
name: doctor-check
description: Run the self-healing doctor: diagnose the current state of the codebase / agent, apply safe automated fixes, and record trust-ledger outcomes. Use when the user asks to "doctor this", "self-heal", "diagnose", or when a task fails and needs auto-repair.
---

# Doctor / Self-Healing Check

Use this skill when something broke, a check failed, or the user asks for a
self-healing pass. The goal is to diagnose first, fix only when trust allows,
and be brutally honest about what could NOT be fixed.

## Steps

1. **Diagnose** — run the checks that matter for this repo:
   - type check / lint / tests (whatever `npm run check` runs here)
   - scan for unfinished marker comments (`FIXME` and similar), empty `catch {}`, `any`, `debugger`
   - look for unfinished branches, stand-in-only paths, or empty implementations
2. **Classify findings** — for each issue:
   - `ok` — nothing wrong
   - `flaw` — real problem found
   - `fixable` — safe, low-risk repair
3. **Trust gate** — only auto-apply fixes when the coder's trust score is at or
   above the configured gate (default 50). If trust is below the gate, report
   the flaw and do NOT edit.
4. **Fix** — apply the narrowest possible edit for each fixable issue. After
   each fix, re-run the failing check to prove the fix (real verification, not
   assumptions).
5. **Record outcomes** — correct fixes earn +1 trust; failed or wrong fixes
   cost -100. Update the ledger.
6. **Report** — summarize what was fixed and what remains. Remaining issues are
   listed plainly; never claim a clean bill of health when issues remain.

## Output format

```markdown
## Diagnosis
| check | result | notes |
|---|---|---|
| typecheck | ok/flaw | ... |

## Fixes applied
- <file>: <what changed> (verified by <command>)

## Remaining
- <unfixed issues, honest>

## Trust
coder: <score>/100 (gate <gate>)
```
