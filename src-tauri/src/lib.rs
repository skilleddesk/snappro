// The modules below are `pub` because the integration tests in `tests/` exercise
// the pure logic directly (image processing, stitching, PDF, recorder args).
pub mod ai;
pub mod capture;
pub mod clipboard;
pub mod cloud;
pub mod commands;
pub mod feedback;
#[cfg(target_os = "linux")]
pub mod gnome_shortcuts;
pub mod history;
pub mod imageio;
pub mod ocr;
pub mod pdf;
pub mod plugins;
#[cfg(target_os = "linux")]
pub mod portal;
pub mod recorder;
pub mod settings;
pub mod shell_open;
pub mod util;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // A second launch just brings the running copy forward: two copies would
    // fight over the global shortcuts and show two tray icons.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            match commands::cli_action(&args) {
                Some(action) => commands::hotkey_action(app.clone(), action),
                None => commands::focus_main(app),
            }
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(recorder::RecorderState::default())
        .manage(commands::SelectorState::default())
        .setup(|app| {
            // Creates the two example plugins and the capture folder on first run.
            plugins::ensure_examples();
            let _ = util::ensure_dir(&util::snappro_dir());
            // Working files from older versions lived inside the picture folders.
            util::migrate_legacy_files(&util::snappro_dir());
            let current = settings::load(app.handle());
            for dir in [&current.save_dir, &current.video_dir, &current.export_dir] {
                if !dir.trim().is_empty() {
                    util::migrate_legacy_files(std::path::Path::new(dir));
                }
            }
            history::cleanup_caches();

            let handle = app.handle().clone();
            let _ = settings::apply_shortcuts(&handle, &settings::load(&handle));

            build_tray(app)?;

            let args: Vec<String> = std::env::args().collect();
            if let Some(action) = commands::cli_action(&args) {
                commands::hotkey_action(app.handle().clone(), action);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides a SnapPro window instead of quitting: the tray keeps
            // the app alive so captures and shortcuts keep working in the
            // background, which is what an app-style capture tool needs.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                if label == "main" || label == "editor" || label == "recorder" || label == "preview"
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // capture
            commands::capture_full_screen,
            commands::capture_all_monitors,
            commands::capture_region,
            commands::capture_freehand,
            commands::capture_window,
            commands::capture_scrolling,
            commands::capture_delayed,
            commands::start_region_selector,
            commands::cancel_region_selector,
            commands::region_backdrop_info,
            commands::list_windows,
            commands::window_thumbnail,
            commands::window_bounds,
            commands::focus_main_window,
            commands::get_monitors,
            commands::pick_color,
            // recording
            commands::list_devices,
            commands::recording_status,
            commands::start_recording,
            commands::pause_recording,
            commands::resume_recording,
            commands::stop_recording,
            // editing / export
            commands::save_edited_image,
            commands::overwrite_image,
            commands::export_image,
            commands::export_pdf,
            commands::pdf_plan,
            commands::export_pdf_data,
            commands::list_drives,
            commands::read_image_data,
            commands::copy_image_file,
            // library
            commands::library_list,
            commands::library_delete,
            commands::library_rename,
            commands::library_export,
            commands::library_reveal,
            commands::reveal_item,
            commands::open_path,
            commands::open_folder,
            // ocr
            commands::ocr_image,
            commands::ocr_and_copy,
            commands::ocr_languages,
            commands::copy_text_to_clipboard,
            // ai
            commands::ai_remove_background,
            commands::ai_blur_faces,
            commands::ai_auto_enhance,
            // cloud
            commands::upload_image,
            // plugins
            commands::plugins_list,
            commands::plugin_install,
            commands::plugin_remove,
            commands::plugin_open_folder,
            // settings & helpers
            commands::get_settings,
            commands::save_settings,
            commands::check_dependencies,
            commands::desktop_info,
            commands::beep,
            commands::close_window,
            commands::pending_editor_path,
            commands::last_capture,
            commands::open_editor,
            commands::window_action,
            commands::set_always_on_top,
            commands::set_window_size,
            commands::minimize_all,
            commands::quit_app,
            commands::prepare_recording,
            commands::show_recorder,
            commands::reconfigure_recording,
            commands::take_pending_recording,
            commands::library_thumbnail,
            commands::keep_capture,
            commands::copy_image_data,
            commands::open_url,
            commands::install_dependency,
        ])
        .build(tauri::generate_context!())
        .expect("error while building SnapPro")
        .run(|app, event| {
            // Quitting during a recording must not throw the take away.
            if let tauri::RunEvent::Exit = event {
                commands::shutdown_recording(app);
            }
        });
}

fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Open SnapPro", true, None::<&str>)?;
    let full = MenuItem::with_id(app, "capture_full", "Capture Full Screen", true, Some("CmdOrCtrl+Shift+1"))?;
    let region = MenuItem::with_id(app, "capture_region", "Capture Region", true, Some("CmdOrCtrl+Shift+2"))?;
    let window = MenuItem::with_id(app, "capture_window", "Capture Window", true, Some("CmdOrCtrl+Shift+3"))?;
    let all = MenuItem::with_id(app, "capture_all", "Capture All Monitors", true, None::<&str>)?;
    let text = MenuItem::with_id(app, "capture_text", "Copy Text From Screen", true, Some("CmdOrCtrl+Shift+O"))?;
    let fixed = MenuItem::with_id(app, "capture_fixed", "Fixed Size Capture", true, None::<&str>)?;
    let picker = MenuItem::with_id(app, "pick_color", "Colour Picker", true, None::<&str>)?;
    let scrolling = MenuItem::with_id(app, "capture_scrolling", "Scrolling Capture", true, None::<&str>)?;
    let record = MenuItem::with_id(app, "toggle_recording", "Start / Stop Recording", true, Some("CmdOrCtrl+Shift+R"))?;
    let library = MenuItem::with_id(app, "open_library", "Open Library", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit SnapPro", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &full,
            &region,
            &window,
            &all,
            &scrolling,
            &fixed,
            &text,
            &picker,
            &record,
            &PredefinedMenuItem::separator(app)?,
            &library,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("snappro-tray")
        .tooltip("SnapPro — screenshot & screen recorder")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let handle = app.clone();
            match event.id().as_ref() {
                "show" => commands::focus_main(&handle),
                "capture_full" => commands::hotkey_action(handle, 0),
                "capture_region" => commands::hotkey_action(handle, 2),
                "capture_window" => commands::hotkey_action(handle, 1),
                "capture_all" => {
                    let handle = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = commands::capture_all_monitors(handle).await;
                    });
                }
                "capture_scrolling" => commands::hotkey_action(handle, 3),
                "capture_text" => commands::hotkey_action(handle, 6),
                "capture_fixed" => commands::hotkey_action(handle, 7),
                "pick_color" => commands::hotkey_action(handle, 8),
                "toggle_recording" => toggle_recording(&handle),
                "open_library" => {
                    commands::focus_main(&handle);
                    let _ = handle.emit("nav://library", ());
                }
                "quit" => handle.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Left click on the tray icon brings SnapPro back to the foreground.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                commands::focus_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

fn toggle_recording(app: &tauri::AppHandle) {
    commands::toggle_recording_shortcut(app);
}

use tauri::Emitter;