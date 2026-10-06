use std::collections::VecDeque;
use std::path::Path;

use image::{Rgba, RgbaImage};

use crate::util::{ensure_dir, store_image};

/// Remove the background of an image by flood filling from the borders.
/// `tolerance` is the colour distance (0-255) considered "same background".
pub fn remove_background(image: &RgbaImage, tolerance: f32, feather: bool) -> RgbaImage {
    let (w, h) = image.dimensions();
    let mut out = image.clone();
    if w == 0 || h == 0 {
        return out;
    }

    // Sample the border colours to build a reference background colour.
    let mut samples: Vec<[f32; 3]> = Vec::new();
    let step = (w / 32).max(1);
    for x in (0..w).step_by(step as usize) {
        samples.push(px(image, x, 0));
        samples.push(px(image, x, h - 1));
    }
    let step_y = (h / 32).max(1);
    for y in (0..h).step_by(step_y as usize) {
        samples.push(px(image, 0, y));
        samples.push(px(image, w - 1, y));
    }
    let reference = samples
        .iter()
        .fold([0f32; 3], |acc, s| [acc[0] + s[0], acc[1] + s[1], acc[2] + s[2]]);
    let count = samples.len().max(1) as f32;
    let reference = [
        reference[0] / count,
        reference[1] / count,
        reference[2] / count,
    ];

    let mut visited = vec![false; (w as usize) * (h as usize)];
    let mut queue: VecDeque<(u32, u32)> = VecDeque::new();

    for x in 0..w {
        queue.push_back((x, 0));
        queue.push_back((x, h - 1));
    }
    for y in 0..h {
        queue.push_back((0, y));
        queue.push_back((w - 1, y));
    }

    while let Some((x, y)) = queue.pop_front() {
        let index = (y as usize) * (w as usize) + (x as usize);
        if visited[index] {
            continue;
        }
        visited[index] = true;
        let p = px(image, x, y);
        if distance(p, reference) > tolerance {
            continue;
        }
        out.put_pixel(x, y, Rgba([0, 0, 0, 0]));
        if x > 0 {
            queue.push_back((x - 1, y));
        }
        if y > 0 {
            queue.push_back((x, y - 1));
        }
        if x + 1 < w {
            queue.push_back((x + 1, y));
        }
        if y + 1 < h {
            queue.push_back((x, y + 1));
        }
    }

    if feather {
        soften_edges(&mut out, &visited, w, h);
    }
    out
}

fn soften_edges(out: &mut RgbaImage, visited: &[bool], w: u32, h: u32) {
    let snapshot = out.clone();
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let index = (y as usize) * (w as usize) + (x as usize);
            if visited[index] {
                continue;
            }
            let mut neighbours = 0;
            for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
                let nx = (x as i32 + dx) as u32;
                let ny = (y as i32 + dy) as u32;
                let n_index = (ny as usize) * (w as usize) + (nx as usize);
                if visited[n_index] {
                    neighbours += 1;
                }
            }
            if neighbours > 0 {
                let p = snapshot.get_pixel(x, y).0;
                let alpha = ((4 - neighbours) as f32 / 4.0 * 255.0).clamp(0.0, 255.0) as u8;
                out.put_pixel(x, y, Rgba([p[0], p[1], p[2], alpha.max(80)]));
            }
        }
    }
}

fn px(image: &RgbaImage, x: u32, y: u32) -> [f32; 3] {
    let p = image.get_pixel(x, y).0;
    [p[0] as f32, p[1] as f32, p[2] as f32]
}

fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    let d = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
    d / 1.732
}

fn is_skin(p: [f32; 3]) -> bool {
    let (r, g, b) = (p[0], p[1], p[2]);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    r > 95.0
        && g > 40.0
        && b > 20.0
        && (max - min) > 15.0
        && (r - g).abs() > 10.0
        && r > g
        && r > b
}

/// Very light-weight privacy blur: finds warm skin-tone blobs and blurs those areas.
/// It intentionally errs on the side of blurring more rather than less.
pub fn blur_faces(image: &RgbaImage, strength: f32) -> RgbaImage {
    let (w, h) = image.dimensions();
    let mut out = image.clone();
    if w < 40 || h < 40 {
        return out;
    }

    // Work on a coarse grid so the scan stays fast on large screenshots.
    let scale = 4u32;
    let gw = (w / scale).max(1);
    let gh = (h / scale).max(1);
    let mut mask = vec![false; (gw as usize) * (gh as usize)];
    for gy in 0..gh {
        for gx in 0..gw {
            mask[(gy as usize) * (gw as usize) + (gx as usize)] =
                is_skin(px(image, gx * scale, gy * scale));
        }
    }

    let mut visited = vec![false; mask.len()];
    let mut boxes: Vec<(u32, u32, u32, u32)> = Vec::new();
    for gy in 0..gh {
        for gx in 0..gw {
            let index = (gy as usize) * (gw as usize) + (gx as usize);
            if visited[index] || !mask[index] {
                continue;
            }
            let mut queue = VecDeque::from([(gx, gy)]);
            let (mut min_x, mut min_y, mut max_x, mut max_y) = (gx, gy, gx, gy);
            let mut cells = 0u32;
            while let Some((cx, cy)) = queue.pop_front() {
                let ci = (cy as usize) * (gw as usize) + (cx as usize);
                if visited[ci] || !mask[ci] {
                    continue;
                }
                visited[ci] = true;
                cells += 1;
                min_x = min_x.min(cx);
                min_y = min_y.min(cy);
                max_x = max_x.max(cx);
                max_y = max_y.max(cy);
                if cx > 0 {
                    queue.push_back((cx - 1, cy));
                }
                if cy > 0 {
                    queue.push_back((cx, cy - 1));
                }
                if cx + 1 < gw {
                    queue.push_back((cx + 1, cy));
                }
                if cy + 1 < gh {
                    queue.push_back((cx, cy + 1));
                }
            }
            let bw = max_x - min_x + 1;
            let bh = max_y - min_y + 1;
            let aspect = bw as f32 / bh as f32;
            // A face-ish blob: roughly square and not tiny.
            if cells > 40 && (0.45..2.2).contains(&aspect) {
                boxes.push((min_x, min_y, bw, bh));
            }
        }
    }

    for (bx, by, bw, bh) in boxes {
        let x = (bx * scale).saturating_sub(scale);
        let y = (by * scale).saturating_sub(scale);
        let width = ((bw * scale) + scale * 2).min(w.saturating_sub(x));
        let height = ((bh * scale) + scale * 2).min(h.saturating_sub(y));
        if width < 12 || height < 12 {
            continue;
        }
        let region = image::imageops::crop_imm(image, x, y, width, height).to_image();
        let blurred = image::imageops::blur(&region, strength.max(6.0));
        image::imageops::replace(&mut out, &blurred, x as i64, y as i64);
    }

    out
}

/// Simple auto-enhance: stretch contrast so the darkest pixel becomes black
/// and the brightest becomes white, then apply a mild saturation boost.
pub fn auto_enhance(image: &RgbaImage) -> RgbaImage {
    let mut min = 255u8;
    let mut max = 0u8;
    for pixel in image.pixels() {
        // u32 arithmetic: a u16 would overflow on 299 * 255.
        let luma =
            ((pixel.0[0] as u32 * 299 + pixel.0[1] as u32 * 587 + pixel.0[2] as u32 * 114) / 1000)
                as u8;
        min = min.min(luma);
        max = max.max(luma);
    }
    if max <= min {
        return image.clone();
    }
    let range = (max - min) as f32;
    let mut out = image.clone();
    for pixel in out.pixels_mut() {
        for c in 0..3 {
            let value = (pixel.0[c] as f32 - min as f32) / range * 255.0;
            let boosted = value.clamp(0.0, 255.0);
            let saturated = (boosted - 128.0) * 1.08 + 128.0;
            pixel.0[c] = saturated.clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// Save an AI-processed image next to the original.
pub fn save_result(image: RgbaImage, source: &Path, suffix: &str) -> anyhow::Result<(String, u64)> {
    let dir = source
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(crate::util::snappro_dir);
    ensure_dir(&dir)?;
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "image".to_string());
    let (id, path, size, _, _) = store_image(&image, &dir, &format!("{}_{}", stem, suffix), "png")?;
    let _ = id;
    Ok((path, size))
}

