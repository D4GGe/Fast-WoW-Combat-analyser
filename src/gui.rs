use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Notify;

use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

const ID_OPEN: i32 = 101;
const ID_STOP: i32 = 102;
const ID_CHANGE: i32 = 103;
const WND_W: i32 = 440;
const WND_H: i32 = 280;

static SHUTDOWN: OnceLock<Arc<Notify>> = OnceLock::new();
static PORT_NUM: OnceLock<u16> = OnceLock::new();
static SHARED_LOG_DIR: OnceLock<Arc<Mutex<PathBuf>>> = OnceLock::new();
/// HWND of the directory label so we can update its text
/// Raw HWND pointer as isize (Send+Sync safe)
static DIR_LABEL_HWND: OnceLock<Mutex<isize>> = OnceLock::new();

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Run the native Win32 GUI window (blocks until closed)
pub fn run(shutdown: Arc<Notify>, log_dir: Arc<Mutex<PathBuf>>, port: u16) {
    SHUTDOWN.set(shutdown).ok();
    PORT_NUM.set(port).ok();
    SHARED_LOG_DIR.set(log_dir).ok();
    DIR_LABEL_HWND.set(Mutex::new(0)).ok();
    unsafe { create_and_run() };
}

unsafe fn get_instance() -> HINSTANCE {
    let h = GetModuleHandleW(PCWSTR::null()).unwrap_or_default();
    HINSTANCE(h.0 as _)
}

fn dir_display_text() -> String {
    let dir = SHARED_LOG_DIR
        .get()
        .map(|d| d.lock().unwrap().display().to_string())
        .unwrap_or_default();
    let short = if dir.len() > 46 {
        format!("{}...", &dir[..46])
    } else {
        dir
    };
    format!("Logs: {}", short)
}

unsafe fn create_and_run() {
    let instance = get_instance();
    let cls = wide("WowLogViewerCtrl");

    let wc = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(wndproc),
        hInstance: instance,
        hCursor: LoadCursorW(HINSTANCE::default(), IDC_ARROW).unwrap_or_default(),
        hbrBackground: HBRUSH((COLOR_BTNFACE.0 + 1) as _),
        lpszClassName: PCWSTR(cls.as_ptr()),
        ..Default::default()
    };
    RegisterClassExW(&wc);

    let sx = GetSystemMetrics(SM_CXSCREEN);
    let sy = GetSystemMetrics(SM_CYSCREEN);
    let title = wide("WoW Combat Log Viewer");

    let _ = CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        PCWSTR(cls.as_ptr()),
        PCWSTR(title.as_ptr()),
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_VISIBLE,
        (sx - WND_W) / 2,
        (sy - WND_H) / 2,
        WND_W,
        WND_H,
        HWND::default(),
        HMENU::default(),
        instance,
        None,
    );

    let mut msg = MSG::default();
    while GetMessageW(&mut msg, HWND::default(), 0, 0).into() {
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}

unsafe fn make_font(height: i32, bold: bool) -> HFONT {
    let weight = if bold { 700 } else { 400 };
    let face = wide("Segoe UI");
    CreateFontW(
        height, 0, 0, 0, weight, 0, 0, 0,
        DEFAULT_CHARSET.0 as u32, 0, 0, CLEARTYPE_QUALITY.0 as u32, 0,
        PCWSTR(face.as_ptr()),
    )
}

unsafe fn add_label(parent: HWND, text: &str, x: i32, y: i32, w: i32, h: i32, font: HFONT, center: bool) -> HWND {
    let inst = get_instance();
    let t = wide(text);
    let align: u32 = if center { 1 } else { 0 }; // SS_CENTER=1, SS_LEFT=0
    match CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        w!("STATIC"),
        PCWSTR(t.as_ptr()),
        WS_CHILD | WS_VISIBLE | WINDOW_STYLE(align),
        x, y, w, h,
        parent,
        HMENU::default(),
        inst,
        None,
    ) {
        Ok(hwnd) => {
            let _ = SendMessageW(hwnd, WM_SETFONT, WPARAM(font.0 as usize), LPARAM(1));
            hwnd
        }
        Err(_) => HWND::default(),
    }
}

unsafe fn add_button(parent: HWND, text: &str, x: i32, y: i32, w: i32, h: i32, id: i32, font: HFONT) {
    let inst = get_instance();
    let t = wide(text);
    if let Ok(hwnd) = CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        w!("BUTTON"),
        PCWSTR(t.as_ptr()),
        WS_CHILD | WS_VISIBLE | WS_TABSTOP,
        x, y, w, h,
        parent,
        HMENU(id as _),
        inst,
        None,
    ) {
        let _ = SendMessageW(hwnd, WM_SETFONT, WPARAM(font.0 as usize), LPARAM(1));
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_CREATE => {
            let port = PORT_NUM.get().copied().unwrap_or(3000);

            let font = make_font(-16, false);
            let font_sm = make_font(-13, false);
            let font_title = make_font(-18, true);

            add_label(hwnd, "\u{25CF} Server Running", 28, 15, 370, 28, font_title, false);
            add_label(hwnd, &format!("http://localhost:{}", port), 28, 47, 370, 22, font, false);

            // Dir label (stored so we can update it later)
            let dir_hwnd = add_label(hwnd, &dir_display_text(), 28, 73, 330, 20, font_sm, false);
            if let Some(lock) = DIR_LABEL_HWND.get() {
                *lock.lock().unwrap() = dir_hwnd.0 as isize;
            }

            // Change folder button (small, next to path)
            add_button(hwnd, "...", 365, 70, 40, 24, ID_CHANGE, font_sm);

            // Main buttons
            add_button(hwnd, "Open in Browser", 20, 120, 192, 40, ID_OPEN, font);
            add_button(hwnd, "Stop Server", 224, 120, 192, 40, ID_STOP, font);

            // Credits
            add_label(hwnd, "Made with \u{2665} by D4GGe  \u{2022}  v0.1.0", 20, 195, 400, 20, font_sm, true);

            LRESULT(0)
        }
        WM_COMMAND => {
            match (wp.0 & 0xFFFF) as i32 {
                ID_OPEN => {
                    let p = PORT_NUM.get().copied().unwrap_or(3000);
                    let _ = open::that(format!("http://localhost:{}", p));
                }
                ID_STOP => {
                    if let Some(s) = SHUTDOWN.get() {
                        s.notify_one();
                    }
                    let _ = DestroyWindow(hwnd);
                }
                ID_CHANGE => {
                    // Open folder picker to change log directory
                    let current = SHARED_LOG_DIR
                        .get()
                        .map(|d| d.lock().unwrap().display().to_string())
                        .unwrap_or_default();

                    if let Some(new_path) = rfd::FileDialog::new()
                        .set_title("Select WoW Combat Log Directory")
                        .set_directory(&current)
                        .pick_folder()
                    {
                        // Update the shared log_dir
                        if let Some(shared) = SHARED_LOG_DIR.get() {
                            *shared.lock().unwrap() = new_path;
                        }
                        // Update the label text
                        if let Some(lock) = DIR_LABEL_HWND.get() {
                            let raw = *lock.lock().unwrap();
                            if raw != 0 {
                                let label_hwnd = HWND(raw as _);
                                let new_text = wide(&dir_display_text());
                                let _ = SetWindowTextW(label_hwnd, PCWSTR(new_text.as_ptr()));
                            }
                        }
                    }
                }
                _ => {}
            }
            LRESULT(0)
        }
        WM_CLOSE => {
            if let Some(s) = SHUTDOWN.get() {
                s.notify_one();
            }
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}
