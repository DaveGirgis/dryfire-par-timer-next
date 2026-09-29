"""Draws the app icons (a stopwatch on the app's dark background). Run: python tools/make-icons.py"""
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
BG, FACE, RING, HAND, GO = (17, 20, 24), (26, 31, 37), (78, 161, 255), (232, 236, 241), (31, 157, 85)


def draw(size, safe):
    """`safe` = fraction of the canvas the artwork may use (maskable icons need ~0.8)."""
    s = size * 4  # supersample, then downscale for smooth edges
    img = Image.new("RGBA", (s, s), BG + (255,))
    d = ImageDraw.Draw(img)
    c = s / 2
    r = s * safe * 0.40
    cy = c + r * 0.12
    w = max(4, int(r * 0.16))
    # crown button and side lug
    d.rounded_rectangle([c - r * 0.18, cy - r * 1.38, c + r * 0.18, cy - r * 1.12], radius=r * 0.06, fill=RING)
    d.rectangle([c - r * 0.07, cy - r * 1.14, c + r * 0.07, cy - r * 0.96], fill=RING)
    lx, ly = c + r * 0.80, cy - r * 0.80
    d.line([lx, ly, lx + r * 0.16, ly - r * 0.16], fill=RING, width=int(w * 0.8))
    # face and ring
    d.ellipse([c - r, cy - r, c + r, cy + r], fill=FACE, outline=RING, width=w)
    # green "par" arc from 12 o'clock to ~4 o'clock
    ir = r - w * 1.6
    d.arc([c - ir, cy - ir, c + ir, cy + ir], start=-90, end=40, fill=GO, width=int(w * 0.9))
    # hand, pointing at the end of the arc
    hx, hy = c + ir * 0.78 * math.cos(math.radians(40)), cy + ir * 0.78 * math.sin(math.radians(40))
    d.line([c, cy, hx, hy], fill=HAND, width=int(w * 0.7))
    d.ellipse([c - w * 0.7, cy - w * 0.7, c + w * 0.7, cy + w * 0.7], fill=HAND)
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(exist_ok=True)
draw(192, 0.92).save(OUT / "icon-192.png")
draw(512, 0.92).save(OUT / "icon-512.png")
draw(512, 0.72).save(OUT / "icon-maskable-512.png")
draw(180, 0.86).save(OUT / "apple-touch-icon.png")
draw(64, 1.0).save(OUT / "favicon-64.png")
print("icons written to", OUT)
