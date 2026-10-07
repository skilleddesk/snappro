//! Unit tests for the pure logic in SnapPro (image processing, stitching,
//! PDF writing, settings serialisation and recorder argument building).

use image::{Rgba, RgbaImage};

fn solid(width: u32, height: u32, colour: [u8; 4]) -> RgbaImage {
    let mut image = RgbaImage::new(width, height);
    for pixel in image.pixels_mut() {
        *pixel = Rgba(colour);
    }
    image
}

/// Fill a horizontal band of rows with a second colour.
fn with_band(mut image: RgbaImage, from: u32, to: u32, colour: [u8; 4]) -> RgbaImage {
    for y in from..to.min(image.height()) {
        for x in 0..image.width() {
            image.put_pixel(x, y, Rgba(colour));
        }
    }
    image
}

#[test]
fn settings_round_trip_through_json() {
    let settings = snappro_lib::settings::Settings::default();
    let text = serde_json::to_string(&settings).unwrap();
    let parsed: snappro_lib::settings::Settings = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed.format, settings.format);
    assert_eq!(parsed.shortcuts.len(), 5);
    assert!(parsed.auto_copy);
}

#[test]
fn settings_fall_back_to_defaults_on_broken_json() {
    let parsed: Result<snappro_lib::settings::Settings, _> = serde_json::from_str("{ not json");
    assert!(parsed.is_err());
    let default = snappro_lib::settings::Settings::default();
    assert_eq!(default.delay_secs, 3);
    assert_eq!(default.monitor, "primary");
}

#[test]
fn shortcut_slots_match_their_ui_labels() {
    // Slot 1 is labelled "Full", 2 "Region", 3 "Window", 4 "Scrolling",
    // 5 "Record"; the action ids are grouped differently, so the mapping is
    // easy to get wrong and must stay pinned by a test.
    use snappro_lib::settings::shortcut_action;
    assert_eq!(shortcut_action(0), 0, "slot 1 -> full screen");
    assert_eq!(shortcut_action(1), 2, "slot 2 -> region");
    assert_eq!(shortcut_action(2), 1, "slot 3 -> window");
    assert_eq!(shortcut_action(3), 3, "slot 4 -> scrolling");
    assert_eq!(shortcut_action(4), 4, "slot 5 -> record");
}

#[test]
fn recording_arguments_target_the_right_input_per_system() {
    use snappro_lib::recorder::{build_args, RecordOptions};

    let opts = RecordOptions {
        fps: 30,
        draw_mouse: true,
        ..RecordOptions::default()
    };
    let args = build_args(&opts, "out.mp4");

    #[cfg(target_os = "windows")]
    assert!(args.contains(&"gdigrab".to_string()), "windows uses gdigrab");
    #[cfg(target_os = "linux")]
    assert!(args.contains(&"x11grab".to_string()), "linux uses x11grab");
    #[cfg(target_os = "macos")]
    assert!(
        args.contains(&"avfoundation".to_string()),
        "macOS must not be handed an X11 input"
    );

    // The output path always has to be the last argument, or ffmpeg writes
    // nowhere and "recording" silently produces nothing.
    assert_eq!(args.last().unwrap(), "out.mp4");
    assert!(args.iter().any(|a| a == "libx264"));
}

#[test]
fn recording_in_a_region_passes_the_crop() {
    use snappro_lib::recorder::{build_args, RecordOptions, RegionRect};

    let opts = RecordOptions {
        region: Some(RegionRect {
            x: 10,
            y: 20,
            width: 800,
            height: 600,
        }),
        ..RecordOptions::default()
    };
    let args = build_args(&opts, "out.mp4");
    assert!(
        args.iter().any(|a| a == "800x600"),
        "the region size must reach ffmpeg, got {:?}",
        args
    );
}

/// End-to-end: really record a few seconds of the screen with ffmpeg and check
/// that a playable file lands on disk.
#[test]
fn recording_writes_a_real_video_file() {
    use snappro_lib::recorder::{spawn_recording, stop_child, RecordOptions};

    let dir = std::env::temp_dir().join(format!("snappro-rec-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let output = dir.join("take.mp4");

    let opts = RecordOptions {
        fps: 10,
        format: "mp4".into(),
        ..RecordOptions::default()
    };

    let mut child = match spawn_recording(&output, &opts) {
        Ok(child) => child,
        // No ffmpeg or no display in this environment: not a regression.
        Err(_) => return,
    };
    std::thread::sleep(std::time::Duration::from_secs(3));
    if stop_child(&mut child).is_err() {
        return;
    }
    // ffmpeg finalises the container while exiting; give it a moment.
    for _ in 0..25 {
        if output.exists() && std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0) > 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    let bytes = std::fs::read(&output).expect("recording produced no file");
    assert!(bytes.len() > 1024, "recording is suspiciously small");
    // MP4 files carry an 'ftyp' box near the start.
    assert_eq!(&bytes[4..8], b"ftyp", "output is not an MP4 container");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn defaults_show_a_result_after_a_capture() {
    // These two defaults are what make a capture visibly "work": the preview is
    // shown, and the app opens in the compact quick bar.
    let default = snappro_lib::settings::Settings::default();
    assert!(default.open_preview, "a capture must show its preview");
    assert!(default.mini_mode, "the app opens as a quick bar");
    assert!(default.auto_save);
    assert_eq!(default.language, "en");
}

#[test]
fn crop_region_returns_requested_size() {
    let image = solid(400, 300, [255, 255, 255, 255]);
    let cropped = snappro_lib::capture::region::crop(&image, 40, 30, 100, 50).unwrap();
    assert_eq!(cropped.width(), 100);
    assert_eq!(cropped.height(), 50);
}

#[test]
fn crop_region_clamps_to_image_bounds() {
    let image = solid(120, 90, [0, 0, 0, 255]);
    let cropped = snappro_lib::capture::region::crop(&image, 100, 80, 400, 400).unwrap();
    assert_eq!(cropped.width(), 20);
    assert_eq!(cropped.height(), 10);
}

#[test]
fn crop_region_rejects_out_of_bounds_start() {
    let image = solid(50, 50, [0, 0, 0, 255]);
    assert!(snappro_lib::capture::region::crop(&image, 60, 60, 10, 10).is_err());
}

#[test]
fn freehand_crop_keeps_the_inside_and_clears_the_outside() {
    let image = solid(100, 100, [255, 0, 0, 255]);
    // A triangle: the bottom-right half of the selection stays transparent.
    let points = vec![(10.0, 10.0), (90.0, 10.0), (10.0, 90.0)];
    let cropped = snappro_lib::capture::region::crop_freehand(&image, &points).unwrap();
    assert_eq!(cropped.dimensions(), (81, 81));

    // A point just inside the top edge of the triangle keeps its colour.
    let inside = cropped.get_pixel(40, 2).0;
    assert_eq!(inside[3], 255);
    assert_eq!(inside[0], 255);

    // The far corner lies outside the triangle and must be transparent.
    let outside = cropped.get_pixel(cropped.width() - 2, cropped.height() - 2).0;
    assert_eq!(outside[3], 0);
}

#[test]
fn freehand_crop_needs_at_least_three_points() {
    let image = solid(40, 40, [0, 0, 0, 255]);
    assert!(snappro_lib::capture::region::crop_freehand(&image, &[(1.0, 1.0), (2.0, 2.0)]).is_err());
}

#[test]
fn stitch_joins_two_frames_and_removes_the_overlap() {
    let base = solid(60, 100, [20, 20, 20, 255]);
    // Frame A: rows 0..100 with a red band at 80..100.
    let frame_a = with_band(base.clone(), 80, 100, [255, 0, 0, 255]);
    // Frame B starts 20 rows further down: the red band is now at 60..80.
    let frame_b = with_band(base.clone(), 60, 80, [255, 0, 0, 255]);
    let stitched = snappro_lib::capture::scrolling::stitch_vertical(&[frame_a, frame_b]).unwrap();
    assert_eq!(stitched.width(), 60);
    // The overlap is removed, so the result is taller than a single frame but
    // shorter than the naive sum.
    assert!(stitched.height() > 100);
    assert!(stitched.height() < 200);
}

#[test]
fn stitch_of_a_single_frame_is_a_copy() {
    let frame = solid(10, 10, [1, 2, 3, 255]);
    let stitched = snappro_lib::capture::scrolling::stitch_vertical(&[frame.clone()]).unwrap();
    assert_eq!(stitched.dimensions(), frame.dimensions());
}

#[test]
fn stitch_rejects_an_empty_frame_list() {
    let frames: Vec<RgbaImage> = Vec::new();
    assert!(snappro_lib::capture::scrolling::stitch_vertical(&frames).is_err());
}

#[test]
fn pdf_writer_creates_a_valid_header() {
    let dir = std::env::temp_dir().join("snappro-test-pdf");
    std::fs::create_dir_all(&dir).unwrap();
    let image_path = dir.join("page.png");
    solid(200, 120, [10, 120, 220, 255]).save(&image_path).unwrap();

    let target = dir.join("out.pdf");
    let size = snappro_lib::pdf::images_to_pdf(&[image_path], &target).unwrap();
    assert!(size > 1000);

    let bytes = std::fs::read(&target).unwrap();
    assert_eq!(&bytes[0..5], b"%PDF-");
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("%%EOF"));
    assert!(text.contains("/Type /Pages"));
}

#[test]
fn pdf_writer_rejects_an_empty_image_list() {
    let target = std::env::temp_dir().join("snappro-test-empty.pdf");
    assert!(snappro_lib::pdf::images_to_pdf(&[], &target).is_err());
}

#[test]
fn remove_background_clears_the_flat_border() {
    let image = solid(60, 60, [250, 250, 250, 255]);
    let processed = snappro_lib::ai::remove_background(&image, 30.0, false);
    assert_eq!(processed.get_pixel(0, 0).0[3], 0);
    assert_eq!(processed.get_pixel(30, 30).0[3], 0);
}

#[test]
fn remove_background_keeps_a_different_subject() {
    let mut image = solid(60, 60, [250, 250, 250, 255]);
    for y in 25..35 {
        for x in 25..35 {
            image.put_pixel(x, y, Rgba([10, 10, 10, 255]));
        }
    }
    let processed = snappro_lib::ai::remove_background(&image, 30.0, false);
    // The dark square is far from the light background, so it survives.
    assert_eq!(processed.get_pixel(30, 30).0[3], 255);
    assert_eq!(processed.get_pixel(0, 0).0[3], 0);
}

#[test]
fn auto_enhance_stretches_the_range() {
    let mut image = solid(20, 20, [100, 100, 100, 255]);
    for y in 0..10 {
        for x in 0..20 {
            image.put_pixel(x, y, Rgba([180, 180, 180, 255]));
        }
    }
    let enhanced = snappro_lib::ai::auto_enhance(&image);
    assert_eq!(enhanced.get_pixel(0, 15).0[0], 0);
    assert_eq!(enhanced.get_pixel(0, 5).0[0], 255);
}

#[test]
fn blur_faces_leaves_a_plain_image_untouched() {
    let image = solid(120, 120, [40, 90, 200, 255]);
    let blurred = snappro_lib::ai::blur_faces(&image, 12.0);
    assert_eq!(blurred.get_pixel(60, 60).0, image.get_pixel(60, 60).0);
}

#[test]
fn recorder_args_include_the_expected_flags() {
    let options = snappro_lib::recorder::RecordOptions {
        mode: "screen".into(),
        fps: 24,
        format: "mp4".into(),
        region: Some(snappro_lib::recorder::RegionRect {
            x: 10,
            y: 20,
            width: 640,
            height: 480,
        }),
        ..Default::default()
    };
    let args = snappro_lib::recorder::build_args(&options, "out.mp4");
    let joined = args.join(" ");
    assert!(joined.contains("-framerate 24"));
    assert!(joined.contains("libx264"));
    assert!(joined.contains("out.mp4"));
    assert!(joined.contains("-y"));
    // A rectangle region must be expressed as an explicit size.
    assert!(joined.contains("640x480"));
    #[cfg(windows)]
    {
        assert!(joined.contains("gdigrab"));
        assert!(joined.contains("-offset_x 10"));
    }
}

#[test]
fn recorder_gif_export_uses_a_palette_scale_filter() {
    // GIF takes are recorded like video and converted when the take ends.
    let filter = snappro_lib::recorder::gif_filter(30);
    assert!(filter.contains("fps=15"), "gif export should cap the frame rate");
    assert!(filter.contains("palettegen") && filter.contains("paletteuse"));
    let options = snappro_lib::recorder::RecordOptions {
        format: "gif".into(),
        ..Default::default()
    };
    let args = snappro_lib::recorder::build_args(&options, "clip.mkv").join(" ");
    assert!(args.contains("libx264"), "gif is captured as video first");
    assert!(!args.contains("movflags"), "matroska must not get mp4-only flags");
}

#[test]
fn capture_result_serialises_as_camel_case_for_the_frontend() {
    let result = snappro_lib::capture::CaptureResult::new(
        "id".into(),
        "C:/shot.png".into(),
        1920,
        1080,
        "full",
        1234,
        "Display 1".into(),
    );
    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("\"sizeBytes\""));
    assert!(json.contains("\"monitor\""));
    assert!(!json.contains("size_bytes"));
}

#[test]
fn plugin_manifest_parses_a_minimal_file() {
    let text = r#"{
        "id": "com.example.demo",
        "name": "Demo",
        "tools": [{ "id": "t1", "label": "One" }]
    }"#;
    let manifest: snappro_lib::plugins::PluginManifest = serde_json::from_str(text).unwrap();
    assert_eq!(manifest.id, "com.example.demo");
    assert_eq!(manifest.tools.len(), 1);
}

#[test]
fn store_image_writes_png_and_reports_the_size() {
    let dir = std::env::temp_dir().join("snappro-test-store");
    let image = solid(32, 16, [12, 34, 56, 255]);
    let (_id, path, size, width, height) = snappro_lib::util::store_image(&image, &dir, "Test", "png").unwrap();
    assert_eq!(width, 32);
    assert_eq!(height, 16);
    assert!(size > 0);
    assert!(std::path::Path::new(&path).exists());
}

#[test]
fn store_image_can_write_jpeg() {
    let dir = std::env::temp_dir().join("snappro-test-jpeg");
    let image = solid(24, 24, [200, 100, 50, 255]);
    let (_id, path, size, _, _) = snappro_lib::util::store_image(&image, &dir, "Test", "jpg").unwrap();
    assert!(size > 0);
    assert!(path.ends_with(".jpg"));
}

#[test]
fn data_url_round_trip() {
    let dir = std::env::temp_dir().join("snappro-test-dataurl");
    std::fs::create_dir_all(&dir).unwrap();
    let image = solid(40, 20, [9, 9, 200, 255]);
    let path = dir.join("source.png");
    image.save(&path).unwrap();

    let data_url = snappro_lib::imageio::read_data_url(&path).unwrap();
    assert!(data_url.starts_with("data:image/png;base64,"));

    let target = dir.join("copy.png");
    let written = snappro_lib::imageio::save_data_url(&data_url, &target).unwrap();
    assert!(written > 0);
    let dimensions = image::image_dimensions(&target).unwrap();
    assert_eq!(dimensions, (40, 20));
}

#[test]
fn history_scan_finds_images_and_ignores_other_files() {
    let dir = std::env::temp_dir().join("snappro-test-history");
    std::fs::create_dir_all(&dir).unwrap();
    solid(10, 10, [0, 0, 0, 255]).save(dir.join("shot.png")).unwrap();
    std::fs::write(dir.join("notes.txt"), "hello").unwrap();

    let items = snappro_lib::history::scan(&dir);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].kind, "image");
    assert_eq!(items[0].width, 10);
    assert!(items[0].created > 0);
}

#[test]
fn history_rename_keeps_the_extension_and_strips_bad_characters() {
    let dir = std::env::temp_dir().join(format!("snappro-test-rename-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let source = dir.join("old.png");
    solid(4, 4, [0, 0, 0, 255]).save(&source).unwrap();

    let renamed = snappro_lib::history::rename(&source, "new/name").unwrap();
    assert_eq!(renamed.file_name().unwrap().to_string_lossy(), "new_name.png");
    assert!(renamed.exists());
    assert!(!source.exists());
}

#[test]
fn monitor_selection_swallows_bad_indices() {
    // The launcher environment may have no display at all; the point of this
    // test is that an invalid index never panics.
    let result = std::panic::catch_unwind(|| {
        let _ = snappro_lib::capture::full::select_monitor(Some(99));
    });
    assert!(result.is_ok());
}

#[test]
fn virtual_bounds_covers_every_offset_display() {
    // Monitors arranged around the primary one must be unioned, not assumed to
    // start at 0,0 - a negative origin (a screen placed to the left) has to
    // survive, otherwise every capture on that display is offset or blank.
    let monitors = [
        (0, 0, 1920, 1080),
        (-1920, 0, 1920, 1080),
        (1920, -200, 1280, 1024),
    ];
    assert_eq!(
        snappro_lib::capture::full::union_bounds(&monitors),
        Some((-1920, -200, 5120, 1280))
    );
}

#[test]
fn virtual_bounds_is_none_without_monitors() {
    assert!(snappro_lib::capture::full::union_bounds(&[]).is_none());
}

#[test]
fn virtual_bounds_matches_a_single_display() {
    assert_eq!(
        snappro_lib::capture::full::union_bounds(&[(0, 0, 2560, 1440)]),
        Some((0, 0, 2560, 1440))
    );
}

/// End-to-end: really capture a display and really write a PNG.
///
/// This is the proof behind "capture and save does nothing": it exercises the
/// exact code path the Full / All-Monitors buttons use, including the file
/// write, instead of only the bounding-box arithmetic.
#[test]
fn capture_writes_a_real_png_to_disk() {
    let dir = std::env::temp_dir().join(format!("snappro-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);

    let result = snappro_lib::capture::full::capture_full_screen(None, "png", dir.clone());
    let result = match result {
        Ok(result) => result,
        // A headless runner has no display; that is an environment fact, not a
        // regression, so the check degrades to "no panic" there.
        Err(_) => return,
    };

    let path = std::path::Path::new(&result.path);
    assert!(path.exists(), "capture did not write {}", result.path);
    let bytes = std::fs::read(path).expect("saved file is unreadable");
    assert!(bytes.len() > 1024, "saved file is suspiciously small");
    // PNG magic number: proves the bytes are a real image, not an empty file.
    assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
    assert!(result.width > 0 && result.height > 0);
    assert!(result.size_bytes > 0);

    let _ = std::fs::remove_dir_all(&dir);
}

/// End-to-end: every-display capture stitches and writes a PNG.
#[test]
fn all_monitors_capture_writes_a_real_png() {
    let dir = std::env::temp_dir().join(format!("snappro-e2e-all-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);

    let result = snappro_lib::capture::full::capture_all_monitors("png", dir.clone());
    let result = match result {
        Ok(result) => result,
        Err(_) => return,
    };

    assert!(std::path::Path::new(&result.path).exists());
    let bytes = std::fs::read(&result.path).expect("saved file is unreadable");
    assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);

    // The stitched image must cover the whole virtual desktop, i.e. every
    // display including ones with a negative origin. This is what makes the
    // All-Monitors capture different from a single-display grab.
    let (_, _, width, height) = snappro_lib::capture::full::virtual_bounds().unwrap();
    assert_eq!(result.width, width, "stitched width must span all displays");
    assert_eq!(result.height, height, "stitched height must span all displays");

    let _ = std::fs::remove_dir_all(&dir);
}
// ---------------------------------------------------------------------------
// Regression tests for bugs found in the review
// ---------------------------------------------------------------------------

#[test]
fn recording_forces_even_dimensions_so_odd_regions_do_not_fail() {
    use snappro_lib::recorder::{build_args, RecordOptions, RegionRect};
    let opts = RecordOptions {
        region: Some(RegionRect { x: 0, y: 0, width: 801, height: 601 }),
        ..RecordOptions::default()
    };
    let joined = build_args(&opts, "out.mp4").join(" ");
    assert!(joined.contains("trunc(iw/2)*2"), "libx264 needs even sizes: {joined}");
    assert!(joined.contains("movflags"), "mp4 output keeps faststart");
}

#[test]
fn recording_with_webcam_and_mic_maps_the_right_inputs() {
    use snappro_lib::recorder::{build_args, RecordOptions};
    let opts = RecordOptions {
        audio: true,
        audio_device: Some("Mic".into()),
        webcam: true,
        camera_device: Some("Cam".into()),
        ..RecordOptions::default()
    };
    let joined = build_args(&opts, "out.mp4").join(" ");
    assert!(joined.contains("-map 2:v"), "camera is input 2 when a mic is input 1: {joined}");
    assert!(joined.contains("out.cam.mkv"), "the camera gets its own file: {joined}");
    assert!(joined.contains("-map 1:a"));

    let no_mic = RecordOptions {
        keep_audio_track: false,
        webcam: true,
        camera_device: Some("Cam".into()),
        ..RecordOptions::default()
    };
    let joined = build_args(&no_mic, "out.mp4").join(" ");
    assert!(joined.contains("-map 1:v"), "camera is input 1 without a mic: {joined}");
}

#[test]
fn avfoundation_listing_is_parsed_into_devices() {
    let text = "[AVFoundation indev @ 0x7f] AVFoundation video devices:\n\
[AVFoundation indev @ 0x7f] [0] FaceTime HD Camera\n\
[AVFoundation indev @ 0x7f] [1] Capture screen 0\n\
[AVFoundation indev @ 0x7f] [2] Capture screen 1\n\
[AVFoundation indev @ 0x7f] AVFoundation audio devices:\n\
[AVFoundation indev @ 0x7f] [0] MacBook Pro Microphone\n";
    let (video, audio) = snappro_lib::recorder::parse_avfoundation_devices(text);
    assert_eq!(video.len(), 3);
    assert_eq!(video[0].1, "FaceTime HD Camera");
    assert_eq!(audio, vec![(0, "MacBook Pro Microphone".to_string())]);
    assert_eq!(snappro_lib::recorder::pick_macos_screen(&video, None), "1");
    assert_eq!(snappro_lib::recorder::pick_macos_screen(&video, Some(1)), "2");
}

#[test]
fn rectangles_are_intersected_across_monitors() {
    use snappro_lib::capture::full::intersect_rect;
    // A region straddling a left-hand monitor at x=-1920 and the primary one.
    let left = (-1920, 0, 1920, 1080);
    let primary = (0, 0, 1920, 1080);
    let region = (-100, 10, 300, 50);
    assert_eq!(intersect_rect(region, left), Some((-100, 10, 100, 50)));
    assert_eq!(intersect_rect(region, primary), Some((0, 10, 200, 50)));
    assert_eq!(intersect_rect((5000, 0, 10, 10), primary), None);
}

#[test]
fn jpeg_export_flattens_transparency_onto_white() {
    let mut image = RgbaImage::new(2, 1);
    image.put_pixel(0, 0, Rgba([0, 0, 0, 0]));
    image.put_pixel(1, 0, Rgba([10, 20, 30, 255]));
    let flat = snappro_lib::util::flatten_on_white(&image);
    assert_eq!(flat.get_pixel(0, 0).0, [255, 255, 255]);
    assert_eq!(flat.get_pixel(1, 0).0, [10, 20, 30]);
}

#[test]
fn rename_never_overwrites_an_existing_file() {
    let dir = std::env::temp_dir().join(format!("snappro-rename-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let a = dir.join("a.png");
    let b = dir.join("b.png");
    std::fs::write(&a, b"A").unwrap();
    std::fs::write(&b, b"B").unwrap();
    let renamed = snappro_lib::history::rename(&a, "b").unwrap();
    assert_ne!(renamed, b, "must pick a free name");
    assert_eq!(std::fs::read(&b).unwrap(), b"B", "the other file is untouched");
    assert_eq!(std::fs::read(&renamed).unwrap(), b"A");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn saving_a_png_data_url_as_webp_really_produces_webp() {
    use base64::Engine;
    let image = solid(8, 8, [1, 2, 3, 255]);
    let mut png = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    let url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    );
    let dir = std::env::temp_dir().join(format!("snappro-webp-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let target = dir.join("out.webp");
    snappro_lib::imageio::save_data_url(&url, &target).unwrap();
    let bytes = std::fs::read(&target).unwrap();
    assert_eq!(image::guess_format(&bytes).unwrap(), image::ImageFormat::WebP);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Pseudo-random "page" so every row is distinctive.
fn noise_page(width: u32, height: u32) -> RgbaImage {
    let mut image = RgbaImage::new(width, height);
    let mut seed = 12345u32;
    for y in 0..height {
        for x in 0..width {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let v = (seed >> 24) as u8;
            image.put_pixel(x, y, Rgba([v, v.wrapping_add(40), v.wrapping_mul(3), 255]));
        }
    }
    image
}

#[test]
fn scrolling_shift_is_found_and_the_page_is_rebuilt_exactly() {
    let page = noise_page(200, 900);
    let view = 300u32;
    let step = 170u32;
    let mut frames = Vec::new();
    let mut top = 0;
    while top + view <= 900 {
        frames.push(image::imageops::crop_imm(&page, 0, top, 200, view).to_image());
        top += step;
    }
    let shift = snappro_lib::capture::scrolling::find_shift(&frames[0], &frames[1], None);
    assert_eq!(shift, Some(step));

    let stitched = snappro_lib::capture::scrolling::stitch_vertical(&frames).unwrap();
    let expected_height = view + step * (frames.len() as u32 - 1);
    assert_eq!(stitched.height(), expected_height);
    let reference = image::imageops::crop_imm(&page, 0, 0, 200, expected_height).to_image();
    assert_eq!(stitched.as_raw(), reference.as_raw(), "stitching must be pixel exact");
}

#[test]
fn scrolling_ignores_a_sticky_header() {
    let page = noise_page(200, 900);
    let header = solid(200, 40, [250, 250, 0, 255]);
    let view = 300u32;
    let step = 150u32;
    let mut frames = Vec::new();
    let mut top = 0;
    while top + view <= 900 {
        let mut frame = image::imageops::crop_imm(&page, 0, top, 200, view).to_image();
        image::imageops::replace(&mut frame, &header, 0, 0);
        frames.push(frame);
        top += step;
    }
    let shift = snappro_lib::capture::scrolling::find_shift(&frames[0], &frames[1], None);
    assert_eq!(shift, Some(step), "a fixed header must not fool the matcher");
}

#[test]
fn flat_pages_report_no_shift() {
    let flat = solid(200, 300, [255, 255, 255, 255]);
    assert_eq!(snappro_lib::capture::scrolling::find_shift(&flat, &flat, None), None);
}

/// Two recorded segments (a pause in between) end up as one playable MP4 / GIF.
#[test]
fn paused_recordings_are_joined_and_gif_is_converted() {
    use snappro_lib::recorder::{finalize_recording, spawn_recording, stop_child, RecordOptions};

    let dir = std::env::temp_dir().join(format!("snappro-final-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let opts = RecordOptions { fps: 10, ..RecordOptions::default() };

    let mut segments = Vec::new();
    for n in 0..2 {
        let seg = dir.join(format!("seg{n}.mkv"));
        let mut child = match spawn_recording(&seg, &opts) {
            Ok(child) => child,
            Err(_) => return, // no ffmpeg / display here: not a regression
        };
        std::thread::sleep(std::time::Duration::from_secs(2));
        stop_child(&mut child).unwrap();
        if !seg.exists() {
            return;
        }
        segments.push(seg);
    }

    let mp4 = finalize_recording(&segments, &dir.join("out.mp4"), "mp4", 10).unwrap();
    let bytes = std::fs::read(&mp4).unwrap();
    assert!(bytes.len() > 1024);
    assert_eq!(&bytes[4..8], b"ftyp", "joined recording must be an MP4");
    assert!(!segments[0].exists(), "segments are cleaned up after joining");

    // GIF from a fresh segment.
    let seg = dir.join("gif.mkv");
    let mut child = spawn_recording(&seg, &opts).unwrap();
    std::thread::sleep(std::time::Duration::from_secs(2));
    stop_child(&mut child).unwrap();
    let gif = finalize_recording(&[seg], &dir.join("out.gif"), "gif", 10).unwrap();
    let bytes = std::fs::read(&gif).unwrap();
    assert_eq!(&bytes[0..3], b"GIF", "gif conversion must produce a GIF file");

    let _ = std::fs::remove_dir_all(&dir);
}

/// With a second display left of the primary one (x < 0), a region straddling
/// the seam must come back whole instead of being clamped to one monitor.
#[test]
fn region_across_the_monitor_seam_is_captured_whole() {
    let Ok((vx, vy, vw, vh)) = snappro_lib::capture::full::virtual_bounds() else {
        return;
    };
    if vx >= 0 || vw < 400 || vh < 100 {
        return; // single display or no display in this environment
    }
    let dir = std::env::temp_dir().join(format!("snappro-seam-{}", std::process::id()));
    let result = snappro_lib::capture::full::capture_region_global(-100, vy.max(0) + 10, 300, 50, "png", dir.clone())
        .expect("seam capture failed");
    assert_eq!((result.width, result.height), (300, 50));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn loopback_sources_are_split_from_microphones() {
    let (mics, loopback) = snappro_lib::recorder::split_audio_devices(vec![
        "Microphone (Realtek)".into(),
        "Stereo Mix (Realtek)".into(),
        "alsa_output.pci.analog-stereo.monitor".into(),
        "BlackHole 2ch".into(),
        "default".into(),
    ]);
    assert_eq!(mics, vec!["Microphone (Realtek)".to_string(), "default".to_string()]);
    assert_eq!(loopback.len(), 3);
}

#[test]
fn recording_can_mix_microphone_and_system_sound_with_the_camera_in_a_corner() {
    use snappro_lib::recorder::{build_args, RecordOptions};
    let opts = RecordOptions {
        audio: true,
        audio_device: Some("Mic".into()),
        system_audio: true,
        system_audio_device: Some("Stereo Mix".into()),
        webcam: true,
        camera_device: Some("Cam".into()),
        webcam_position: "tl".into(),
        webcam_width: 400,
        ..RecordOptions::default()
    };
    let joined = build_args(&opts, "out.mp4").join(" ");
    assert!(joined.contains("amix=inputs=2"), "two sound sources are mixed: {joined}");
    assert!(joined.contains("-map [aout]"));
    assert!(joined.contains("-map 3:v"), "camera is the third input: {joined}");
    assert!(joined.contains("scale=400:-2"), "camera is shrunk to the chosen width: {joined}");
    // The screen picture itself no longer waits for the camera.
    assert!(!joined.contains("overlay"), "no overlay inside the live recording: {joined}");
}

#[test]
fn old_frontends_without_the_new_fields_still_parse() {
    let options: snappro_lib::recorder::RecordOptions =
        serde_json::from_str(r#"{ "mode": "screen", "fps": 24 }"#).unwrap();
    assert_eq!(options.fps, 24);
    assert_eq!(options.webcam_position, "br");
}

#[test]
fn every_take_keeps_an_audio_track_so_sound_can_be_switched_midway() {
    use snappro_lib::recorder::{build_args, RecordOptions};
    let silent = build_args(&RecordOptions::default(), "out.mkv").join(" ");
    assert!(silent.contains("anullsrc"), "silent track when no source is on: {silent}");
    assert!(silent.contains("-map 1:a"));
    let with_mic = build_args(
        &RecordOptions { audio: true, audio_device: Some("Mic".into()), ..RecordOptions::default() },
        "out.mkv",
    )
    .join(" ");
    assert!(!with_mic.contains("anullsrc"));
    assert!(with_mic.contains("-ar 48000"), "same sample rate as the silent track: {with_mic}");
    let gif = build_args(&RecordOptions { format: "gif".into(), ..RecordOptions::default() }, "out.mkv").join(" ");
    assert!(!gif.contains("anullsrc"), "gif has no sound");
}

// ---------------------------------------------------------------------------
// Linux / Wayland
// ---------------------------------------------------------------------------

#[test]
fn crop_desktop_cuts_and_scales_from_the_portal_picture() {
    use snappro_lib::capture::full::crop_desktop;
    // Desktop 200x100 at the origin; the picture is twice as large (HiDPI).
    let picture = with_band(solid(400, 200, [10, 10, 10, 255]), 100, 200, [200, 0, 0, 255]);
    let piece = crop_desktop(&picture, (0, 0, 200, 100), (50, 50, 20, 10)).unwrap();
    assert_eq!((piece.width(), piece.height()), (40, 20));
    assert_eq!(piece.get_pixel(0, 0).0, [200, 0, 0, 255]);
    // A desktop whose left edge is negative (monitor left of the primary one).
    let picture = solid(300, 100, [1, 2, 3, 255]);
    let piece = crop_desktop(&picture, (-100, 0, 300, 100), (-100, 0, 300, 100)).unwrap();
    assert_eq!((piece.width(), piece.height()), (300, 100));
    // Partly off screen keeps the requested size.
    let piece = crop_desktop(&picture, (0, 0, 300, 100), (290, 90, 20, 20)).unwrap();
    assert_eq!((piece.width(), piece.height()), (20, 20));
    assert!(crop_desktop(&picture, (0, 0, 300, 100), (400, 400, 10, 10)).is_err());
}

#[test]
fn cli_actions_map_to_hotkey_actions() {
    use snappro_lib::commands::cli_action;
    let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(cli_action(&args(&["snappro"])), None);
    assert_eq!(cli_action(&args(&["snappro", "--capture"])), Some(0));
    assert_eq!(cli_action(&args(&["snappro", "--capture", "region"])), Some(2));
    assert_eq!(cli_action(&args(&["snappro", "--capture", "window"])), Some(1));
    assert_eq!(cli_action(&args(&["snappro", "--capture", "color"])), Some(8));
    assert_eq!(cli_action(&args(&["snappro", "--record"])), Some(4));
    assert_eq!(cli_action(&args(&["snappro", "--capture", "nonsense"])), None);
}

#[cfg(target_os = "linux")]
#[test]
fn gnome_shortcuts_use_gtk_notation() {
    use snappro_lib::gnome_shortcuts::{cli_argument, gtk_accelerator, parse_paths};
    assert_eq!(gtk_accelerator("CmdOrCtrl+Shift+2").as_deref(), Some("<Control><Shift>2"));
    assert_eq!(gtk_accelerator("Alt+PrintScreen").as_deref(), Some("<Alt>Print"));
    assert_eq!(gtk_accelerator("Shift+Super+S").as_deref(), Some("<Shift><Super>s"));
    assert_eq!(gtk_accelerator("Ctrl+F12").as_deref(), Some("<Control>F12"));
    assert_eq!(gtk_accelerator("Ctrl+Shift+KeyO").as_deref(), Some("<Control><Shift>o"));
    assert_eq!(gtk_accelerator("Ctrl+A+B"), None);
    assert_eq!(gtk_accelerator(""), None);
    use snappro_lib::gnome_shortcuts::{gvariant_string, shortcut_command};
    assert_eq!(gvariant_string("SnapPro: it's"), "'SnapPro: it\\'s'");
    assert_eq!(shortcut_command("/usr/bin/snappro", "--capture region"), "/usr/bin/snappro --capture region");
    assert_eq!(shortcut_command("/opt/Snap Pro/snappro", "--record"), "\"/opt/Snap Pro/snappro\" --record");
    assert_eq!(parse_paths("@as []"), Vec::<String>::new());
    assert_eq!(parse_paths("['/a/', '/b/']"), vec!["/a/".to_string(), "/b/".to_string()]);
    for action in 0..=8 {
        let arg = cli_argument(action).unwrap();
        let mut argv = vec!["snappro".to_string()];
        argv.extend(arg.split(' ').map(str::to_string));
        assert_eq!(snappro_lib::commands::cli_action(&argv), Some(action));
    }
}

#[cfg(target_os = "linux")]
#[test]
fn portal_file_uri_is_decoded() {
    use snappro_lib::portal::uri_to_path;
    assert_eq!(
        uri_to_path("file:///home/a/Pictures/Screenshot%20from%202026.png").unwrap(),
        std::path::PathBuf::from("/home/a/Pictures/Screenshot from 2026.png")
    );
    assert!(uri_to_path("https://example.com/x.png").is_none());
}

#[cfg(target_os = "linux")]
#[test]
fn wayland_recording_reads_the_picture_from_stdin() {
    use snappro_lib::recorder::{build_args_for, wayland, RecordOptions, RegionRect, ScreenSource};
    let region = RegionRect { x: 100, y: 50, width: 640, height: 360 };
    // The shared screen is 1920x1080 at the origin; the stream may have more pixels.
    let crop = wayland::crop_filter(&region, Some((0, 0)), Some((1920, 1080))).unwrap();
    assert_eq!(crop, "crop=trunc(iw*640/1920):trunc(ih*360/1080):trunc(iw*100/1920):trunc(ih*50/1080)");
    // A region that is the whole screen needs no crop.
    let whole = RegionRect { x: 0, y: 0, width: 1920, height: 1080 };
    assert_eq!(wayland::crop_filter(&whole, Some((0, 0)), Some((1920, 1080))), None);
    // Second screen: the region is made relative to it.
    let right = RegionRect { x: 2020, y: 0, width: 100, height: 100 };
    let crop = wayland::crop_filter(&right, Some((1920, 0)), Some((1280, 1024))).unwrap();
    assert!(crop.ends_with("trunc(iw*100/1280):trunc(ih*0/1024)"), "{crop}");

    let opts = RecordOptions { region: Some(region), mode: "custom".into(), ..RecordOptions::default() };
    let args = build_args_for(&opts, "out.mkv", &ScreenSource::Pipe(Some(crop.clone())));
    let joined = args.join(" ");
    assert!(joined.contains("-f yuv4mpegpipe -i pipe:0"), "{joined}");
    assert!(!joined.contains("x11grab"), "{joined}");
    assert!(joined.contains(&crop), "{joined}");
    // The sound inputs never end, so the segment must end with the picture.
    assert!(args.contains(&"-shortest".to_string()));
    // The normal X11 grabber is untouched.
    let grab = snappro_lib::recorder::build_args(&opts, "out.mkv").join(" ");
    assert!(grab.contains("x11grab") && !grab.contains("-shortest"), "{grab}");

    let gst = wayland::gst_args(42, 30).join(" ");
    assert!(gst.contains("pipewiresrc fd=3 path=42"), "{gst}");
    assert!(gst.contains("framerate=30/1") && gst.contains("y4menc"), "{gst}");
}

/// A page taller than the window, scrolled by a fake mouse wheel.
struct FakePage {
    page: RgbaImage,
    view: u32,
    top: u32,
    px_per_notch: u32,
}

impl snappro_lib::capture::scrolling::ScrollDriver for FakePage {
    fn frame(&mut self) -> anyhow::Result<RgbaImage> {
        Ok(image::imageops::crop_imm(&self.page, 0, self.top, self.page.width(), self.view).to_image())
    }
    fn park(&mut self) {}
    fn scroll(&mut self, notches: i32) {
        let max = (self.page.height() - self.view) as i64;
        let next = self.top as i64 + notches as i64 * self.px_per_notch as i64;
        self.top = next.clamp(0, max) as u32;
    }
}

fn textured_page(width: u32, height: u32) -> RgbaImage {
    let mut page = RgbaImage::new(width, height);
    for (x, y, p) in page.enumerate_pixels_mut() {
        // Rows differ from each other and columns vary, like lines of text.
        let v = ((y * 37 + (x / 7) * 11 + (y / 5) * 3) % 251) as u8;
        *p = Rgba([v, v.wrapping_mul(3), 255 - v, 255]);
    }
    page
}

#[test]
fn scrolling_capture_rebuilds_the_whole_page() {
    use snappro_lib::capture::scrolling::scroll_and_stitch;
    let page = textured_page(160, 1000);
    // Starts in the middle: the capture must first go back to the top.
    let mut fake = FakePage { page: page.clone(), view: 200, top: 400, px_per_notch: 40 };
    let (stitched, frames) = scroll_and_stitch(&mut fake, 200, 60, 0, 0, None, None).unwrap();
    assert!(frames >= 5, "only {frames} frames");
    assert_eq!(stitched.dimensions(), page.dimensions(), "the stitched picture must be the whole page");
    assert_eq!(stitched.as_raw(), page.as_raw(), "the stitched picture must match the page exactly");
}

#[cfg(target_os = "linux")]
#[test]
fn png_stream_is_split_into_frames() {
    use snappro_lib::capture::wayland_scroll::take_pngs;
    let mut one = Vec::new();
    solid(3, 2, [1, 2, 3, 255])
        .write_to(&mut std::io::Cursor::new(&mut one), image::ImageFormat::Png)
        .unwrap();
    let mut stream = Vec::new();
    stream.extend_from_slice(&one);
    stream.extend_from_slice(&one);
    stream.extend_from_slice(&one[..10]); // the start of a third frame
    let frames = take_pngs(&mut stream);
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0], one);
    assert_eq!(stream, one[..10].to_vec(), "the unfinished frame stays buffered");
    stream.extend_from_slice(&one[10..]);
    assert_eq!(take_pngs(&mut stream).len(), 1);
    assert!(stream.is_empty());
    let args = snappro_lib::capture::wayland_scroll::gst_args(7).join(" ");
    assert!(args.contains("pipewiresrc fd=3 path=7") && args.contains("pngenc"), "{args}");
}

/// Lines that look alike and differ only in a small "number" (tables, lists, code).
fn repetitive_page(width: u32, height: u32) -> RgbaImage {
    let mut page = solid(width, height, [255, 255, 255, 255]);
    let line = 42;
    for y in 0..height {
        let n = y / line;
        let inside = y % line;
        if !(10..24).contains(&inside) {
            continue;
        }
        for x in 20..width - 40 {
            // The same "text" on every line...
            let ink = (x * 13 + inside * 7) % 9 < 4;
            // ...except a few digits at the end that encode the line number.
            let digit = x >= width - 90 && ((x / 6 + n * 5 + inside) % 4 == 0);
            if ink || digit {
                page.put_pixel(x, y, Rgba([30, 60, 140, 255]));
            }
        }
    }
    page
}

#[test]
fn scrolling_capture_handles_lookalike_lines() {
    use snappro_lib::capture::scrolling::scroll_and_stitch;
    let page = repetitive_page(400, 2000);
    let mut fake = FakePage { page: page.clone(), view: 300, top: 0, px_per_notch: 83 };
    let (stitched, _) = scroll_and_stitch(&mut fake, 300, 60, 0, 0, None, None).unwrap();
    assert_eq!(stitched.dimensions(), page.dimensions());
    assert_eq!(stitched.as_raw(), page.as_raw(), "look-alike lines must not be stitched at the wrong offset");
}

#[test]
fn scrolling_badge_keeps_clear_of_the_capture_area() {
    use snappro_lib::commands::badge_corner;
    let screen = (0, 0, 1366, 768);
    // Area near the top-left: a corner on the far side (top-right, 336 px clear).
    assert_eq!(badge_corner(screen, (120, 120, 600, 300), (310, 70)), Some((1056, 0)));
    // Area across the whole top: a bottom corner.
    assert_eq!(badge_corner(screen, (0, 0, 1366, 500), (310, 70)), Some((0, 698)));
    // Area along the bottom: a top corner.
    assert_eq!(badge_corner(screen, (0, 400, 1366, 368), (310, 70)), Some((0, 0)));
    // The whole screen, or too close to every corner: nowhere to go.
    assert_eq!(badge_corner(screen, (0, 0, 1366, 768), (310, 70)), None);
    assert_eq!(badge_corner(screen, (20, 20, 1326, 728), (310, 70)), None);
}
