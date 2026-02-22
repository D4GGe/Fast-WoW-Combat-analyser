use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Notify;

use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

#[repr(C)]
#[allow(non_snake_case, non_camel_case_types)]
struct DRAWITEMSTRUCT {
    pub CtlType: u32,
    pub CtlID: u32,
    pub itemID: u32,
    pub itemAction: u32,
    pub itemState: ODS_FLAGS,
    pub hwndItem: HWND,
    pub hDC: HDC,
    pub rcItem: RECT,
    pub itemData: usize,
}

#[repr(transparent)]
#[derive(Clone, Copy)]
#[allow(non_camel_case_types)]
struct ODS_FLAGS(pub u32);

const ID_OPEN: i32 = 101;
const ID_STOP: i32 = 102;
const ID_CHANGE: i32 = 103;
const WND_W: i32 = 500;
const WND_H: i32 = 620;

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

    // Load the embedded icon resource
    let icon = LoadIconW(instance, PCWSTR(1 as _)).unwrap_or_default();

    let wc = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(wndproc),
        hInstance: instance,
        hIcon: icon,
        hIconSm: icon,
        hCursor: LoadCursorW(HINSTANCE::default(), IDC_ARROW).unwrap_or_default(),
        hbrBackground: CreateSolidBrush(COLORREF(0x001E1A1A)),
        lpszClassName: PCWSTR(cls.as_ptr()),
        ..Default::default()
    };
    RegisterClassExW(&wc);

    let sx = GetSystemMetrics(SM_CXSCREEN);
    let sy = GetSystemMetrics(SM_CYSCREEN);
    let title = wide("Fast WoW Combat Analyzer");

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
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | WINDOW_STYLE(0x0000000B), // BS_OWNERDRAW
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
        WM_CTLCOLORSTATIC => {
            let hdc = HDC(wp.0 as _);
            SetTextColor(hdc, COLORREF(0x00F0EAE8)); // Light text (BGR format)
            SetBkMode(hdc, TRANSPARENT);
            static mut BRUSH: isize = 0;
            if BRUSH == 0 {
                BRUSH = CreateSolidBrush(COLORREF(0x001E1A1A)).0 as isize; // Dark bg
            }
            LRESULT(BRUSH)
        }
        WM_DRAWITEM => {
            let dis = &*(lp.0 as *const DRAWITEMSTRUCT);
            let hdc = dis.hDC;
            let rc = dis.rcItem;
            let pressed = (dis.itemState.0 & 0x0001) != 0; // ODS_SELECTED

            // First fill entire rect with window background to kill white corners
            let win_bg = CreateSolidBrush(COLORREF(0x001E1A1A));
            let mut full = rc;
            FillRect(hdc, &mut full, win_bg);
            let _ = DeleteObject(win_bg);

            // Draw rounded blue-tinted button on top
            let bg_color = if pressed { COLORREF(0x00503828) } else { COLORREF(0x00352818) };
            let bg_brush = CreateSolidBrush(bg_color);
            let round = CreateRoundRectRgn(rc.left, rc.top, rc.right, rc.bottom, 12, 12);
            FillRgn(hdc, round, bg_brush);
            let _ = DeleteObject(bg_brush);
            let _ = DeleteObject(round);

            // Draw text
            SetBkMode(hdc, TRANSPARENT);
            SetTextColor(hdc, COLORREF(0x00C8C0B8));
            let font = make_font(-14, false);
            let old = SelectObject(hdc, font);
            let mut text_buf = [0u16; 128];
            let len = GetWindowTextW(dis.hwndItem, &mut text_buf);
            let mut r = rc;
            DrawTextW(hdc, &mut text_buf[..len as usize], &mut r, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
            SelectObject(hdc, old);
            let _ = DeleteObject(font);

            return LRESULT(1);
        }
        WM_CREATE => {
            let port = PORT_NUM.get().copied().unwrap_or(3000);

            let font = make_font(-16, false);
            let font_sm = make_font(-13, false);
            let font_title = make_font(-18, true);

            // Logo icon at the top
            let inst = get_instance();
            let icon_handle = LoadImageW(
                inst,
                PCWSTR(1 as _),
                IMAGE_ICON,
                256, 256,
                LR_DEFAULTCOLOR,
            );
            if let Ok(icon_h) = icon_handle {
                if let Ok(static_hwnd) = CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("STATIC"),
                    PCWSTR::null(),
                    WS_CHILD | WS_VISIBLE | WINDOW_STYLE(0x00000003), // SS_ICON
                    120, 15, 256, 256,
                    hwnd,
                    HMENU(200 as _),
                    inst,
                    None,
                ) {
                    SendMessageW(static_hwnd, STM_SETICON, WPARAM(icon_h.0 as usize), LPARAM(0));
                }
            }

            add_label(hwnd, "\u{25CF} Server Running", 28, 290, 440, 28, font_title, false);
            add_label(hwnd, &format!("http://localhost:{}", port), 28, 322, 440, 22, font, false);

            // Dir label (stored so we can update it later)
            let dir_hwnd = add_label(hwnd, &dir_display_text(), 28, 348, 390, 20, font_sm, false);
            if let Some(lock) = DIR_LABEL_HWND.get() {
                *lock.lock().unwrap() = dir_hwnd.0 as isize;
            }

            // Change folder button (small, next to path)
            add_button(hwnd, "...", 425, 345, 40, 24, ID_CHANGE, font_sm);

            // Main buttons
            add_button(hwnd, "Open in Browser", 20, 400, 222, 44, ID_OPEN, font);
            add_button(hwnd, "Stop Server", 254, 400, 222, 44, ID_STOP, font);

            // Credits
            add_label(hwnd, "Made with \u{2665} by D4GGe  \u{2022}  v0.1.0", 20, 530, 460, 20, font_sm, true);

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
