#!/usr/bin/env python3
"""Render Bridge's brand mark into a 1024x1024 macOS app icon (PNG).

The mark is the same vector used in-app (app/renderer/index.html #brand-mark):
three rounded-square frames (outline only) stepping diagonally from the
bottom-left to the top-right, on an 89 x 70 viewBox.

Drawn white on the app's dark background (#12151d → #0b0d12 gradient) inside a
macOS-style rounded square. Pure numpy: each frame is a stroked rounded-rect
rendered from its signed distance field, the three strokes are unioned (max
coverage, so overlaps stay solid rather than XOR-cancelling), and edges are
anti-aliased by the distance to the stroke band (no Pillow/cairo dependency).
"""
import struct
import sys
import zlib

import numpy as np

SIZE = 1024
SS = 2                      # supersample factor
S = SIZE * SS

# macOS icon grid: rounded square inset from the full canvas with a large radius.
INSET = int(0.098 * S)     # ~100px @1024 padding
RADIUS = int(0.185 * S)    # ~185px @1024 corner radius

BG_TOP = (0x12, 0x15, 0x1d)     # slightly lifted #0f1117
BG_BOT = (0x0b, 0x0d, 0x12)     # --bg-elev
WHITE = (0xff, 0xff, 0xff)

# Brand mark: three overlapping frames on an 89 x 70 viewBox. Each frame is a
# 39x39 rounded square (corner radius 6) outlined with a stroke of width 4,
# stepping diagonally bottom-left → centre → top-right.
MARK_VB_W = 89.0
MARK_VB_H = 70.0
RECT_SIZE = 39.0
RECT_RADIUS = 6.0
RECT_STROKE = 4.0
RECT_ORIGINS = [(0.0, 31.0), (25.0, 15.5), (50.0, 0.0)]   # top-left corner of each frame

# Map the mark viewBox into the art area, centered with breathing room.
ART = S - 2 * INSET
MARK_SCALE = (ART * 0.66) / max(MARK_VB_W, MARK_VB_H)
MARK_OFFX = (S - MARK_VB_W * MARK_SCALE) / 2.0
MARK_OFFY = (S - MARK_VB_H * MARK_SCALE) / 2.0


def rounded_rect_sdf(xx, yy, cx, cy, hx, hy, r):
    """Signed distance to a rounded rectangle's border (<0 inside the solid)."""
    qx = np.abs(xx - cx) - (hx - r)
    qy = np.abs(yy - cy) - (hy - r)
    outside = np.sqrt(np.maximum(qx, 0.0) ** 2 + np.maximum(qy, 0.0) ** 2)
    inside = np.minimum(np.maximum(qx, qy), 0.0)
    return outside + inside - r


def mark_coverage(xx, yy):
    """Union of the three stroked frames as per-pixel coverage in [0, 1]."""
    half_stroke = (RECT_STROKE * 0.5) * MARK_SCALE
    half = (RECT_SIZE * 0.5) * MARK_SCALE
    r = RECT_RADIUS * MARK_SCALE
    aa = 1.2 * SS
    cov = np.zeros(xx.shape, dtype=np.float64)
    for ox, oy in RECT_ORIGINS:
        cx = MARK_OFFX + (ox + RECT_SIZE / 2.0) * MARK_SCALE
        cy = MARK_OFFY + (oy + RECT_SIZE / 2.0) * MARK_SCALE
        sdf = rounded_rect_sdf(xx, yy, cx, cy, half, half, r)
        band = np.abs(sdf) - half_stroke          # <0 within the stroke
        c = np.clip(0.5 - band / aa, 0.0, 1.0)
        cov = np.maximum(cov, c)                   # union, not XOR
    return cov


def rounded_rect_mask(yy, xx):
    cx_lo, cx_hi = INSET + RADIUS, S - INSET - RADIUS
    cy_lo, cy_hi = INSET + RADIUS, S - INSET - RADIUS
    inside = (xx >= INSET) & (xx <= S - INSET) & (yy >= INSET) & (yy <= S - INSET)
    for cx, cy in ((cx_lo, cy_lo), (cx_hi, cy_lo), (cx_lo, cy_hi), (cx_hi, cy_hi)):
        in_corner_box = ((xx < cx_lo) | (xx > cx_hi)) & ((yy < cy_lo) | (yy > cy_hi))
        d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
        inside &= ~(in_corner_box & (d > RADIUS) &
                    (np.abs(xx - cx) <= RADIUS + 1) & (np.abs(yy - cy) <= RADIUS + 1))
    return inside


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "icon_1024.png"
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float64)

    # --- background gradient inside the rounded square ---
    img = np.zeros((S, S, 4), dtype=np.float64)
    tgrad = (yy / S)[..., None]
    bg = (np.array(BG_TOP) * (1 - tgrad) + np.array(BG_BOT) * tgrad)
    mask = rounded_rect_mask(yy, xx).astype(np.float64)
    img[..., :3] = bg
    img[..., 3] = mask * 255.0

    # --- the mark: three unioned stroked frames, distance anti-aliased ---
    cov = mark_coverage(xx, yy)
    cov *= mask                                     # clip mark to the rounded square

    # composite white mark over background
    for c in range(3):
        img[..., c] = img[..., c] * (1 - cov) + WHITE[c] * cov
    img[..., 3] = np.maximum(img[..., 3], cov * 255.0)

    # --- downsample supersample -> final size (box average) ---
    img = img.reshape(SIZE, SS, SIZE, SS, 4).mean(axis=(1, 3))
    arr = np.clip(img + 0.5, 0, 255).astype(np.uint8)

    _write_png(out, arr)
    print(f"wrote {out} ({SIZE}x{SIZE})")


def _write_png(path, arr):
    h, w, _ = arr.shape
    raw = bytearray()
    for y in range(h):
        raw.append(0)                       # filter type 0
        raw.extend(arr[y].tobytes())
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
           chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    main()
