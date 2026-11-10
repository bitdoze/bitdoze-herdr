#!/usr/bin/env bash
# Install the Herdr packs into ~/.config/herdr-app (or $HERDR_APP_HOME).
#
#   ./install.sh [--dry-run] [--link] [--no-vitals]
#
# Copies the abyss layout (json + svg), its theme and every bundled mod
# (abyss chrome + generated herd-* copies), plus the vendored vitals mod
# unless --no-vitals. Key bindings are merged add-only: a chord the person
# already uses is left alone and reported. Nothing in the app home is ever
# deleted; user config files (bots.json, sites.json, keys.json, ...) are
# never overwritten. --link symlinks instead of copying, for development.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
DRY=0 LINK=0 VITALS=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --link) LINK=1 ;;
    --no-vitals) VITALS=0 ;;
    *) echo "usage: $0 [--dry-run] [--link] [--no-vitals]" >&2; exit 2 ;;
  esac
done

[ -d "$APP" ] || { echo "no herdr-app home at $APP — run the app once first"; exit 1; }

# Regenerate layouts/abyss/mods/* from the canonical mod packages.
[ "$DRY" -eq 1 ] || bash "$HERE/scripts/sync.sh" >/dev/null

say() { if [ "$DRY" -eq 1 ]; then echo "[dry-run] $*"; else echo "$*"; fi; }
put() { # put <src> <dst-dir>  — copy (or symlink) a file/dir
  local src="$1" dstdir="$2" dst="$2/$(basename "$1")"
  if [ "$DRY" -eq 1 ]; then say "install $src -> $dst"; return; fi
  mkdir -p "$dstdir"
  if [ "$LINK" -eq 1 ]; then
    if [ -L "$dst" ]; then rm -f "$dst";
    elif [ -e "$dst" ]; then echo "refusing to replace existing $dst with a symlink" >&2; exit 1; fi
    ln -s "$src" "$dst"
  else
    [ -L "$dst" ] && rm -f "$dst"          # replace a --link symlink with a copy
    cp -R "$src" "$dstdir/"; rm -rf "$dst/__pycache__"
  fi
}

put "$HERE/layouts/abyss/layouts/abyss.json" "$APP/layouts"
put "$HERE/layouts/abyss/layouts/abyss.svg" "$APP/layouts"
put "$HERE/layouts/abyss/themes/abyss.json" "$APP/themes"
if [ "$LINK" -eq 1 ]; then
  # Link canonical sources, not the generated copies: sync.sh rm -rf's the
  # generated folders, which would destroy user files in a linked folder.
  for mod in "$HERE"/layouts/abyss/mods/abyss-*/ "$HERE"/mods/*/mods/*/; do
    [ -f "$mod/main.js" ] || continue
    put "${mod%/}" "$APP/mods"
  done
else
  for mod in "$HERE"/layouts/abyss/mods/*/; do
    [ -f "$mod/main.js" ] || continue
    put "${mod%/}" "$APP/mods"
  done
fi
if [ "$VITALS" -eq 1 ]; then
  put "$HERE/third_party/vitals/mods/vitals" "$APP/mods"
fi

# Merge keys add-only: never replace a chord the person already binds.
FRAGS=("$HERE/layouts/abyss/keys.json")
[ "$VITALS" -eq 1 ] && FRAGS+=("$HERE/third_party/vitals/keys.json")
[ "$DRY" -eq 1 ] && say "merge keys add-only from: ${FRAGS[*]}"
if [ "$DRY" -eq 0 ]; then
  APP="$APP" python3 - "${FRAGS[@]}" <<'PY'
import json, os, sys
app = os.environ["APP"]
path = f"{app}/keys.json"
keys = json.load(open(path)) if os.path.exists(path) else {}
skipped = []
added = []
kept = []
for frag in sys.argv[1:]:
    for section, bindings in json.load(open(frag)).items():
        keys.setdefault(section, {})
        for chord, action in bindings.items():
            if chord in keys[section]:
                if keys[section][chord] != action:
                    skipped.append(f"{section}:{chord} (yours: {keys[section][chord]})")
                else:
                    kept.append(f"{section}:{chord}")
            else:
                keys[section][chord] = action
                added.append(f"{section}:{chord} -> {action}")
json.dump(keys, open(path, "w"), indent=2)
for a in added:
    print(f"key added   {a}")
for k in kept:
    print(f"key present {k}")
for s in skipped:
    print(f"key skipped {s}")
PY
fi

# Validate installed mods.
if [ "$DRY" -eq 0 ]; then
  for mod in "$APP"/mods/*/; do
    [ -f "$mod/main.js" ] || continue
    case "$(basename "$mod")" in
      abyss-*|herd-*|vitals) herdr-app check "$mod" ;;
    esac
  done
fi

if [ "$VITALS" -eq 1 ]; then
  say "Note: vitals is vendored under third_party/ (mrolafsson/herdr-vitals, MIT)."
  say "      It downloads a checksummed herdr-vitals binary per machine on first"
  say "      open and runs curl/tar/sha256 on every machine it monitors, including remotes."
fi

echo
say "Done. Switch layouts with: herdr-app do layout.switch '{\"name\":\"abyss\"}'"
