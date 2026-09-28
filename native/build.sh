#!/usr/bin/env bash
# Cross-compiles the Eee Note apps with the FreeeNote toolchain (GCC 4.2.4, Qt Embedded
# 4.6.2) in an amd64 container. The toolchain package is an amd64 .deb, so on Apple
# silicon Docker runs it emulated.
#
#   native/build.sh [app ...]    apps default to: eeereview inktest
set -euo pipefail
cd "$(dirname "$0")"

cache="${EEE_CACHE:-$HOME/.cache/eeenote}"
deb="$cache/eeenote-toolchain-amd64.deb"
mkdir -p "$cache"
if [ ! -f "$deb" ]; then
  curl -fL -o "$deb" https://freenote.peterbarrette.com/downloads/devkit/eeenote-toolchain-amd64.deb
fi
cp Dockerfile "$cache/Dockerfile"
docker build --platform linux/amd64 -q -t eeenote-build "$cache" >/dev/null

apps=("$@")
[ ${#apps[@]} -eq 0 ] && apps=(eeereview inktest eeelink)
for app in "${apps[@]}"; do
  if [ "$app" = eeelink ]; then
    docker run --rm --platform linux/amd64 -v "$PWD":/src eeenote-build \
      arm-unknown-linux-gnueabi-gcc -std=gnu99 -O2 -Wall -o /src/eeelink/eeelink /src/eeelink/eeelink.c
    libusb="$(brew --prefix libusb 2>/dev/null || echo /opt/homebrew)"
    cc -O2 -Wall -DEEELINK_HOST -I"$libusb/include" -L"$libusb/lib" -o eeelink/eeelink-host eeelink/eeelink.c -lusb-1.0 -lpthread
    echo "built native/eeelink/eeelink (tablet) and native/eeelink/eeelink-host (this machine)"
    continue
  fi
  docker run --rm --platform linux/amd64 -v "$PWD":/src eeenote-build sh -c "
    set -e
    rm -rf /tmp/b && mkdir -p /tmp/b/common /tmp/b/$app
    cp /src/common/pen.h /tmp/b/common/
    cp /src/$app/*.cpp /src/$app/*.pro /tmp/b/$app/
    cd /tmp/b/$app && qmake -spec qws/linux-EA800-g++ >/dev/null && make 2>&1 | grep -E 'error|warning' || true
    cp $app /src/$app/$app"
  echo "built native/$app/$app"
done
