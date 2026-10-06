use image::RgbaImage;

use crate::capture::r;

/// Full-screen snapshot used as the backdrop of the region selector overlay.
///
/// `None` captures the whole virtual desktop (every monitor stitched together,
/// so the overlay that spans all screens lines up with its backdrop); `Some(i)`
/// captures just that monitor.
pub fn overlay_backdrop(monitor: Option<usize>) -> anyhow::Result<(RgbaImage, String, i32, i32, u32, u32)> {
    if monitor.is_none() {
        let (image, vx, vy) = crate::capture::full::capture_virtual_raw()?;
        let (w, h) = (image.width(), image.height());
        return Ok((image, "all displays".to_string(), vx, vy, w, h));
    }
    let m = crate::capture::full::select_monitor(monitor)?;
    let image = r(m.capture_image())?;
    let (w, h) = (image.width(), image.height());
    Ok((
        image,
        crate::capture::full::monitor_label(&m),
        m.x().unwrap_or(0),
        m.y().unwrap_or(0),
        w,
        h,
    ))
}

/// Crop a rectangle out of an existing image.
pub fn crop(image: &RgbaImage, x: u32, y: u32, width: u32, height: u32) -> anyhow::Result<RgbaImage> {
    if x >= image.width() || y >= image.height() {
        anyhow::bail!("crop area starts outside the image");
    }
    let w = width.min(image.width() - x);
    let h = height.min(image.height() - y);
    if w == 0 || h == 0 {
        anyhow::bail!("crop area is empty");
    }
    Ok(image::imageops::crop_imm(image, x, y, w, h).to_image())
}

fn point_in_polygon(points: &[(f32, f32)], x: f32, y: f32) -> bool {
    let mut inside = false;
    let n = points.len();
    if n < 3 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = points[i];
        let (xj, yj) = points[j];
        if ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + f32::EPSILON) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Crop a freehand (polygon) selection; everything outside the polygon becomes transparent.
pub fn crop_freehand(image: &RgbaImage, points: &[(f32, f32)]) -> anyhow::Result<RgbaImage> {
    if points.len() < 3 {
        anyhow::bail!("freehand selection needs at least three points");
    }
    let min_x = points.iter().map(|p| p.0).fold(f32::MAX, f32::min).max(0.0) as u32;
    let min_y = points.iter().map(|p| p.1).fold(f32::MAX, f32::min).max(0.0) as u32;
    let max_x = (points.iter().map(|p| p.0).fold(f32::MIN, f32::max) as u32).min(image.width() - 1);
    let max_y = (points.iter().map(|p| p.1).fold(f32::MIN, f32::max) as u32).min(image.height() - 1);
    let w = max_x.saturating_sub(min_x) + 1;
    let h = max_y.saturating_sub(min_y) + 1;
    if w < 2 || h < 2 {
        anyhow::bail!("freehand selection is too small");
    }

    let local: Vec<(f32, f32)> = points
        .iter()
        .map(|(x, y)| (x - min_x as f32, y - min_y as f32))
        .collect();

    let mut out = RgbaImage::new(w, h);
    for py in 0..h {
        for px in 0..w {
            if point_in_polygon(&local, px as f32 + 0.5, py as f32 + 0.5) {
                let src = image.get_pixel(px + min_x, py + min_y);
                out.put_pixel(px, py, *src);
            }
        }
    }
    Ok(out)
}