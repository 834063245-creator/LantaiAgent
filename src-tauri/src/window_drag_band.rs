// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! window_drag_band — 把「窗口拖动带」夹到书眉真实高度（2026-09-14 事故立法）。
//!
//! **病灶**（实机取证：`WindowFromPoint` + 对归属窗口发 `WM_NCHITTEST`）：
//! `decorations: false` 窗口里，**WebView2 的宿主窗口**（类名 `Chrome_WidgetWin_0/1`）
//! 把顶部约 **86px** 一律当 caption 回 `HTCAPTION`（页面渲染窗
//! `Chrome_RenderWidgetHostHWND` 从 y≈88 起才是 `HTCLIENT`）。这条带：
//!   - **与页面 CSS 无关**：`-webkit-app-region` 全部删除后照旧存在；把 `--bar-h`
//!     改成 30px 也照样到 88（不是从元素高度派生的）；
//!   - 书眉只有 56px，多出的 ~30px「幽灵标题栏」压在画布顶缘与目次带最上方——
//!     在那段里拖内容＝**挪窗口**（用户三报「拖动目次带最上方还是会挪窗口」，并
//!     直接点出「问题是出在标题栏的触发范围上」）；
//!   - 页面侧的 `no-drag` 挖除只对**拖动元素的后代**生效（应用自绘的窗口钮正是
//!     如此），对书眉以下的兄弟元素无效：逐个加 no-drag 既挖不动这条带，删掉
//!     `app-region` 还会连窗口钮一起被吃掉（实机两轮验证，均已回退）。
//!
//! **修法**：给 WebView2 宿主窗口挂子类化（`SetWindowSubclass`），在
//! `WM_NCHITTEST` 里取内层结果后**只夹 `HTCAPTION`**——命中点在书眉下缘之下即改判
//! `HTCLIENT`（鼠标归应用）。于是拖动范围**严格等于书眉元素**，而页面侧的
//! `app-region: drag` + `no-drag` 机制原样保留（窗口钮的挖除仍生效，窗口拖动/双击
//! 最大化/Aero Snap 全走 OS 原生路径，无需前端参与）。`HTTOP/HTLEFT/…` 一律不动
//! （wry `undecorated_resizing` 的边框调整照旧）。
//!
//! 前端侧同源事实：书眉高 = `tokens.css --bar-h`（本文件 `TOPBAR_H` 是它的镜像，
//! 由 `tests/stage4-toc-titlebar-band.test.tsx` 钉住 token 值 = 56px）。

#[cfg(windows)]
mod imp {
    use std::time::Duration;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GA_ROOT, GetAncestor, HTCAPTION, HTCLIENT, WM_NCHITTEST,
    };

    /// 书眉高（px）——`tokens.css --bar-h: 56px` 的同源镜像（改一处两处同改）。
    pub const TOPBAR_H: i32 = 56;

    /// 纯函数：内层命中结果 → 夹紧后结果。
    /// **把 `HTCAPTION` 一律降为 `HTCLIENT`**——窗口拖动改由前端自管（书眉 pointerdown
    /// → `plugin:window|start_dragging`，见 `src/app/window-drag.ts`）；其余结果
    /// （`HTCLIENT` / `HTTOP` / `HTLEFT` / `HTBOTTOM` …）原样返回，边框调整不受影响。
    ///
    /// 为什么不是"只夹书眉以下"：WebView2 的拖动区行窗**只在宿主初始化那一刻按当时的
    /// 页面**光栅化一次、永不重算（实测：启动落在首页 → 行带按首页 `.sh-head`(~88px)
    /// 计算，进画布视图后既多出一条 88px 幽灵带、又按首页布局吃掉了书眉里的按钮）。
    /// 掐掉全部 caption 才没有"按另一张页面算出来的区域"在乱咬。
    pub fn clamp_caption_hit(inner: i32, _client_y: i32) -> i32 {
        if inner == HTCAPTION as i32 {
            HTCLIENT as i32
        } else {
            inner
        }
    }

    /// 子类化 id（'LANT'）——同窗口重复挂载时覆盖，不叠加。
    const SUBCLASS_ID: usize = 0x4C41_4E54;

    unsafe extern "system" fn clamp_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        let res = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
        if msg != WM_NCHITTEST || res.0 as i32 != HTCAPTION as i32 {
            return res;
        }
        // lparam = 屏幕坐标（x 低 16 位、y 高 16 位，带符号）
        let raw = lparam.0 as u32;
        let sx = (raw & 0xFFFF) as u16 as i16 as i32;
        let sy = ((raw >> 16) & 0xFFFF) as u16 as i16 as i32;
        let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
        if root.0.is_null() {
            return res;
        }
        let mut pt = POINT { x: sx, y: sy };
        if !unsafe { windows::Win32::Graphics::Gdi::ScreenToClient(root, &mut pt) }.as_bool() {
            return res;
        }
        LRESULT(clamp_caption_hit(res.0 as i32, pt.y) as isize)
    }

    /// 找出主窗口下的 WebView2 宿主窗口（Chromium 系类名；宿主 + 渲染宿主都在内）。
    fn host_children(root: HWND) -> Vec<HWND> {
        use windows::core::PCWSTR;
        use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, WM_GETTEXT};
        let mut out: Vec<HWND> = Vec::new();
        unsafe extern "system" fn cb(child: HWND, lparam: LPARAM) -> windows::core::BOOL {
            let out = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
            let mut buf = [0u16; 128];
            let n = unsafe { GetClassNameW(child, &mut buf) };
            if n > 0 {
                let cls = String::from_utf16_lossy(&buf[..n as usize]);
                if cls.starts_with("Chrome_WidgetWin") {
                    out.push(child);
                }
            }
            let _ = (PCWSTR::null(), WM_GETTEXT);
            true.into()
        }
        let _ = unsafe { EnumChildWindows(Some(root), Some(cb), LPARAM(&mut out as *mut _ as isize)) };
        out
    }

    /// 诊断日志（release 版无控制台——写临时文件，排障期可读；见 2026-09-14 事故复盘）。
    fn diag(line: &str) {
        use std::io::Write;
        let p = std::env::temp_dir().join("lantai-drag-band.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
            let _ = writeln!(f, "{line}");
        }
    }

    /// 安装：后台轮询等 WebView2 宿主窗口出现（webview 创建后才存在），再在主线程子类化。
    pub fn install(app: tauri::AppHandle) {
        use tauri::Manager;
        let Some(win) = app.get_webview_window("main") else {
            diag("[window] 拖动带夹紧未安装：找不到 main 窗口");
            return;
        };
        let Ok(hwnd) = win.hwnd() else {
            diag("[window] 拖动带夹紧未安装：取窗口句柄失败");
            return;
        };
        diag(&format!("[window] install: hwnd={:?} TOPBAR_H={TOPBAR_H}", hwnd.0));
        // HWND 不是 Send：跨线程只带裸句柄，线程内重建（轮询只在后台做，子类化回主线程）
        let root_raw = hwnd.0 as isize;
        std::thread::spawn(move || {
            let root = HWND(root_raw as *mut core::ffi::c_void);
            /* 常驻轮询（2026-09-14 实机取证）：WebView2 把页面的 app-region **光栅化成
             * 一叠薄子窗**（`Chrome_WidgetWin_0`，实测 y 0-12/12-14/…/56-58/58-63/63-88），
             * 每个都无条件回 `HTCAPTION`；且这叠只在**启动那一刻**算一次——首页
             * `.sh-head`（~88px 高的 drag 区）算出的行带，进了画布视图也不重算，所以
             * `--bar-h` 改成 30 也照样到 88。行窗是**后出现的**（启动首轮只见到 2 个宿主）。
             * 故：持续扫描、逐个子类化（同 id 幂等），才能在它们出现时夹住。 */
            let mut seen: std::collections::HashSet<isize> = std::collections::HashSet::new();
            loop {
                let hosts: Vec<isize> = host_children(root).iter().map(|h| h.0 as isize).collect();
                let fresh: Vec<isize> = hosts.iter().copied().filter(|h| !seen.contains(h)).collect();
                if !fresh.is_empty() {
                    for h in &fresh {
                        seen.insert(*h);
                    }
                    let n = hosts.len();
                    let _ = app.run_on_main_thread(move || {
                        let mut ok = 0;
                        for raw in fresh {
                            let h = HWND(raw as *mut core::ffi::c_void);
                            unsafe {
                                if SetWindowSubclass(h, Some(clamp_proc), SUBCLASS_ID, 0).as_bool() {
                                    ok += 1;
                                } else {
                                    diag(&format!("[window] SetWindowSubclass(hwnd={raw}) 失败——该窗不归本线程"));
                                }
                            }
                        }
                        diag(&format!("[window] 新增宿主窗子类化 {ok} 个（累计 {n}）"));
                    });
                }
                std::thread::sleep(Duration::from_millis(1500));
            }
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn caption_neutralized_everywhere() {
            let cap = HTCAPTION as i32;
            let cli = HTCLIENT as i32;
            // caption 一律降为 client（窗口拖动由前端自管——行窗可能按"另一张页面"算出来）
            for y in [0, 20, TOPBAR_H - 1, TOPBAR_H, 88, 700] {
                assert_eq!(clamp_caption_hit(cap, y), cli, "y={y} 的 caption 必须降为 client");
            }
        }

        #[test]
        fn other_hits_untouched() {
            // 只夹 HTCAPTION——边框调整（HTTOP/HTLEFT/HTBOTTOM…）与已归应用的 HTCLIENT 不动
            for inner in [HTCLIENT as i32, 12 /* HTTOP */, 10 /* HTRIGHT */, 8 /* HTBOTTOM */, 0] {
                assert_eq!(clamp_caption_hit(inner, 5), inner);
                assert_eq!(clamp_caption_hit(inner, 700), inner);
            }
        }
    }
}

#[cfg(windows)]
pub use imp::install;
