#!/usr/bin/env sh
# Fetches the 1inch SwapVM and Aqua sources the router is built against. They are source-available
# (Degensoft licenses) and are not committed; run once after `npm ci`.
set -e
mkdir -p vendor
[ -d vendor/swap-vm ] || git clone -q --depth 1 --branch release/1.1 https://github.com/1inch/swap-vm vendor/swap-vm
[ -d vendor/aqua ] || git clone -q --depth 1 https://github.com/1inch/aqua vendor/aqua
echo "vendored: swap-vm ($(git -C vendor/swap-vm rev-parse --short HEAD)), aqua ($(git -C vendor/aqua rev-parse --short HEAD))"
