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

sdk_version=$(xcrun --sdk macosx --show-sdk-version)
if [ "${sdk_version%%.*}" -ge 26 ] && xcrun --sdk macosx --find actool >/dev/null 2>&1; then
    deployment_target=$(plutil -extract LSMinimumSystemVersion raw Info.plist)
    xcrun --sdk macosx actool --compile "$resources" \
        --platform macosx --target-device mac --minimum-deployment-target "$deployment_target" \
        --app-icon OneApp --standalone-icon-behavior all --output-format human-readable-text \
        --output-partial-info-plist "$build_dir/icon-info.plist" "$app_dir/OneApp.icon"
    /usr/libexec/PlistBuddy -c "Merge \"$build_dir/icon-info.plist\"" "$contents/Info.plist"
else
    install -m 644 OneApp.icns "$resources/OneApp.icns"
    plutil -insert CFBundleIconFile -string OneApp "$contents/Info.plist"
fi

codesign --force --sign - "$staged_bundle"
rm -rf "$bundle"
mv "$staged_bundle" "$bundle"
