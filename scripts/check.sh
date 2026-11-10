#!/usr/bin/env bash
# The pack's one verification gate. Prints PASS/FAIL per step, exits
# non-zero on any failure.
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
fail=0

step() { # step <name> <cmd...>
  local name="$1"; shift
  if "$@" >/tmp/herd-check.$$ 2>&1; then
    echo "PASS $name"
  else
    echo "FAIL $name"; sed 's/^/  /' /tmp/herd-check.$$; fail=1
  fi
}
trap 'rm -f /tmp/herd-check.$$' EXIT

step "sync --check" bash scripts/sync.sh --check

step "json parses" python3 - <<'PY'
import json, subprocess, sys
files = subprocess.run(["git", "ls-files", "*.json"], capture_output=True, text=True).stdout.split()
bad = []
for f in files:
    try:
        json.load(open(f))
    except Exception as e:
        bad.append(f"{f}: {e}")
if bad:
    print("\n".join(bad)); sys.exit(1)
PY

step "python compiles" bash -c '
set -e
tmp=$(mktemp -d); trap "rm -rf $tmp" EXIT
find . -name "*.py" -not -path "./.git/*" | while read -r f; do
  PYTHONDONTWRITEBYTECODE=1 PYTHONPYCACHEPREFIX="$tmp" python3 -B -m py_compile "$f" || exit 1
  [ -x /usr/bin/python3 ] && { PYTHONPYCACHEPREFIX="$tmp" /usr/bin/python3 -B -m py_compile "$f" || exit 1; }
done
'

step "python tests" bash -c '
set -e
tmp=$(mktemp -d); trap "rm -rf $tmp" EXIT
for d in herd-*/tests; do
  compgen -G "$d/test_*.py" >/dev/null || continue
  PYTHONDONTWRITEBYTECODE=1 PYTHONPYCACHEPREFIX="$tmp" python3 -m unittest discover -s "$d" -p "test_*.py" || exit 1
  [ -x /usr/bin/python3 ] && PYTHONPYCACHEPREFIX="$tmp" /usr/bin/python3 -B -m unittest discover -s "$d" -p "test_*.py" || exit 1
done
'

step "node tests" bash -c '
if ! command -v node >/dev/null; then echo "SKIP node tests (no node)"; exit 0; fi
if compgen -G "herd-*/tests/*.test.mjs" >/dev/null; then node --test herd-*/tests/*.test.mjs; else echo "no node tests"; fi
'

step "sh syntax" bash -c 'find . -name "*.sh" -not -path "./.git/*" | while read -r f; do bash -n "$f" || exit 1; done; bash -n install.sh'

step "herdr-app check" bash -c '
set -e
for d in herd-*/mods/*/ abyss/mods/*/; do
  [ -f "$d/main.js" ] || continue
  herdr-app check "$d" >/dev/null || { echo "herdr-app check failed: $d"; exit 1; }
done
'

step "no personal data" bash -c '
# Personal identifiers must never ship. Scans every file git would commit
# (tracked + untracked, not ignored) except vendored third_party/.
# bitdoze only flags the personal domains: a public repo path like
# github.com/bitdoze/<repo> is legitimate and does not match.
pat="dra""gos|nep""otu|best""smart|living""andglow|em""dash|bit""doze\\.(com|ro)|/Use""rs/|/home/[a-z]|50""00\\+|192\\.168\\.|10\\.0\\.|172\\.(1[6-9]|2[0-9]|3[01])\\."
{ git ls-files; git ls-files --others --exclude-standard; } | sort -u | grep -v "^third_party/" | xargs grep -inE "$pat" | grep . && exit 1 || exit 0
'

exit "$fail"
