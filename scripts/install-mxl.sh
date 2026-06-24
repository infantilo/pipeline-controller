#!/usr/bin/env bash
# Baut EBU/AMWA DMF "Media eXchange Layer" (libmxl, C++ SDK) + das gst-mxl-rs
# GStreamer-Plugin (mxlsrc/mxlsink) aus den offiziellen Quellen:
#   https://github.com/dmf-mxl/mxl
# Schreibt env/mxl.env mit GST_PLUGIN_PATH/LD_LIBRARY_PATH — von server.js beim
# Start gesourced (siehe Top von server.js).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MXL_SRC_DIR="${MXL_SRC_DIR:-$ROOT_DIR/third_party/mxl}"
MXL_PRESET="${MXL_PRESET:-Linux-GCC-Release}"
MXL_DOMAIN="${MXL_DOMAIN:-/dev/shm/mxl}"

echo "== System-Pakete (cmake, build-essential, pkg-config) =="
if ! command -v cmake >/dev/null; then
  sudo apt-get update -y
  sudo apt-get install -y cmake build-essential pkg-config curl git ninja-build
fi

if ! command -v cargo >/dev/null; then
  echo "== Rust-Toolchain (rustup) =="
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

echo "== Clone/Update dmf-mxl/mxl =="
if [ -d "$MXL_SRC_DIR/.git" ]; then
  git -C "$MXL_SRC_DIR" pull --ff-only
else
  mkdir -p "$(dirname "$MXL_SRC_DIR")"
  git clone --depth 1 https://github.com/dmf-mxl/mxl "$MXL_SRC_DIR"
fi

echo "== Build libmxl (CMake Preset: $MXL_PRESET) =="
cd "$MXL_SRC_DIR"
cmake --preset "$MXL_PRESET"
cmake --build "build/$MXL_PRESET" --parallel "$(nproc)"
MXL_BUILD_DIR="$MXL_SRC_DIR/build/$MXL_PRESET"

echo "== Build gst-mxl-rs Plugin (mxlsrc/mxlsink) =="
cd "$MXL_SRC_DIR/rust/gst-mxl-rs"
# shellcheck disable=SC1091
source "$HOME/.cargo/env" 2>/dev/null || true
LD_LIBRARY_PATH="$MXL_BUILD_DIR/lib:$MXL_BUILD_DIR/lib/internal:${LD_LIBRARY_PATH:-}" \
  cargo build --release

mkdir -p "$ROOT_DIR/env"
cat > "$ROOT_DIR/env/mxl.env" <<EOF
# Auto-generiert von scripts/install-mxl.sh — wird von server.js beim Start gesourced.
export MXL_DOMAIN="$MXL_DOMAIN"
export LD_LIBRARY_PATH="$MXL_BUILD_DIR/lib:$MXL_BUILD_DIR/lib/internal:\${LD_LIBRARY_PATH:-}"
export GST_PLUGIN_PATH="$MXL_SRC_DIR/rust/target/release:\${GST_PLUGIN_PATH:-}"
export PATH="$MXL_BUILD_DIR/tools/mxl-info:\$PATH"
export MXL_INFO_BIN="$MXL_BUILD_DIR/tools/mxl-info/mxl-info"
EOF

mkdir -p "$MXL_DOMAIN"

echo "== Verifikation =="
# shellcheck disable=SC1090
source "$ROOT_DIR/env/mxl.env"
gst-inspect-1.0 mxlsrc  | head -3
gst-inspect-1.0 mxlsink | head -3
"$MXL_INFO_BIN" -d "$MXL_DOMAIN" -l || echo "(Domain '$MXL_DOMAIN' noch leer — ok beim ersten Lauf)"

echo
echo "Fertig. env/mxl.env wird ab jetzt automatisch von server.js geladen."
echo "Test-Feed erzeugen: $MXL_BUILD_DIR/utils/mxl-gst-testsrc -d $MXL_DOMAIN -v $MXL_SRC_DIR/lib/tests/data/v210_flow.json"
