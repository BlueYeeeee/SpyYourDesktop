#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

VERSION="$(node -p "require('./package.json').version")"
ARCH_ARG="${1:-amd64}"

case "$ARCH_ARG" in
  amd64|x64)
    DEB_ARCH="amd64"
    PKG_ARCH="x64"
    BIN_NAME="spy-your-desktop"
    ;;
  arm64|aarch64)
    DEB_ARCH="arm64"
    PKG_ARCH="arm64"
    BIN_NAME="spy-your-desktop-arm64"
    ;;
  *)
    echo "用法: $0 [amd64|arm64]" >&2
    exit 1
    ;;
esac

DIST_DIR="dist"
BINARY="$DIST_DIR/$BIN_NAME"
DEB_FILE="$DIST_DIR/spy-your-desktop_${VERSION}_${DEB_ARCH}.deb"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$DIST_DIR"

if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund
fi

echo "[build] pkg target=node22-linux-$PKG_ARCH"
./node_modules/.bin/pkg . \
  --targets "node22-linux-$PKG_ARCH" \
  --output "$BINARY"

chmod 0755 "$BINARY"
echo "[build] binary: $BINARY ($(du -h "$BINARY" | cut -f1))"

mkdir -p \
  "$STAGE/DEBIAN" \
  "$STAGE/usr/bin" \
  "$STAGE/usr/share/doc/spy-your-desktop"

install -m 0755 "$BINARY" "$STAGE/usr/bin/$BIN_NAME"
install -m 0644 README.md "$STAGE/usr/share/doc/spy-your-desktop/README.md"

cat > "$STAGE/usr/share/doc/spy-your-desktop/copyright" <<'EOF'
SpyYourDesktop Linux client
https://github.com/QQ1816/SpyYourDesktop

This package is built from the source tree in the Linux/ directory of the
SpyYourDesktop repository. See the repository for authorship and licensing
information.
EOF
chmod 0644 "$STAGE/usr/share/doc/spy-your-desktop/copyright"

INSTALLED_SIZE="$(du -sk "$STAGE/usr" | cut -f1)"
cat > "$STAGE/DEBIAN/control" <<EOF
Package: spy-your-desktop
Version: $VERSION
Section: utils
Priority: optional
Architecture: $DEB_ARCH
Maintainer: QQ1816 <3962118580@qq.com>
Installed-Size: $INSTALLED_SIZE
Depends: libc6 (>= 2.28), libstdc++6, libgcc-s1
Recommends: x11-utils
Suggests: xdotool, wlrctl
Homepage: https://github.com/QQ1816/SpyYourDesktop
Description: SpyYourDesktop Linux client (X11 / Wayland)
 Uploads the title and application name of the currently focused window to a
 SpyYourDesktop server. Supports KDE Plasma Wayland through the KWin D-Bus
 scripting API, GNOME Shell extensions / introspect, Sway/i3, Hyprland,
 wlroots (wlrctl), and X11 desktops.
 .
 The client never captures screenshots, keystrokes, clipboard contents, or
 file contents. Monitoring can be stopped at any time.
EOF

dpkg-deb --build --root-owner-group "$STAGE" "$DEB_FILE" >/dev/null
echo "[build] deb:    $DEB_FILE ($(du -h "$DEB_FILE" | cut -f1))"

(
  cd "$DIST_DIR"
  sha256sum "$BIN_NAME" "$(basename "$DEB_FILE")" > "SHA256SUMS"
)
echo "[build] sha256: $DIST_DIR/SHA256SUMS"
cat "$DIST_DIR/SHA256SUMS"
