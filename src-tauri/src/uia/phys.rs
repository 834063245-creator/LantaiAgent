// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 物理输入原语（SendInput / SetCursorPos / 鼠标滚轮 / 热键）——2026-11-22 体量清账
// 自 `com.rs` 抽出（com.rs 1706 → 约 1548 行，回到 1600 档）。
//
// INVARIANTS #13 不变：本模块只负责「注入」；授权（DesktopTool 分层）与全局输入租约
// 全在能力口（`commands/uia_cap.rs`）。**调用方必须已持有 input lease**。
use super::errors;

use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS,
    VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;

fn send(inputs: &[INPUT]) {
    if inputs.is_empty() {
        return;
    }
    unsafe {
        SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

fn mouse_input(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

pub(super) fn click(x: i32, y: i32, right: bool) {
    let _ = unsafe { SetCursorPos(x, y) };
    let (down, up) = if right {
        (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
    } else {
        (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
    };
    send(&[mouse_input(down, x, y, 0), mouse_input(up, x, y, 0)]);
}

pub(super) fn wheel(x: i32, y: i32, delta: i32, horizontal: bool) {
    let _ = unsafe { SetCursorPos(x, y) };
    let flags = if horizontal {
        MOUSEEVENTF_HWHEEL
    } else {
        MOUSEEVENTF_WHEEL
    };
    send(&[mouse_input(flags, x, y, delta)]);
}

/// key 名 → VK 码。支持功能键/编辑键/箭头/F1-F12/单字符。
fn vk_of(key: &str) -> Option<u16> {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    let k = key.trim();
    let vk = match k.to_ascii_lowercase().as_str() {
        "enter" | "return" => VK_RETURN.0,
        "tab" => VK_TAB.0,
        "escape" | "esc" => VK_ESCAPE.0,
        "backspace" => VK_BACK.0,
        "delete" | "del" => VK_DELETE.0,
        "insert" => VK_INSERT.0,
        "home" => VK_HOME.0,
        "end" => VK_END.0,
        "pageup" => VK_PRIOR.0,
        "pagedown" => VK_NEXT.0,
        "up" | "arrowup" => VK_UP.0,
        "down" | "arrowdown" => VK_DOWN.0,
        "left" | "arrowleft" => VK_LEFT.0,
        "right" | "arrowright" => VK_RIGHT.0,
        "space" => VK_SPACE.0,
        "win" | "meta" => VK_LWIN.0,
        other => {
            let mut chars = other.chars();
            let (first, second) = (chars.next(), chars.next());
            match (first, second) {
                (Some(c), None) if c.is_ascii_alphanumeric() => c.to_ascii_uppercase() as u16,
                (Some('f'), Some(d)) if d.is_ascii_digit() => {
                    // F1-F12
                    let n: u32 = other[1..].parse().unwrap_or(0);
                    if (1..=12).contains(&n) {
                        0x70 + (n - 1) as u16
                    } else {
                        return None;
                    }
                }
                _ => return None,
            }
        }
    };
    Some(vk)
}

/// 修饰键序列：ctrl/alt/shift/meta(win)。
fn mod_vks(mods: &[String]) -> Result<Vec<u16>, String> {
    let mut out = Vec::new();
    for m in mods {
        let vk = match m.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => VK_CONTROL.0,
            "alt" | "option" => VK_MENU.0,
            "shift" => VK_SHIFT.0,
            "meta" | "cmd" | "win" => VK_LWIN.0,
            other => {
                return Err(errors::err(
                    errors::codes::ARG_INVALID,
                    format!("不支持的修饰键: {other}（ctrl/alt/shift/meta）"),
                ))
            }
        };
        if !out.contains(&vk) {
            out.push(vk);
        }
    }
    Ok(out)
}

fn key_input(vk: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    KEYBD_EVENT_FLAGS(0)
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// 热键：按住 modifiers → key down/up → 释放 modifiers。
pub(super) fn key_tap(mods: &[String], key: &str) -> Result<(), String> {
    let vk = vk_of(key).ok_or_else(|| {
        errors::err(
            errors::codes::ARG_INVALID,
            format!(
                "无法识别的按键: {key}（Enter/Tab/Escape/Backspace/Delete/ArrowUp/F1-F12/单字符）"
            ),
        )
    })?;
    let m = mod_vks(mods)?;
    let mut seq: Vec<INPUT> = m.iter().map(|&v| key_input(v, false)).collect();
    seq.push(key_input(vk, false));
    seq.push(key_input(vk, true));
    seq.extend(m.iter().rev().map(|&v| key_input(v, true)));
    send(&seq);
    Ok(())
}
