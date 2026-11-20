"""JDraw slop checker.

Reads one drawing as JSON on stdin and prints the problems it finds as JSON.
It checks the tells the user keeps rejecting in JSlop that can be measured:
loose marks, scattered dots, copy-pasted shapes, stacked-triangle trees,
primitive-only drawings, objects lined up in a row, see-through light
wedges, gradients on everything, multicolor text, and (from the rendered
picture) gray, muddy, low-contrast or purple color, a centered mirror-symmetric
subject and a horizon through the middle. Composition: an object that grazes
the canvas edge, two objects that almost touch, an object that hangs in the
air, the same shape repeated with small changes, detail spread evenly with
no quiet area, and full-strength color over most of the picture.

Input:  {"width", "height", "png": base64 PNG of the whole canvas,
         "svgs": [{"svg": "<svg ...>", "x", "y", "w", "h", "name", "layer",
                   "native": bool}],
         "ask": what the person asked for (optional),
         "clean": true when they asked for an icon, logo, diagram or other
                  clean flat look (the scene rules are skipped)}
Output: {"ok": bool, "issues": [{"rule", "title", "detail", "where", "fix"}],
         "stats": {...}}

Run: python slop_check.py < drawing.json
"""

import base64
import io
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict

try:
    from PIL import Image
except ImportError:  # the shape checks still run without Pillow
    Image = None

NUM = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
CMD = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def tag(el):
    return el.tag.split("}")[-1]


def fnum(v, d=0.0):
    try:
        return float(NUM.match(str(v).strip()).group(0))
    except Exception:
        return d


def style_of(el, inherited):
    """Paint and opacity for an element, with inheritance from parent groups."""
    st = dict(inherited)
    for k in ("fill", "stroke", "opacity", "fill-opacity", "stroke-dasharray", "stroke-width"):
        if el.get(k) is not None:
            st[k] = el.get(k)
    for part in (el.get("style") or "").split(";"):
        if ":" in part:
            k, v = part.split(":", 1)
            k = k.strip()
            if k in ("fill", "stroke", "opacity", "fill-opacity", "stroke-dasharray", "stroke-width"):
                st[k] = v.strip()
    if el.get("opacity") is not None:
        st["_op"] = st.get("_op", 1.0) * fnum(el.get("opacity"), 1.0)
    return st


def translate_of(el):
    """Only translate and scale are followed; that covers almost every agent SVG."""
    t = el.get("transform") or ""
    dx = dy = 0.0
    sx = sy = 1.0
    m = re.search(r"translate\(\s*([-\d.e+]+)[ ,]*([-\d.e+]*)", t)
    if m:
        dx = float(m.group(1))
        dy = float(m.group(2) or 0)
    m = re.search(r"scale\(\s*([-\d.e+]+)[ ,]*([-\d.e+]*)", t)
    if m:
        sx = float(m.group(1))
        sy = float(m.group(2) or m.group(1))
    return dx, dy, sx, sy


def path_points(d):
    """Every point and control point of a path, absolute. Good enough for boxes."""
    toks = CMD.findall(d or "")
    pts = []
    starts = []
    x = y = sx = sy = 0.0
    cmd = None
    i = 0
    nverts = 0

    def take(n):
        nonlocal i
        vals = []
        for _ in range(n):
            if i >= len(toks) or re.match(r"[A-Za-z]", toks[i]):
                raise StopIteration
            vals.append(float(toks[i]))
            i += 1
        return vals

    try:
        while i < len(toks):
            if re.match(r"[A-Za-z]", toks[i]):
                cmd = toks[i]
                i += 1
                if cmd in "Zz":
                    x, y = sx, sy
                    continue
            if cmd is None:
                break
            rel = cmd.islower()
            c = cmd.upper()
            if c == "M":
                a, b = take(2)
                x, y = (x + a, y + b) if rel else (a, b)
                sx, sy = x, y
                starts.append(len(pts))
                pts.append((x, y))
                nverts += 1
                cmd = "l" if rel else "L"
            elif c == "L" or c == "T":
                a, b = take(2)
                x, y = (x + a, y + b) if rel else (a, b)
                pts.append((x, y))
                nverts += 1
            elif c == "H":
                (a,) = take(1)
                x = x + a if rel else a
                pts.append((x, y))
                nverts += 1
            elif c == "V":
                (b,) = take(1)
                y = y + b if rel else b
                pts.append((x, y))
                nverts += 1
            elif c in "CSQ":
                n = {"C": 6, "S": 4, "Q": 4}[c]
                v = take(n)
                for k in range(0, n, 2):
                    px, py = (x + v[k], y + v[k + 1]) if rel else (v[k], v[k + 1])
                    pts.append((px, py))
                x, y = pts[-1]
                nverts += 1
            elif c == "A":
                v = take(7)
                x, y = (x + v[5], y + v[6]) if rel else (v[5], v[6])
                pts.append((x, y))
                nverts += 1
            else:
                i += 1
    except StopIteration:
        pass
    curved = bool(re.search(r"[CcSsQqTtAa]", d or ""))
    path_points.starts = starts
    return pts, nverts, curved


def flatten_path(d):
    """Each subpath of a path as a polyline with its curves sampled. Arcs are cut straight."""
    toks = CMD.findall(d or "")
    subs = []
    cur = None
    x = y = sx = sy = 0.0
    cmd = None
    i = 0
    last_c = None

    def take(n):
        nonlocal i
        vals = []
        for _ in range(n):
            if i >= len(toks) or re.match(r"[A-Za-z]", toks[i]):
                raise StopIteration
            vals.append(float(toks[i]))
            i += 1
        return vals

    def bez(p0, c1, c2, p1):
        for t in (0.25, 0.5, 0.75, 1.0):
            u = 1 - t
            cur.append((u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
                        u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1]))

    try:
        while i < len(toks):
            if re.match(r"[A-Za-z]", toks[i]):
                cmd = toks[i]
                i += 1
                if cmd in "Zz":
                    x, y = sx, sy
                    last_c = None
                    continue
            if cmd is None:
                break
            rel = cmd.islower()
            c = cmd.upper()
            ab = (lambda a, b: (x + a, y + b)) if rel else (lambda a, b: (a, b))
            if c == "M":
                x, y = ab(*take(2))
                sx, sy = x, y
                cur = [(x, y)]
                subs.append(cur)
                cmd = "l" if rel else "L"
                last_c = None
                continue
            if cur is None:
                cur = [(x, y)]
                subs.append(cur)
            if c == "L":
                x, y = ab(*take(2))
                cur.append((x, y))
            elif c == "H":
                (a,) = take(1)
                x = x + a if rel else a
                cur.append((x, y))
            elif c == "V":
                (b,) = take(1)
                y = y + b if rel else b
                cur.append((x, y))
            elif c == "C":
                v = take(6)
                c1, c2, p1 = ab(v[0], v[1]), ab(v[2], v[3]), ab(v[4], v[5])
                bez((x, y), c1, c2, p1)
                x, y = p1
                last_c = c2
                continue
            elif c == "S":
                v = take(4)
                c1 = (2 * x - last_c[0], 2 * y - last_c[1]) if last_c else (x, y)
                c2, p1 = ab(v[0], v[1]), ab(v[2], v[3])
                bez((x, y), c1, c2, p1)
                x, y = p1
                last_c = c2
                continue
            elif c == "Q":
                v = take(4)
                q, p1 = ab(v[0], v[1]), ab(v[2], v[3])
                bez((x, y), (x + 2 / 3 * (q[0] - x), y + 2 / 3 * (q[1] - y)), (p1[0] + 2 / 3 * (q[0] - p1[0]), p1[1] + 2 / 3 * (q[1] - p1[1])), p1)
                x, y = p1
            elif c == "T":
                x, y = ab(*take(2))
                cur.append((x, y))
            elif c == "A":
                v = take(7)
                x, y = ab(v[5], v[6])
                cur.append((x, y))
            else:
                i += 1
            last_c = None
    except StopIteration:
        pass
    return [sp for sp in subs if len(sp) >= 2]


def subpaths(d):
    """Absolute points of each subpath of a path (relative m handled)."""
    pts, _, curved = path_points(d)
    starts = list(path_points.starts) or [0]
    out = []
    for k, a in enumerate(starts):
        b = starts[k + 1] if k + 1 < len(starts) else len(pts)
        if b - a >= 1:
            out.append(pts[a:b])
    return out, curved


class Shape:
    def __init__(self, kind, box, fill, stroke, op, nverts, curved, sig, dash, text_fill=None, where="", pts=None, outline=None, item=None, own=False):
        self.kind = kind  # rect circle ellipse line polyline polygon path text
        self.box = box  # x0 y0 x1 y1 in canvas pixels
        self.fill = fill
        self.stroke = stroke
        self.op = op
        self.nverts = nverts
        self.curved = curved
        self.sig = sig
        self.dash = dash
        self.text_fill = text_fill
        self.where = where
        self.pts = pts or []
        # The outline with its curves sampled, in canvas pixels.
        self.outline = outline or []
        # Which placed SVG it came from; shapes JDraw added itself are "own".
        self.item = item
        self.own = own

    @property
    def w(self):
        return self.box[2] - self.box[0]

    @property
    def h(self):
        return self.box[3] - self.box[1]

    @property
    def filled(self):
        f = (self.fill or "").strip().lower()
        return f not in ("", "none", "transparent")

    @property
    def stroked(self):
        s = (self.stroke or "").strip().lower()
        return s not in ("", "none", "transparent")


def parse_svg(entry, out, index=0):
    """Turns one SVG (an agent's draw_svg item, or the native items) into Shapes in canvas pixels."""
    first = len(out)
    try:
        root = ET.fromstring(entry.get("svg") or "")
    except ET.ParseError:
        return
    vb = (root.get("viewBox") or "").replace(",", " ").split()
    if len(vb) == 4:
        vx, vy, vw, vh = map(float, vb)
    else:
        vx, vy = 0.0, 0.0
        vw = fnum(root.get("width"), entry.get("w") or 1)
        vh = fnum(root.get("height"), entry.get("h") or 1)
    kx = (entry.get("w") or vw) / (vw or 1)
    ky = (entry.get("h") or vh) / (vh or 1)
    ox, oy = entry.get("x") or 0, entry.get("y") or 0
    label = entry.get("name") or entry.get("layer") or "drawing"

    def walk(el, st, tx, ty, sx, sy):
        t = tag(el)
        if t in ("defs", "clipPath", "mask", "linearGradient", "radialGradient", "filter", "pattern", "symbol", "style", "title", "desc"):
            return
        st = style_of(el, st)
        dx, dy, ssx, ssy = translate_of(el)
        tx, ty = tx + dx * sx, ty + dy * sy
        sx, sy = sx * ssx, sy * ssy

        def canvas(px, py):
            return (ox + (tx + px * sx - vx) * kx, oy + (ty + py * sy - vy) * ky)

        pts, nverts, curved, sig = [], 0, False, None
        outline = None
        own = el.get("data-jdraw-plane") is not None
        if t == "rect":
            x, y, w, h = (fnum(el.get(k)) for k in ("x", "y", "width", "height"))
            pts = [(x, y), (x + w, y + h)]
            outline = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
            nverts = 4
            sig = ("rect", round(w), round(h))
        elif t in ("circle", "ellipse"):
            cx, cy = fnum(el.get("cx")), fnum(el.get("cy"))
            rx = fnum(el.get("r")) if t == "circle" else fnum(el.get("rx"))
            ry = fnum(el.get("r")) if t == "circle" else fnum(el.get("ry"))
            pts = [(cx - rx, cy - ry), (cx + rx, cy + ry)]
            outline = [(cx + rx * math.cos(k * math.pi / 8), cy + ry * math.sin(k * math.pi / 8)) for k in range(16)]
            nverts = 0
            curved = True
            sig = (t, round(rx), round(ry))
        elif t == "line":
            pts = [(fnum(el.get("x1")), fnum(el.get("y1"))), (fnum(el.get("x2")), fnum(el.get("y2")))]
            nverts = 2
        elif t in ("polyline", "polygon"):
            vals = [float(v) for v in NUM.findall(el.get("points") or "")]
            pts = list(zip(vals[0::2], vals[1::2]))
            outline = list(pts)
            nverts = len(pts)
            if pts:
                x0, y0 = pts[0]
                sig = (t, tuple((round(px - x0), round(py - y0)) for px, py in pts[:12]))
        elif t == "path":
            d = el.get("d") or ""
            subs, scurved = subpaths(d)
            flat = flatten_path(d)
            if len(subs) > 1:
                # One shape per subpath, so 20 dashes in one path count as 20.
                op = st.get("_op", 1.0) * fnum(st.get("fill-opacity", 1), 1.0)
                fill = st.get("fill", "black")
                for k, spts in enumerate(subs):
                    snv = len(spts)
                    cp = [canvas(*q) for q in spts]
                    xs, ys = [q[0] for q in cp], [q[1] for q in cp]
                    x0, y0 = spts[0]
                    ssig = ("path", len(spts), tuple((round(px - x0), round(py - y0)) for px, py in spts[:12]))
                    so = [canvas(*q) for q in flat[k]] if len(flat) == len(subs) else cp
                    out.append(Shape("path", (min(xs), min(ys), max(xs), max(ys)), fill, st.get("stroke"), op, snv, scurved, ssig, st.get("stroke-dasharray"), where=label, pts=cp, outline=so, own=own))
                for child in el:
                    walk(child, st, tx, ty, sx, sy)
                return
            pts, nverts, curved = path_points(d)
            if flat:
                outline = flat[0]
            if pts:
                x0, y0 = pts[0]
                sig = ("path", len(pts), tuple((round(px - x0), round(py - y0)) for px, py in pts[:12]))
        elif t in ("text", "tspan"):
            x, y = fnum(el.get("x")), fnum(el.get("y"))
            size = fnum(el.get("font-size"), 16)
            text = "".join(el.itertext()).strip()
            pts = [(x, y - size), (x + size * 0.6 * max(1, len(text)), y)]
            fill = st.get("fill", "black")
            if text and t == "text":
                cp = [canvas(*p) for p in pts]
                xs, ys = [p[0] for p in cp], [p[1] for p in cp]
                out.append(Shape("text", (min(xs), min(ys), max(xs), max(ys)), fill, None, 1, 0, False, None, None, fill, label))
            for child in el:
                if tag(child) == "tspan":
                    cst = style_of(child, st)
                    if "".join(child.itertext()).strip():
                        out.append(Shape("text", (0, 0, 0, 0), cst.get("fill", fill), None, 1, 0, False, None, None, cst.get("fill", fill), label + " (tspan)"))
            return
        if pts:
            cp = [canvas(*p) for p in pts]
            xs, ys = [p[0] for p in cp], [p[1] for p in cp]
            op = st.get("_op", 1.0) * fnum(st.get("fill-opacity", 1), 1.0)
            fill = st.get("fill")
            if fill is None and t not in ("line", "polyline"):
                fill = "black"  # SVG default fill
            out.append(Shape(t, (min(xs), min(ys), max(xs), max(ys)), fill, st.get("stroke"), op, nverts, curved, sig, st.get("stroke-dasharray"), where=label, pts=cp, outline=[canvas(*p) for p in outline] if outline else cp, own=own))
        for child in el:
            walk(child, st, tx, ty, sx, sy)

    walk(root, {}, 0.0, 0.0, 1.0, 1.0)
    # Native items are separate objects; the shapes of one placed SVG are one object.
    for k, s in enumerate(out[first:]):
        s.item = "n%d.%d" % (index, k) if entry.get("native") else "s%d" % index
        s.item_name = "" if entry.get("native") else (entry.get("name") or "")


def is_boxy(s):
    """An axis-aligned rectangle (walls, windows, planks, shelves): normal in buildings and rooms."""
    if s.kind == "rect":
        return True
    if s.kind in ("polygon", "path") and s.nverts in (4, 5) and not s.curved and s.pts:
        xs = sorted(round(p[0]) for p in s.pts)
        ys = sorted(round(p[1]) for p in s.pts)
        return len({x for x in xs if abs(x - xs[0]) > 2 and abs(x - xs[-1]) > 2}) == 0 and len({y for y in ys if abs(y - ys[0]) > 2 and abs(y - ys[-1]) > 2}) == 0
    return False


def upright_triangle(s):
    """Three corners with a flat-ish base and the apex on top: a triangle tree, roof or mountain."""
    if s.nverts != 3 or s.curved or len(s.pts) < 3:
        return False
    pts = sorted(s.pts[:3], key=lambda p: p[1])
    apex, b1, b2 = pts[0], pts[1], pts[2]
    base = abs(b1[0] - b2[0])
    return base > 0 and abs(b1[1] - b2[1]) < 0.25 * base and min(b1[0], b2[0]) - 0.1 * base <= apex[0] <= max(b1[0], b2[0]) + 0.1 * base and (b1[1] - apex[1]) > 0.5 * base


def fmt_box(b):
    return "x %d y %d (%dx%d)" % (b[0], b[1], b[2] - b[0], b[3] - b[1])


def check_shapes(shapes, W, H, issues, clean=False):
    small = min(W, H)

    # 1. Loose marks: short strokes that are not part of a filled shape.
    marks = [s for s in shapes if s.stroked and not s.filled and s.kind in ("line", "polyline", "path") and max(s.w, s.h) < 0.14 * small]
    if len(marks) >= 3:
        issues.append({
            "rule": "loose-marks",
            "title": "Loose short lines used as texture",
            "detail": "%d short stroke-only lines (dashes, hatching, cracks, grain, fur or water lines). The user rejects these every time." % len(marks),
            "where": "; ".join(fmt_box(s.box) + " in " + s.where for s in marks[:6]),
            "fix": "Delete every one of them. Show the surface with filled shapes: a darker patch, a lighter plane facing the light, a broken edge.",
        })
    dashed = [s for s in shapes if s.dash and s.dash.strip().lower() not in ("none", "0")]
    if dashed:
        issues.append({
            "rule": "dashes",
            "title": "Dashed or dotted lines",
            "detail": "%d dashed strokes (dotted paths, stitched edges, map trails)." % len(dashed),
            "where": "; ".join(fmt_box(s.box) for s in dashed[:5]),
            "fix": "Remove the dashes. If a path or edge is needed, draw it as a filled shape.",
        })

    # 2. Scattered dots: specks, stars, snow or sparkles sprinkled around.
    dots = [s for s in shapes if s.kind in ("circle", "ellipse") and max(s.w, s.h) < 0.012 * small]
    if len(dots) >= 6:
        issues.append({
            "rule": "scattered-dots",
            "title": "Scattered tiny dots",
            "detail": "%d tiny dots sprinkled over the picture (stars, snow, specks, sparkles)." % len(dots),
            "where": "; ".join(fmt_box(s.box) for s in dots[:6]),
            "fix": "Delete them, or keep at most three with a clear reason and different sizes.",
        })

    # 2b. Dashes made of filled shapes: many small elongated patches
    # (pill or hexagon "reflections", dash rows on water, stitched paths).
    pills = [s for s in shapes if s.filled and s.kind != "text" and not is_boxy(s) and 0.004 * small < max(s.w, s.h) < 0.07 * small and max(s.w, s.h) > 2.5 * max(1, min(s.w, s.h))]
    def attached(p):
        for o in shapes:
            if o is p or not o.filled or o.kind == "text" or o.w * o.h < 4 * max(1, p.w * p.h) or o.w * o.h > 0.5 * W * H:
                continue
            inside = p.box[0] >= o.box[0] - 2 and p.box[2] <= o.box[2] + 2 and p.box[1] >= o.box[1] - 2 and p.box[3] <= o.box[3] + 2
            overlaps = p.box[0] < o.box[2] and p.box[2] > o.box[0] and p.box[1] < o.box[3] and p.box[3] > o.box[1]
            # Inside an object (stripes on a tower, bars in a window) is
            # structure; inside a big field (sea, sky) it floats unless it
            # crosses that field's edge.
            if inside and o.w * o.h <= 0.15 * W * H:
                return True
            if overlaps and not inside:
                return True
        return False
    pills = [p for p in pills if not attached(p)]
    if len(pills) >= 8:
        issues.append({
            "rule": "dash-patches",
            "title": "Dashes drawn as small filled shapes",
            "detail": "%d small long thin filled shapes (dash reflections, sparkle rows, water strokes). They read as the same dash tell as loose lines." % len(pills),
            "where": "; ".join(fmt_box(s.box) + " in " + s.where for s in pills[:6]),
            "fix": "Delete them. Show a reflection or a surface with a few bigger broken color shapes that follow the forms, widening toward the viewer.",
        })

    # 2c. Regular stacks: four or more similar shapes stepping along one line
    # at near-even spacing (a reflection ladder, stacked bars, a dash column).
    # Only wide, flat bars stacked down a column: railings, windows and
    # tone bands are not ladders.
    cands = [s for s in shapes if s.filled and s.kind != "text" and 0.03 * W < s.w < 0.3 * W and s.w > 2.5 * max(s.h, 1) and s.w * s.h < 0.03 * W * H]
    stack_hit = None
    for axis in (0,):  # a vertical column (centers share x)
        other = 1 - axis
        cs = sorted(cands, key=lambda s: ((s.box[other] + s.box[other + 2]) / 2))
        for i, a in enumerate(cs):
            ca = (a.box[axis] + a.box[axis + 2]) / 2
            line = [a]
            for b in cs[i + 1:]:
                cb = (b.box[axis] + b.box[axis + 2]) / 2
                ws = sorted([a.w, b.w])
                hs = sorted([a.h, b.h])
                if abs(cb - ca) < 0.1 * W and ws[1] < 3.5 * max(ws[0], 1) and hs[1] < 2.0 * max(hs[0], 1):
                    line.append(b)
            if len(line) < 5:
                continue
            # Ladder rungs stand apart: each one clears the last with a gap.
            line.sort(key=lambda s: s.box[other])
            rungs = [line[0]]
            for b in line[1:]:
                if b.box[other] > rungs[-1].box[other + 2] + 0.25 * (rungs[-1].box[other + 2] - rungs[-1].box[other]):
                    rungs.append(b)
            if len(rungs) < 5:
                continue
            line = rungs
            ys = [(s.box[1] + s.box[3]) / 2 for s in line]
            xs = [(s.box[0] + s.box[2]) / 2 for s in line]
            n = len(line)
            my, mx = sum(ys) / n, sum(xs) / n
            vy = sum((y - my) ** 2 for y in ys) or 1
            slope = sum((y - my) * (x - mx) for x, y in zip(xs, ys)) / vy
            resid = max(abs(x - (mx + slope * (y - my))) for x, y in zip(xs, ys))
            gaps = [q - p for p, q in zip(ys, ys[1:])]
            if abs(slope) < 1.2 and resid < 0.08 * W and max(gaps) < 0.15 * H:
                stack_hit = line
                break
        if stack_hit:
            break
    if stack_hit:
        issues.append({
            "rule": "stack",
            "title": "A ladder of similar shapes",
            "detail": "%d look-alike shapes step along one line at even spacing (a reflection ladder, stacked bars or dashes)." % len(stack_hit),
            "where": "; ".join(fmt_box(s.box) + " in " + s.where for s in stack_hit[:6]),
            "fix": "Delete the ladder. Paint the reflection or surface as two or three bigger broken shapes that follow the waves and widen toward the viewer, with uneven gaps.",
        })

    # 3. Copy-pasted shapes.
    groups = defaultdict(list)
    for s in shapes:
        if s.sig and not is_boxy(s) and max(s.w, s.h) > 0.01 * small:
            groups[s.sig].append(s)
    for sig, g in groups.items():
        if len(g) >= 4:
            issues.append({
                "rule": "copy-paste",
                "title": "The same shape copied %d times" % len(g),
                "detail": "Identical %s shapes repeated (foam, leaves, trees, waves, petals or windows that are all the same)." % g[0].kind,
                "where": "; ".join(fmt_box(s.box) for s in g[:5]),
                "fix": "Redraw them so each one differs in size, angle, shape and shade, or cut most of them.",
            })
            break

    # 4. Stacked triangles (pine trees made of triangle tiers).
    tris = [s for s in shapes if s.filled and s.kind in ("polygon", "path") and s.h > 0.02 * H and upright_triangle(s)]
    stacks = 0
    used = set()
    for i, a in enumerate(tris):
        if i in used:
            continue
        cx = (a.box[0] + a.box[2]) / 2
        tier = [i]
        for j, b in enumerate(tris):
            if j != i and j not in used and abs((b.box[0] + b.box[2]) / 2 - cx) < 0.02 * W and not (b.box[3] < a.box[1] - a.h or b.box[1] > a.box[3] + a.h):
                tier.append(j)
        if len(tier) >= 2:
            stacks += 1
            used.update(tier)
    plain_tri_trees = [s for s in tris if s.h > 1.2 * s.w]
    if stacks >= 1 or len(plain_tri_trees) >= 3:
        issues.append({
            "rule": "triangle-trees",
            "title": "Trees or mountains made of plain triangles",
            "detail": "%d stacks of triangle tiers and %d tall plain triangles." % (stacks, len(plain_tri_trees)),
            "where": "; ".join(fmt_box(tris[k].box) for k in list(used)[:4]) or "; ".join(fmt_box(s.box) for s in plain_tri_trees[:4]),
            "fix": "Redraw each tree as one irregular silhouette path with many points: uneven branch tips, gaps, a lean, a visible trunk. Mountains get uneven ridges and shoulders.",
        })

    # 5. Mostly primitives.
    solid = [s for s in shapes if s.filled and s.kind != "text" and s.w * s.h > 0.0004 * W * H]
    prim = [s for s in solid if s.kind in ("circle", "ellipse") or (s.kind in ("polygon", "path") and s.nverts == 3 and not s.curved)]
    if len(prim) >= 6 and len(prim) / len(solid) > 0.3 and not clean:
        issues.append({
            "rule": "primitives",
            "title": "Built from basic shapes",
            "detail": "%d of %d visible shapes are plain circles, ellipses or triangles (lollipop trees, circle heads, triangle roofs and trees, half-dome bushes)." % (len(prim), len(solid)),
            "where": "; ".join(fmt_box(s.box) + " " + s.kind for s in sorted(prim, key=lambda s: -s.w * s.h)[:6]),
            "fix": "Redraw the biggest of these as silhouette paths with 12 or more points that follow the real outline, and add the parts that make them read (frames, trim, base, joints).",
        })

    # 6. Things lined up in one row.
    big = [s for s in solid if not is_boxy(s) and s.w * s.h > 0.002 * W * H and s.h < 0.6 * H and s.w < 0.5 * W]
    rows = defaultdict(list)
    for s in big:
        rows[round(s.box[3] / (0.012 * H))].append(s)
    for key in sorted(rows, key=lambda k: -len(rows[k])):
        g = rows[key] + rows.get(key + 1, [])
        xs = sorted((s.box[0] + s.box[2]) / 2 for s in g)
        if len(g) >= 3 and xs[-1] - xs[0] > 0.4 * W:
            # Four or more on a baseline is a row no matter the spacing; three
            # is only the generated-layout tell when the gaps between them are
            # even (a real trio lands at uneven depths and spaces).
            gaps = [xs[i + 1] - xs[i] for i in range(len(xs) - 1)]
            mean = sum(gaps) / len(gaps) if gaps else 0
            cv = (sum((gp - mean) ** 2 for gp in gaps) / len(gaps)) ** 0.5 / mean if mean else 1
            if len(g) < 4 and cv >= 0.15:
                continue
            hs = sorted(s.h for s in g)
            if hs[-1] / max(1, hs[0]) < 1.8:
                issues.append({
                    "rule": "row",
                    "title": "Objects standing in one straight row",
                    "detail": "%d similar objects share the same baseline near y %d across the picture." % (len(g), g[0].box[3]),
                    "where": "; ".join(fmt_box(s.box) for s in g[:6]),
                    "fix": "Move them to different depths: some lower and bigger in front, some higher and smaller behind, in uneven groups that overlap.",
                })
                break

    # 7. See-through light wedges.
    def light_paint(f):
        m = re.match(r"#([0-9a-fA-F]{6})", (f or "").strip())
        if not m:
            return "url(" in (f or "") or (f or "").strip().lower() in ("white", "#fff", "#ffffff")
        v = int(m.group(1), 16)
        r, g, b = v >> 16, (v >> 8) & 255, v & 255
        return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150

    def narrows(s):
        if len(s.pts) < 3:
            return False
        if s.nverts == 3:
            return True
        xs = [p[0] for p in s.pts]
        left = [p for p in s.pts if p[0] - min(xs) < 0.1 * (max(xs) - min(xs))]
        right = [p for p in s.pts if max(xs) - p[0] < 0.1 * (max(xs) - min(xs))]
        span = lambda ps: max(p[1] for p in ps) - min(p[1] for p in ps)
        a, b = span(left), span(right)
        return min(a, b) < 0.3 * max(a, b, 1)
    wedges = [s for s in shapes if s.filled and s.kind in ("polygon", "path") and s.nverts in (3, 4) and not s.curved and s.op < 0.55 and s.w > 0.2 * W and light_paint(s.fill) and narrows(s)]
    if wedges:
        issues.append({
            "rule": "light-wedge",
            "title": "Light beam drawn as a see-through wedge",
            "detail": "%d large faint triangles or wedges." % len(wedges),
            "where": "; ".join(fmt_box(s.box) for s in wedges[:3]),
            "fix": "Delete the wedge. Show light by what it hits: lit surfaces, a soft glow close to the source, brighter color on nearby objects.",
        })

    # 8. Gradients on everything.
    fills = [s for s in solid]
    grad = [s for s in fills if "url(" in (s.fill or "")]
    if len(fills) >= 8 and len(grad) / len(fills) > 0.6:
        issues.append({
            "rule": "gradients",
            "title": "Gradients on almost everything",
            "detail": "%d of %d filled shapes use a gradient." % (len(grad), len(fills)),
            "where": "whole drawing",
            "fix": "Keep gradients for the sky and real light falloff. Give objects two or three flat tones instead (lit, mid, shadow).",
        })

    # 9. Multicolor text.
    tfills = {(s.text_fill or "").lower() for s in shapes if s.kind == "text" and s.text_fill}
    tfills.discard("")
    if len(tfills) > 1:
        issues.append({
            "rule": "text-color",
            "title": "Text in more than one color",
            "detail": "Text uses %d colors: %s." % (len(tfills), ", ".join(sorted(tfills))[:120]),
            "where": "text",
            "fix": "Use one color for all text.",
        })


def in_poly(poly, x, y):
    r = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            r = not r
        j = i
    return r


def seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def segs_cross(a, b, c, d):
    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    return (side(a, b, c) > 0) != (side(a, b, d) > 0) and (side(c, d, a) > 0) != (side(c, d, b) > 0)


def outline_gap(a, b, limit):
    """Distance between two filled outlines: 0 when they overlap or cross, and
    `limit` or more when they are clearly apart."""
    if a.box[0] - b.box[2] >= limit or b.box[0] - a.box[2] >= limit or a.box[1] - b.box[3] >= limit or b.box[1] - a.box[3] >= limit:
        return limit
    A, B = a.outline, b.outline
    if len(A) < 3 or len(B) < 3:
        return limit
    if any(in_poly(B, x, y) for x, y in A) or any(in_poly(A, x, y) for x, y in B):
        return 0.0
    best = limit
    na, nb = len(A), len(B)
    for i in range(na):
        a0, a1 = A[i], A[(i + 1) % na]
        for j in range(nb):
            b0, b1 = B[j], B[(j + 1) % nb]
            if segs_cross(a0, a1, b0, b1):
                return 0.0
            d = min(seg_dist(a0, b0, b1), seg_dist(b0, a0, a1))
            if d < best:
                best = d
    return best


# Things that stand on something, and things that may hang in the air.
STANDS = re.compile(r"\b(house|home|cottage|cabin|hut|shed|barn|church|chapel|castle|tower|lighthouse|windmill|building|shop|store|tent|tree|pine|oak|birch|bush|shrub|rock|boulder|stone|car|truck|bus|van|bike|bicycle|tractor|cart|wagon|chair|armchair|table|desk|bench|sofa|couch|fence|gate|person|man|woman|girl|boy|child|figure|cat|dog|fox|horse|cow|sheep|deer|bear|rabbit|snowman|mailbox|barrel|crate|pot|vase|bowl|cup|mug|bottle|basket|bucket|boat|ship|statue|well|bridge|pier|dock|jetty|robot|platform|plinth|steps|stairs)s?\b", re.I)
FLIES = re.compile(r"\b(birds?|gulls?|kites?|clouds?|flags?|balloons?|planes?|sun|moon|stars?|leaf|leaves|butterfl\w+|bees?|smoke|steam|flying|falling|jumping|floating|hanging|ufo|rocket|drone|fish|ghost|angel|snow|rain|signs?|logo|icon|glow|light|shadows?|reflections?|mist|haze|fog|sky|sea|water|ocean|ground|background|backdrop|far|distant)\b", re.I)


def check_layout(shapes, W, H, issues, limg=None):
    """Whole-picture placement: edge grazes, near touches, floating objects, near-copies."""
    small = min(W, H)
    tol = 0.012 * small  # a sliver the eye reads as "almost touching"
    hair = 0.003 * small  # closer than this is touching
    solid = [s for s in shapes if s.filled and s.kind != "text" and not s.own and s.op >= 0.5 and "url(" not in (s.fill or "") and len(s.outline) >= 3 and s.w > 0 and s.h > 0]
    area = lambda s: s.w * s.h

    # 1. An object that grazes the canvas edge: it stops a sliver short of the
    # frame, or a round side touches it at one point. Cropped objects (they
    # cross the edge or lie flat along it) and backgrounds are fine.
    grazes = []
    for s in solid:
        if area(s) < 0.004 * W * H or s.w >= 0.6 * W or s.h >= 0.6 * H:
            continue
        gaps = {"left": s.box[0], "top": s.box[1], "right": W - s.box[2], "bottom": H - s.box[3]}
        if any(g < -hair for g in gaps.values()):
            continue  # cut by the frame
        near = [(k, g) for k, g in gaps.items() if g <= tol]
        if len(near) != 1:
            continue
        side, g = near[0]
        if g <= hair:
            # Touching: only a point contact is a graze.
            axis = 0 if side in ("top", "bottom") else 1
            edge = {"left": 0, "top": 0, "right": W, "bottom": H}[side]
            on = [p[axis] for p in s.outline if abs(p[1 - axis] - edge) <= 2 * hair]
            run = (max(on) - min(on)) if on else 0
            if run > 0.15 * (s.w if axis == 0 else s.h):
                continue
        # Part of a bigger object that itself reaches that edge is not a graze.
        def reaches(o):
            og = {"left": o.box[0], "top": o.box[1], "right": W - o.box[2], "bottom": H - o.box[3]}[side]
            return og <= hair
        if any(o is not s and area(o) > area(s) and reaches(o) and o.box[0] <= s.box[0] + 2 and o.box[1] <= s.box[1] + 2 and o.box[2] >= s.box[2] - 2 and o.box[3] >= s.box[3] - 2 and o.w < 0.85 * W for o in solid):
            continue
        grazes.append((s, side))
    if grazes:
        issues.append({
            "rule": "edge-graze",
            "title": "An object just touches the edge of the canvas",
            "detail": "%d shape%s stop%s a few pixels from the frame or touch it at one point. It reads as placed by accident." % (len(grazes), "" if len(grazes) == 1 else "s", "s" if len(grazes) == 1 else ""),
            "where": "; ".join("%s (%s edge) in %s" % (fmt_box(s.box), side, s.where) for s, side in grazes[:4]),
            "fix": "Move it clearly inside the frame, or let the frame cut through it.",
        })

    # Objects: the shapes of one placed SVG together. An SVG that paints a
    # field (sky, sea, ground) is scenery, not an object: its swells and
    # bands lie next to everything.
    is_field = lambda s: s.w >= 0.85 * W and (s.h >= 0.2 * H or s.box[1] <= 0.02 * H or s.box[3] >= 0.98 * H)
    field_items = {s.item for s in shapes if s.filled and s.kind != "text" and is_field(s)}
    items = defaultdict(list)
    for s in solid:
        if s.item not in field_items:
            items[s.item].append(s)
    objs = []
    for key, ss in items.items():
        box = (min(s.box[0] for s in ss), min(s.box[1] for s in ss), max(s.box[2] for s in ss), max(s.box[3] for s in ss))
        a = (box[2] - box[0]) * (box[3] - box[1])
        if a < 0.003 * W * H or a > 0.3 * W * H:
            continue
        name = getattr(ss[0], "item_name", "") or ""
        objs.append({"key": key, "shapes": ss, "box": box, "name": name, "where": ss[0].where})

    def obj_gap(p, q):
        if p["box"][0] - q["box"][2] > tol or q["box"][0] - p["box"][2] > tol or p["box"][1] - q["box"][3] > tol or q["box"][1] - p["box"][3] > tol:
            return tol + 1
        best = tol + 1
        for a in p["shapes"]:
            for b in q["shapes"]:
                d = outline_gap(a, b, tol + 1)
                if d < best:
                    best = d
                    if best <= hair:
                        return best
        return best

    # 2. Two objects that almost touch: a sliver of background between them.
    soft_name = re.compile(r"\b(glow|light|haze|mist|fog|shadows?|reflections?|rain|snow|stars?|sparkles?|spray|foam|smoke|steam)\b", re.I)
    near = []
    for i, p in enumerate(objs):
        if soft_name.search(p["name"]):
            continue
        for q in objs[i + 1:]:
            if soft_name.search(q["name"]) or len(near) >= 4:
                continue
            d = obj_gap(p, q)
            if hair < d <= tol:
                near.append((p, q, d))
    if near:
        issues.append({
            "rule": "near-touch",
            "title": "Two objects almost touch",
            "detail": "%d pair%s of objects sit%s a few pixels apart without touching. A gap that small reads as a mistake: parts that should join look loose, and separate things look stuck together." % (len(near), "" if len(near) == 1 else "s", "s" if len(near) == 1 else ""),
            "where": "; ".join("%s and %s, %d px apart" % (fmt_box(p["box"]) + (" " + p["name"] if p["name"] else ""), fmt_box(q["box"]) + (" " + q["name"] if q["name"] else ""), round(d)) for p, q, d in near[:3]),
            "fix": "Overlap them so one clearly sits on or in front of the other, or move them well apart.",
        })

    # 3. A standing object that touches nothing: it hangs in the air. Only
    # in a picture that has ground or water to stand on, and only for things
    # named as something that stands (a house, a tree, a boat), never a bird.
    def backdrop(s):
        return s.w >= 0.85 * W and s.box[1] <= 0.05 * H
    ground = [s for s in solid if s.w >= 0.6 * W and s.box[1] > 0.05 * H and s.box[3] >= 0.9 * H]

    def floats_over_region(p):
        """An object cut by the left or right frame is cropped on purpose as
        often as not (a cliff running off-frame), so it only counts as
        floating when the paint right under its base reads as one region that
        clearly is not the object itself: a pier deck over water, a beam over
        sky. Read from the render; without it the old rule stands."""
        if limg is None:
            return False
        b = p["box"]
        iw, ih = limg.size
        sx, sy = iw / W, ih / H
        iy = int(round(b[3] * sy))
        if iy < 3 or iy + 6 >= ih:
            return False
        px = limg.load()
        base = [pt for s in p["shapes"] for pt in s.outline if pt[1] >= b[3] - 0.15 * (b[3] - b[1])]
        xs = sorted(pt[0] for pt in base)
        if not xs or xs[-1] - xs[0] < 0.02 * W:
            return False
        cols = [min(iw - 1, max(0, int(round((xs[0] + (xs[-1] - xs[0]) * f) * sx)))) for f in (0.12, 0.31, 0.5, 0.69, 0.88)]
        own = [px[c, iy - 2] for c in cols]
        below = [tuple(sorted(px[c, iy + d][k] for d in (2, 3, 4, 5))[2] for k in range(3)) for c in cols]

        def med(cs, k):
            return sorted(v[k] for v in cs)[len(cs) // 2]

        def dist(a, e):
            return math.sqrt(sum((a[k] - e[k]) ** 2 for k in range(3)))
        mb = tuple(med(below, k) for k in range(3))
        mo = tuple(med(own, k) for k in range(3))
        # One quiet region under the whole base, and not the object's paint.
        quiet = sum(1 for c in below if dist(c, mb) <= 42) >= 0.8 * len(below)
        return quiet and dist(mb, mo) >= 50

    floating = []
    if ground:
        for p in objs:
            if not STANDS.search(p["name"]) or FLIES.search(p["name"]):
                continue
            if any(p is x or p is y for x, y, _ in near):
                continue  # already reported as almost touching
            b = p["box"]
            if b[3] >= H - tol:
                continue  # stands on the frame
            cut = b[0] <= tol or b[2] >= W - tol
            h = b[3] - b[1]
            base = [pt for s in p["shapes"] for pt in s.outline if pt[1] >= b[3] - 0.15 * h]
            held = False
            for s in solid:
                if s.item == p["key"] or backdrop(s):
                    continue
                if s.box[2] < b[0] or s.box[0] > b[2] or s.box[3] < b[3] - 0.15 * h - tol or s.box[1] > b[3] + tol:
                    continue
                if any(in_poly(s.outline, x, y + tol) or in_poly(s.outline, x, y) for x, y in base):
                    held = True
                    break
            if held:
                continue
            if cut and not floats_over_region(p):
                continue  # cropped by the frame, or the region under it is unclear
            floating.append(p)
    if floating:
        issues.append({
            "rule": "floating",
            "title": "An object hangs in the air",
            "detail": "%s touch%s nothing: no ground, water or other object under the base." % (", ".join(p["name"] for p in floating[:3]), "es" if len(floating) == 1 else ""),
            "where": "; ".join(fmt_box(p["box"]) + " " + p["name"] for p in floating[:3]),
            "fix": "Set it down: overlap its base with what it stands on and add a dark contact shadow where they meet.",
        })

    # 4. The same shape repeated with small changes (a tree, a cloud or a
    # mark stamped three times and nudged). Exact copies are rule copy-paste.
    def norm_outline(s, n=16):
        P = s.outline
        m = len(P)
        lens = [math.hypot(P[(k + 1) % m][0] - P[k][0], P[(k + 1) % m][1] - P[k][1]) for k in range(m)]
        total = sum(lens)
        if total <= 0:
            return None
        out, k, acc = [], 0, 0.0
        for j in range(n):
            target = total * j / n
            while k < m - 1 and acc + lens[k] < target:
                acc += lens[k]
                k += 1
            t = (target - acc) / lens[k] if lens[k] else 0
            x = P[k][0] + (P[(k + 1) % m][0] - P[k][0]) * t
            y = P[k][1] + (P[(k + 1) % m][1] - P[k][1]) * t
            out.append(((x - s.box[0]) / s.w, (y - s.box[1]) / s.h))
        return out

    def hosted(s):
        # Windows, stripes and panels inside one object repeat on purpose.
        for o in solid:
            if o is s or o.item != s.item or area(o) < 3 * area(s) or area(o) > 0.15 * W * H:
                continue
            if s.box[0] >= o.box[0] - 2 and s.box[2] <= o.box[2] + 2 and s.box[1] >= o.box[1] - 2 and s.box[3] <= o.box[3] + 2:
                return True
        return False

    # Long thin strips (swells, streaks) all look alike once stretched to a
    # square, so only compact shapes are compared.
    cands = [s for s in solid if s.kind in ("path", "polygon") and not is_boxy(s) and s.nverts >= 7 and max(s.w, s.h) >= 0.03 * small and max(s.w, s.h) < 4 * min(s.w, s.h) and area(s) < 0.1 * W * H and not hosted(s)]
    clusters = []
    for s in cands[:400]:
        n = norm_outline(s)
        if not n:
            continue
        for c in clusters:
            r = c["rep"]
            if not (0.8 <= (s.w / s.h) / (r.w / r.h) <= 1.25) or not (1 / 3 <= s.w / r.w <= 3):
                continue
            d = sum(abs(a[0] - b[0]) + abs(a[1] - b[1]) for a, b in zip(n, c["norm"])) / (2 * len(n))
            if d <= 0.045:
                c["members"].append(s)
                break
        else:
            clusters.append({"rep": s, "norm": n, "members": [s]})
    def lattice(g):
        # Tiles, bricks and panes laid out in rows and columns repeat on purpose.
        def lines(vals, size):
            out = []
            for v in sorted(vals):
                if not out or v - out[-1] > 0.25 * size:
                    out.append(v)
            return out
        def even(v):
            gaps = [b - a for a, b in zip(v, v[1:])]
            if len(gaps) < 2:
                return True
            m = sum(gaps) / len(gaps)
            return (sum((x - m) ** 2 for x in gaps) / len(gaps)) ** 0.5 < 0.2 * m
        cols = lines([(s.box[0] + s.box[2]) / 2 for s in g], g[0].w)
        rows = lines([(s.box[1] + s.box[3]) / 2 for s in g], g[0].h)
        return len(g) >= 6 and len(cols) >= 2 and len(rows) >= 2 and even(cols) and even(rows)
    copies = sorted((c["members"] for c in clusters if len(c["members"]) >= 3 and not lattice(c["members"])), key=len, reverse=True)
    if copies and not any(i["rule"] == "copy-paste" for i in issues):
        g = copies[0]
        issues.append({
            "rule": "near-copies",
            "title": "The same shape repeated %d times with small changes" % len(g),
            "detail": "%d shapes share one outline, only moved, scaled or nudged (trees, clouds, rocks or marks stamped from one template)." % len(g),
            "where": "; ".join(fmt_box(s.box) + " in " + s.where for s in g[:5]),
            "fix": "Draw each one on its own: a different silhouette, size, lean and shade. Or keep one and cut the rest.",
        })


# Looks that are busy or loud all over on purpose.
ASK_ALL_OVER = re.compile(r"\b(stained[\s-]?glass|mosaic|patterns?|tiles?|tiling|wallpaper|textures?|pop[\s-]?art|comic|halftone|collage|crowd|mandala|kaleidoscope|quilt|pixel)\b", re.I)
ASK_LOUD = re.compile(r"\b(pop[\s-]?art|synthwave|neon|vaporwave|stained[\s-]?glass|psychedelic|vivid|saturated|bright|bold colou?rs?|fluorescent|comic|rainbow|candy|cartoon|anime|pixel|8[\s-]?bit|blueprint)\b", re.I)


def check_color(png_b64, issues, stats, ask="", clean=False):
    if not Image or not png_b64:
        return
    img = Image.open(io.BytesIO(base64.b64decode(png_b64))).convert("RGB")
    img.thumbnail((256, 256))
    px = list(img.get_flattened_data()) if hasattr(img, "get_flattened_data") else list(img.getdata())
    n = len(px)
    lums, sats, purple, muddy, loud = [], [], 0, 0, 0
    for r, g, b in px:
        r, g, b = r / 255, g / 255, b / 255
        mx, mn = max(r, g, b), min(r, g, b)
        l = 0.2126 * r + 0.7152 * g + 0.0722 * b
        s = 0 if mx == 0 else (mx - mn) / mx
        lums.append(l)
        sats.append(s)
        if s > 0.65 and mx > 0.55:
            loud += 1
        if mx - mn > 0.08:
            if mx == r:
                h = ((g - b) / (mx - mn)) % 6
            elif mx == g:
                h = (b - r) / (mx - mn) + 2
            else:
                h = (r - g) / (mx - mn) + 4
            hue = h * 60
            if 255 <= hue <= 310 and s > 0.25:
                purple += 1
        if 0.22 < l < 0.68 and s < 0.28:
            muddy += 1
    lums.sort()
    p2, p98 = lums[int(n * 0.01)], lums[min(n - 1, int(n * 0.995))]
    mean_s = sum(sats) / n
    stats.update({"dark_p2": round(p2, 3), "light_p98": round(p98, 3), "mean_saturation": round(mean_s, 3), "purple_share": round(purple / n, 3), "muddy_share": round(muddy / n, 3), "loud_share": round(loud / n, 3)})
    if p98 - p2 < 0.5 or p2 > 0.25:
        issues.append({
            "rule": "low-contrast",
            "title": "Washed out, no real darks or lights",
            "detail": "Darkest 1%% of the picture is at %.0f%% brightness and the lightest at %.0f%%. A full range runs from under 15%% to over 85%%." % (p2 * 100, p98 * 100),
            "where": "whole drawing",
            "fix": "Push the deepest shadows near black and the lit spots near white, with the strongest contrast at the focus.",
        })
    if mean_s < 0.16:
        issues.append({
            "rule": "gray",
            "title": "Gray, colorless picture",
            "detail": "Average saturation is %.0f%%. The user calls this 'colors feel off'." % (mean_s * 100),
            "where": "whole drawing",
            "fix": "Give the main colors real hue (a real brick red, ochre, deep green or blue), keep gray only in the far distance.",
        })
    if muddy / n > 0.55:
        issues.append({
            "rule": "muddy",
            "title": "Muddy midtones with no light idea",
            "detail": "%.0f%% of the picture is dull middle-value color (gray-olive, beige-gray, brown on brown)." % (muddy / n * 100),
            "where": "whole drawing",
            "fix": "Pick a light story: warm light against cool shadow. Make the lit areas clean and warm, the shadows deep and cool.",
        })
    # Full-strength color over half the picture. Pop art, neon and the like
    # are loud on purpose, and so are flat icons and logos.
    if loud / n > 0.5 and not clean and not ASK_LOUD.search(ask or ""):
        issues.append({
            "rule": "oversaturated",
            "title": "Full-strength color almost everywhere",
            "detail": "%.0f%% of the picture is bright, fully saturated color, so nothing stands out." % (loud / n * 100),
            "where": "whole drawing",
            "fix": "Quiet the big areas (grayer, darker or paler versions of the same hues) and keep the strong color for the focus.",
        })
    if purple / n > 0.18:
        issues.append({
            "rule": "purple",
            "title": "Purple and violet everywhere",
            "detail": "%.0f%% of the picture is purple or violet." % (purple / n * 100),
            "where": "whole drawing",
            "fix": "Move the palette away from purple: use the scene's real colors and keep any violet small.",
        })


def check_evenness(img, issues, stats, ask=""):
    """Detail spread evenly over the whole picture, with no quiet area. Read
    from a small copy, so paint texture and grain do not count: only edges
    that survive at 96 pixels wide do."""
    w = 96
    h = max(24, round(w * img.size[1] / max(1, img.size[0])))
    g = img.resize((w, h), Image.BILINEAR)
    px = g.load()
    N = 5
    hit = [[0] * N for _ in range(N)]
    cnt = [[0] * N for _ in range(N)]
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            cy, cx = min(N - 1, y * N // h), min(N - 1, x * N // w)
            cnt[cy][cx] += 1
            if abs(px[x + 1, y] - px[x - 1, y]) + abs(px[x, y + 1] - px[x, y - 1]) >= 24:
                hit[cy][cx] += 1
    busy = [hit[i][j] / max(1, cnt[i][j]) for i in range(N) for j in range(N)]
    mean = sum(busy) / len(busy)
    cv = (sum((v - mean) ** 2 for v in busy) / len(busy)) ** 0.5 / mean if mean else 9.0
    stats.update({"quietest_area": round(min(busy), 3), "detail_spread": round(cv, 3)})
    # Every one of the 25 areas is busy, and all about equally: no rest, no focus.
    if min(busy) >= 0.12 and cv < 0.28 and not ASK_ALL_OVER.search(ask or ""):
        issues.append({
            "rule": "even-detail",
            "title": "Every part of the picture is equally busy",
            "detail": "Detail is spread evenly from corner to corner (the quietest area is as busy as the rest), so the eye has nowhere to rest and nothing to land on.",
            "where": "whole drawing",
            "fix": "Pick one focus and give it the detail and contrast. Empty out at least a quarter of the picture: plain sky, flat ground, or one big simple shape.",
        })


def check_composition(png_b64, issues, stats, ask="", clean=False):
    """Centered, mirror-symmetric subjects and a horizon through the middle, read from the render."""
    if not Image or not png_b64:
        return
    img = Image.open(io.BytesIO(base64.b64decode(png_b64))).convert("L")
    if not clean:
        check_evenness(img, issues, stats, ask)
    img.thumbnail((192, 192))
    w, h = img.size
    if w < 32 or h < 32:
        return
    px = img.load()
    # Edge energy: where the drawing has detail and contrast.
    e = [[0.0] * w for _ in range(h)]
    tot = 0.0
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            v = abs(px[x + 1, y] - px[x - 1, y]) + abs(px[x, y + 1] - px[x, y - 1])
            e[y][x] = v
            tot += v
    if tot <= 0:
        return
    cx = sum(e[y][x] * x for y in range(h) for x in range(w)) / tot / w
    cy = sum(e[y][x] * y for y in range(h) for x in range(w)) / tot / h
    # Mirror symmetry of the edge map around the vertical center line.
    num = den = 0.0
    for y in range(h):
        row = e[y]
        for x in range(w // 2):
            a, b = row[x], row[w - 1 - x]
            num += min(a, b)
            den += max(a, b)
    sym = num / den if den else 0
    stats.update({"focus_x": round(cx, 3), "focus_y": round(cy, 3), "mirror": round(sym, 3)})
    if abs(cx - 0.5) < 0.04 and sym > 0.62 and not clean:
        issues.append({
            "rule": "centered",
            "title": "Subject dead center in a mirror-symmetric scene",
            "detail": "The detail sits at %.0f%% across and the left and right halves mirror each other (%.0f%% match)." % (cx * 100, sym * 100),
            "where": "whole drawing",
            "fix": "Move the subject to a third, and make the two sides differ: a bigger shape on one side, open space on the other.",
        })
    # Horizon: a strong horizontal edge across most of the width at the middle.
    best_y, best = -1, 0.0
    for y in range(2, h - 2):
        row = [abs(px[x, y + 1] - px[x, y - 1]) for x in range(w)]
        strong = sum(1 for v in row if v > 18) / w
        if strong > best:
            best, best_y = strong, y
    stats.update({"horizon_y": round(best_y / h, 3), "horizon_strength": round(best, 3)})
    # A bright dome sitting on the horizon line: the half sun.
    if best > 0.3 and 4 < best_y < h - 4:
        row = best_y - 2
        lum = [px[x, row] for x in range(w)]
        top = max(lum)
        if top > 200:
            runs, start = [], None
            for x in range(w + 1):
                on = x < w and lum[x] >= top - 12
                if on and start is None:
                    start = x
                elif not on and start is not None:
                    runs.append((start, x))
                    start = None
            for x0, x1 in runs:
                rw = x1 - x0
                if not (0.02 * w <= rw <= 0.2 * w):
                    continue
                cx = (x0 + x1) // 2
                yy = row
                while yy > 0 and px[cx, yy - 1] >= top - 25:
                    yy -= 1
                height = row - yy + 2
                below = px[cx, min(h - 1, best_y + 3)]
                if 0.25 <= height / rw <= 0.75 and below < top - 25:
                    issues.append({
                        "rule": "half-sun",
                        "title": "Half sun sitting on the horizon",
                        "detail": "A bright dome %d%% of the width wide sits exactly on the horizon line." % (rw / w * 100),
                        "where": "x %d-%d%% at the horizon" % (x0 / w * 100, x1 / w * 100),
                        "fix": "Delete the half disc. Put the sun higher, behind a cloud bank, or out of frame, and show it by the warm light on the clouds and water.",
                    })
                    break
    if best > 0.5 and 0.45 <= best_y / h <= 0.55:
        issues.append({
            "rule": "horizon-middle",
            "title": "Horizon cuts the picture in half",
            "detail": "A straight edge runs across %.0f%% of the width at %.0f%% of the height." % (best * 100, best_y / h * 100),
            "where": "y around %d%%" % (best_y / h * 100),
            "fix": "Move the horizon to about a third from the top or bottom, and break it with something that overlaps it.",
        })


def main():
    data = json.load(sys.stdin)
    if data.get("png") and not Image:
        json.dump({"ok": None, "error": "The checker needs Pillow for the color and composition checks: pip install pillow"}, sys.stdout)
        return
    W, H = data.get("width") or 1600, data.get("height") or 1200
    ask = str(data.get("ask") or "")
    clean = bool(data.get("clean"))
    shapes = []
    for n, e in enumerate(data.get("svgs") or []):
        parse_svg(e, shapes, n)
    issues = []
    stats = {"shapes": len(shapes)}
    check_shapes(shapes, W, H, issues, clean)
    if not clean:
        limg = None
        if data.get("png") and Image:
            try:
                limg = Image.open(io.BytesIO(base64.b64decode(data["png"]))).convert("RGB")
                limg.thumbnail((384, 384))
            except Exception:
                limg = None
        try:
            check_layout(shapes, W, H, issues, limg)
        except Exception as err:
            stats["layout_error"] = str(err)
    try:
        check_color(data.get("png"), issues, stats, ask, clean)
    except Exception as err:
        json.dump({"ok": None, "error": "The checker could not read the render: %s" % err}, sys.stdout)
        return
    try:
        check_composition(data.get("png"), issues, stats, ask, clean)
    except Exception as err:
        stats["composition_error"] = str(err)
    json.dump({"ok": not issues, "issues": issues, "stats": stats}, sys.stdout)


if __name__ == "__main__":
    main()
