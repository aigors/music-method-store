#!/bin/bash
set -e

PKG_TARGET="/var/packages/iventoy/target"
export LD_LIBRARY_PATH="${PKG_TARGET}/lib:${LD_LIBRARY_PATH}"

cd "${PKG_TARGET}"

exec "${PKG_TARGET}/iventoy.sh" "$@"