#!/bin/sh
# render-versions.sh — render the engine-version catalog into the live manifests.
#
# config/versions.yaml is the single AUTHORED source for the supported EnergyPlus
# version set (ADR-0015). This script stamps the derived values into every place a
# version would otherwise be re-typed:
#
#   - engineVersion:                     -> DEFAULT (first catalog entry)
#   - image: <runner-repo>:<tag>         -> DEFAULT
#   - SP_ENGINE_VERSION                  -> DEFAULT
#   - SP_ALLOWED_ENGINE_VERSIONS         -> ALLOWED (comma-joined catalog)
#
# Usage:
#   hack/render-versions.sh            write the rendered values into the manifests
#   hack/render-versions.sh --check    exit non-zero if any manifest has drifted
#                                       (no writes) — for CI.
#
# Plain POSIX sh + awk only; no yq/sed -i required (works on BSD/macOS + GNU).
set -eu

# Resolve the repo root from this script's location (hack/ lives at the root).
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

CATALOG="$ROOT/config/versions.yaml"
RUNNER_REPO="ghcr.io/synergyplus/energyplus-runner"

CHECK=0
if [ "${1:-}" = "--check" ]; then
	CHECK=1
elif [ "${1:-}" != "" ]; then
	echo "usage: $0 [--check]" >&2
	exit 2
fi

[ -f "$CATALOG" ] || { echo "catalog not found: $CATALOG" >&2; exit 2; }

# Parse the catalog: collect every quoted/bare list item under `versions:`.
# Tolerant of "x.y.z" or x.y.z, ignores comments and blank lines.
VERSIONS=$(awk '
	/^[[:space:]]*#/ { next }
	/^versions:[[:space:]]*$/ { inlist=1; next }
	inlist && /^[^[:space:]-]/ { inlist=0 }   # a new top-level key ends the list
	inlist && /^[[:space:]]*-[[:space:]]*/ {
		v=$0
		sub(/^[[:space:]]*-[[:space:]]*/, "", v)
		sub(/[[:space:]]*#.*$/, "", v)         # strip trailing comment
		gsub(/"/, "", v); gsub(/'"'"'/, "", v) # strip quotes
		sub(/[[:space:]]+$/, "", v)
		if (v != "") print v
	}
' "$CATALOG")

[ -n "$VERSIONS" ] || { echo "no versions found in $CATALOG" >&2; exit 2; }

DEFAULT=$(printf '%s\n' "$VERSIONS" | head -n 1)
ALLOWED=$(printf '%s\n' "$VERSIONS" | paste -sd, -)

# render <file> — print <file> to stdout with version sites rewritten.
# Keyed on the YAML key / env-var name so it is robust to line-number churn.
render() {
	awk -v def="$DEFAULT" -v allowed="$ALLOWED" -v repo="$RUNNER_REPO" '
	{
		line=$0
		# leading-whitespace + key prefix, preserving indentation and trailing comments.
		if (match(line, /^[[:space:]]*engineVersion:[[:space:]]*/)) {
			pre=substr(line, 1, RLENGTH); rest=substr(line, RLENGTH+1)
			print pre "\"" def "\"" trailing(rest); next
		}
		if (match(line, /^[[:space:]]*image:[[:space:]]*/)) {
			val=substr(line, RLENGTH+1)
			if (val ~ ("^" reEsc(repo) ":")) {
				pre=substr(line, 1, RLENGTH)
				print pre repo ":" def trailing(substr(val, length(repo)+2)); next
			}
		}
		if (match(line, /^[[:space:]]*SP_ENGINE_VERSION[:=][[:space:]]*/)) {
			pre=substr(line, 1, RLENGTH); rest=substr(line, RLENGTH+1)
			sep=(line ~ /SP_ENGINE_VERSION=/) ? "=val" : ":val"
			if (sep == "=val") print pre def trailing(rest)
			else                print pre "\"" def "\"" trailing(rest)
			next
		}
		if (match(line, /^[[:space:]]*SP_ALLOWED_ENGINE_VERSIONS[:=][[:space:]]*/)) {
			pre=substr(line, 1, RLENGTH); rest=substr(line, RLENGTH+1)
			if (line ~ /SP_ALLOWED_ENGINE_VERSIONS=/) print pre allowed trailing(rest)
			else                                      print pre "\"" allowed "\"" trailing(rest)
			next
		}
		print line
	}
	# trailing() recovers an inline comment from the original value portion,
	# preserving the exact whitespace that separated the value from the "#".
	# The value we re-emit is quote/identifier-shaped with no internal spaces,
	# so the first run of whitespace in "rest" is the gap before the comment.
	function trailing(rest,   i, ws) {
		i=index(rest, "#")
		if (i == 0) return ""
		ws=substr(rest, 1, i-1)
		sub(/^[^[:space:]]*/, "", ws)   # drop any leftover value chars before the gap
		if (ws == "") ws=" "
		return ws substr(rest, i)
	}
	function reEsc(s) { gsub(/[.[\]\/*+?(){}|^$]/, "\\\\&", s); return s }
	' "$1"
}

FILES="
config/samples/runnerpool.yaml
deploy/docker-compose.yml
deploy/k8s-local/runnerpool-demo.yaml
deploy/k8s-local/secret.yaml
"

drift=0
for rel in $FILES; do
	f="$ROOT/$rel"
	[ -f "$f" ] || { echo "missing manifest: $rel" >&2; exit 2; }
	tmp=$(mktemp)
	render "$f" > "$tmp"
	if cmp -s "$f" "$tmp"; then
		rm -f "$tmp"
		continue
	fi
	if [ "$CHECK" -eq 1 ]; then
		echo "DRIFT: $rel does not match config/versions.yaml" >&2
		diff -u "$f" "$tmp" >&2 || true
		drift=1
		rm -f "$tmp"
	else
		mv "$tmp" "$f"
		echo "rendered: $rel"
	fi
done

if [ "$CHECK" -eq 1 ]; then
	if [ "$drift" -ne 0 ]; then
		echo "version manifests are out of date; run 'make generate-versions'" >&2
		exit 1
	fi
	echo "ok: manifests match config/versions.yaml (default=$DEFAULT allowed=$ALLOWED)"
fi
