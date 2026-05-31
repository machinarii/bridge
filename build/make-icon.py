#!/usr/bin/env python3
"""Render Bridge's brand mark into a 1024x1024 macOS app icon (PNG).

The mark is the same vector used in-app (app/renderer/index.html #brand-mark):
three rounded "node" squares joined into a bridge, exported from Figma as a
single even-odd Union path on a 150 x 139.5 viewBox.

Drawn white on the app's dark background (#12151d → #0b0d12 gradient) inside a
macOS-style rounded square. Pure numpy: the path is flattened to polylines, the
fill is an even-odd crossing-number test, and edges are anti-aliased by the
signed distance to the path boundary (no Pillow/cairo dependency).
"""
import re
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

# Brand mark: Figma Union export (viewBox 0 0 150 139.5), even-odd fill.
MARK_VB_W = 150.0
MARK_VB_H = 139.5
MARK_PATH = (
    "M108 0C112.971 0 117 4.02944 117 9V19.5H123C131.284 19.5 138 26.2157 138 "
    "34.5V90H141C145.971 90 150 94.0294 150 99V130.5C150 135.471 145.971 139.5 "
    "141 139.5H109.5C104.529 139.5 100.5 135.471 100.5 130.5V126H46.5L46.1133 "
    "125.995C38.1362 125.793 31.7068 119.364 31.5049 111.387L31.5 111V105H9C4.02944 "
    "105 2.41604e-07 100.971 0 96V49.5C2.41604e-07 44.5294 4.02944 40.5 9 40.5H31.5"
    "V34.5C31.5 26.2157 38.2157 19.5 46.5 19.5H76.5V9C76.5 4.02944 80.5294 "
    "3.62394e-08 85.5 0H108ZM46.5 25.5C41.5294 25.5 37.5 29.5294 37.5 34.5V40.5H55.5"
    "C60.4706 40.5 64.5 44.5294 64.5 49.5V96C64.5 100.971 60.4706 105 55.5 105H37.5"
    "V111C37.5 115.971 41.5294 120 46.5 120H100.5V99C100.5 94.0294 104.529 90 109.5 "
    "90H132V34.5C132 29.5294 127.971 25.5 123 25.5H117V31.5C117 36.4706 112.971 40.5 "
    "108 40.5H85.5C80.5294 40.5 76.5 36.4706 76.5 31.5V25.5H46.5Z"
)

# Map the mark viewBox into the art area, centered with breathing room.
ART = S - 2 * INSET
MARK_SCALE = (ART * 0.62) / max(MARK_VB_W, MARK_VB_H)
MARK_OFFX = (S - MARK_VB_W * MARK_SCALE) / 2.0
MARK_OFFY = (S - MARK_VB_H * MARK_SCALE) / 2.0


_CMD = set("MmLlHhVvCcSsQqTtAaZz")
_NUM_RE = re.compile(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")


def _tokenize(d):
    """Yield (command, [floats]) tuples for an SVG path (absolute cmds only).

    Note: 'e'/'E' are NOT command letters here — they belong to scientific
    notation (e.g. 2.41604e-07), so only real path commands split the stream.
    """
    i, n = 0, len(d)
    while i < n:
        c = d[i]
        if c in _CMD:
            i += 1
            j = i
            while j < n and d[j] not in _CMD:
                j += 1
            nums = [float(m.group()) for m in _NUM_RE.finditer(d[i:j])]
            yield c, nums
            i = j
        else:
            i += 1


def _bezier(p0, p1, p2, p3, segs=22):
    t = np.linspace(0, 1, segs + 1)[1:]   # skip t=0 (== p0, already added)
    mt = 1 - t
    x = (mt**3) * p0[0] + 3 * (mt**2) * t * p1[0] + 3 * mt * (t**2) * p2[0] + (t**3) * p3[0]
    y = (mt**3) * p0[1] + 3 * (mt**2) * t * p1[1] + 3 * mt * (t**2) * p2[1] + (t**3) * p3[1]
    return list(zip(x.tolist(), y.tolist()))


def parse_path(d):
    """Return a list of subpaths, each a list of (x, y) points in pixel space."""
    def vb(x, y):
        return (MARK_OFFX + x * MARK_SCALE, MARK_OFFY + y * MARK_SCALE)

    subpaths = []
    cur = None          # current subpath (list of points)
    start = (0.0, 0.0)  # subpath start (for Z)
    cx = cy = 0.0
    for cmd, nums in _tokenize(d):
        if cmd == "M":
            if cur:
                subpaths.append(cur)
            cx, cy = nums[0], nums[1]
            start = (cx, cy)
            cur = [vb(cx, cy)]
        elif cmd == "L":
            cx, cy = nums[0], nums[1]
            cur.append(vb(cx, cy))
        elif cmd == "H":
            cx = nums[0]
            cur.append(vb(cx, cy))
        elif cmd == "V":
            cy = nums[0]
            cur.append(vb(cx, cy))
        elif cmd == "C":
            for k in range(0, len(nums), 6):
                p0 = vb(cx, cy)
                p1 = vb(nums[k], nums[k + 1])
                p2 = vb(nums[k + 2], nums[k + 3])
                p3 = vb(nums[k + 4], nums[k + 5])
                cur.extend(_bezier(p0, p1, p2, p3))
                cx, cy = nums[k + 4], nums[k + 5]
        elif cmd in ("Z", "z"):
            cur.append(vb(*start))
            cx, cy = start
    if cur:
        subpaths.append(cur)
    return subpaths


def edges_from_subpaths(subpaths):
    """Flatten all subpaths to a single (M, 2, 2) array of segment endpoints."""
    segs = []
    for sp in subpaths:
        for a, b in zip(sp[:-1], sp[1:]):
            segs.append((a, b))
    return np.array(segs, dtype=np.float64)   # (M, 2, 2): [seg][a/b][x/y]


def even_odd_inside(xx, yy, edges):
    """Crossing-number parity for each pixel (even-odd fill rule)."""
    flatx = xx.ravel()
    flaty = yy.ravel()
    crossings = np.zeros(flatx.shape, dtype=np.int32)
    for (ax, ay), (bx, by) in edges:
        cond = (ay > flaty) != (by > flaty)
        # x of the edge at height flaty
        denom = (by - ay)
        denom = denom if denom != 0 else 1e-9
        xint = ax + (flaty - ay) * (bx - ax) / denom
        crossings += (cond & (flatx < xint)).astype(np.int32)
    return ((crossings & 1) == 1).reshape(xx.shape)


def dist_to_edges(xx, yy, edges):
    """Min distance from each pixel to the set of boundary segments."""
    flatx = xx.ravel()
    flaty = yy.ravel()
    best = np.full(flatx.shape, 1e18, dtype=np.float64)
    for (ax, ay), (bx, by) in edges:
        abx, aby = bx - ax, by - ay
        ab2 = abx * abx + aby * aby
        if ab2 == 0:
            ab2 = 1e-9
        t = ((flatx - ax) * abx + (flaty - ay) * aby) / ab2
        np.clip(t, 0.0, 1.0, out=t)
        dx = flatx - (ax + t * abx)
        dy = flaty - (ay + t * aby)
        np.minimum(best, dx * dx + dy * dy, out=best)
    return np.sqrt(best).reshape(xx.shape)


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

    # --- the mark: even-odd fill with distance-based anti-aliasing ---
    edges = edges_from_subpaths(parse_path(MARK_PATH))
    inside = even_odd_inside(xx, yy, edges)
    dist = dist_to_edges(xx, yy, edges)
    aa = 1.2 * SS
    signed = np.where(inside, -dist, dist)          # <0 inside
    cov = np.clip(0.5 - signed / aa, 0.0, 1.0)
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
