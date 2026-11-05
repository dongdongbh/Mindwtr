#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
docker run --rm --entrypoint /bin/sh \
    -v "$root/docker/app/20-service-worker.sh:/worker-entrypoint.sh:ro" \
    -v "$root/apps/desktop/public/sw.js:/opt/mindwtr/sw-pwa.js:ro" \
    -v "$root/docker/app/sw-online.js:/opt/mindwtr/sw-online.js:ro" \
    nginx:1.31.4-alpine@sha256:db35bfc6b2951e7f8a72db5db120288c127ffaeeb4a6d4b95a26fead017d5913 -ec '
        sh /worker-entrypoint.sh
        cmp /opt/mindwtr/sw-pwa.js /usr/share/nginx/html/sw.js
        MINDWTR_PWA_ENABLED=false sh /worker-entrypoint.sh
        cmp /opt/mindwtr/sw-online.js /usr/share/nginx/html/sw.js
        MINDWTR_PWA_ENABLED=true sh /worker-entrypoint.sh
        cmp /opt/mindwtr/sw-pwa.js /usr/share/nginx/html/sw.js
        if MINDWTR_PWA_ENABLED=invalid sh /worker-entrypoint.sh; then exit 1; fi
        cmp /opt/mindwtr/sw-pwa.js /usr/share/nginx/html/sw.js
    '
