use std::path::PathBuf;
use std::thread::sleep;
use std::time::Duration;

use enigo::{Axis, Enigo, Mouse, Settings};
use image::RgbaImage;

use crate::capture::CaptureResult;

/// Difference between one row of `a` and one row of `b` (0 = identical).
fn row_diff_at(a: &RgbaImage, row_a: u32, b: &RgbaImage, row_b: u32) -> f32 {
    let width = a.width().min(b.width());
    if width == 0 {
        return 255.0;
    }
    let mut sum = 0f32;
    for x in 0..width {
        let pa = a.get_pixel(x, row_a).0;
        let pb = b.get_pixel(x, row_b).0;
        sum += (pa[0] as f32 - pb[0] as f32).abs()
            + (pa[1] as f32 - pb[1] as f32).abs()
            + (pa[2] as f32 - pb[2] as f32).abs();
    }
    sum / (width as f32 * 3.0)
}

/// Mean difference between two rows looking only at every `step`-th column and
/// ignoring the right-hand edge (where a scroll bar would otherwise spoil the match).
fn row_diff_sparse(a: &RgbaImage, row_a: u32, b: &RgbaImage, row_b: u32, step: u32) -> f32 {
    let width = a.width().min(b.width());
    let usable = width.saturating_sub(width / 40 + 18).max(1);
    let mut sum = 0f32;
    let mut count = 0f32;
    let mut x = 0;
    while x < usable {
        let pa = a.get_pixel(x, row_a).0;
        let pb = b.get_pixel(x, row_b).0;
        sum += (pa[0] as f32 - pb[0] as f32).abs()
            + (pa[1] as f32 - pb[1] as f32).abs()
            + (pa[2] as f32 - pb[2] as f32).abs();
        count += 3.0;
        x += step;
    }
    if count == 0.0 {
        255.0
    } else {
        sum / count
    }
}

/// True when a row contains more than one colour (flat white rows tell us nothing).
fn row_has_texture(img: &RgbaImage, row: u32) -> bool {
    let mut min = 255u8;
    let mut max = 0u8;
    let mut x = 0;
    while x < img.width() {
        let p = img.get_pixel(x, row).0;
        let l = ((p[0] as u16 + p[1] as u16 + p[2] as u16) / 3) as u8;
        min = min.min(l);
        max = max.max(l);
        x += 3;
    }
    max.saturating_sub(min) > 14
}

/// How far (in pixels) the content moved between two consecutive frames.
///
/// A band near the top of `next` is searched for inside `prev`. Using a band
/// instead of the very top rows keeps sticky page headers from confusing the
/// match, and checking several rows keeps repeated patterns (tables, lined
/// paper) from matching at the wrong offset. `expected` breaks near-ties.
pub fn find_shift(prev: &RgbaImage, next: &RgbaImage, expected: Option<u32>) -> Option<u32> {
    let h = prev.height().min(next.height());
    if h < 60 {
        return None;
    }
    let band_start = h * 18 / 100;
    let band_end = h * 38 / 100;
    let max_shift = h - band_end;
    if max_shift < 2 {
        return None;
    }

    let rows: Vec<u32> = {
        let span = band_end - band_start;
        let n = span.min(24).max(1);
        (0..n).map(|i| band_start + i * span / n).collect()
    };
    let textured = rows.iter().filter(|&&y| row_has_texture(next, y)).count();
    if textured < 3 {
        return None;
    }

    let mut scores: Vec<(u32, f32)> = Vec::with_capacity(max_shift as usize);
    for shift in 1..=max_shift {
        let mut total = 0f32;
        for &y in &rows {
            total += row_diff_sparse(next, y, prev, y + shift, 3);
            // Early exit: this offset is clearly worse than a perfect match.
            if total > rows.len() as f32 * 30.0 {
                break;
            }
        }
        scores.push((shift, total / rows.len() as f32));
    }

    let best = scores
        .iter()
        .map(|(_, s)| *s)
        .fold(f32::MAX, f32::min);
    if best > 5.0 {
        return None;
    }
    let near_best: Vec<u32> = scores
        .iter()
        .filter(|(_, s)| *s <= best + 0.6)
        .map(|(shift, _)| *shift)
        .collect();
    match expected {
        Some(target) => near_best
            .into_iter()
            .min_by_key(|shift| (*shift as i64 - target as i64).abs()),
        None => near_best.into_iter().min(),
    }
}

/// Find the vertical overlap (pixels) between two consecutive frames by
/// matching the bottom of `prev` against the top of `next`. Used when the
/// banded search finds nothing to hold on to (mostly flat pages).
fn find_overlap(prev: &RgbaImage, next: &RgbaImage) -> Option<u32> {
    let height = prev.height().min(next.height());
    if height < 24 {
        return None;
    }
    let min_overlap = (height / 10).max(8);
    let max_overlap = height.saturating_sub(4);
    let mut best: Option<(f32, u32)> = None;

    for overlap in min_overlap..=max_overlap {
        let samples = 12u32;
        let mut total = 0f32;
        for i in 0..samples {
            let offset = (i * overlap / samples).min(overlap.saturating_sub(1));
            let row_prev = prev.height() - overlap + offset;
            total += row_diff_at(prev, row_prev, next, offset);
        }
        let score = total / samples as f32;
        if score < 8.0 {
            let better = match best {
                Some((best_score, best_overlap)) => {
                    score < best_score - 0.05
                        || ((score - best_score).abs() <= 0.05 && overlap > best_overlap)
                }
                None => true,
            };
            if better {
                best = Some((score, overlap));
            }
        }
    }
    best.map(|(_, overlap)| overlap)
}

fn frames_identical(a: &RgbaImage, b: &RgbaImage) -> bool {
    if a.dimensions() != b.dimensions() {
        return false;
    }
    let step = (a.height() / 40).max(1);
    let mut row = 0;
    while row < a.height() {
        if row_diff_at(a, row, b, row) > 1.0 {
            return false;
        }
        row += step;
    }
    true
}

/// Height of a sticky footer: rows at the bottom that stay identical while the
/// page scrolls underneath them.
fn static_footer(prev: &RgbaImage, next: &RgbaImage) -> u32 {
    let h = prev.height().min(next.height());
    let limit = h / 3;
    let mut count = 0;
    let mut textured = false;
    while count < limit {
        let y = h - 1 - count;
        if row_diff_at(prev, y, next, y) > 1.5 {
            break;
        }
        if row_has_texture(next, y) {
            textured = true;
        }
        count += 1;
    }
    if textured {
        count
    } else {
        0
    }
}

/// Copy rows `from..to` of `src` into `out` starting at row `y`, returning the next free row.
fn blit_rows(out: &mut RgbaImage, src: &RgbaImage, from: u32, to: u32, mut y: u32) -> u32 {
    let width = out.width().min(src.width());
    for row in from..to.min(src.height()) {
        if y >= out.height() {
            break;
        }
        for x in 0..width {
            out.put_pixel(x, y, *src.get_pixel(x, row));
        }
        y += 1;
    }
    y
}

/// Join frames using a known scroll distance per pair (`None` = unknown, fall
/// back to overlap matching). `footer` rows of the last frame are kept once.
fn stitch_with_shifts(frames: &[RgbaImage], shifts: &[Option<u32>], footer: u32) -> RgbaImage {
    let width = frames[0].width().max(1);
    // (frame index, first row, last row exclusive)
    let mut parts: Vec<(usize, u32, u32)> = Vec::new();
    let first_h = frames[0].height();
    let body_end = |h: u32| h.saturating_sub(footer);
    parts.push((0, 0, if frames.len() > 1 { body_end(first_h) } else { first_h }));

    for i in 1..frames.len() {
        let h = frames[i].height();
        let shift = shifts.get(i - 1).copied().flatten();
        let (from, to) = match shift {
            Some(s) => (body_end(h).saturating_sub(s), body_end(h)),
            None => {
                let skip = find_overlap(&frames[i - 1], &frames[i]).unwrap_or(0);
                (skip.min(h.saturating_sub(1)), body_end(h).max(skip + 1).min(h))
            }
        };
        parts.push((i, from, to.max(from)));
    }
    if footer > 0 && frames.len() > 1 {
        let last = frames.len() - 1;
        let h = frames[last].height();
        parts.push((last, body_end(h), h));
    }

    let total: u32 = parts.iter().map(|(_, a, b)| b - a).sum();
    let mut out = RgbaImage::new(width, total.max(1));
    let mut y = 0;
    for (index, from, to) in parts {
        y = blit_rows(&mut out, &frames[index], from, to, y);
    }
    let final_height = y.max(1);
    image::imageops::crop_imm(&out, 0, 0, width, final_height).to_image()
}

/// Stitch frames (top to bottom) into one tall image by removing the overlap.
pub fn stitch_vertical(frames: &[RgbaImage]) -> anyhow::Result<RgbaImage> {
    if frames.is_empty() {
        anyhow::bail!("nothing captured");
    }
    if frames.len() == 1 {
        return Ok(frames[0].clone());
    }
    let shifts: Vec<Option<u32>> = frames
        .windows(2)
        .map(|pair| find_shift(&pair[0], &pair[1], None))
        .collect();
    Ok(stitch_with_shifts(frames, &shifts, 0))
}

/// Pixel limit so a runaway page cannot exhaust memory.
const MAX_STITCHED_HEIGHT: u32 = 30_000;

/// Capture a tall region by scrolling and stitching the frames together.
///
/// `scroll_amount` is a hint for how many wheel notches to send per step
/// (0 = work it out automatically). The mouse wheel goes to whatever is under
/// the pointer, so the pointer is parked in the middle of the region.
#[allow(clippy::too_many_arguments)]
pub fn capture_scrolling(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    max_frames: u32,
    scroll_amount: i32,
    delay_ms: u64,
    format: &str,
    dir: PathBuf,
    on_progress: Option<&dyn Fn(u32, u32)>,
    should_stop: Option<&dyn Fn() -> bool>,
) -> anyhow::Result<CaptureResult> {
    let stop_requested = || should_stop.map(|f| f()).unwrap_or(false);
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| {
        anyhow::anyhow!(
            "Scrolling capture needs permission to control the mouse wheel ({e}). \
             On macOS allow SnapPro under Privacy & Security > Accessibility; \
             on Linux allow remote interaction when the desktop asks."
        )
    })?;
    let max_frames = max_frames.clamp(2, 120);
    let settle = Duration::from_millis(delay_ms.max(150));

    let centre_x = x + (width as i32 / 2).max(1);
    let centre_y = y + (height as i32 / 2).max(1);
    let park = |engine: &mut Enigo| {
        let _ = engine.move_mouse(centre_x, centre_y, enigo::Coordinate::Abs);
    };
    park(&mut enigo);

    // Go to the top of the page: keep scrolling up until two frames match.
    let mut last = crate::capture::full::capture_region_raw(x, y, width, height)?;
    for _ in 0..80 {
        if stop_requested() {
            break;
        }
        let _ = enigo.scroll(-12, Axis::Vertical);
        sleep(Duration::from_millis(60));
        let now = crate::capture::full::capture_region_raw(x, y, width, height)?;
        let same = frames_identical(&last, &now);
        last = now;
        if same {
            break;
        }
    }
    sleep(settle);

    let first = crate::capture::full::capture_region_raw(x, y, width, height)?;
    let mut frames: Vec<RgbaImage> = vec![first];
    let mut shifts: Vec<Option<u32>> = Vec::new();
    if let Some(cb) = on_progress {
        cb(1, max_frames);
    }

    // Wheel notches per step; the real pixel size of a notch is measured on
    // the way (it depends on the app and on display scaling).
    let target_shift = (height as f32 * 0.55).max(40.0);
    let mut notches: i32 = if scroll_amount != 0 {
        scroll_amount.abs().clamp(1, 40)
    } else {
        ((target_shift / 100.0).round() as i32).max(1)
    };
    let mut px_per_notch: Option<f32> = None;
    let mut retries = 0;
    let mut footer = 0u32;
    let mut total_height = height;

    while (frames.len() as u32) < max_frames {
        if stop_requested() {
            break;
        }
        park(&mut enigo);
        let _ = enigo.scroll(notches, Axis::Vertical);
        sleep(settle);
        let frame = crate::capture::full::capture_region_raw(x, y, width, height)?;
        let prev = frames.last().expect("at least one frame");

        if frames_identical(prev, &frame) {
            break; // bottom of the page
        }

        let expected = px_per_notch.map(|p| (p * notches as f32) as u32);
        match find_shift(prev, &frame, expected) {
            Some(shift) if shift >= 3 => {
                px_per_notch = Some(shift as f32 / notches as f32);
                if frames.len() == 1 {
                    footer = static_footer(prev, &frame);
                }
                // Aim the next step at ~55% of the window.
                if scroll_amount == 0 {
                    if let Some(ppn) = px_per_notch {
                        notches = ((target_shift / ppn.max(1.0)).round() as i32).clamp(1, 40);
                    }
                }
                total_height = total_height.saturating_add(shift);
                shifts.push(Some(shift));
                frames.push(frame);
                retries = 0;
                if let Some(cb) = on_progress {
                    cb(frames.len() as u32, max_frames);
                }
            }
            Some(_) => break, // barely moved: the end of the page
            None => {
                // The step was too big to find any common content: go back and
                // try a smaller one, as long as that is still possible.
                if notches > 1 && retries < 4 {
                    let _ = enigo.scroll(-notches, Axis::Vertical);
                    sleep(settle);
                    notches = (notches / 2).max(1);
                    retries += 1;
                    continue;
                }
                shifts.push(None);
                frames.push(frame);
                retries = 0;
                if let Some(cb) = on_progress {
                    cb(frames.len() as u32, max_frames);
                }
            }
        }
        if total_height > MAX_STITCHED_HEIGHT {
            break;
        }
    }

    let count = frames.len();
    let stitched = if count == 1 {
        frames.remove(0)
    } else {
        stitch_with_shifts(&frames, &shifts, footer)
    };
    crate::capture::full::save_rgba(
        stitched,
        "Scrolling",
        format,
        dir,
        "scrolling",
        format!("{} frames stitched", count),
    )
}
