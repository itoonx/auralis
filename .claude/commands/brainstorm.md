---
description: Multi-model panel brainstorms a topic until it converges, then learns the brief into the brain
argument-hint: <topic or design question>
allowed-tools: Bash(pnpm brainstorm:*)
---

Run a multi-model brainstorm on: **$ARGUMENTS**

Spin up the configured panel (see `auralis.config.json` → `runners.brainstorm`, or set
`AURALIS_BRAINSTORM_PANEL="gpt:gpt-5.5,glm:glm-4-plus,claude"`). Each model proposes independently, then
they critique and revise across rounds until the votes stabilize; a synthesizer writes the decision brief
and it is learned into the shared brain (recallable by every future session and fleet worker).

```bash
pnpm brainstorm "$ARGUMENTS"
```

Report the synthesis to me, note which models were on the panel and how it converged, and confirm the
brief was saved to the brain.
