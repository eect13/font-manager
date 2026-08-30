#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activate;
mod namepatch;
mod parse;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                activate::session_begin(&handle);
            });

            let show = MenuItem::with_id(app, "show", "Show Font Manager", true, None::<&str>)?;
            let folder = MenuItem::with_id(app, "folder", "Open Documents folder", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &folder, &quit])?;

            let icon = app
                .default_window_icon()
                .cloned()
                .expect("app icon");

            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("Font Manager")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "folder" => {
                        let _ = activate::open_activation_folder(app.clone());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            activate::activation_folder,
            activate::install_font_file,
            activate::unload_font_family,
            activate::unload_font_families,
            activate::uninstall_font_family,
            activate::font_family_installed,
            activate::list_activated_families,
            activate::open_activation_folder,
            activate::register_font_path,
            activate::flush_font_cache,
            activate::save_library_file,
            activate::remove_library_file,
            activate::start_google_downloads,
            activate::retry_google_downloads,
            activate::skip_google_failures,
            activate::cancel_google_downloads,
            activate::pause_google_downloads,
            activate::resume_google_downloads,
            activate::google_download_progress,
            activate::register_existing_on_disk,
            activate::activate_families_on_disk,
            activate::plan_google_activation,
            activate::set_session_families,
            activate::session_families,
            activate::read_family_font,
            activate::scan_disk_families,
            parse::parse_family_cmap,
            parse::parse_family_layout,
            parse::parse_font_layout,
            parse::parse_font_layouts,
            parse::parse_font_cmap,
            parse::hash_bytes,
            parse::hash_font_path,
            parse::diff_font_bytes,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Font Manager")
        .run(|app, event| match event {
            // X closes the app. Activations restore on the next launch.
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { .. },
                ..
            } if label == "main" => {
                app.exit(0);
            }
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. } => {
                activate::session_end();
            }
            _ => {}
        });
}
