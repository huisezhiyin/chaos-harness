# Real mixed batch v2: cache isolation and verifier failures

Implementation repair only: no v2 model targets or admissions have been created, and no provider has been started. Historical v1 tasks/results/caches remain frozen.

Three bounded issues in independent repositories: yargs-parser #385, async-mutex #90,
fast-json-stringify #684. This is a local engineering evaluation, not a benchmark
claim about other languages or large projects. Source pins and allowed files are in
`catalog.json`; public requirements are in `suite.mjs`. Owner probes and qualification
repairs/mutants must never be copied into model targets.

From the Harness workspace:

```sh
node bin/chaos-real-mixed-batch-v2-cache.mjs report
node bin/chaos-real-mixed-batch-v2-cache.mjs preflight
```

`report` is read-only and does not load credentials. `preflight` verifies the complete
batch admission, every pending artifact, toolchain and dependency fingerprints, and
does not load credentials or start a Host.

The preparation sequence is `bootstrap`, `qualify`, `prepare`. These are model-free.
Bootstrap only creates absent independent targets; an incomplete existing target is
preserved for inspection. Qualification uses disposable source copies and explicit task-local caches. The positive control first runs package commands with the live environment (network denied, dependencies remain writable as in live), then independent sandboxed verification (writes limited to scratch and `/dev/null`). Full dependency hashes must remain unchanged. It requires expected baseline failures,
healthy controls, a passing repair, and behavior-rejected (not compile-broken) mutants.
All original upstream tests are retained. Yarn 1.22.22 is pinned in the private tool
directory. Node 22 test subprocesses use `--no-experimental-strip-types` so upstream
ts-node handles TypeScript tests. Generated output is rebuilt from Git-visible source.
Fast-json-stringify's self-package import resolves to the current candidate copy,
not to the dependency staging directory. Its externally generated npm lock is private
and hash-bound; no lock or dependency declaration was added to its upstream source.

After explicit authorization for new provider Missions, the live entry is:

```sh
node bin/chaos-real-mixed-batch-v2-cache.mjs run-all
```

This uses personal Qwen direct access and serially executes the three admitted tasks.
Each task retains v10's work/controller limits, a shared 900-second deadline, a final
180-second closure window, and the 30-second independent verification limit. No core
runtime changes are required. The runner adds the pinned Yarn path to Host/tool PATH.

The batch preflights all pending tasks before dispatch, refuses concurrent runs,
claims each task once before loading a profile, and pauses on the first non-success.
Do not remove `run.started.json`, overwrite results, reset targets, or change old
admissions. After reviewing a stopped batch, an explicit
`run-all --continue-unrun` only visits unconsumed tasks; it never retries a consumed
task. A process killed while holding `execution.lock` leaves the lock for inspection;
there is no automatic stale-lock removal.

Both paths use `commandEnvironment` with `CACHE_DIR` and `NYC_CACHE_DIR`; NYC caching must be exercised by the Semaphore positive control in both environments. No dependency subtree is excluded from production integrity checks.

Verifier environment exceptions and timeouts stop after one Attempt without code-repair recovery. Allowlisted codes persist in the journal and survive normal Host cleanup. Ordinary test failures retain bounded recovery. New reports mark artifact acceptance unknown when the verifier is unavailable, while retaining the raw Mission outcome. Post-grade exceptions preserve their code rather than becoming an undifferentiated interruption.

Results retain raw Mission outcome, independent artifact acceptance, final artifact
digest, observed actions, attempts, timings, failures and claim `unreviewed`.
Execution duration and post-exit verification duration are separate. Post-exit
artifact acceptance never converts an interrupted Mission into end-to-end success.
Experience observations remain unavailable unless someone actually records them.

Local checks:

```sh
node --test evals/real-mixed-batch-v2-cache/*.test.mjs
node bin/chaos-real-mixed-batch-v2-cache.mjs check-environment
node_modules/.bin/tsx evals/real-mixed-batch-v2-cache/self-check.mts
pnpm check
```

`check-environment` uses the preserved v1 bootstrap source and a separately copied dependency tree to exercise the production v2 qualification path. Only the historically proven NYC cache is omitted from that copy, whose complete tree must match the old admission before testing. It never regrades the consumed candidate or modifies the historical dependency directory. It also proves that a real package mutation is rejected and pipefail preserves failing pipeline exit codes.

The runner self-check injects fake profile/Host ports, including a native-exec call
that checks task prompt, cwd, tool PATH and shared deadline. It never reads a credential
or launches OpenCode. Native parsing reuses v10; new classification correlates the final verifier failure with its Mission. Hard deadline, model and permission failures retain priority.

Private source archives, dependency installs, baseline snapshots, qualification
outputs and live evidence stay under the local evaluation state directory. The
business Git repository contains only reusable code, tests, docs and public pins.
