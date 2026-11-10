#!/usr/bin/env bash
# Regenerate the herd-* mod copies bundled inside abyss/mods/.
# Canonical sources live in <pkg>/mods/<name>/; only folders with a
# main.js are copied. `--check` reports drift without changing anything.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

drift=0
for pkg in "$HERE"/*/; do
  name="$(basename "$pkg")"
  src="$pkg/mods/$name"
  dst="$HERE/abyss/mods/$name"
  [ -f "$src/main.js" ] || continue
  if [ "$CHECK" -eq 1 ]; then
    if [ ! -d "$dst" ] || ! diff -rq -x "*.d.ts" -x jsconfig.json -x __pycache__ -x "*.pyc" -x bots.json -x sites.json "$src" "$dst" >/dev/null 2>&1; then
      echo "drift: abyss/mods/$name differs from $name/mods/$name"
      drift=1
    fi
  else
    rm -rf "$dst"
    mkdir -p "$dst"
    cp -R "$src/." "$dst/"
    rm -f "$dst/bots.json" "$dst/sites.json" "$dst/tasks.json" \
          "$dst/gpui-kit.d.ts" "$dst/herdr.d.ts" "$dst/jsconfig.json"
    rm -rf "$dst/__pycache__"
    echo "synced abyss/mods/$name"
  fi
done

if [ "$CHECK" -eq 1 ]; then
  # also flag generated copies whose source no longer qualifies
  for dst in "$HERE"/abyss/mods/*/; do
    name="$(basename "$dst")"
    case "$name" in abyss-*) continue ;; esac
    [ -f "$HERE/$name/mods/$name/main.js" ] || { echo "drift: abyss/mods/$name has no canonical source"; drift=1; }
  done
fi

exit "$drift"
