#!/bin/sh
# Build this machine's binary and publish it as release v<version> on GitHub.
# The version comes from Cargo.toml; plugin/.claude-plugin/plugin.json and VERSION in
# plugin/hooks/register.ts must say the same. Push main first: the tag is made from it.
set -eu
cd "$(dirname "$0")/.."

version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
target=$(rustc -vV | sed -n 's/^host: //p')
archive="handsfree-$target.tar.gz"

grep -q "\"version\": \"$version\"" plugin/.claude-plugin/plugin.json || { echo "plugin.json is not at $version" >&2; exit 1; }
grep -q "const VERSION = '$version'" plugin/hooks/register.ts || { echo "register.ts VERSION is not $version" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "commit your changes first" >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "push main first" >&2; exit 1; }

cargo build --release
out=$(mktemp -d)
tar -czf "$out/$archive" -C target/release handsfree

if gh release view "v$version" >/dev/null 2>&1; then
  gh release upload "v$version" "$out/$archive" --clobber   # another machine's binary for the same release
else
  gh release create "v$version" "$out/$archive" --target main --title "v$version" --generate-notes
fi
echo "published $archive to v$version"
