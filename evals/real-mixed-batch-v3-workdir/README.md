# Real mixed batch v3: workspace temporary files

Independent follow-up for the two not-run issue tasks: async-mutex #90 and fast-json-stringify #684. The consumed yargs task is excluded. No model targets, qualification or admission have been created for this version.

The runner fixes cwd/PWD to the task root and overrides TMPDIR/TMP/TEMP to test/.chaos-tmp. The public prompt requires explicit temporary logs/reproductions to use that directory, preserving command exit codes. The directory must be physical and inside the workspace; symbolic links are rejected. Final acceptance rejects leftover entries even when Git ignores them. Temporary files cannot count as regression tests. No ignore exemptions or permission flags are added. This is a workflow convention, not a shell sandbox.

The v2 controlled cache environment is retained: tool-managed NYC/package caches remain in task-specific private state outside dependency/source trees. Models must not inspect or manually clean those caches. All old artifacts and results remain immutable. New source invalidates prior runtime admissions; do not refresh or reuse them.

Model-free checks:
```sh
node --test evals/real-mixed-batch-v3-workdir/*.test.mjs
node_modules/.bin/tsx evals/real-mixed-batch-v3-workdir/self-check.mts
```

Future live preparation requires fresh bootstrap, qualification and admission with this version; run-all remains serial and stops at the first failure. No automatic continuation or replay of an old task is authorized by this implementation change.
