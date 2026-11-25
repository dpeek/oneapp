#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
    printf '%s\n' 'Building OneApp for macOS requires a Mac.' >&2
    exit 1
fi

cd "$(dirname "$0")"
app_dir=$(pwd -P)
swift build
bin_dir=$(swift build --show-bin-path)

bundle=dist/OneApp.app
mkdir -p dist
build_dir=$(mktemp -d "$app_dir/dist/.oneapp.XXXXXXXX")
trap 'rm -rf "$build_dir"' EXIT

staged_bundle=$build_dir/OneApp.app
contents=$staged_bundle/Contents
resources=$contents/Resources
mkdir -p "$contents/MacOS" "$resources"
install -m 755 "$bin_dir/OneApp" "$contents/MacOS/OneApp"
install -m 644 Info.plist "$contents/Info.plist"
install -m 644 OneApp.icns "$resources/OneApp.icns"

codesign --force --sign - "$staged_bundle"
rm -rf "$bundle"
mv "$staged_bundle" "$bundle"
