#!/bin/sh
# Aside Pocket installer. Downloads the app into <data dir>/app, links the aside-pocket command
# into ~/.local/bin and runs "aside-pocket setup". Safe to run again: it upgrades in place and keeps your data.
#
#   ASIDE_POCKET_DIR      data directory (default ~/.aside-pocket)
#   ASIDE_POCKET_REF      branch, tag or commit to install (default: latest release, else main)
#   ASIDE_POCKET_TARBALL  URL of a .tar.gz to install instead (https:// or file://)
#   ASIDE_POCKET_NO_SETUP 1 = only download and link (used by "aside-pocket update")
set -eu

REPO=khmuhtadin/aside-pocket

fail() {
  echo "$1" >&2
  exit 1
}

main() {
  [ "$(uname -s)" = Darwin ] || fail "Aside Pocket only runs on macOS."
  [ "$(id -u)" != 0 ] || fail "Do not run this as root or with sudo. Run it as your normal user."
  [ -x "$HOME/.aside/cli/Aside CLI.app/Contents/MacOS/aside" ] ||
    fail "Aside was not found in ~/.aside. Install Aside, open it once and sign in, then run this again."

  dir=${ASIDE_POCKET_DIR:-$HOME/.aside-pocket}
  app=$dir/app
  [ ! -e "$app/.git" ] || fail "$app is a git checkout. Update it with: aside-pocket update"

  url=${ASIDE_POCKET_TARBALL:-}
  if [ -z "$url" ]; then
    ref=${ASIDE_POCKET_REF:-}
    if [ -z "$ref" ]; then
      ref=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
        sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
    fi
    if [ -n "$ref" ]; then
      url=https://github.com/$REPO/archive/$ref.tar.gz
    else
      url=https://github.com/$REPO/archive/refs/heads/main.tar.gz
    fi
  fi

  mkdir -p "$dir"
  chmod 700 "$dir"
  rm -rf "$dir/app.new" "$dir/app.old"
  mkdir "$dir/app.new"
  echo "Downloading Aside Pocket..."
  curl -fsSL -o "$dir/app.tar.gz" "$url" || fail "Download failed: $url"
  tar -xzf "$dir/app.tar.gz" -C "$dir/app.new" --strip-components 1 || fail "Could not unpack the download."
  rm -f "$dir/app.tar.gz"
  [ -f "$dir/app.new/tools/cli.js" ] && [ -f "$dir/app.new/bin/aside-pocket" ] ||
    fail "The download does not look like Aside Pocket."
  chmod +x "$dir/app.new/bin/aside-pocket"

  if [ -d "$app" ]; then mv "$app" "$dir/app.old"; fi
  mv "$dir/app.new" "$app"
  rm -rf "$dir/app.old"

  mkdir -p "$HOME/.local/bin"
  ln -sf "$app/bin/aside-pocket" "$HOME/.local/bin/aside-pocket"
  echo "Installed in $app, command: ~/.local/bin/aside-pocket"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "Note: ~/.local/bin is not on your PATH. Add it, or start the command as ~/.local/bin/aside-pocket" ;;
  esac

  if [ "${ASIDE_POCKET_NO_SETUP:-}" = 1 ]; then exit 0; fi
  exec "$app/bin/aside-pocket" setup
}

# the whole script is read before anything runs, so a download that was cut off does nothing
main
