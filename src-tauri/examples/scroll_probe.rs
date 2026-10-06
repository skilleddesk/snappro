//! Manual end-to-end probe for scrolling capture.
//!
//! Open a tall page in a window titled "SCROLLTEST" and run:
//!   cargo run --release --example scroll_probe
//! The window is found by title, scrolled with real mouse-wheel events and the
//! stitched result is written to the temp folder.

fn main() {
    let windows = xcap::Window::all().expect("cannot list windows");
    let target = windows
        .into_iter()
        .find(|w| w.title().unwrap_or_default().contains("SCROLLTEST"))
        .expect("open a window titled SCROLLTEST first");
    let (x, y) = (target.x().unwrap(), target.y().unwrap());
    let (w, h) = (target.width().unwrap(), target.height().unwrap());
    println!("window at {x},{y} size {w}x{h}");

    // Skip the title bar / frame: capture the inner part only.
    let (rx, ry, rw, rh) = (x + 10, y + 40, w - 40, h - 60);
    let dir = std::env::temp_dir().join("snappro-scroll-probe");
    let _ = std::fs::remove_dir_all(&dir);
    let started = std::time::Instant::now();
    let result = snappro_lib::capture::scrolling::capture_scrolling(
        rx, ry, rw, rh, 60, 0, 350, "png", dir, Some(&|done, _| println!("frame {done}")), None,
    )
    .expect("scrolling capture failed");
    println!(
        "OK {} ({}x{}) in {:.1}s [{}]",
        result.path,
        result.width,
        result.height,
        started.elapsed().as_secs_f32(),
        result.monitor
    );
}
