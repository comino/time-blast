#!/bin/sh
# Merge a PR only when `bx merge-check` passes for its head: on top of origin/main, a passing gate record for that
# tree, and the red requirement. The merge is pinned to that head, so a later push can't slip in.
set -eu
pr=${1:?usage: scripts/merge.sh PR}
sha=$(gh pr view "$pr" --json headRefOid -q .headRefOid)
git fetch -q origin "pull/$pr/head"
bx merge-check "$sha"
gh pr merge "$pr" --squash --match-head-commit "$sha"
