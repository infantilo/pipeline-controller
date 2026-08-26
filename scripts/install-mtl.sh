#!/usr/bin/env bash
# Baut Intel "Media Transport Library" (MTL, SMPTE ST2110 Stack für Intel-NICs
# wie E810) + das GStreamer-Plugin (mtl_st20p_tx/rx, mtl_st30p_tx/rx, …) aus
# den offiziellen Quellen:
#   https://github.com/OpenVisualCloud/Media-Transport-Library
# Schreibt env/mtl.env mit GST_PLUGIN_PATH/LD_LIBRARY_PATH — von server.js beim
# Start gesourced (siehe _earlyDataDir()-Loader am Anfang von server.js, analog
# zu env/mxl.env).
#
# ACHTUNG — im Unterschied zu install-mxl.sh (fertiges, sofort lauffähiges
# Ergebnis) braucht MTL zusätzlich NIC-seitige Vorbereitung, die pro Maschine
# unterschiedlich ist (PCI-Adresse/Interface-Name der E810-Ports, Anzahl Huge
# Pages, ggf. IOMMU/vfio-pci für den DPDK-Backend). Dieses Skript baut die
# Bibliothek + das Plugin und richtet Huge Pages ein — die NIC-Bindung
# (bind_e810.sh, Teil des MTL-Repos unter script/) muss DANACH manuell mit den
# echten PCI-IDs/Interface-Namen dieser Maschine ausgeführt werden; siehe
# Ausgabe am Ende dieses Skripts.
#
# Backend-Wahl (MTL_BACKEND):
#   af_xdp (Standard) — NIC bleibt am Kernel-ice-Treiber, kein PCI-Unbind nötig.
#                        Sicherer Default für eine Maschine, die die NIC evtl.
#                        auch für normalen Netzwerkverkehr braucht.
#   dpdk              — volles DPDK-Kernel-Bypass (vfio-pci), höherer Durchsatz/
#                        niedrigere Latenz, NIC-Port steht dem Kernel-Netzwerk-
#                        stack danach nicht mehr zur Verfügung.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MTL_SRC_DIR="${MTL_SRC_DIR:-$ROOT_DIR/third_party/mtl}"
MTL_BACKEND="${MTL_BACKEND:-af_xdp}"
MTL_HUGEPAGES_2M="${MTL_HUGEPAGES_2M:-2048}"   # Anzahl 2M-Hugepages (Standard: 4GB)

echo "== System-Pakete =="
sudo apt-get update -y
sudo apt-get install -y build-essential meson ninja-build pkg-config cmake \
  libnuma-dev libjson-c-dev libpcap-dev libssl-dev libsdl2-dev libsdl2-ttf-dev \
  systemtap-sdt-dev llvm clang libelf-dev git

echo "== Huge Pages (2M x ${MTL_HUGEPAGES_2M}) =="
echo "${MTL_HUGEPAGES_2M}" | sudo tee /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages >/dev/null
grep -q '^vm.nr_hugepages' /etc/sysctl.conf 2>/dev/null || \
  echo "vm.nr_hugepages=${MTL_HUGEPAGES_2M}" | sudo tee -a /etc/sysctl.conf >/dev/null

echo "== Clone/Update OpenVisualCloud/Media-Transport-Library =="
if [ -d "$MTL_SRC_DIR/.git" ]; then
  git -C "$MTL_SRC_DIR" pull --ff-only
else
  mkdir -p "$(dirname "$MTL_SRC_DIR")"
  git clone --depth 1 https://github.com/OpenVisualCloud/Media-Transport-Library "$MTL_SRC_DIR"
fi
cd "$MTL_SRC_DIR"

if [[ "$MTL_BACKEND" == "dpdk" ]]; then
  echo "== Build (DPDK-Backend, via offiziellem build.sh) =="
  # build.sh ist der von MTL dokumentierte Einstiegspunkt — baut die passende
  # gepatchte DPDK-Version mit und danach die Library selbst.
  ./build.sh
else
  echo "== Build (AF_XDP-Backend, via offiziellem build.sh --disable-dpdk-dep bzw. dokumentierter AF_XDP-Weg) =="
  # Manche MTL-Versionen bauen AF_XDP-Unterstützung automatisch mit, wenn keine
  # DPDK-Patches gewünscht sind — falls dieses Flag in der geklonten Version
  # anders heißt, siehe MTL_SRC_DIR/doc/ (build.sh --help) und ANPASSEN.
  ./build.sh --disable-dpdk-dep || ./build.sh
fi

echo "== Build GStreamer-Plugin (ecosystem/gstreamer_plugin) =="
cd "$MTL_SRC_DIR/ecosystem/gstreamer_plugin"
meson setup build --prefix="$MTL_SRC_DIR/gst-install"
ninja -C build
ninja -C build install

mkdir -p "$ROOT_DIR/env"
cat > "$ROOT_DIR/env/mtl.env" <<EOF
# Auto-generiert von scripts/install-mtl.sh — wird von server.js beim Start gesourced.
export MTL_BACKEND="$MTL_BACKEND"
export LD_LIBRARY_PATH="$MTL_SRC_DIR/build/lib:${LD_LIBRARY_PATH:-}"
export GST_PLUGIN_PATH="$MTL_SRC_DIR/gst-install/lib/x86_64-linux-gnu/gstreamer-1.0:$MTL_SRC_DIR/gst-install/lib/gstreamer-1.0:${GST_PLUGIN_PATH:-}"
EOF

echo
echo "== Verifikation (Plugin-Elemente sichtbar?) =="
# shellcheck disable=SC1090
source "$ROOT_DIR/env/mtl.env"
gst-inspect-1.0 mtl_st20p_tx | head -5 || echo "(mtl_st20p_tx nicht gefunden — GST_PLUGIN_PATH/Build prüfen)"
gst-inspect-1.0 mtl_st20p_rx | head -5 || true
gst-inspect-1.0 mtl_st30p_tx | head -5 || true
gst-inspect-1.0 mtl_st30p_rx | head -5 || true

cat <<'EOF'

Fertig. env/mtl.env wird ab jetzt automatisch von server.js geladen.

NÄCHSTER SCHRITT (manuell, maschinenspezifisch):
  Die E810-Port(s) müssen für MTL gebunden werden, BEVOR die App sie nutzen
  kann. PCI-Adresse/Interface-Name herausfinden:
    lspci | grep -i "Ethernet.*E810"
    ip link show
  Dann je nach Backend (Skripte liegen im MTL-Repo unter script/):
    AF_XDP:  sudo third_party/mtl/script/nicctl.sh af_xdp <interface>
    DPDK:    sudo third_party/mtl/script/nicctl.sh bind_pmd <pci-id>
  (Exakte Skriptnamen/Optionen können je nach geklonter MTL-Version leicht
  abweichen — siehe third_party/mtl/doc/ bzw. third_party/mtl/script/ selbst.)

WICHTIG: Die tatsächlichen Element-/Property-Namen (mtl_st20p_tx etc.) oben
per gst-inspect-1.0 verifizieren — die Pipeline-Fragmente in dieser App
(lib/OutputEngine.js, lib/AudioRouter.js, lib/ClockStrategy.js, server.js)
wurden nach der öffentlich dokumentierten MTL-GStreamer-Plugin-API gebaut,
aber noch NICHT gegen echten gst-inspect-1.0-Output dieser Maschine
verifiziert. Bei Abweichungen dort anpassen.
EOF
