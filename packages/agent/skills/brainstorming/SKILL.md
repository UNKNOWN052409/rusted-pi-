---
name: brainstorming
description: Run a structured brainstorming / ideation session for features, products, or approaches before implementation. Use when the user asks to brainstorm, ideate, explore options, or wants creative alternatives to a problem.
---

# Brainstorming Session

Use this skill whenever the task is open-ended ideation: new features, product
directions, alternative approaches, or "give me options". Do NOT jump into
implementation before this session completes.

## Steps

1. **Restate the problem** in one sentence. Confirm what problem we are solving,
   not what solution the user already assumed.
2. **Generate at least 5 divergent ideas**. Do not filter or judge during
   generation. Cover at least one wild/ambitious idea, one minimal/simple idea,
   one low-resource idea, and one that flips the default assumption.
3. **Pressure-test each idea** against real constraints:
   - Effort (low / minimum / high / xhigh)
   - Resources (CPU/GPU/network/tokens)
   - User value vs complexity (avoid gold-plating)
   - Risk of "AI slop" — generic, ungrounded output
4. **Search the web for latest data** relevant to the problem before finalizing
   recommendations, and cite what you found. Never recommend based on stale
   assumptions.
5. **Pick a recommendation**: the narrowest wedge that delivers real value.
   State what you are deliberately NOT doing.

## Output format

```markdown
## Problem
<one sentence>

## Ideas
1. <idea> — <one-line why it works>
...

## Evidence
- <latest-data finding with source>

## Recommendation
<chosen idea + why + what is explicitly out of scope>
```
