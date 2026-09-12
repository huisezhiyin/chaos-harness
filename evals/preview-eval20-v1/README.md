# Preview eval20 preparation

The catalog is a frozen selection record; use `cli.mjs report` for current qualification and execution state. User authorized launch on 2026-09-09 after the full qualification gate. This directory is a candidate preparation package, not a ready-to-run benchmark.

`catalog.json` records 20 task contracts, official source identities, provenance, draft delivery scopes and a serial execution order. The mix is 8 public bug tasks plus 12 owner-authored maintenance tasks (4 feature / 4 refactor / 4 tests), across five repositories. These JavaScript/TypeScript libraries are an initial ordinary-coding sample; they do not establish cross-language, full application, external benchmark or comparative performance.

The 16 implementation tasks require both implementation changes and a new regression-test file. The four feature tasks also require public API/type documentation. This supplies cross-file work; it must not be described as broad cross-module application coverage. Existing tests, manifests and locks remain protected. Draft scopes still need executable boundary qualification before use.

## Provider-free commands

Run from the harness repository root, in this order:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 evals/preview-eval20-v1/prepare-sources.py
PYTHONDONTWRITEBYTECODE=1 python3 evals/preview-eval20-v1/prepare-environments.py
PYTHONDONTWRITEBYTECODE=1 python3 evals/preview-eval20-v1/check-bug-references.py
PYTHONDONTWRITEBYTECODE=1 python3 evals/preview-eval20-v1/status.py
```

Source/environment preparation reuses complete, unchanged records and refuses partial directories. Bug reference screening creates fresh logs and records; pass one or more task slugs to check only selected candidates. No command creates an admission or contacts a model. Installing public dependencies may use the network; test execution denies network and writes outside disposable copies. Installation does not run package lifecycle scripts.

Original package checks include `npm test`; fast-uri also runs lint and TypeScript checks. Browser tests and other operating systems are not covered. Source archives are checked against every official Git blob. Original source trees, private locked dependencies, reference source changes and append-only check logs live outside Git under the batch's local state directory. The report contains only relative evidence locations and SHA-256 digests.

`runtime.mts` delegates setup to the actual product `packages/preview/cli.mts`. Its local fixture test checks that the evaluator's verifier and budgets reach the bridge and that product-managed Host scratch is used. This is not a live end-to-end result or a substitute for task acceptance.

## Remaining before launch

1. Implement and check references/probes for the 12 owner-authored tasks. Features must fail on the baseline; refactors must have meaningful structural and compatibility checks; test-only tasks must fail for missing new tests and their new tests alone must reject relevant defects.
2. For all 20 tasks, prove correct-reference full-suite pass, independent mutant rejection and delivery-boundary rejection. A process/tool failure must never count as a reproduced code defect.
3. Bind compiler, native Host, runtime, grader, dependencies, source and contracts; freeze the qualified batch and single-use admissions. Revalidate when one of these changes.
4. After user direction to start, run the catalog order serially in groups of four, stop on the first non-success, preserve every attempt, and never automatically retry or skip a failed task.

## Qualified execution commands

Run with `node --import tsx evals/preview-eval20-v1/cli.mjs <command>`:

- `qualify`: local checks plus all 20 reference deliveries, full package suites, types/structure contracts and 41 negative controls; freeze only on complete success.
- `prepare`: import detached target repositories and issue identity-bound admissions. No branch or worktree is created.
- `preflight`: check all pending admissions before any provider configuration is loaded.
- `run-all`: single-use serial execution, stop at first non-success; no automatic retry or skip of failures.
- `report`: read current qualification and saved execution results.

Execution reuses the product preview entry. Controlled eval environment disables the tsx cache, sets CI and disables Node experimental type stripping. fast-uri resolves TypeScript from its locked dependencies and uses a private TSTyche store. The exact settings are part of the runtime identity. Existing package checks may rebuild p-queue's ignored dist directory; this directory is excluded from delivered artifacts, checked for links, and rebuilt independently during grading.

A task has a 900-second execution deadline including a 180-second closure window, using the existing action/turn budgets. Post-exit independent verification has up to 240 seconds. Candidate tests run in disposable copies; source changes during verification fail acceptance. Test-only deliveries must themselves reject the registered mutants. Readiness is a cheap delivery-boundary check and does not replace final grading.

`status.py` remains read-only. If a qualification exists, it also includes identity-checked execution state from the CLI. No report command creates admissions or contacts a provider.
