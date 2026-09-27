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
[ ${#apps[@]} -eq 0 ] && apps=(eeereview inktest)
for app in "${apps[@]}"; do
  docker run --rm --platform linux/amd64 -v "$PWD":/src eeenote-build sh -c "
    set -e
    rm -rf /tmp/b && mkdir -p /tmp/b/common /tmp/b/$app
    cp /src/common/pen.h /tmp/b/common/
    cp /src/$app/*.cpp /src/$app/*.pro /tmp/b/$app/
    cd /tmp/b/$app && qmake -spec qws/linux-EA800-g++ >/dev/null && make 2>&1 | grep -E 'error|warning' || true
    cp $app /src/$app/$app"
  echo "built native/$app/$app"
done
