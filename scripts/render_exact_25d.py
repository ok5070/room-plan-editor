#!/usr/bin/env python3
"""Create a geometry-preserving 2.5D material pass from the project plan raster.

This renderer never redraws rooms or doors. It projects the source raster and
adds shallow wall relief, ambient shadow, and a presentation background.
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont


OUT_SIZE = (2400, 1350)
SOURCE_ROI = [(1715, 40), (2600, 55), (2600, 1720), (45, 1720)]


def affine_parameters(width: int, height: int, out_size: tuple[int, int]):
    # Oblique axonometric projection chosen to make the triangular plan fill a
    # 16:9 sheet without changing topology.
    a, b, c, d = 0.82, -0.08, 0.15, 0.55
    corners = np.array(SOURCE_ROI, dtype=float)
    matrix = np.array([[a, b], [c, d]], dtype=float)
    projected = corners @ matrix.T
    lo = projected.min(axis=0)
    hi = projected.max(axis=0)
    margin_x, margin_y = 54.0, 88.0
    scale = min((out_size[0] - 2 * margin_x) / (hi[0] - lo[0]), (out_size[1] - 2 * margin_y) / (hi[1] - lo[1]))
    matrix *= scale
    projected = corners @ matrix.T
    lo = projected.min(axis=0)
    hi = projected.max(axis=0)
    tx = (out_size[0] - (hi[0] - lo[0])) / 2 - lo[0]
    ty = (out_size[1] - (hi[1] - lo[1])) / 2 - lo[1] + 22
    forward = np.array([[matrix[0, 0], matrix[0, 1], tx], [matrix[1, 0], matrix[1, 1], ty], [0, 0, 1]], dtype=float)
    inverse = np.linalg.inv(forward)
    data = (inverse[0, 0], inverse[0, 1], inverse[0, 2], inverse[1, 0], inverse[1, 1], inverse[1, 2])
    return forward, data


def transform(img: Image.Image, data, out_size=OUT_SIZE, resample=Image.Resampling.BICUBIC):
    return img.transform(out_size, Image.Transform.AFFINE, data, resample=resample)


def prepare_source(src: Image.Image):
    rgb = np.asarray(src.convert("RGB"), dtype=np.uint8)
    spread = rgb.max(axis=2).astype(np.int16) - rgb.min(axis=2).astype(np.int16)
    gray = np.dot(rgb[..., :3], [0.299, 0.587, 0.114]).astype(np.uint8)

    # Remove coloured SKUD overlays from the clean architectural material pass.
    clean = np.stack([gray, gray, gray], axis=2)
    clean[spread > 34] = 255
    clean = np.clip(218 + (clean.astype(np.int16) - 218) * 0.72, 0, 255).astype(np.uint8)

    roi = Image.new("L", src.size, 0)
    ImageDraw.Draw(roi).polygon(SOURCE_ROI, fill=255)

    # Only long neutral drafting strokes can become wall relief. This removes
    # room numbers, text, device symbols and door swing arcs from the 3D mask.
    neutral_dark = (gray < 228) & (spread < 25)
    neutral_img = Image.fromarray(neutral_dark.astype(np.uint8) * 255, "L")
    neutral_dark = np.asarray(neutral_img.filter(ImageFilter.MaxFilter(3))) > 0
    wall_runs = long_line_mask(neutral_dark, min_run=20)
    wall = Image.fromarray(wall_runs.astype(np.uint8) * 255, "L")
    wall = wall.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(3))
    wall = Image.composite(wall, Image.new("L", src.size, 0), roi)
    return Image.fromarray(clean, "RGB"), roi, wall


def _mark_runs(values: np.ndarray, output: np.ndarray, coords, min_run: int):
    start = None
    for idx, value in enumerate(values):
        if value and start is None:
            start = idx
        if start is not None and (not value or idx == len(values) - 1):
            end = idx if not value else idx + 1
            if end - start >= min_run:
                for pos in range(start, end):
                    y, x = coords[pos]
                    output[y, x] = True
            start = None


def long_line_mask(binary: np.ndarray, min_run: int = 24):
    """Keep long horizontal, vertical, and diagonal runs from a binary raster."""
    h, w = binary.shape
    output = np.zeros_like(binary, dtype=bool)
    for y in range(h):
        coords = [(y, x) for x in range(w)]
        _mark_runs(binary[y, :], output, coords, min_run)
    for x in range(w):
        coords = [(y, x) for y in range(h)]
        _mark_runs(binary[:, x], output, coords, min_run)
    for offset in range(-h + 1, w):
        coords = [(y, y + offset) for y in range(h) if 0 <= y + offset < w]
        vals = np.array([binary[y, x] for y, x in coords], dtype=bool)
        _mark_runs(vals, output, coords, max(16, min_run - 6))
    for total in range(h + w - 1):
        coords = [(y, total - y) for y in range(h) if 0 <= total - y < w]
        vals = np.array([binary[y, x] for y, x in coords], dtype=bool)
        _mark_runs(vals, output, coords, max(16, min_run - 6))
    return output


def shifted_mask(mask: Image.Image, dy: int):
    out = Image.new("L", mask.size, 0)
    out.paste(mask, (0, dy))
    return out


def font(size: int, bold=False):
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Helvetica.ttc",
    ]
    for name in candidates:
        if Path(name).exists():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default()


def render(source_path: Path, output_path: Path):
    src = Image.open(source_path).convert("RGB")
    clean, roi, wall = prepare_source(src)
    _, inv = affine_parameters(*src.size, OUT_SIZE)

    projected_plan = transform(clean, inv)
    projected_roi = transform(roi, inv, resample=Image.Resampling.BILINEAR)
    projected_wall = transform(wall, inv, resample=Image.Resampling.BILINEAR)

    canvas = Image.new("RGBA", OUT_SIZE, (246, 247, 248, 255))
    bg = Image.new("RGBA", OUT_SIZE, (246, 247, 248, 255))
    # Soft studio falloff.
    shade = Image.new("L", OUT_SIZE, 0)
    sd = ImageDraw.Draw(shade)
    sd.ellipse((-180, -280, 2050, 1580), fill=95)
    shade = shade.filter(ImageFilter.GaussianBlur(250))
    glow = Image.new("RGBA", OUT_SIZE, (255, 255, 255, 0))
    glow.putalpha(shade)
    bg.alpha_composite(glow)
    canvas.alpha_composite(bg)

    # Model footprint and broad ambient shadow.
    shadow_mask = projected_roi.filter(ImageFilter.GaussianBlur(20))
    shadow = Image.new("RGBA", OUT_SIZE, (40, 48, 54, 0))
    shadow.putalpha(shadow_mask.point(lambda p: int(p * 0.22)))
    shadow = Image.new("RGBA", OUT_SIZE, (0, 0, 0, 0)) if not shadow.getbbox() else shadow
    shifted_shadow = Image.new("RGBA", OUT_SIZE, (0, 0, 0, 0))
    shifted_shadow.paste(shadow, (15, 28), shadow)
    canvas.alpha_composite(shifted_shadow)

    floor = projected_plan.convert("RGBA")
    floor.putalpha(projected_roi.point(lambda p: int(p * 0.98)))
    canvas.alpha_composite(floor)

    # Raised wall sides, kept shallow enough that door openings remain legible.
    height = 42
    for step in range(height, 0, -1):
        alpha = shifted_mask(projected_wall, -step).point(lambda p: int(p * (0.82 + 0.16 * step / height)))
        tone = int(118 + 58 * (1 - step / height))
        side = Image.new("RGBA", OUT_SIZE, (tone, tone + 2, tone + 4, 0))
        side.putalpha(alpha)
        canvas.alpha_composite(side)

    top_shadow = shifted_mask(projected_wall, -height).filter(ImageFilter.GaussianBlur(2))
    top = Image.new("RGBA", OUT_SIZE, (226, 228, 230, 0))
    top.putalpha(top_shadow)
    canvas.alpha_composite(top)

    # Reapply exact source linework over the floor so every door swing and
    # partition remains available for the door-control comparison.
    line_overlay = projected_plan.convert("RGBA")
    arr = np.asarray(projected_plan.convert("L"))
    line_alpha = np.clip((224 - arr.astype(np.int16)) * 2.5, 0, 180).astype(np.uint8)
    line_alpha = Image.fromarray(line_alpha, "L")
    line_alpha = Image.composite(line_alpha, Image.new("L", OUT_SIZE, 0), projected_roi)
    line_overlay.putalpha(line_alpha)
    canvas.alpha_composite(line_overlay)

    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((42, 34, 790, 121), radius=18, fill=(248, 249, 250, 232), outline=(27, 142, 158, 190), width=2)
    draw.text((70, 48), "СКУД · ОБЩИЙ ПЛАН · 2.5D", font=font(42, bold=True), fill=(26, 48, 60, 255))
    draw.rounded_rectangle((52, 1252, 690, 1312), radius=12, fill=(248, 249, 250, 235), outline=(90, 112, 124, 150), width=1)
    draw.text((75, 1266), "Иллюстративная визуализация. Не для монтажа.", font=font(24), fill=(62, 82, 94, 255))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(output_path, quality=96)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    render(args.source, args.output)


if __name__ == "__main__":
    main()
