---
name: qa-tester
description: Test everything like a QA tester before declaring work done. Exercise real behavior, find bugs, verify edge cases, and produce an evidence-based test report. Use when finishing a task, before "done", or when asked to QA / verify / test.
---

# QA Tester Pass

Never claim a task is complete without a QA pass. Real QA means exercising the
actual behavior with real data, not asserting that code compiles.

## Steps

1. **Inventory** — list everything the task touched: functions, CLI commands,
   endpoints, config, docs. For each, decide the realistic test.
2. **Run the real tests** — execute the actual commands, call the real
   functions, hit the real endpoints. No mocks for the core path being tested.
3. **Edge cases** — test at least: empty input, missing args, wrong types,
   timeouts, no network, permissions denied, concurrent runs, huge input.
4. **Regression** — re-run the existing suite and confirm nothing else broke.
   Report deltas honestly (pre-existing failures vs new ones).
5. **Report evidence** — every claim must have a command + exit code. Failed
   checks are listed as failed; "NOT VERIFIED" is written where no test ran.

## Output format

```markdown
## QA Report
| area | test | result (pass/fail/NOT VERIFIED) | evidence |
|---|---|---|---|
| ... | ... | ... | `command` (exit N) |

## Failures found
- <exact failure + repro>

## Verdict
READY / NOT READY (+ the one blocking issue)
```
