from __future__ import annotations

import io
from collections import deque
from dataclasses import dataclass
from typing import Iterable

import numpy as np
from PIL import Image


@dataclass
class SpriteObject:
    object_id: str
    image: Image.Image
    bbox: tuple[int, int, int, int]


def _to_rgba(image_bytes: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    return image


def _sample_border_pixels(rgb: np.ndarray, sample_step: int = 2) -> np.ndarray:
    h, w, _ = rgb.shape
    top = rgb[0, ::sample_step]
    bottom = rgb[h - 1, ::sample_step]
    left = rgb[::sample_step, 0]
    right = rgb[::sample_step, w - 1]
    samples = np.concatenate([top, bottom, left, right], axis=0)
    return samples.astype(np.int16)


def _reduce_border_samples(samples: np.ndarray, bin_size: int = 12, max_samples: int = 64) -> np.ndarray:
    # Quantize and deduplicate border colors to bound computation cost.
    if samples.size == 0:
        return samples

    quantized = (samples // bin_size) * bin_size
    _, unique_idx = np.unique(quantized, axis=0, return_index=True)
    reduced = samples[np.sort(unique_idx)]

    if reduced.shape[0] > max_samples:
        step = max(1, reduced.shape[0] // max_samples)
        reduced = reduced[::step][:max_samples]

    return reduced


def _color_distance_mask(rgb: np.ndarray, samples: np.ndarray, tolerance: int) -> np.ndarray:
    # Chunked min-distance computation to avoid allocating huge (pixels x samples) tensors.
    pixels = rgb.astype(np.int32).reshape(-1, 3)
    samples32 = samples.astype(np.int32)

    chunk_size = 120_000
    sample_batch = 32
    threshold2 = int(tolerance) * int(tolerance)
    out = np.zeros((pixels.shape[0],), dtype=bool)

    for start in range(0, pixels.shape[0], chunk_size):
        end = min(start + chunk_size, pixels.shape[0])
        chunk = pixels[start:end]
        min_dist2 = np.full((chunk.shape[0],), np.iinfo(np.int32).max, dtype=np.int64)

        for i in range(0, samples32.shape[0], sample_batch):
            batch = samples32[i : i + sample_batch]
            diff = chunk[:, None, :] - batch[None, :, :]
            dist2 = np.sum(diff * diff, axis=2)
            min_dist2 = np.minimum(min_dist2, np.min(dist2, axis=1))

        out[start:end] = min_dist2 <= threshold2

    return out.reshape(rgb.shape[0], rgb.shape[1])


def _flood_from_border(candidate_mask: np.ndarray) -> np.ndarray:
    h, w = candidate_mask.shape
    visited = np.zeros((h, w), dtype=bool)
    q: deque[tuple[int, int]] = deque()

    def try_push(y: int, x: int) -> None:
        if candidate_mask[y, x] and not visited[y, x]:
            visited[y, x] = True
            q.append((y, x))

    for x in range(w):
        try_push(0, x)
        try_push(h - 1, x)
    for y in range(h):
        try_push(y, 0)
        try_push(y, w - 1)

    neighbors = [(-1, 0), (1, 0), (0, -1), (0, 1)]
    while q:
        cy, cx = q.popleft()
        for dy, dx in neighbors:
            ny, nx = cy + dy, cx + dx
            if 0 <= ny < h and 0 <= nx < w and candidate_mask[ny, nx] and not visited[ny, nx]:
                visited[ny, nx] = True
                q.append((ny, nx))

    return visited


def remove_background(image_bytes: bytes, tolerance: int = 48) -> Image.Image:
    image = _to_rgba(image_bytes)
    arr = np.array(image)
    h, w = arr.shape[:2]

    # Downscale very large inputs during background detection to keep processing responsive.
    max_side = 1600
    if max(h, w) > max_side:
        scale = max_side / float(max(h, w))
        nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
        detect_img = image.resize((nw, nh), Image.Resampling.BILINEAR)
        detect_arr = np.array(detect_img)
        detect_rgb = detect_arr[:, :, :3]
    else:
        detect_rgb = arr[:, :, :3]

    alpha = arr[:, :, 3]

    border_samples = _sample_border_pixels(detect_rgb)
    border_samples = _reduce_border_samples(border_samples)
    candidate_bg_small = _color_distance_mask(detect_rgb, border_samples, tolerance=tolerance)

    # Only remove candidate pixels connected to outer border.
    removable_bg_small = _flood_from_border(candidate_bg_small)

    if removable_bg_small.shape != alpha.shape:
        removable_bg_img = Image.fromarray((removable_bg_small.astype(np.uint8) * 255), mode="L")
        removable_bg_img = removable_bg_img.resize((w, h), Image.Resampling.NEAREST)
        removable_bg = np.array(removable_bg_img) > 0
    else:
        removable_bg = removable_bg_small

    new_alpha = alpha.copy()
    new_alpha[removable_bg] = 0

    out = arr.copy()
    out[:, :, 3] = new_alpha
    return Image.fromarray(out, mode="RGBA")


def _connected_components(alpha_mask: np.ndarray, min_area: int) -> Iterable[tuple[int, int, int, int, np.ndarray]]:
    h, w = alpha_mask.shape
    visited = np.zeros((h, w), dtype=bool)
    neighbors = [(-1, 0), (1, 0), (0, -1), (0, 1)]

    for y in range(h):
        for x in range(w):
            if visited[y, x] or not alpha_mask[y, x]:
                continue

            q: deque[tuple[int, int]] = deque([(y, x)])
            visited[y, x] = True
            coords: list[tuple[int, int]] = []

            while q:
                cy, cx = q.popleft()
                coords.append((cy, cx))
                for dy, dx in neighbors:
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and alpha_mask[ny, nx]:
                        visited[ny, nx] = True
                        q.append((ny, nx))

            if len(coords) < min_area:
                continue

            ys = [p[0] for p in coords]
            xs = [p[1] for p in coords]
            y0, y1 = min(ys), max(ys)
            x0, x1 = min(xs), max(xs)

            local_mask = np.zeros((y1 - y0 + 1, x1 - x0 + 1), dtype=bool)
            for py, px in coords:
                local_mask[py - y0, px - x0] = True

            yield x0, y0, x1 + 1, y1 + 1, local_mask


def split_sprites(image: Image.Image, min_area: int = 36) -> list[SpriteObject]:
    rgba = np.array(image)
    alpha_mask = rgba[:, :, 3] > 0

    results: list[SpriteObject] = []
    for idx, (x0, y0, x1, y1, local_mask) in enumerate(_connected_components(alpha_mask, min_area=min_area), start=1):
        cropped = rgba[y0:y1, x0:x1].copy()
        cropped_alpha = cropped[:, :, 3]
        cropped_alpha[~local_mask] = 0
        cropped[:, :, 3] = cropped_alpha
        obj_image = Image.fromarray(cropped, mode="RGBA")
        results.append(SpriteObject(object_id=f"obj_{idx}", image=obj_image, bbox=(x0, y0, x1, y1)))

    return results


def image_to_png_bytes(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()
