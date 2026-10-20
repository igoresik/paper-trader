"""Draws assets/icon.ico (the same picture as ui/public/icon.svg) at every size Windows asks for."""

from pathlib import Path

from PIL import Image, ImageDraw

S = 16  # the SVG is 64 units wide; draw at 1024 px and let Pillow shrink it
INK, PAPER, RULE, BUY, SELL = "#15171C", "#F4F5F7", "#D5D8DE", "#2F6FEB", "#D23F31"


def box(x0, y0, x1, y1):
    return [x0 * S, y0 * S, x1 * S, y1 * S]


img = Image.new("RGBA", (64 * S, 64 * S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle(box(0, 0, 64, 64), radius=14 * S, fill=INK)
d.rounded_rectangle(box(16, 10, 48, 30), radius=3 * S, fill=PAPER)
teeth = [(48 - 4 * i, 52 + (2.5 if i % 2 else 0)) for i in range(9)]  # the torn bottom edge
d.polygon([(x * S, y * S) for x, y in [(16, 20), (48, 20), *teeth]], fill=PAPER)
for y in range(20, 50, 5):
    d.line(box(22, y, 42, y), fill=RULE, width=S)
for wick, body, colour in (((26.25, 17, 27.75, 44), (23.5, 22, 30.5, 38), BUY), ((36.25, 24, 37.75, 42), (33.5, 28, 40.5, 37), SELL)):
    d.rounded_rectangle(box(*wick), radius=0.75 * S, fill=colour)
    d.rounded_rectangle(box(*body), radius=1.5 * S, fill=colour)

out = Path(__file__).resolve().parent.parent / "assets" / "icon.ico"
img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", out)
