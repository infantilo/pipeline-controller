#!/usr/bin/env bash
# =============================================================================
# build_jammy_pkgroot.sh — Lädt GStreamer/ffmpeg/libstdc++ als Ubuntu-22.04-
# Pakete (.deb) herunter und extrahiert sie nach JAMMY_ROOT, ohne dass dafür
# Docker oder ein echtes chroot (mit Device-Nodes) nötig ist — nur Downloads
# + `dpkg -x` (reine Dateientpackung).
#
# Hintergrund: build_appimage.sh läuft typischerweise auf dem Entwickler-Host
# (z.B. Debian 12, glibc 2.36), das AppImage muss aber auf älteren Zielsystemen
# (Ubuntu 22.04, glibc 2.35) laufen. Werden GStreamer/ffmpeg/libstdc++ vom
# Build-Host gebündelt, können sie Glibc-Symbolversionen verlangen, die auf
# dem Ziel fehlen ("Lib fehlt"/"version `GLIBC_2.36' not found"), weil
# libc/pthread/dl/m/rt bewusst NICHT gebündelt werden (siehe copy_libs in
# build_appimage.sh) und stattdessen vom Zielsystem geladen werden.
#
# Lösung: die zu bündelnden .so-Dateien aus echten Ubuntu-22.04-Paketen
# holen, statt vom (neueren) Build-Host.
#
# Nutzung:
#   sudo apt-get install -y debootstrap   # liefert keine Keyring-Pakete für
#                                          # Ubuntu, daher wird die Keyring-
#                                          # .deb separat geholt (s.u.)
#   ./scripts/build_jammy_pkgroot.sh
#   JAMMY_ROOT=/opt/jammy-apt/extracted ./build_appimage.sh
#
# Voraussetzung: Internetzugang auf der BUILD-Maschine (nicht auf dem
# Zielsystem — das AppImage selbst braucht danach kein Internet mehr).
# =============================================================================
set -euo pipefail

JROOT="${JROOT:-/opt/jammy-apt}"
KEYRING_URL="http://archive.ubuntu.com/ubuntu/pool/main/u/ubuntu-keyring/ubuntu-keyring_2021.03.26_all.deb"

log()  { echo "[jammy-pkgroot] $*"; }

PKGS=(
    gstreamer1.0-tools
    gstreamer1.0-plugins-base
    gstreamer1.0-plugins-good
    gstreamer1.0-plugins-bad
    gstreamer1.0-plugins-ugly
    gstreamer1.0-libav
    gstreamer1.0-x
    gstreamer1.0-alsa
    gstreamer1.0-gl
    ffmpeg
    libstdc++6
    libgcc-s1
)

log "Ubuntu-Keyring holen..."
TMP_KEYRING_DIR="$(mktemp -d)"
curl -fsSL -o "${TMP_KEYRING_DIR}/ubuntu-keyring.deb" "$KEYRING_URL"
dpkg -x "${TMP_KEYRING_DIR}/ubuntu-keyring.deb" "${TMP_KEYRING_DIR}/extract"
KEYRING_GPG="${TMP_KEYRING_DIR}/extract/usr/share/keyrings/ubuntu-archive-keyring.gpg"

log "Apt-Root anlegen: ${JROOT}"
sudo mkdir -p "$JROOT"/{etc/apt/apt.conf.d,etc/apt/trusted.gpg.d,var/lib/dpkg,var/cache/apt/archives/partial,var/lib/apt/lists/partial}
sudo touch "$JROOT/var/lib/dpkg/status"
sudo cp "$KEYRING_GPG" "$JROOT/etc/apt/trusted.gpg.d/"
sudo bash -c "cat > '$JROOT/etc/apt/sources.list'" <<EOF
deb [signed-by=/etc/apt/trusted.gpg.d/ubuntu-archive-keyring.gpg] http://archive.ubuntu.com/ubuntu jammy main universe
deb [signed-by=/etc/apt/trusted.gpg.d/ubuntu-archive-keyring.gpg] http://archive.ubuntu.com/ubuntu jammy-updates main universe
deb [signed-by=/etc/apt/trusted.gpg.d/ubuntu-archive-keyring.gpg] http://security.ubuntu.com/ubuntu jammy-security main universe
EOF

APT_OPTS=(
    -o "Dir=$JROOT"
    -o "Dir::State::status=$JROOT/var/lib/dpkg/status"
    -o "APT::Architecture=amd64"
    -o "APT::Architectures=amd64"
    -o "Acquire::AllowInsecureRepositories=true"
    -o "APT::Get::AllowUnauthenticated=true"
)

log "apt-get update (jammy)..."
sudo apt-get "${APT_OPTS[@]}" update --allow-insecure-repositories

log "Pakete + Abhängigkeiten herunterladen: ${PKGS[*]}"
sudo apt-get "${APT_OPTS[@]}" install --download-only --no-install-recommends -y --allow-unauthenticated "${PKGS[@]}"

log "Entpacken nach ${JROOT}/extracted ..."
sudo mkdir -p "$JROOT/extracted"
for f in "$JROOT"/var/cache/apt/archives/*.deb; do
    sudo dpkg -x "$f" "$JROOT/extracted" 2>/dev/null || true
done

rm -rf "$TMP_KEYRING_DIR"
log "Fertig: ${JROOT}/extracted"
log "Build mit:  JAMMY_ROOT=${JROOT}/extracted ./build_appimage.sh"
