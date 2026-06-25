#!/bin/sh
# bump-version.sh — set every package version in lockstep.
#
# SynergyPlus ships several packages (the portal, the Runner, the Python SDK)
# that are released together under one platform version. Their version strings
# live in different files and syntaxes; editing them by hand drifts. This script
# is the single source of that bump.
#
# Usage:
#   hack/bump-version.sh <version>   # set ALL packages to <version> (e.g. 0.4.0)
#   hack/bump-version.sh --check     # print each version; exit 1 if not all equal
#
# It never guesses: each target is matched by an anchored pattern, and the script
# fails loudly if any file did not change (a missed pattern is a bug, not a no-op).
set -eu

# Repo root = the directory above this script's hack/ dir.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# Each entry: <file>|<anchor>
# <anchor> is the exact text that precedes the quoted version on its line; the
# version itself is the next "..." token, matched at start-of-line.
TARGETS='portal/package.json|  "version":
runner/pyproject.toml|version =
runner/synergy_runner/__init__.py|__version__ =
sdk/python/pyproject.toml|version =
sdk/python/synergyplus/__init__.py|__version__ ='

die() { echo "bump-version: $*" >&2; exit 1; }

# Escape regex metacharacters so an anchor is matched literally.
escape_re() { printf '%s' "$1" | sed 's/[].[*^$\\/]/\\&/g'; }

# current_version <file> <anchor> -> prints the version, or empty if not found.
# Tolerates the whitespace between the anchor (e.g. `version =`) and the quote.
current_version() {
  _re=$(escape_re "$2")
  sed -n "s/^${_re}[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$ROOT/$1" | head -n1
}

cmd_check() {
  _first=''; _ok=1
  printf '%-40s %s\n' "FILE" "VERSION"
  _oifs=$IFS; IFS='
'
  for _entry in $TARGETS; do
    [ -n "$_entry" ] || continue
    _file=${_entry%%|*}; _anchor=${_entry#*|}
    [ -f "$ROOT/$_file" ] || die "missing file: $_file"
    _v=$(current_version "$_file" "$_anchor")
    [ -n "$_v" ] || die "no version found in $_file (anchor: '$_anchor')"
    printf '%-40s %s\n' "$_file" "$_v"
    [ -n "$_first" ] || _first=$_v
    [ "$_v" = "$_first" ] || _ok=0
  done
  IFS=$_oifs
  [ "$_ok" = 1 ] || die "package versions are NOT in sync (see above)"
  echo "ok: all packages at $_first"
}

cmd_bump() {
  _ver=$1
  printf '%s' "$_ver" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' \
    || die "invalid version '$_ver' (expected X.Y.Z or X.Y.Z-pre)"

  _oifs=$IFS; IFS='
'
  for _entry in $TARGETS; do
    [ -n "$_entry" ] || continue
    _file=${_entry%%|*}; _anchor=${_entry#*|}
    _path="$ROOT/$_file"
    [ -f "$_path" ] || die "missing file: $_file"
    _old=$(current_version "$_file" "$_anchor")
    [ -n "$_old" ] || die "no version found in $_file (anchor: '$_anchor') — refusing to guess"

    _re=$(escape_re "$_anchor")
    _tmp=$(mktemp)
    # Replace only the quoted token after the anchor, normalising to a single
    # space; keep the rest of the line (e.g. package.json's trailing comma) intact.
    sed "s/^${_re}[[:space:]]*\"[^\"]*\"/${_re} \"${_ver}\"/" "$_path" > "$_tmp"
    _new=$(sed -n "s/^${_re}[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$_tmp" | head -n1)
    [ "$_new" = "$_ver" ] || { rm -f "$_tmp"; die "failed to set version in $_file (still '$_new')"; }
    mv "$_tmp" "$_path"
    printf '  %-40s %s -> %s\n' "$_file" "$_old" "$_ver"
  done
  IFS=$_oifs
  echo "bumped all packages to $_ver"
}

case "${1:-}" in
  --check) cmd_check ;;
  '')      die "usage: bump-version.sh <version> | --check" ;;
  -*)      die "unknown flag '$1' (use --check or a version)" ;;
  *)       cmd_bump "$1" ;;
esac
