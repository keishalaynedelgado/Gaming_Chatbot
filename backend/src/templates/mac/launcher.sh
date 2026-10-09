#!/bin/sh
# The Mac app's executable (Contents/MacOS, see exporter.js): opens the
# game's window by running Resources/main.js with macOS's own JavaScript for
# Automation, so the app needs no compiled code.
resources="$(cd "$(dirname "$0")/../Resources" && pwd)"
exec /usr/bin/osascript -l JavaScript "$resources/main.js" "$resources"
