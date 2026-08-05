# Drift — Intent-Driven Versioning

You are working in a repository that uses **Drift**: a semantic version-control
layer on top of Git. Every commit is an *intent* — the prompt that produced it,
the model behind it, an AST-level delta, and a cryptographic signature.

Point Drift at this repository by exporting `DRIFT_REPO` (defaults to the
current directory when unset).

## Workflow

1. **Ground yourself before editing** — instead of guessing why a file looks
   the way it does:

   ```bash
   drift context <file>          # last intents that touched the file
   drift blame <file> --function <name>   # the prompt that created a symbol
   ```

2. **Commit as an intent, not a bare commit** — never use plain `git commit`
   when a `.drift/` directory exists:

   ```bash
   drift realize -p "<what you changed and why>" --agent --model <your-model>
   ```

   The syntax gate rejects broken code before anything enters history (exit 2) —
   fix the code and retry. Secrets are redacted from the prompt automatically;
   never paste keys or tokens into a prompt anyway.

3. **Verify and resume**:

   ```bash
   drift verify <intent-id>      # re-run the recorded verification command
   drift replay --checkout       # restore the last checkpointed agent state
   ```

4. **Health check** when something looks off:

   ```bash
   drift doctor
   ```
