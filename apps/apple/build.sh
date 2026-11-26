#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
    printf '%s\n' 'Building Orumai for macOS requires a Mac.' >&2
    exit 1
fi

cd "$(dirname "$0")"
app_dir=$(pwd -P)
swift build
bin_dir=$(swift build --show-bin-path)

bundle=dist/Orumai.app
mkdir -p dist
build_dir=$(mktemp -d "$app_dir/dist/.orumai.XXXXXXXX")
trap 'rm -rf "$build_dir"' EXIT

staged_bundle=$build_dir/Orumai.app
contents=$staged_bundle/Contents
resources=$contents/Resources
mkdir -p "$contents/MacOS" "$resources"
install -m 755 "$bin_dir/Orumai" "$contents/MacOS/Orumai"
install -m 644 Info.plist "$contents/Info.plist"
install -m 644 Orumai.icns "$resources/Orumai.icns"

codesign --force --sign - "$staged_bundle"
rm -rf "$bundle"
mv "$staged_bundle" "$bundle"
