//! Manual end-to-end probe for the capture stack (xcap -> PNG on disk).
//!
//! Run it with:  cargo run --example capture_probe
//! It exercises exactly the same functions the "Full Screen" button calls, so a
//! failure here means the GUI button cannot work either.

fn main() {
    let dir = std::env::temp_dir().join("snappro-probe");
    let _ = std::fs::create_dir_all(&dir);

    println!("screens:");
    match xcap::Monitor::all() {
        Ok(monitors) => {
            for (index, monitor) in monitors.iter().enumerate() {
                println!(
                    "  [{}] {} {}x{} at ({},{}) primary={:?}",
                    index,
                    monitor
                        .friendly_name()
                        .or_else(|_| monitor.name())
                        .unwrap_or_else(|_| "display".into()),
                    monitor.width().unwrap_or(0),
                    monitor.height().unwrap_or(0),
                    monitor.x().unwrap_or(0),
                    monitor.y().unwrap_or(0),
                    monitor.is_primary()
                );
            }
        }
        Err(err) => println!("  FAILED: {err}"),
    }

    println!("full screen capture:");
    match snappro_lib::capture::full::capture_full_screen(None, "png", dir.clone()) {
        Ok(result) => println!(
            "  OK {} {}x{} {} bytes",
            result.path, result.width, result.height, result.size_bytes
        ),
        Err(err) => println!("  FAILED: {err}"),
    }

    println!("region capture (100x100 at 10,10):");
    match snappro_lib::capture::full::capture_region_global(10, 10, 100, 100, "png", dir.clone()) {
        Ok(result) => println!("  OK {} {}x{}", result.path, result.width, result.height),
        Err(err) => println!("  FAILED: {err}"),
    }

    println!("active window capture:");
    match snappro_lib::capture::window::capture_active_window("png", dir.clone(), None) {
        Ok(result) => println!("  OK {} {}x{}", result.path, result.width, result.height),
        Err(err) => println!("  FAILED: {err}"),
    }

    println!("saved files:");
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            println!("  {}", entry.path().display());
        }
    }
}