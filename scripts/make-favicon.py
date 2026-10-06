#!/usr/bin/env python3
"""Draw the Feature Planner's favicon: a small planner grid on a rounded dark square.

Three rows of week cells, one of them "booked" in the planner's dev yellow and one in its test
blue, so the mark reads as the app even at tab size. Nothing is loaded from disk — the icon is
pure geometry — so it can be regenerated anywhere Pillow is installed:

    python3 scripts/make-favicon.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUTPUTS = [(ROOT / "public/favicon.png", 128), (ROOT / "public/apple-touch-icon.png", 180)]

BG = (29, 35, 44, 255)  # the app's neutral-900
EMPTY = (71, 82, 99, 255)  # neutral-600: an unbooked cell
DEV = (254, 185, 19, 255)  # the dev (yellow) cell colour
TEST = (84, 156, 229, 255)  # the test (blue) cell colour
CORNER_FRACTION = 0.1875  # 24px radius on a 128px canvas

# the grid: 3 rows × 4 columns, each cell either empty or booked as dev / test
ROWS = [
    [DEV, DEV, EMPTY, EMPTY],
    [EMPTY, DEV, DEV, TEST],
    [EMPTY, EMPTY, TEST, TEST],
]


def main() -> None:
    for path, size in OUTPUTS:
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(canvas)
        radius = round(size * CORNER_FRACTION)
        draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=BG)

        margin = round(size * 0.17)
        gap = max(2, round(size * 0.05))
        cols = len(ROWS[0])
        rows = len(ROWS)
        cell_w = (size - 2 * margin - gap * (cols - 1)) / cols
        cell_h = (size - 2 * margin - gap * (rows - 1)) / rows
        cell_r = max(1, round(min(cell_w, cell_h) * 0.22))
        for r, row in enumerate(ROWS):
            for c, colour in enumerate(row):
                x0 = margin + c * (cell_w + gap)
                y0 = margin + r * (cell_h + gap)
                draw.rounded_rectangle((x0, y0, x0 + cell_w, y0 + cell_h), radius=cell_r, fill=colour)

        path.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(path)
        print(f"wrote {path.relative_to(ROOT)} ({size}×{size})")


if __name__ == "__main__":
    main()
