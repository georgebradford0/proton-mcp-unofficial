#!/usr/bin/env bash
#
# install-debian.sh — set up everything needed to run proton-mcp on a Debian
# (or Ubuntu) system, including a headless server with no GUI.
#
# It installs:
#   - base tools (curl, gnupg, ca-certificates)
#   - `pass` + GnuPG, and initialises them as Proton Bridge's keychain backend
#     (Bridge refuses to start without a Secret Service; `pass` is the headless
#     answer)
#   - Node.js 22 (via NodeSource) if a recent enough Node isn't already present
#   - Proton Mail Bridge (.deb)
#   - this MCP's npm dependencies + a compiled build
#
# Safe to re-run: every step checks whether it's already done.
#
# Usage:
#   ./install-debian.sh
#
# Override the Bridge download if the default version 404s (check the current
# version at https://proton.me/mail/bridge#download):
#   BRIDGE_DEB_URL="https://proton.me/download/bridge/protonmail-bridge_X.Y.Z-1_amd64.deb" ./install-debian.sh

set -euo pipefail

# --- config ------------------------------------------------------------------
NODE_MAJOR_MIN=18
NODE_INSTALL_MAJOR=22
BRIDGE_VERSION="${BRIDGE_VERSION:-3.21.2}"
BRIDGE_DEB_URL="${BRIDGE_DEB_URL:-https://proton.me/download/bridge/protonmail-bridge_${BRIDGE_VERSION}-1_amd64.deb}"
GPG_KEY_NAME="ProtonMail Bridge"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- helpers -----------------------------------------------------------------
log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Run a command as root, using sudo only when we aren't already root.
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  command -v sudo >/dev/null 2>&1 || die "Please run as root or install sudo."
  SUDO="sudo"
fi

# --- sanity checks -----------------------------------------------------------
command -v apt-get >/dev/null 2>&1 || die "This script targets Debian/Ubuntu (apt-get not found)."

ARCH="$(dpkg --print-architecture)"
if [ "$ARCH" != "amd64" ]; then
  warn "Proton Bridge only ships an amd64 .deb; detected '$ARCH'. Bridge install may fail."
fi

# --- 1. base packages --------------------------------------------------------
log "Installing base packages (curl, gnupg, pass, ca-certificates)..."
$SUDO apt-get update -y
$SUDO apt-get install -y curl ca-certificates gnupg pass

# --- 2. Node.js --------------------------------------------------------------
need_node=1
if command -v node >/dev/null 2>&1; then
  current_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${current_major:-0}" -ge "$NODE_MAJOR_MIN" ]; then
    log "Node.js $(node -v) already present (>= ${NODE_MAJOR_MIN}); skipping."
    need_node=0
  else
    warn "Node.js $(node -v) is older than v${NODE_MAJOR_MIN}; installing newer."
  fi
fi
if [ "$need_node" -eq 1 ]; then
  log "Installing Node.js ${NODE_INSTALL_MAJOR}.x via NodeSource..."
  # `-E` (preserve env) is a sudo flag, so only pass it when sudo is in use.
  if [ -n "$SUDO" ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x" | $SUDO -E bash -
  else
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x" | bash -
  fi
  $SUDO apt-get install -y nodejs
  log "Installed Node.js $(node -v)."
fi

# --- 3. GnuPG key + pass store (Bridge keychain) -----------------------------
# Proton Bridge stores its credentials in a Secret Service. On a headless box
# the supported backend is `pass`, which needs a GPG key and an initialised
# password store.
if gpg --list-secret-keys "$GPG_KEY_NAME" >/dev/null 2>&1; then
  log "GPG key '$GPG_KEY_NAME' already exists; skipping key generation."
else
  log "Generating a GPG key for the keychain (no passphrase, headless use)..."
  gpg --batch --passphrase '' --quick-gen-key "$GPG_KEY_NAME" default default never
fi

if [ -f "${PASSWORD_STORE_DIR:-$HOME/.password-store}/.gpg-id" ]; then
  log "pass store already initialised; skipping."
else
  log "Initialising pass store with the Bridge GPG key..."
  # Resolve the key fingerprint so `pass init` is unambiguous.
  fpr="$(gpg --list-secret-keys --with-colons "$GPG_KEY_NAME" \
          | awk -F: '/^fpr:/ {print $10; exit}')"
  [ -n "$fpr" ] || die "Could not resolve GPG fingerprint for '$GPG_KEY_NAME'."
  pass init "$fpr"
fi

# --- 4. Proton Mail Bridge ---------------------------------------------------
if command -v protonmail-bridge >/dev/null 2>&1; then
  log "Proton Bridge already installed: $(protonmail-bridge --version 2>/dev/null | head -1 || echo present)."
else
  log "Downloading Proton Bridge from: $BRIDGE_DEB_URL"
  tmp_deb="$(mktemp --suffix=.deb)"
  if ! curl -fL --retry 3 -o "$tmp_deb" "$BRIDGE_DEB_URL"; then
    rm -f "$tmp_deb"
    die "Bridge download failed. Find the current version at \
https://proton.me/mail/bridge#download and re-run with BRIDGE_DEB_URL=<url>."
  fi
  log "Installing Proton Bridge (resolving dependencies)..."
  $SUDO apt-get install -y "$tmp_deb"
  rm -f "$tmp_deb"
fi

# --- 5. Build the MCP --------------------------------------------------------
log "Installing MCP dependencies and building (in $SCRIPT_DIR)..."
cd "$SCRIPT_DIR"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
npm run build

# --- done --------------------------------------------------------------------
cat <<'EOF'

============================================================
 Install complete. Next steps:
============================================================

1. Log Proton Bridge into your account (one time, interactive):

     protonmail-bridge --cli

   At the prompt:
     >>> login            # enter your Proton email + password (+ 2FA)
     >>> change-keychain  # if asked, choose: pass
     >>> info             # shows IMAP/SMTP host, ports, and the
                          # BRIDGE-SPECIFIC password — copy these
     >>> exit

2. Keep Bridge running in the background (e.g. tmux, or a systemd
   --user service):

     protonmail-bridge --noninteractive

3. Configure the MCP with the values from `info`, e.g.:

     export PROTON_BRIDGE_USERNAME="you@proton.me"
     export PROTON_BRIDGE_PASSWORD="<bridge-specific-password>"
     # defaults assume host 127.0.0.1, IMAP 1143, SMTP 1025

4. Register it with your MCP client, pointing at:

     node SCRIPT_DIR/dist/index.js

============================================================
EOF
# Substitute the real path into the final hint above.
printf 'Resolved MCP entrypoint: %s/dist/index.js\n' "$SCRIPT_DIR"
