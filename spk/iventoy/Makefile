SPK_NAME = iventoy
SPK_VERS = 1.0.39
SPK_REV = 1
SPK_ICON = src/iventoy.png

UNSUPPORTED_ARCHS = $(ARMv5_ARCHS) $(ARMv7_ARCHS) $(ARMv8_ARCHS) $(PPC_ARCHS) $(i686_ARCHS)

MAINTAINER = omnimax
DESCRIPTION = iVentoy PXE Network Boot Server. Boot ISO images over network via PXE. Free Edition for personal/non-commercial use only (max 20 clients, x86_64 only).
DESCRIPTION_FRE = Serveur de démarrage réseau PXE iVentoy. Démarrez des images ISO via le réseau PXE. Édition gratuite pour usage personnel/non-commercial uniquement (max 20 clients, x86_64 uniquement).
DISPLAY_NAME = iVentoy
CHANGELOG = "Initial iVentoy v1.0.39 package for DSM 7.x. Free Edition (personal use)."
HOMEPAGE = https://www.ventoy.net/en/iventoy.html
LICENSE = Proprietary (Free Edition - Non-commercial use only)
STARTABLE = yes

DSM_UI_DIR = app
WIZARDS_DIR = src/wizard/

SERVICE_USER = root
SERVICE_SETUP = src/service-setup.sh
SERVICE_PORT = 26001
SERVICE_PORT_TITLE = iVentoy Web GUI (nginx reverse proxy + auth)
SERVICE_CERT = iventoy_webui

FWPORTS = src/iventoy.sc

DL_FILE = iventoy-$(SPK_VERS)-linux-x86_64-free.tar.gz
DL_URL  = https://github.com/ventoy/PXE/releases/download/v$(SPK_VERS)/$(DL_FILE)

EXTRACT_DIR = iventoy-$(SPK_VERS)

POST_STRIP_TARGET = iventoy_install_binary

include ../../mk/spksrc.spk.mk

.PHONY: iventoy_install_binary
iventoy_install_binary:
	@echo ">> Installing iVentoy binary bundle into staging dir"
	install -m 755 $(WORK_DIR)/$(EXTRACT_DIR)/iventoy.sh $(STAGING_DIR)/
	install -m 755 $(WORK_DIR)/$(EXTRACT_DIR)/lib/iventoy $(STAGING_DIR)/lib/
	cp -r $(WORK_DIR)/$(EXTRACT_DIR)/lib/lin64/. $(STAGING_DIR)/lib/
	install -m 755 src/iventoy-wrapper.sh $(STAGING_DIR)/
	cp -r $(WORK_DIR)/$(EXTRACT_DIR)/data $(STAGING_DIR)/data.init
	cp -r $(WORK_DIR)/$(EXTRACT_DIR)/driver $(STAGING_DIR)/driver.init
	cp -r $(WORK_DIR)/$(EXTRACT_DIR)/user $(STAGING_DIR)/user.init
	install -m 644 src/iventoy.conf $(STAGING_DIR)/
	install -m 644 src/iventoy.service $(STAGING_DIR)/
	install -m 644 src/nginx/iventoy.conf $(STAGING_DIR)/nginx/
	install -m 755 src/nginx/generate_htpasswd.sh $(STAGING_DIR)/nginx/