#!/usr/bin/env bash
# Dedicated mod-manager browser: system Chromium with CDP enabled.
# Keeps its own profile — fully separate from your main browser.
exec chromium \
    --user-data-dir="$HOME/.config/modman-browser" \
    --remote-debugging-port=9223 \
    "$@" https://www.nexusmods.com
