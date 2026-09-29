#!/usr/bin/env python3
"""Renders tmux capture-pane -e output (80 by 25) to a PNG with a fixed font and palette.

Usage: render-terminal.py screen.ans screen.png
"""
import re
import sys

from PIL import Image, ImageDraw, ImageFont

COLS, ROWS = 80, 25
FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 20)
BOLD = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 20)
CELL_W, CELL_H, PAD = 12, 26, 16
# The Linux console palette, the colours whiptail was designed for.
PALETTE = [
    (0, 0, 0), (170, 0, 0), (0, 170, 0), (170, 85, 0),
    (0, 0, 170), (170, 0, 170), (0, 170, 170), (170, 170, 170),
    (85, 85, 85), (255, 85, 85), (85, 255, 85), (255, 255, 85),
    (85, 85, 255), (255, 85, 255), (85, 255, 255), (255, 255, 255),
]
DEFAULT_FG, DEFAULT_BG = (220, 220, 220), (24, 24, 24)


# Box-drawing characters as (up, down, left, right) arms, drawn as lines so they join across cells.
BOX = {
    "─": (0, 0, 1, 1), "│": (1, 1, 0, 0), "┌": (0, 1, 0, 1), "┐": (0, 1, 1, 0),
    "└": (1, 0, 0, 1), "┘": (1, 0, 1, 0), "├": (1, 1, 0, 1), "┤": (1, 1, 1, 0),
}


def box(draw, ch, x, y, fill):
    up, down, left, right = BOX[ch]
    cx, cy = x + CELL_W // 2, y + CELL_H // 2
    if up:
        draw.line([cx, y, cx, cy], fill=fill, width=2)
    if down:
        draw.line([cx, cy, cx, y + CELL_H - 1], fill=fill, width=2)
    if left:
        draw.line([x, cy, cx, cy], fill=fill, width=2)
    if right:
        draw.line([cx, cy, x + CELL_W - 1, cy], fill=fill, width=2)


def colour(n):
    return PALETTE[n] if n < 16 else DEFAULT_FG


def main(src, dst):
    lines = open(src, encoding="utf-8").read().split("\n")[:ROWS]
    img = Image.new("RGB", (COLS * CELL_W + 2 * PAD, ROWS * CELL_H + 2 * PAD), DEFAULT_BG)
    draw = ImageDraw.Draw(img)
    fg, bg, bold, reverse = None, None, False, False
    for row, line in enumerate(lines):
        col = 0
        for token in re.split(r"(\x1b\[[0-9;]*m)", line):
            if token.startswith("\x1b["):
                codes = [int(c) if c else 0 for c in token[2:-1].split(";")]
                i = 0
                while i < len(codes):
                    c = codes[i]
                    if c == 0:
                        fg, bg, bold, reverse = None, None, False, False
                    elif c == 1:
                        bold = True
                    elif c == 22:
                        bold = False
                    elif c == 7:
                        reverse = True
                    elif c == 27:
                        reverse = False
                    elif 30 <= c <= 37:
                        fg = colour(c - 30)
                    elif 90 <= c <= 97:
                        fg = colour(c - 82)
                    elif c == 39:
                        fg = None
                    elif 40 <= c <= 47:
                        bg = colour(c - 40)
                    elif 100 <= c <= 107:
                        bg = colour(c - 92)
                    elif c == 49:
                        bg = None
                    elif c in (38, 48) and i + 2 < len(codes) and codes[i + 1] == 5:
                        if c == 38:
                            fg = colour(codes[i + 2])
                        else:
                            bg = colour(codes[i + 2])
                        i += 2
                    i += 1
                continue
            for ch in token:
                if col >= COLS:
                    break
                f, b = fg or DEFAULT_FG, bg or DEFAULT_BG
                if reverse:
                    f, b = b, f
                x, y = PAD + col * CELL_W, PAD + row * CELL_H
                draw.rectangle([x, y, x + CELL_W - 1, y + CELL_H - 1], fill=b)
                if ch in BOX:
                    box(draw, ch, x, y, f)
                elif ch != " ":
                    draw.text((x, y + 2), ch, font=BOLD if bold else FONT, fill=f)
                col += 1
        # tmux trims trailing blanks; fill the rest of the row with the current background.
        if col < COLS and bg is not None:
            x, y = PAD + col * CELL_W, PAD + row * CELL_H
            draw.rectangle([x, y, PAD + COLS * CELL_W - 1, y + CELL_H - 1], fill=bg)
    img.save(dst, optimize=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
