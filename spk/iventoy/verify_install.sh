#!/bin/bash
# iVentoy post-install verification script for DSM
# Run via SSH as root/admin after package installation
# Usage: bash verify_install.sh [--fix] [--verbose]

set -euo pipefail

FIX_MODE=false
VERBOSE=false
for arg in "$@"; do
    case $arg in
        --fix) FIX_MODE=true ;;
        --verbose) VERBOSE=true ;;
    esac
done

PKG_NAME="iventoy"
PKG_DEST="/var/packages/${PKG_NAME}/target"
PKG_VAR="/var/packages/${PKG_NAME}/var"
LOG_FILE="${PKG_VAR}/log/verify_install.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[$(date '+%H:%M:%S')]${NC} $*" | tee -a "${LOG_FILE}"; }
ok() { echo -e "${GREEN}[OK]${NC} $*" | tee -a "${LOG_FILE}"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*" | tee -a "${LOG_FILE}"; }
err() { echo -e "${RED}[ERR]${NC} $*" | tee -a "${LOG_FILE}"; }
detail() { [ "$VERBOSE" = true ] && echo -e "    $*" | tee -a "${LOG_FILE}"; }

mkdir -p "$(dirname "${LOG_FILE}")"
log "=== iVentoy Post-Install Verification ==="
log "Package: ${PKG_NAME} | Dest: ${PKG_DEST} | Var: ${PKG_VAR}"

FAIL_COUNT=0
WARN_COUNT=0

check() {
    local name="$1"; shift
    if "$@"; then
        ok "$name"
        return 0
    else
        err "$name"
        ((FAIL_COUNT++))
        return 1
    fi
}

check_warn() {
    local name="$1"; shift
    if "$@"; then
        ok "$name"
        return 0
    else
        warn "$name"
        ((WARN_COUNT++))
        return 1
    fi
}

log "\n--- 1. Package Structure ---"
check "Package destination exists" test -d "${PKG_DEST}"
check "Package var directory exists" test -d "${PKG_VAR}"
check "Binary exists" test -x "${PKG_DEST}/lib/iventoy"
check "Wrapper script exists" test -x "${PKG_DEST}/iventoy-wrapper.sh"
check "Original iventoy.sh exists" test -x "${PKG_DEST}/iventoy.sh"
check "Libraries present" test -f "${PKG_DEST}/lib/libglib-2.0.so.0"
check "Config template exists" test -f "${PKG_DEST}/iventoy.conf"
check "Systemd unit exists" test -f "${PKG_DEST}/iventoy.service"
check "nginx proxy config exists" test -f "${PKG_DEST}/nginx/iventoy.conf"
check "htpasswd generator exists" test -x "${PKG_DEST}/nginx/generate_htpasswd.sh"
check "Seed data directory (.init)" test -d "${PKG_DEST}/data.init"
check "Seed driver directory (.init)" test -d "${PKG_DEST}/driver.init"
check "Seed user directory (.init)" test -d "${PKG_DEST}/user.init"

log "\n--- 2. Symlinks (Persistent Data) ---"
for d in data driver user log; do
    check "target/$d -> var/$d" test -L "${PKG_DEST}/$d"
    detail "  $(readlink -f "${PKG_DEST}/$d")"
done
check "var/data populated" test -f "${PKG_VAR}/data/iventoy.dat"
check "var/data/mac.db exists" test -f "${PKG_VAR}/data/mac.db"

log "\n--- 3. ISO Storage ---"
if [ -f "${PKG_VAR}/iventoy.conf" ]; then
    source "${PKG_VAR}/iventoy.conf"
    check "IVENTOY_ISO_DIR set in config" test -n "${IVENTOY_ISO_DIR}"
    check "ISO directory exists" test -d "${IVENTOY_ISO_DIR}"
    check "ISO directory writable" test -w "${IVENTOY_ISO_DIR}"
    check "target/iso symlinks to ISO dir" test -L "${PKG_DEST}/iso"
    detail "  ISO dir: ${IVENTOY_ISO_DIR}"
    detail "  target/iso -> $(readlink "${PKG_DEST}/iso")"
else
    err "Config file not found: ${PKG_VAR}/iventoy.conf"
    ((FAIL_COUNT++))
fi

log "\n--- 4. Web UI Authentication ---"
if [ -f "${PKG_VAR}/htpasswd" ]; then
    check "htpasswd file exists" true
    detail "  Users: $(cut -d: -f1 "${PKG_VAR}/htpasswd" | tr '\n' ' ')"
else
    warn "No htpasswd file (auth disabled - NOT recommended)"
fi

log "\n--- 5. Service Status ---"
check "Package shown as installed in DSM" synopkg is_installed "${PKG_NAME}"
if synopkg is_onoff "${PKG_NAME}" | grep -q "running"; then
    check "Service running (synopkg)" true
else
    check "Service running (synopkg)" false
fi

if [ -f /var/run/iventoy.pid ]; then
    PID=$(cat /var/run/iventoy.pid 2>/dev/null || echo 0)
    if [ "$PID" -gt 0 ] && kill -0 "$PID" 2>/dev/null; then
        check "PID file valid (PID=$PID)" true
    else
        check "PID file valid" false
    fi
else
    check "PID file exists" false
fi

log "\n--- 6. Process & Ports ---"
if pgrep -f "lib/iventoy" >/dev/null; then
    check "iVentoy process running" true
    detail "  PIDs: $(pgrep -f 'lib/iventoy' | tr '\n' ' ')"
else
    check "iVentoy process running" false
fi

for port in 67 68 69 4011 16000 26000 26001 10809 3260 12049; do
    proto="tcp"
    [ "$port" = "67" ] && proto="udp"
    [ "$port" = "68" ] && proto="udp"
    [ "$port" = "69" ] && proto="udp"
    [ "$port" = "4011" ] && proto="udp"
    if ss -l${proto:0:1} -n | grep -q ":$port "; then
        check "Port $port/$proto listening" true
    else
        check_warn "Port $port/$proto listening" false
    fi
done

log "\n--- 7. Firewall / iptables ---"
if iptables -C INPUT -i lo -p tcp --dport 26000 -j ACCEPT 2>/dev/null; then
    check "iptables: localhost allow 26000" true
else
    check_warn "iptables: localhost allow 26000" false
    [ "$FIX_MODE" = true ] && iptables -I INPUT -i lo -p tcp --dport 26000 -j ACCEPT && ok "  (fixed)"
fi

if iptables -C INPUT ! -i lo -p tcp --dport 26000 -j DROP 2>/dev/null; then
    check "iptables: external drop 26000" true
else
    check_warn "iptables: external drop 26000" false
    [ "$FIX_MODE" = true ] && iptables -I INPUT ! -i lo -p tcp --dport 26000 -j DROP && ok "  (fixed)"
fi

log "\n--- 8. nginx Reverse Proxy ---"
if [ -L /etc/nginx/sites-enabled/iventoy.conf ]; then
    check "nginx site enabled" true
    detail "  -> $(readlink /etc/nginx/sites-enabled/iventoy.conf)"
else
    check "nginx site enabled" false
    [ "$FIX_MODE" = true ] && ln -sf "${PKG_DEST}/nginx/iventoy.conf" /etc/nginx/sites-enabled/ && /usr/syno/sbin/nginx -s reload && ok "  (fixed)"
fi

if pgrep -f "nginx.*master" >/dev/null; then
    check "nginx master process running" true
else
    check "nginx master process running" false
fi

if ss -ltn | grep -q ":26001 "; then
    check "nginx proxy listening on 26001" true
else
    check "nginx proxy listening on 26001" false
fi

log "\n--- 9. HTTP Accessibility ---"
if curl -sf -o /dev/null --max-time 5 "http://127.0.0.1:26000" 2>/dev/null; then
    check "iVentoy internal (26000) responds" true
else
    check_warn "iVentoy internal (26000) responds" false
fi

AUTH_USER=""
if [ -f "${PKG_VAR}/htpasswd" ]; then
    AUTH_USER=$(cut -d: -f1 "${PKG_VAR}/htpasswd" | head -1)
    if curl -sf -o /dev/null --max-time 5 -u "${AUTH_USER}:wrongpass" "http://127.0.0.1:26001" 2>/dev/null; then
        check "Proxy (26001) accepts auth" false
    else
        check "Proxy (26001) returns 401 for bad creds" true
    fi
fi

log "\n--- 10. DSM Integration ---"
check "Package appears in Package Center" synopkg list | grep -q "^${PKG_NAME}$"
check "Package version correct" synopkg version "${PKG_NAME}" | grep -q "1.0.39"
check "Firewall rules registered" test -f "${PKG_DEST}/../scripts/iventoy.sc" || test -f "${PKG_DEST}/../src/iventoy.sc"

log "\n--- 11. Logs ---"
check "Log directory exists" test -d "${PKG_VAR}/log"
check "Client log dir exists" test -d "${PKG_VAR}/log/client"
check "History log dir exists" test -d "${PKG_VAR}/log/history"
if [ -f /var/log/iventoy.log ] || [ -f "${PKG_VAR}/log/iventoy.log" ]; then
    check "Service log file exists" true
else
    check_warn "Service log file exists" false
fi

log "\n--- 12. Binary Dependencies ---"
if command -v ldd >/dev/null; then
    MISSING=$(ldd "${PKG_DEST}/lib/iventoy" 2>/dev/null | grep "not found" | wc -l)
    if [ "$MISSING" -eq 0 ]; then
        check "All shared libraries resolved" true
    else
        check "All shared libraries resolved" false
        ldd "${PKG_DEST}/lib/iventoy" | grep "not found" | while read line; do detail "  Missing: $line"; done
    fi
fi

log "\n=== SUMMARY ==="
log "Failures: ${FAIL_COUNT} | Warnings: ${WARN_COUNT}"

if [ "$FAIL_COUNT" -eq 0 ]; then
    ok "All critical checks passed!"
    EXIT_CODE=0
else
    err "${FAIL_COUNT} critical failure(s) - review above"
    EXIT_CODE=1
fi

if [ "$WARN_COUNT" -gt 0 ]; then
    warn "${WARN_COUNT} warning(s) - review recommended"
    [ "$EXIT_CODE" -eq 0 ] && EXIT_CODE=0
fi

log "\nLog saved to: ${LOG_FILE}"
log "Run with --fix to auto-repair common issues (iptables, nginx site)"
exit $EXIT_CODE