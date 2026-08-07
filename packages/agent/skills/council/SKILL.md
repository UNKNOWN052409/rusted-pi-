---
name: council
description: Pressure-test a decision, plan, or design through an independent multi-advisor council with anonymous peer review and a synthesized verdict. Use when the user says "council this", "war room this", "debate this", or asks "which option" with real tradeoffs.
---

# Council Session

Use this skill when a decision has stakes, multiple options, and real tradeoffs.
Do NOT use it for factual lookups or simple yes/no questions.

## Steps

1. **Frame the question** as a single, concrete sentence with the decision and
   the alternatives. Include the real constraints (effort level, resources,
   timeline).
2. **Assemble the panel** — at minimum these five advisors, each reasoning
   independently (never sharing notes during the first pass):
   - skeptic (adversarial: find every hole)
   - architect (structure, dependencies, failure modes)
   - user (experience, clarity, cost)
   - security (trust boundaries, injection surface, unsafe defaults)
   - pragmatist (narrowest viable version, shipping)
3. **Run the council** (use the council module / tool if available, otherwise
   emulate the process manually). Collect each advisor's stance and confidence.
4. **Anonymous peer review**: each advisor critiques the others' opinions.
   Record the top concern raised.
5. **Synthesize the verdict**: summary, confidence 0-10, and the strongest
   concern. Be brutally honest — if the council disagrees with the user's
   initial preference, say so directly.

## Output format

```markdown
## Verdict
<2-3 sentence synthesis>

## Advisor opinions
| advisor | stance | confidence | title |
|---|---|---|---|
| ... | agree/disagree/mixed | 0-10 | ... |

## Top concern
<the strongest dissent>

## Action
<what to do next, with the narrowest wedge first>
```
