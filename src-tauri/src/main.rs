#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activate;
mod namepatch;
mod parse;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;
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

static QUITTING: AtomicBool = AtomicBool::new(false);

/// Hide first so X feels instant. Enumerable session fonts (flag 0) are NOT
/// dropped when the process dies — RemoveFontResourceExW must finish.
/// The unload thread is joined via a channel; 45s is only the hung-GDI cap.
fn quit_gracefully(app: &tauri::AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    // X is quit, not hide-to-tray.
    let _ = app.remove_tray_by_id("main");
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    let handle = app.clone();
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::spawn(move || {
        activate::session_end(&handle);
        let _ = done_tx.send(());
    });
    std::thread::spawn(move || {
        let _ = done_rx.recv_timeout(Duration::from_secs(45));
        std::process::exit(0);
    });
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

            TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip("Font Manager")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "folder" => {
                        let _ = activate::open_activation_folder(app.clone());
                    }
                    "quit" => quit_gracefully(app),
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
            activate::prune_unknown_folders,
            parse::parse_family_cmap,
            parse::parse_family_layout,
            parse::parse_font_layout,
            parse::parse_font_layouts,
            parse::parse_font_cmap,
            parse::hash_bytes,
            parse::hash_font_path,
            parse::diff_font_bytes,
            parse::list_system_fonts,
            parse::open_system_fonts_folder,
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                quit_gracefully(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Font Manager")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if !QUITTING.load(Ordering::SeqCst) {
                    activate::session_end(app);
                }
            }
        });
}
