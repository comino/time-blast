# CLAUDE.md — time-blast

The project rules and vision are shared with other agents and live in these files:

@AGENTS.md
@docs/vision.md

Before proposing work, check it against the vision: does it shrink thought → result, keep the
protocol uniform across placements, and come with a concrete, measurable reason? Don't ask the
user whether the model should write SQL, whether data should be generic, or whether micro-
optimization is worth it. Those questions are settled.

## Release path
No test environment. A change is done when it is merged to `main` with the gate green and shown
working in a throwaway dev server or preview. The public demo is Sven's live install: only he
deploys it ([deploy/README.md](deploy/README.md)).
Merge with `scripts/merge.sh <PR>` only: it runs `bx merge-check` on the PR head and merges that head.

## What is live
`curl -s https://time-blast.46-224-133-201.sslip.io/ | shasum -a 256` names the static release:
match it against the index SHA-256 values in [deploy/README.md](deploy/README.md).
`/api/inference/health` and `/api/database/health` report the services, model and spend.

## Required gates
`bx test` (bx profile `time-blast`): `pnpm build`, vitest, `cargo test` for the workspace,
`inference-server` and `database-server`. The expected count is its last green record.
Prompt changes also need an eval run (above).

## Exercise path
`pnpm dev` or `pnpm preview` with `tests/fake_inference.py` (no model, no cost) and the
Playwright smokes. Never point tests at the public demo's paid inference.

## Error signature
`/api/inference/health` or `/api/database/health` not 200, or `budget.costTodayUsd` reaching
`dailyBudgetUsd`.
