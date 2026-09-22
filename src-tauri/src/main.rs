#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activate;
mod namepatch;
mod parse;
mod session_stage;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

static QUITTING: AtomicBool = AtomicBool::new(false);
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(false);

fn show_main(app: &tauri::AppHandle) {
    if QUITTING.load(Ordering::SeqCst) {
        return;
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Hide first so X feels instant. Do **not** block the event loop on unload —
/// that froze single-instance IPC (second launch hung → two processes, no window).
/// Unload runs on a worker; a path-scaled watchdog is only a hung-GDI backstop
/// (worker exits(0) when session_end finishes).
fn quit_gracefully(app: &tauri::AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.remove_tray_by_id("main");
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        activate::session_end(&handle);
        std::process::exit(0);
    });
    let budget = activate::quit_unload_budget(app);
    std::thread::spawn(move || {
        std::thread::sleep(budget);
        std::process::exit(0);
    });
}

#[tauri::command]
fn set_desktop_prefs(close_to_tray: bool, start_with_windows: bool) {
    CLOSE_TO_TRAY.store(close_to_tray, Ordering::SeqCst);
    let _ = apply_start_with_windows(start_with_windows);
}

fn apply_start_with_windows(on: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let appdata = std::env::var("APPDATA").map_err(|e| e.to_string())?;
        let dir = std::path::PathBuf::from(appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Startup");
        let link = dir.join("Font Manager.cmd");
        if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let body = format!("@echo off\r\nstart \"\" \"{}\"\r\n", exe.display());
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(&link, body).map_err(|e| e.to_string())?;
        } else if link.exists() {
            let _ = std::fs::remove_file(&link);
        }
    }
    let _ = on;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch while X is draining GDI must not un-hide the dying
            // window (zombie + "app won't open"). Exit so the next click can start
            // a fresh process; .session-paths.txt is already saved for recovery.
            if QUITTING.load(Ordering::SeqCst) {
                std::process::exit(0);
            }
            show_main(app);
        }))
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
            set_desktop_prefs,
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
            activate::resolve_family_fetch_intent,
            activate::start_google_downloads,
            activate::retry_google_downloads,
            activate::try_fontsource_gdi_offer,
            activate::repair_incomplete_families,
            activate::skip_google_failures,
            activate::cancel_google_downloads,
            activate::drop_google_download_families,
            activate::pause_google_downloads,
            activate::resume_google_downloads,
            activate::google_download_progress,
            activate::register_existing_on_disk,
            activate::activate_families_on_disk,
            activate::plan_google_activation,
            activate::set_session_families,
            activate::session_families,
            activate::session_boot_state,
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
            parse::index_font_paths,
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
                if CLOSE_TO_TRAY.load(Ordering::SeqCst) {
                    let _ = window.hide();
                    return;
                }
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
