#!/bin/bash
# Backs up the working tree (tracked changes and new files, .gitignore respected) as a commit on
# claude/fervent-newton-263lz3-wip05, without touching HEAD, the index or the files: agents keep
# seeing their work as uncommitted changes against 99dbdee. Each snapshot's parent is the previous one, so the
# push is a fast-forward. The plan files that exist only in the scratchpad (plan05 and plan06 without its frozen tree: the contracts, the workflow
# scripts, the hand-offs, the tools, the patches; text files under 400 KB) ride along under _session/plan05/ in
# the snapshot tree only, never in the working tree or the real index.  Usage: snapshot.sh "what the snapshot holds"
set -euo pipefail
cd /home/user/claude
SCR=/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad
BRANCH=claude/pigment-photocraft-wip
IDX=$(mktemp "$SCR/wip-index.XXXXXX")
trap 'rm -f "$IDX"' EXIT
cp .git/index "$IDX"
GIT_INDEX_FILE="$IDX" git add -A
(cd "$SCR" && find planpc photocraft-eval -type f -size -400k \( -name '*.md' -o -name '*.js' \
    -o -name '*.mjs' -o -name '*.py' -o -name '*.sh' -o -name '*.json' -o -name '*.patch' -o -name '*.txt' \) -print0) |
  while IFS= read -r -d '' f; do
    printf '100644 %s\t%s\0' "$(git hash-object -w "$SCR/$f")" "_session/$f"
  done | GIT_INDEX_FILE="$IDX" git update-index -z --add --index-info
tree=$(GIT_INDEX_FILE="$IDX" git write-tree)
parent=$(git rev-parse -q --verify "refs/remotes/origin/$BRANCH" || git rev-parse HEAD)
if [[ "$(git rev-parse "$parent^{tree}")" == "$tree" ]]; then echo "no change since the last snapshot ($parent)"; exit 0; fi
msg="Pigment on PhotoCraft (backup snapshot: ${1:-work in progress}) [skip ci]

Working-tree backup of the PhotoCraft-based Pigment work, taken while agents work;
the branch claude/pigment-photocraft gets the verified commits.
_session/ holds the round's plan files, which live outside the repository.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012irzNNBVSJyVqHJpCPbdwm"
commit=$(git commit-tree "$tree" -p "$parent" -m "$msg")
for i in 1 2 3 4; do
  if git push -q origin "$commit:refs/heads/$BRANCH"; then git update-ref "refs/remotes/origin/$BRANCH" "$commit"; echo "pushed $commit to $BRANCH"; exit 0; fi
  sleep $((2 ** i))
done
echo "push failed" >&2
exit 1
