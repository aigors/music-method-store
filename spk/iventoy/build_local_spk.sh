#!/bin/bash
# iVentoy local SPK builder - DSM7 compatible
# Builds a .spk package using exact spksrc templates

set -euo pipefail

# Package metadata
SPK_NAME="iventoy"
SPK_VERS="1.0.39"
SPK_REV="1"
SPK_ARCH="x86_64"
TCVERSION="7.2"
SPK_TCVERS="dsm72"
OS_MIN_VER="7.2-63134"
MAINTAINER="omnimax"
DESCRIPTION="iVentoy PXE Network Boot Server. Boot ISO images over network via PXE. Free Edition for personal/non-commercial use only (max 20 clients, x86_64 only)."
DISPLAY_NAME="iVentoy"
HOMEPAGE="https://www.ventoy.net/en/iventoy.html"
CHANGELOG="Initial iVentoy v1.0.39 package for DSM 7.x. Free Edition (personal use)."
SERVICE_PORT="26001"
SERVICE_PORT_TITLE="iVentoy Web GUI (nginx reverse proxy + auth)"
SERVICE_CERT="iventoy_webui"
DSM_UI_DIR="app"

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${SCRIPT_DIR}/work"
STAGING_DIR="${WORK_DIR}/staging"
PKG_WORK_DIR="${WORK_DIR}/pkg"
SPKSRC_MK_DIR="/c/Claude-Code_OmniRoute-Usb-main/Claude-Code_OmniRoute-Usb-main/engine/spksrc/mk"

# iVentoy download
DL_FILE="iventoy-${SPK_VERS}-linux-x86_64-free.tar.gz"
DL_URL="https://github.com/ventoy/PXE/releases/download/v${SPK_VERS}/${DL_FILE}"
EXTRACT_DIR="iventoy-${SPK_VERS}"

log() { echo -e "\033[0;34m[INFO]\033[0m $*"; }
ok() { echo -e "\033[0;32m[OK]\033[0m $*"; }
err() { echo -e "\033[0;31m[ERR]\033[0m $*"; }

# Clean and prepare
log "Cleaning previous build..."
rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}" "${STAGING_DIR}" "${PKG_WORK_DIR}"

# Download iVentoy
log "Downloading iVentoy ${SPK_VERS}..."
curl -L -o "${WORK_DIR}/${DL_FILE}" "${DL_URL}"

# Extract
log "Extracting iVentoy..."
tar -xzf "${WORK_DIR}/${DL_FILE}" -C "${WORK_DIR}"
ok "Extracted"

# Install to staging
log "Installing files to staging..."
install -m 755 "${WORK_DIR}/${EXTRACT_DIR}/iventoy.sh" "${STAGING_DIR}/"
install -m 755 "${SCRIPT_DIR}/src/iventoy-wrapper.sh" "${STAGING_DIR}/"
mkdir -p "${STAGING_DIR}/lib"
install -m 755 "${WORK_DIR}/${EXTRACT_DIR}/lib/iventoy" "${STAGING_DIR}/lib/"
cp -r "${WORK_DIR}/${EXTRACT_DIR}/lib/lin64/." "${STAGING_DIR}/lib/"
cp -r "${WORK_DIR}/${EXTRACT_DIR}/data" "${STAGING_DIR}/data.init"
cp -r "${WORK_DIR}/${EXTRACT_DIR}/driver" "${STAGING_DIR}/driver.init"
cp -r "${WORK_DIR}/${EXTRACT_DIR}/user" "${STAGING_DIR}/user.init"
install -m 644 "${SCRIPT_DIR}/src/iventoy.conf" "${STAGING_DIR}/"
install -m 644 "${SCRIPT_DIR}/src/iventoy.service" "${STAGING_DIR}/"
mkdir -p "${STAGING_DIR}/nginx"
install -m 644 "${SCRIPT_DIR}/src/nginx/iventoy.conf" "${STAGING_DIR}/nginx/"
install -m 755 "${SCRIPT_DIR}/src/nginx/generate_htpasswd.sh" "${STAGING_DIR}/nginx/"

# Create app directory with .sc firewall file
mkdir -p "${STAGING_DIR}/${DSM_UI_DIR}"
cp "${SCRIPT_DIR}/src/iventoy.sc" "${STAGING_DIR}/${DSM_UI_DIR}/iventoy.sc"

ok "Staging populated"

# --- DSM7 Scripts (exact spksrc templates) ---
log "Creating DSM7 scripts..."
mkdir -p "${PKG_WORK_DIR}/scripts"

# 1. installer (from spksrc.service/installer.dsm7)
cp "${SPKSRC_MK_DIR}/spksrc.service/installer.dsm7" "${PKG_WORK_DIR}/scripts/installer"

# 2. functions (from spksrc.service/installer.functions)
cp "${SPKSRC_MK_DIR}/spksrc.service/installer.functions" "${PKG_WORK_DIR}/scripts/functions"

# 3. start-stop-status (from spksrc.service/start-stop-status)
cp "${SPKSRC_MK_DIR}/spksrc.service/start-stop-status" "${PKG_WORK_DIR}/scripts/start-stop-status"

# 4. service-setup (generated from service-setup.sh)
# The service-setup script is sourced by both installer and start-stop-status
cat > "${PKG_WORK_DIR}/scripts/service-setup" <<'SERVICE_SETUP_EOF'
### Generic variables and functions
### -------------------------------

if [ -z "${SYNOPKG_PKGNAME}" ] || [ -z "${SYNOPKG_DSM_VERSION_MAJOR}" ]; then
  echo "Error: Environment variables are not set." 1>&2;
  echo "Please run me using synopkg instead. Example: \"synopkg start [packagename]\"" 1>&2;
  exit 1
fi

USER="iventoy"
EFF_USER="sc-iventoy"

# Service port
SERVICE_PORT="26001"

# Certificate for service
SERVICE_CERT="iventoy_webui"

# start-stop-status script redirect stdout/stderr to LOG_FILE
LOG_FILE="${SYNOPKG_PKGVAR}/${SYNOPKG_PKGNAME}.log"

# Service command has to deliver its pid into PID_FILE
PID_FILE="${SYNOPKG_PKGVAR}/${SYNOPKG_PKGNAME}.pid"

# Service command to execute
SERVICE_COMMAND="${SYNOPKG_PKGDEST}/iventoy-wrapper.sh -R start"

### Package specific variables and functions
### ----------------------------------------

PKG_TARGET="${SYNOPKG_PKGDEST}"
PKG_VAR="${SYNOPKG_PKGVAR}"
WRAPPER="${PKG_TARGET}/iventoy-wrapper.sh"
IVENTOY_CONF="${PKG_VAR}/iventoy.conf"
NGINX_CONF="${PKG_TARGET}/nginx/iventoy.conf"
NGINX_HTPASSWD="${PKG_VAR}/htpasswd"

read_config() {
    if [ -f "${IVENTOY_CONF}" ]; then
        . "${IVENTOY_CONF}"
    fi
    : ${IVENTOY_ISO_DIR:="/volume1/ISO/iVentoy"}
    : ${IVENTOY_WEB_PORT:=26000}
}

link_var_dirs() {
    for d in data driver user log; do
        mkdir -p "${PKG_VAR}/$d"
        if [ -d "${PKG_TARGET}/$d.init" ]; then
            cp -rn "${PKG_TARGET}/$d.init/." "${PKG_VAR}/$d/" 2>/dev/null || true
        fi
        if [ -d "${PKG_TARGET}/$d" -a ! -L "${PKG_TARGET}/$d" ]; then
            rm -rf "${PKG_TARGET}/$d"
        fi
        ln -sfn "${PKG_VAR}/$d" "${PKG_TARGET}/$d"
    done

    mkdir -p "${PKG_VAR}/log/client" "${PKG_VAR}/log/history"
    if [ -d "${PKG_TARGET}/log" -a ! -L "${PKG_TARGET}/log" ]; then
        rm -rf "${PKG_TARGET}/log"
    fi
    ln -sfn "${PKG_VAR}/log" "${PKG_TARGET}/log"

    mkdir -p "${IVENTOY_ISO_DIR}"
    chmod 755 "${IVENTOY_ISO_DIR}"
    if [ -d "${PKG_TARGET}/iso" -a ! -L "${PKG_TARGET}/iso" ]; then
        rm -rf "${PKG_TARGET}/iso"
    fi
    ln -sfn "${IVENTOY_ISO_DIR}" "${PKG_TARGET}/iso"
}

generate_config() {
    cat > "${IVENTOY_CONF}" <<EOF
# iVentoy Configuration - Generated by DSM package wizard
IVENTOY_ISO_DIR="${wizard_iso_path}"
IVENTOY_WEB_PORT=26000
IVENTOY_BIND_ADDR=127.0.0.1
IVENTOY_DHCP_ENABLE=1
IVENTOY_TFTP_ENABLE=1
IVENTOY_HTTP_ENABLE=1
IVENTOY_NBD_ENABLE=1
IVENTOY_ISCSI_ENABLE=1
IVENTOY_NFS_ENABLE=1
EOF
    chmod 644 "${IVENTOY_CONF}"
}

generate_nginx_config() {
    mkdir -p "${PKG_TARGET}/nginx"
    if [ -n "${wizard_username}" -a -n "${wizard_password}" ]; then
        "${PKG_TARGET}/nginx/generate_htpasswd.sh" "${wizard_username}" "${wizard_password}" "${NGINX_HTPASSWD}"
        AUTH_CONFIG="auth_basic \"iVentoy Web UI\";\n    auth_basic_user_file ${NGINX_HTPASSWD};"
    else
        AUTH_CONFIG="# No authentication configured"
    fi
    cat > "${NGINX_CONF}" <<EOF
server {
    listen 127.0.0.1:26001;
    server_name localhost;
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    ${AUTH_CONFIG}
    location / {
        proxy_pass http://127.0.0.1:26000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
}

block_internal_port() {
    iptables -C INPUT -i lo -p tcp --dport 26000 -j ACCEPT 2>/dev/null || \
        iptables -I INPUT -i lo -p tcp --dport 26000 -j ACCEPT
    iptables -C INPUT ! -i lo -p tcp --dport 26000 -j DROP 2>/dev/null || \
        iptables -I INPUT ! -i lo -p tcp --dport 26000 -j DROP
}

unblock_internal_port() {
    iptables -D INPUT -i lo -p tcp --dport 26000 -j ACCEPT 2>/dev/null || true
    iptables -D INPUT ! -i lo -p tcp --dport 26000 -j DROP 2>/dev/null || true
}

service_postinst() {
    if [ "${SYNOPKG_PKG_STATUS}" = "INSTALL" ]; then
        generate_config
        generate_nginx_config
        link_var_dirs
    fi
}

service_prestart() {
    read_config
    link_var_dirs
    if [ ! -f "${NGINX_CONF}" ]; then
        generate_nginx_config
    fi
    export LD_LIBRARY_PATH="${PKG_TARGET}/lib:${LD_LIBRARY_PATH}"
    block_internal_port
}

service_poststart() {
    if [ -x /usr/syno/sbin/nginx ]; then
        ln -sf "${NGINX_CONF}" /etc/nginx/sites-enabled/iventoy.conf 2>/dev/null || true
        /usr/syno/sbin/nginx -s reload 2>/dev/null || true
    fi
}

service_stop() {
    rm -f /etc/nginx/sites-enabled/iventoy.conf 2>/dev/null
    /usr/syno/sbin/nginx -s reload 2>/dev/null || true
    unblock_internal_port
    ${WRAPPER} stop
}

service_preupgrade() {
    mkdir -p "${SYNOPKG_TEMP_UPGRADE_FOLDER}/backup"
    cp -p "${IVENTOY_CONF}" "${SYNOPKG_TEMP_UPGRADE_FOLDER}/backup/" 2>/dev/null || true
    cp -p "${NGINX_HTPASSWD}" "${SYNOPKG_TEMP_UPGRADE_FOLDER}/backup/" 2>/dev/null || true
    cp -p "${PKG_VAR}/data/iventoy.dat" "${SYNOPKG_TEMP_UPGRADE_FOLDER}/backup/" 2>/dev/null || true
    cp -p "${PKG_VAR}/data/mac.db" "${SYNOPKG_TEMP_UPGRADE_FOLDER}/backup/" 2>/dev/null || true
}

service_postupgrade() {
    if [ -f "${SYNOPKG_TEMP_UPGRADE_FOLDER}/backup/iventoy.conf" ]; then
        cp -p "${SYNOPKG_TEMP_UPGRADE_FOLDER}/backup/iventoy.conf" "${IVENTOY_CONF}"
    fi
    if [ -f "${SYNOPKG_TEMP_UPGRADE_FOLDER}/backup/htpasswd" ]; then
        cp -p "${SYNOPKG_TEMP_UPGRADE_FOLDER}/backup/htpasswd" "${NGINX_HTPASSWD}"
    fi
    if [ -f "${SYNOPKG_TEMP_UPGRADE_FOLDER}/backup/iventoy.dat" ]; then
        cp -p "${SYNOPKG_TEMP_UPGRADE_FOLDER}/backup/iventoy.dat" "${PKG_VAR}/data/"
    fi
    if [ -f "${SYNOPKG_TEMP_UPGRADE_FOLDER}/backup/mac.db" ]; then
        cp -p "${SYNOPKG_TEMP_UPGRADE_FOLDER}/backup/mac.db" "${PKG_VAR}/data/"
    fi
    generate_nginx_config
    link_var_dirs
}
SERVICE_SETUP_EOF

# 5. Redirect scripts (exact spksrc format)
for script in preinst postinst preuninst postuninst preupgrade postupgrade; do
    cat > "${PKG_WORK_DIR}/scripts/${script}" <<EOF
#!/bin/sh
. \$(dirname \$0)/installer
${script} >> \$\$SYNOPKG_TEMP_LOGFILE 2>&1
EOF
done

# Set permissions
chmod 755 "${PKG_WORK_DIR}/scripts/"*

ok "DSM7 scripts created"

# --- conf/ ---
log "Creating conf..."
mkdir -p "${PKG_WORK_DIR}/conf"

# DSM7 privilege (JSON format)
cat > "${PKG_WORK_DIR}/conf/privilege" <<'EOF'
{"defaults":{"run-as":"package"},"username":"sc-iventoy","groupname":"synocommunity"}
EOF

# resource file for firewall rules
cat > "${PKG_WORK_DIR}/conf/resource" <<EOF
{"port-config":{"protocol-file":"${DSM_UI_DIR}/iventoy.sc"}}
EOF

ok "Conf created"

# --- app/config (DSM UI) ---
log "Creating app/config..."
mkdir -p "${STAGING_DIR}/${DSM_UI_DIR}"
cat > "${STAGING_DIR}/${DSM_UI_DIR}/config" <<EOF
{".url":{"com.synocommunity.packages.${SPK_NAME}":{"title":"${DISPLAY_NAME}","desc":"${DESCRIPTION}","icon":"images/${SPK_NAME}-{0}.png","type":"url","protocol":"http","port":"${SERVICE_PORT}","url":"/","allUsers":true,"grantPrivilege":"all","advanceGrantPrivilege":true}}}
EOF

ok "App config created"

# --- WIZARD_UIFILES ---
log "Creating wizard UI files..."
mkdir -p "${PKG_WORK_DIR}/WIZARD_UIFILES"
cp "${SCRIPT_DIR}/src/wizard/install_uifile" "${PKG_WORK_DIR}/WIZARD_UIFILES/"

# --- LICENSE ---
cp "${SCRIPT_DIR}/LICENSE" "${PKG_WORK_DIR}/LICENSE"

# --- PACKAGE_ICON ---
log "Creating icons..."
# Minimal valid PNG (1x1 pixel)
MINIMAL_PNG='\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDAT\x08\xd7c\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa7\xf4\xd6\xb5\x8b\x00\x00\x00\x00IEND\xaeB`\x82'
printf "$MINIMAL_PNG" > "${PKG_WORK_DIR}/PACKAGE_ICON.PNG"
printf "$MINIMAL_PNG" > "${PKG_WORK_DIR}/PACKAGE_ICON_256.PNG"

# --- package.tgz ---
log "Creating package.tgz..."
(cd "${STAGING_DIR}" && find . -mindepth 1 -maxdepth 1 -not -empty | tar cpzf "${PKG_WORK_DIR}/package.tgz" --owner=root --group=root --files-from=/dev/stdin)

# --- INFO ---
log "Creating INFO..."
CHECKSUM=$(md5sum "${PKG_WORK_DIR}/package.tgz" | cut -d' ' -f1)

cat > "${PKG_WORK_DIR}/INFO" <<EOF
package="${SPK_NAME}"
version="${SPK_VERS}-${SPK_REV}"
description="${DESCRIPTION}"
arch="${SPK_ARCH}"
maintainer="${MAINTAINER}"
maintainer_url="https://github.com/${MAINTAINER}"
distributor="SynoCommunity"
distributor_url="https://synocommunity.com"
os_min_ver="${OS_MIN_VER}"
displayname="${DISPLAY_NAME}"
changelog="${CHANGELOG}"
helpurl="${HOMEPAGE}"
dsmappname="com.synocommunity.packages.${SPK_NAME}"
dsmuidir="${DSM_UI_DIR}"
ctl_stop="yes"
startable="yes"
support_conf_folder="yes"
install_dep_packages=""
checksum="${CHECKSUM}"
EOF

ok "INFO created (checksum: ${CHECKSUM})"

# --- Final .spk ---
SPK_CONTENT="package.tgz INFO scripts WIZARD_UIFILES LICENSE conf PACKAGE_ICON.PNG PACKAGE_ICON_256.PNG"
SPK_FILE="${WORK_DIR}/${SPK_NAME}_${SPK_ARCH}-${SPK_TCVERS}_${SPK_VERS}-${SPK_REV}.spk"
log "Creating .spk..."
(cd "${PKG_WORK_DIR}" && tar cpf "${SPK_FILE}" --group=root --owner=root ${SPK_CONTENT})

# Copy to script dir
cp "${SPK_FILE}" "${SCRIPT_DIR}/"

ok "Build complete!"
ok "SPK: ${SCRIPT_DIR}/${SPK_NAME}_${SPK_ARCH}-${SPK_TCVERS}_${SPK_VERS}-${SPK_REV}.spk"
ok "Size: $(du -h "${SPK_FILE}" | cut -f1)"