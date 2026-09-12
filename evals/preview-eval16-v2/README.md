# Remaining sixteen tasks, v2

New identities for the sixteen unconsumed v1 tasks, in the same order. Frozen source/reference/dependency directories are reused read-only. Old task targets, raw evidence and evaluator code are never modified.

Commands: `node --import tsx evals/preview-eval16-v2/cli.mjs qualify`, then `prepare`, then `preflight`. `run-all` is a separate live dispatch; serial, stop at first non-success, no retry. `report` is read-only. Online and post-run graders each have a 240-second bound; the shared 900-second execution deadline can cancel online verification earlier.

Qualification must include the actual product entry and bridge with a local scripted model, a completion verifier lasting over 30 seconds, cancellation/child cleanup, and full graders. Catalog selected-unqualified is the immutable selection state; private qualification and admission records establish readiness. No official benchmark or superiority claim.
