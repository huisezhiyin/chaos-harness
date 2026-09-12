# Managed runtime v1

Opt-in evaluation runner for the next newly admitted batch. Does not modify or
replay basic-coding-v1/v2 or the frozen shared Harness. No catalog, provider
profile, admission, or live command is created here.

Use `run.mts` with a new suite implementing the basic-v2 suite interface. Its
identity must include these source files and the native binary (`nativeHost`);
qualify and admit only after selecting this runner. `runTask` wraps the suite's
prompt and grade with the strict candidate-scratch contract. Use this module's
`readiness.mjs` / `workdir.mjs` for preparation checks too. All existing single-use
admission and serial stop-on-failure rules remain required.

- `prepareRuntime`: requires disjoint physical, owned workspace/cache roots;
  prepares owner-managed Host tmp and Node compilation cache plus task scratch.
- `verifyManagedProfile`: adds exactly one shell-environment plugin alongside
  the observation plugin, validates the actual resolved plugin/origin list,
  then applies all existing provider/MCP isolation checks. Does not set permission
  overrides or disable managed policy.
- Host `TMPDIR/TMP/TEMP`: `<run-cache>/managed-runtime/host-tmp`.
- Shell tool `TMPDIR/TMP/TEMP`: `<task>/test/.chaos-tmp`.
- Host and tools `NODE_COMPILE_CACHE`: owner runtime cache, outside artifacts.
- Candidate scratch must be empty. No empty-opencode exception, wildcard ignore,
  or automatic candidate cleanup. Existing cache settings and immutable dependency
  validation remain. Runtime caches are retained privately with the run; retention
  is owner-managed and is not assigned to the model.

Validation (no remote model):

```sh
node --test evals/managed-runtime-v1/environment.test.mjs evals/managed-runtime-v1/ava-cache.test.mjs
node --import tsx --test evals/managed-runtime-v1/host-profile.test.mts evals/managed-runtime-v1/native-host.test.mts
```

Native fixture: actual installed OpenCode, exact resolved profile validation,
local deterministic OpenAI-compatible replies, actual shell/Node compile-cache
probe. This is not an agent eval. It uses fresh profile/data/cache paths and the
normal Host execution environment; imposing an additional OS sandbox made local
external-plugin initialization wait before fixture requests. That sandbox-specific
startup gap remains outside the validated contract. AVA fixture runs twice with
network denied and writes confined to its owned fixture directory, mounts only
existing dependency files, and confirms their digest is unchanged.
