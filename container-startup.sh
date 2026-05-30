#!/usr/bin/env bash
#
# container-startup.sh — run at container start to install the packages Proton
# Bridge needs and launch it headless in the background.
#
# Designed to be the "startup script" hook of an already-built image: it returns
# after Bridge is up so the container's main process keeps running. Idempotent —
# on a warm container it skips installs and re-uses the existing keychain.
#
# It does NOT log Bridge into your account: that one-time step needs your Proton
# password + 2FA and is done interactively (see the note at the end). For the
# login to persist, mount a volume over $HOME so the keychain + Bridge vault
# survive container restarts.

set -euo pipefail

GPG_KEY_NAME="${GPG_KEY_NAME:-ProtonMail Bridge}"
BRIDGE_VERSION="${BRIDGE_VERSION:-3.21.2}"
BRIDGE_DEB_URL="${BRIDGE_DEB_URL:-https://proton.me/download/bridge/protonmail-bridge_${BRIDGE_VERSION}-1_amd64.deb}"
LOG_FILE="${BRIDGE_LOG_FILE:-$HOME/protonmail-bridge.log}"
export GNUPGHOME="${GNUPGHOME:-$HOME/.gnupg}"
export PASSWORD_STORE_DIR="${PASSWORD_STORE_DIR:-$HOME/.password-store}"
# Bridge v3 runs even its headless modes through a bundled Qt binary; the
# "offscreen" platform lets it initialise with no display/GPU.
export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-offscreen}"

log() { printf '[startup] %s\n' "$*" >&2; }

# Use sudo only if we aren't already root (containers usually run this as root).
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
export DEBIAN_FRONTEND=noninteractive

# --- 1. base packages (skip if already present) ------------------------------
if ! command -v pass >/dev/null 2>&1 \
  || ! command -v gpg >/dev/null 2>&1 \
  || ! command -v curl >/dev/null 2>&1; then
  log "Installing base packages (curl, ca-certificates, gnupg, pass)…"
  $SUDO apt-get update -y
  $SUDO apt-get install -y --no-install-recommends ca-certificates gnupg pass curl
fi

# --- 1b. Qt/OpenGL runtime libs for Bridge v3 --------------------------------
# Bridge v3 launches everything (even --cli / --noninteractive) through its
# bundled Qt "bridge-gui", which links OpenGL. A headless image lacks those
# libs (the telltale error is "libGLX.so.0: cannot open shared object file").
# Install them only if libGLX is actually missing, so warm containers skip it.
if ! ldconfig -p 2>/dev/null | grep -q 'libOpenGL\.so\.0'; then
  log "Installing Qt/OpenGL runtime libs for headless Bridge…"
  $SUDO apt-get update -y
  $SUDO apt-get install -y --no-install-recommends \
    libgl1 libopengl0 libegl1 libxkbcommon0 libdbus-1-3 fontconfig
fi

# --- 2. Proton Bridge (skip if already installed) ----------------------------
if ! command -v protonmail-bridge >/dev/null 2>&1; then
  log "Downloading Proton Bridge: $BRIDGE_DEB_URL"
  tmp_deb="$(mktemp --suffix=.deb)"
  if ! curl -fL --retry 3 -o "$tmp_deb" "$BRIDGE_DEB_URL"; then
    rm -f "$tmp_deb"
    log "Bridge download failed — set BRIDGE_DEB_URL to the current version from"
    log "https://proton.me/mail/bridge#download and restart."
    exit 1
  fi
  $SUDO apt-get install -y --no-install-recommends "$tmp_deb"
  rm -f "$tmp_deb"
fi

# --- 3. keychain backend (GnuPG + pass) --------------------------------------
# Bridge stores credentials in a Secret Service; on a headless box `pass` is the
# supported backend and needs a GPG key + an initialised store.
mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"
if ! gpg --list-secret-keys "$GPG_KEY_NAME" >/dev/null 2>&1; then
  log "Generating GnuPG key for the keychain (no passphrase)…"
  gpg --batch --passphrase '' --quick-gen-key "$GPG_KEY_NAME" default default never
fi
if [ ! -f "$PASSWORD_STORE_DIR/.gpg-id" ]; then
  log "Initialising pass store…"
  fpr="$(gpg --list-secret-keys --with-colons "$GPG_KEY_NAME" \
          | awk -F: '/^fpr:/ {print $10; exit}')"
  [ -n "$fpr" ] || { log "could not resolve GPG fingerprint"; exit 1; }
  pass init "$fpr" >/dev/null
fi

# --- 4. start Bridge in the background ----------------------------------------
if command -v pgrep >/dev/null 2>&1 && pgrep -x protonmail-bridge >/dev/null 2>&1; then
  log "Proton Bridge already running."
else
  log "Starting Proton Bridge (noninteractive) → $LOG_FILE"
  nohup protonmail-bridge --noninteractive >>"$LOG_FILE" 2>&1 &
  disown || true

  # Give the local IMAP listener a moment to come up so the MCP can connect
  # right away. Non-fatal: if it isn't ready in time we continue anyway.
  for _ in $(seq 1 30); do
    if (exec 3<>/dev/tcp/127.0.0.1/1143) 2>/dev/null; then
      exec 3>&- 3<&- || true
      log "Bridge IMAP is listening on 127.0.0.1:1143."
      break
    fi
    sleep 1
  done
fi

log "Startup complete."
log "One-time login (interactive, separate):"
log "  QT_QPA_PLATFORM=offscreen protonmail-bridge --cli   →  login"
