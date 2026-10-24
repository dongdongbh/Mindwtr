#!/bin/sh
set -eu

# Keep both originals outside the web root so changing modes survives restarts.
case "${MINDWTR_PWA_ENABLED:-true}" in
    true) worker=/opt/mindwtr/sw-pwa.js ;;
    false) worker=/opt/mindwtr/sw-online.js ;;
    *) echo 'MINDWTR_PWA_ENABLED must be true or false' >&2; exit 1 ;;
esac
cp "$worker" /usr/share/nginx/html/sw.js
