#!/bin/bash
# Rebuilds what a fresh container lacks for the Pigment-on-PhotoCraft work. Safe to run again.
#
# A cloud container is reclaimed after a period of inactivity (a usage-limit stop is enough). The
# clone then comes back at its start branch, and the scratchpad, the build folder, the reference
# clones, the apt packages and the agents' transcripts are gone. What survives is what was pushed:
# the branches, and the snapshots snapshot.sh pushed to claude/pigment-photocraft-wip (the working
# tree plus the scratchpad's plan files under _session/).
#
# Before this script (it lives in the snapshot itself), restore the scratchpad:
#   cd /home/user/claude && git fetch -q origin '+refs/heads/claude/pigment-photocraft-wip:refs/remotes/origin/claude/pigment-photocraft-wip'
#   mkdir -p "$SCR" && git archive origin/claude/pigment-photocraft-wip _session | tar -x -C "$SCR" --strip-components=1
#   bash "$SCR/planpc/setup-container.sh"
set -uo pipefail
SCR=/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad
REPO=/home/user/claude
REF=/home/user/storytold
BRANCH=claude/pigment-photocraft
cd "$REPO" || exit 1

echo "== 1. branches"
git fetch -q origin \
  "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" \
  "+refs/heads/$BRANCH-wip:refs/remotes/origin/$BRANCH-wip" \
  '+refs/heads/claude/fervent-newton-263lz3:refs/remotes/origin/claude/fervent-newton-263lz3' \
  '+refs/heads/claude/fervent-newton-263lz3-wip05:refs/remotes/origin/claude/fervent-newton-263lz3-wip05' \
  '+refs/heads/claude/nib-vector-editor:refs/remotes/origin/claude/nib-vector-editor' || echo "fetch failed"
# Local names the briefs read with `git show <branch>:<path>`.
for b in claude/fervent-newton-263lz3 claude/fervent-newton-263lz3-wip05; do
  [ "$(git branch --show-current)" = "$b" ] || git branch -q -f "$b" "origin/$b"
done
if [ "$(git branch --show-current)" != "$BRANCH" ]; then
  if git rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null; then git checkout -q "$BRANCH"; else git checkout -q -b "$BRANCH" "origin/$BRANCH"; fi
fi
git branch -q --set-upstream-to="origin/$BRANCH" "$BRANCH" 2>/dev/null
echo "on $(git branch --show-current) at $(git log -1 --format='%h %ci %s' | cut -c1-100)"
echo "origin/$BRANCH at $(git log -1 --format='%h %ci' "origin/$BRANCH")"
snap=$(git log -1 --format='%h %ci %s' "origin/$BRANCH-wip" | cut -c1-120)
base=$(git log -1 --format=%B "origin/$BRANCH-wip" | sed -n 's/^Base: //p')
echo "latest snapshot: $snap${base:+ (base $base)}"
echo "snapshot vs branch head (unfinished work an agent had in the tree; STANDING.md says when to apply it):"
git diff --stat "origin/$BRANCH" "origin/$BRANCH-wip" -- . ':(exclude)_session' | tail -4

echo "== 2. Linux build libraries"
need=""
for p in libxkbcommon-dev libwayland-dev libx11-dev libxrandr-dev libxi-dev libgl1-mesa-dev libasound2-dev pkg-config libxcursor-dev libfontconfig1-dev; do
  dpkg -s "$p" >/dev/null 2>&1 || need="$need $p"
done
if [ -n "$need" ]; then
  apt-get update -qq 2>&1 | tail -1
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $need 2>&1 | tail -1
fi
for p in libxkbcommon-dev libwayland-dev libxrandr-dev libxi-dev libgl1-mesa-dev libasound2-dev libxcursor-dev libfontconfig1-dev; do
  dpkg -s "$p" >/dev/null 2>&1 || echo "MISSING $p"
done

echo "== 3. reference clones (read only)"
mkdir -p "$REF"
ref_clone() { # name url commit
  local d="$REF/$1"
  if git -C "$d" rev-parse -q --verify HEAD >/dev/null 2>&1; then echo "$1: $(git -C "$d" rev-parse --short HEAD) (already there)"; return; fi
  mkdir -p "$d" && git -C "$d" init -q && git -C "$d" remote add origin "$2" 2>/dev/null
  if GIT_LFS_SKIP_SMUDGE=1 git -C "$d" fetch -q --depth 1 origin "$3" 2>/dev/null; then
    GIT_LFS_SKIP_SMUDGE=1 git -C "$d" checkout -q FETCH_HEAD
  else
    echo "$1: commit $3 not fetchable, taking the default branch"
    GIT_LFS_SKIP_SMUDGE=1 git -C "$d" fetch -q --depth 1 origin HEAD && GIT_LFS_SKIP_SMUDGE=1 git -C "$d" checkout -q FETCH_HEAD
  fi
  echo "$1: $(git -C "$d" rev-parse --short HEAD 2>/dev/null || echo FAILED) $(du -sh "$d" | cut -f1)"
}
ref_clone photocraft https://github.com/storytold/photocraft "$(cat "$REPO/pigment/UPSTREAM-REVISION" 2>/dev/null || echo abb30dff47638eaa38a09de11b60ae8a14baa334)"
ref_clone craft-libs https://github.com/storytold/craft-libs e2dc681a3ad8a47038da2f11ddd2c5e1c0454991
ref_clone craft-ai-integrations https://github.com/storytold/craft-ai-integrations db30646d9df2ae5d36d74f3feed6dc6f00d3ef6b
ref_clone craft-i18n https://github.com/storytold/craft-i18n "$(tr -d '[:space:]' < "$REPO/pigment/craft-i18n.rev" 2>/dev/null || echo e56d26244bbac099bfd42e23fb12f78a4be418a7)"
ref_clone craft-fonts https://github.com/storytold/craft-fonts b076417b5880bd4154bd22f00695b1d28c6bea83

echo "== 4. scratch"
mkdir -p /dev/shm/pt "$SCR/pc-build" "$SCR/planpc/build"
chmod +x "$SCR/planpc/"*.sh 2>/dev/null
df -h / | tail -1
echo "done. Test runs: TMPDIR=/dev/shm/pt CRAFT_I18N_DIR=$REF/craft-i18n CRAFT_FONTS_DIR=$REF/craft-fonts; builds: CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0, -j 4."
