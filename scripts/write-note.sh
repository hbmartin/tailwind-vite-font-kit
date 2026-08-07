#!/usr/bin/env bash
# Attach a metrics JSON blob to the current commit as a git note, and push it.
#
#   ./scripts/write-note.sh metrics.json [more.json ...]
#
# Notes live on refs/notes/metrics. Read them with:
#   git fetch origin 'refs/notes/*:refs/notes/*'
#   git log --notes=metrics
#   git notes --ref=metrics show <sha>
#
# Concurrent runs race on the same ref, so this fetches and retries. Notes are merged
# by concatenating the existing note with the new blob, so the weekly CLS job can
# append to a note the CI job already wrote for that commit instead of clobbering it.
set -euo pipefail

REF=refs/notes/metrics
SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
TRIES=5

# CI checks out with `persist-credentials: false`, so the token is not in .git/config and
# the two remote commands below have to carry it themselves. It goes through `-c
# http.<host>.extraheader` rather than a credential in the remote URL, which would be
# visible in `ps` to everything else on the runner and would land back in .git/config.
# Unset locally, where ambient credentials already work — hence the wrapper, not a flag.
if [ -n "${GITHUB_TOKEN:-}" ]; then
  _host="${GITHUB_SERVER_URL:-https://github.com}"
  _hdr="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"
  git_remote() { git -c "http.${_host}/.extraheader=${_hdr}" "$@"; }
else
  git_remote() { git "$@"; }
fi

git config user.name  "${GIT_AUTHOR_NAME:-github-actions[bot]}"
git config user.email "${GIT_AUTHOR_EMAIL:-github-actions[bot]@users.noreply.github.com}"

body="$(cat "$@")"

for i in $(seq 1 "$TRIES"); do
  # Always start from the remote state; another job may have written since checkout.
  git_remote fetch -q origin "+$REF:$REF" 2>/dev/null || true

  if git notes --ref=metrics show "$SHA" >/dev/null 2>&1; then
    existing="$(git notes --ref=metrics show "$SHA")"
    printf '%s\n%s\n' "$existing" "$body" | git notes --ref=metrics add -f -F - "$SHA"
  else
    printf '%s\n' "$body" | git notes --ref=metrics add -F - "$SHA"
  fi

  if git_remote push -q origin "$REF"; then
    echo "wrote note on $SHA (attempt $i)"
    exit 0
  fi

  echo "note push rejected (attempt $i/$TRIES) — refetching and retrying"
  # Drop the local ref so the next fetch is authoritative.
  git update-ref -d "$REF" || true
  sleep $((i * 2))
done

# A failed note must not fail the build — the metrics are also in the job summary.
echo "::warning::could not push $REF after $TRIES attempts; metrics are in the job summary only"
exit 0
