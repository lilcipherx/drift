---
name: drift-intent
description: Commit changes as Drift intents (semantic versioning layer on git) and trace why code exists. Use when the repository has a .drift/ directory and the drift CLI is available.
---

# Drift intents

Use the `drift` CLI instead of a bare `git commit` whenever the repository has
a `.drift/` directory (check with `ls .drift` or `drift doctor`).

## realize — commit with intent

```bash
drift realize -p "<prompt: what and why>" --agent --model <model>
```

- Broken syntax is rejected before any commit (exit 2): fix the code, retry.
- Secrets in prompts are redacted automatically; never paste keys anyway.

## blame / context — trace intent

```bash
drift blame src/auth.ts --function refreshToken
drift context src/auth.ts
```

## verify / replay

```bash
drift verify <intent-id>
drift replay --checkout
```
