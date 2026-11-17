#!/bin/bash
# Backs up the working tree (tracked changes and new files, .gitignore respected) as a commit on
# claude/pigment-photocraft-wip, without touching HEAD, the index or the files. Each snapshot's
# parent is the previous one, so the push is a fast-forward. The scratchpad's plan files (planpc
# and photocraft-eval, every file under 2 MB) ride along under _session/ in the snapshot tree only.
#
# A container can be reclaimed at any time (a usage-limit stop is enough): this snapshot and the
# pushed branch are all that survive. The message records the commit the tree was based on
# ("Base: <sha>"), so the unfinished work can be put back with
#   git diff --binary <base> origin/claude/pigment-photocraft-wip -- . ':(exclude)_session' | git apply --3way
# Usage: snapshot.sh "what the snapshot holds"
set -euo pipefail
cd /home/user/claude
SCR=/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad
BRANCH=claude/pigment-photocraft-wip
IDX=$(mktemp "$SCR/wip-index.XXXXXX")
trap 'rm -f "$IDX"' EXIT
cp .git/index "$IDX"
GIT_INDEX_FILE="$IDX" git add -A
(cd "$SCR" && find planpc photocraft-eval -type f -size -2000k ! -name 'wip-index.*' ! -name '*.log' -print0 2>/dev/null) |
  while IFS= read -r -d '' f; do
    printf '100644 %s\t%s\0' "$(git hash-object -w "$SCR/$f")" "_session/$f"
  done | GIT_INDEX_FILE="$IDX" git update-index -z --add --index-info
tree=$(GIT_INDEX_FILE="$IDX" git write-tree)
git fetch -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" 2>/dev/null || true
parent=$(git rev-parse -q --verify "refs/remotes/origin/$BRANCH" || git rev-parse HEAD)
if [[ "$(git rev-parse "$parent^{tree}")" == "$tree" ]]; then echo "no change since the last snapshot ($parent)"; exit 0; fi
msg="Pigment on PhotoCraft (backup snapshot: ${1:-work in progress}) [skip ci]

Working-tree backup of the PhotoCraft-based Pigment work, taken while agents work;
the branch claude/pigment-photocraft gets the verified commits.
_session/ holds the plan files, which live outside the repository.

Base: $(git rev-parse HEAD)

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012irzNNBVSJyVqHJpCPbdwm"
commit=$(git commit-tree "$tree" -p "$parent" -m "$msg")
for i in 1 2 3 4; do
  if git push -q origin "$commit:refs/heads/$BRANCH"; then git update-ref "refs/remotes/origin/$BRANCH" "$commit"; echo "pushed $commit to $BRANCH"; exit 0; fi
  sleep $((2 ** i))
done
echo "push failed" >&2
exit 1
