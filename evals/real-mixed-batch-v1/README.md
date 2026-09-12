# Real mixed batch v1

Three bounded issues in independent repositories: yargs-parser #385, async-mutex #90,
fast-json-stringify #684. This is a local engineering evaluation, not a benchmark
claim about other languages or large projects. Source pins and allowed files are in
`catalog.json`; public requirements are in `suite.mjs`. Owner probes and qualification
repairs/mutants must never be copied into model targets.

From the Harness workspace:

```sh
node bin/chaos-real-mixed-batch-v1.mjs report
node bin/chaos-real-mixed-batch-v1.mjs preflight
```

`report` is read-only and does not load credentials. `preflight` verifies the complete
batch admission, every pending artifact, toolchain and dependency fingerprints, and
does not load credentials or start a Host.

The preparation sequence is `bootstrap`, `qualify`, `prepare`. These are model-free.
Bootstrap only creates absent independent targets; an incomplete existing target is
preserved for inspection. Qualification uses disposable copies, with no network and
no writes outside the copy except `/dev/null`. It requires expected baseline failures,
healthy controls, a passing repair, and behavior-rejected (not compile-broken) mutants.
All original upstream tests are retained. Yarn 1.22.22 is pinned in the private tool
directory. Node 22 test subprocesses use `--no-experimental-strip-types` so upstream
ts-node handles TypeScript tests. Generated output is rebuilt from Git-visible source.
Fast-json-stringify's self-package import resolves to the current candidate copy,
not to the dependency staging directory. Its externally generated npm lock is private
and hash-bound; no lock or dependency declaration was added to its upstream source.

After explicit authorization for new provider Missions, the live entry is:

```sh
node bin/chaos-real-mixed-batch-v1.mjs run-all
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

Results retain raw Mission outcome, independent artifact acceptance, final artifact
digest, observed actions, attempts, timings, failures and claim `unreviewed`.
Execution duration and post-exit verification duration are separate. Post-exit
artifact acceptance never converts an interrupted Mission into end-to-end success.
Experience observations remain unavailable unless someone actually records them.

Local checks:

```sh
node --test evals/real-mixed-batch-v1/batch.test.mjs
node_modules/.bin/tsx evals/real-mixed-batch-v1/self-check.mts
pnpm check
```

The runner self-check injects fake profile/Host ports, including a native-exec call
that checks task prompt, cwd, tool PATH and shared deadline. It never reads a credential
or launches OpenCode. Native parsing/classification uses the unchanged v10 module.

Private source archives, dependency installs, baseline snapshots, qualification
outputs and live evidence stay under the local evaluation state directory. The
business Git repository contains only reusable code, tests, docs and public pins.
