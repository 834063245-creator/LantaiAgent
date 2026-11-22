// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tool 实现 — 每个 Tauri command 对应一个 Tool (spec §4.2 映射表)
// 实现 crate::permissions::Tool trait，委托给 permissions/* 辅助函数。

use std::borrow::Cow;
use std::path::PathBuf;

use crate::permissions::{bash, filesystem, git, web, PermissionContext, PermissionResult, Tool};

// ═══════════════════════════════════════════════════════════════
// ReadTool — read_file_content, read_file_base64, list_directory,
//           glob, search_content 及只读 git 命令
// ═══════════════════════════════════════════════════════════════

pub struct ReadTool {
    pub path: String,
    pub agent_id: Option<String>,
}

impl Tool for ReadTool {
    fn name(&self) -> Cow<'static, str> {
        Cow::Borrowed("Read")
    }

    fn get_path(&self) -> Option<PathBuf> {
        Some(PathBuf::from(&self.path))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_destructive(&self) -> bool {
        false
    }

    fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        let rules = ctx.read_rules();
        // Phase 3: 反向映射 worktree 路径 → 主仓库路径以进行规则匹配 (spec §5.6)
        let logical =
            ctx.reverse_map_path(std::path::Path::new(&self.path), self.agent_id.as_deref());
        let logical_str = logical.to_string_lossy().replace('\\', "/");
        filesystem::check_read_permission(&self.path, &ctx.sandbox, &rules, Some(&logical_str))
    }
}

// ═══════════════════════════════════════════════════════════════
// OfficeTool — office 域工具（officecli 调用）的强制层闸
// ═══════════════════════════════════════════════════════════════
// 为什么需要它（2026-09-15 R3，见 docs/plans/office-cli-integration-plan.md §11.3）：
// office 域工具过去借 `Bash` 家族过闸，而 `bash::check` 的路径检查是按"argv 里含 `/`
// 的 token 就是文件系统路径"的启发式做的——officecli 的 argv 恰恰不是：
//   ① `BIN=${…}` 赋值段、② DOM 路径 `/Sheet1/A1`、③ batch 的 JSON 载荷（内含 `/`）
// 三处都解析失败 ⇒ 判"项目外路径" ⇒ Ask，且该判定在 allow 规则匹配**之前**提前返回
// （bash.rs 步骤 3 → 4）⇒ 默认（ask）与 auto 模式下**每次调用都弹卡、且"始终允许"无效**，
// 只有 yolo 能跑（2026-09-15 探针实证）。
//
// 本闸改判**声明的目标文件**（file/out），走 fs 家族同一套路径策略（沙箱边界 + 安全检查 +
// 内容级规则），DOM 路径与 JSON 载荷不参与判定——它们在**文档内**寻址，不是文件系统路径。
// 规则族名 = "Office"：裸 `Office` 规则可整体放行（对齐 Browser/Desktop 口内闸形态），
// 路径级建议仍是 `Read(<path>)` / `Edit(<path>)`（沿用 fs 家族语义 ⇒ 用户写过的规则直接命中）。

pub struct OfficeTool {
    /// 声明的文件系统目标：`(路径, 是否写)`。空 = 无文件目标（如 playbook 动作）。
    pub targets: Vec<(String, bool)>,
    pub agent_id: Option<String>,
}

impl Tool for OfficeTool {
    fn name(&self) -> Cow<'static, str> {
        Cow::Borrowed("Office")
    }

    fn get_path(&self) -> Option<PathBuf> {
        self.targets.first().map(|(p, _)| PathBuf::from(p))
    }

    fn is_read_only(&self) -> bool {
        !self.targets.is_empty() && self.targets.iter().all(|(_, write)| !*write)
    }

    fn is_destructive(&self) -> bool {
        !self.is_read_only()
    }

    fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        let rules = ctx.read_rules();
        // 1. 工具级 Deny — 最高优先级
        if let Some(rule) = rules.find_deny("Office", None) {
            return PermissionResult::Deny {
                reason: rule.explain(),
            };
        }
        // 2. 工具级 Allow（用户"始终允许 Office"）— 对齐 Browser/Desktop 口内闸形态
        if rules.find_allow("Office", None).is_some() {
            return PermissionResult::Allow;
        }
        // 3. 逐目标过 fs 家族路径闸：
        //    项目内 → Allow（不弹卡）；项目外 → Ask（建议规则可"始终允许"）；
        //    .ssh / .git/config 一类敏感面 → safety 检查升 Ask；内容级规则照旧命中。
        for (path, write) in &self.targets {
            let verdict = if *write {
                filesystem::check_write_permission(path, &ctx.sandbox, &rules, None)
            } else {
                filesystem::check_read_permission(path, &ctx.sandbox, &rules, None)
            };
            match verdict {
                PermissionResult::Deny { .. } | PermissionResult::Ask { .. } => return verdict,
                PermissionResult::Allow | PermissionResult::Passthrough => {}
            }
        }
        PermissionResult::Passthrough
    }
}

// ═══════════════════════════════════════════════════════════════
// EditTool — write_file_content, edit_file, delete_file_or_dir,
//           create_directory, rename_file_or_dir, log_append, move_file
// ═══════════════════════════════════════════════════════════════

pub struct EditTool {
    pub path: String,
    pub agent_id: Option<String>,
}

impl Tool for EditTool {
    fn name(&self) -> Cow<'static, str> {
        Cow::Borrowed("Edit")
    }

    fn get_path(&self) -> Option<PathBuf> {
        Some(PathBuf::from(&self.path))
    }

    fn is_read_only(&self) -> bool {
        false
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        let rules = ctx.read_rules();
        // Phase 3: 反向映射 worktree 路径 → 主仓库路径以进行规则匹配 (spec §5.6)
        let logical =
            ctx.reverse_map_path(std::path::Path::new(&self.path), self.agent_id.as_deref());
        let logical_str = logical.to_string_lossy().replace('\\', "/");
        filesystem::check_write_permission(&self.path, &ctx.sandbox, &rules, Some(&logical_str))
    }
}

// ═══════════════════════════════════════════════════════════════
// BashTool — exec_command
// ═══════════════════════════════════════════════════════════════

pub struct BashTool {
    pub command: String,
}

impl Tool for BashTool {
    fn name(&self) -> Cow<'static, str> {
        Cow::Borrowed("Bash")
    }

    fn get_path(&self) -> Option<PathBuf> {
        None // bash 命令操作多个路径，而非单个文件
    }

    fn is_read_only(&self) -> bool {
        false
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        let rules = ctx.read_rules();
        bash::check(&self.command, &ctx.sandbox, &rules)
    }
}

// ═══════════════════════════════════════════════════════════════
// GitTool — git_stage, git_unstage, git_stage_all, git_commit,
//          git_push, git_pull, git_init, git_checkout,
//          git_create_branch, git_stash_push, git_stash_pop, git_discard
// ═══════════════════════════════════════════════════════════════

pub struct GitTool {
    pub repo_path: String,
    pub subcommand: String,
}

impl Tool for GitTool {
    fn name(&self) -> Cow<'static, str> {
        Cow::Borrowed("Git")
    }

    fn get_path(&self) -> Option<PathBuf> {
        Some(PathBuf::from(&self.repo_path))
    }

    fn is_read_only(&self) -> bool {
        false
    }

    fn is_destructive(&self) -> bool {
        // push/commit/stash_pop/checkout 可能修改工作区
        true
    }

    fn requires_user_interaction(&self) -> bool {
        // ponytail: git 破坏性操作始终需要用户交互
        matches!(
            self.subcommand.as_str(),
            "push" | "commit" | "checkout" | "discard" | "stash_pop"
        )
    }

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        // 首先检查仓库路径是否可读
        let rules = ctx.read_rules();
        let path_check =
            filesystem::check_read_permission(&self.repo_path, &ctx.sandbox, &rules, None);
        if let PermissionResult::Deny { .. } = path_check {
            return path_check;
        }
        // 然后检查 git 子命令
        git::check(&self.subcommand, &rules)
    }
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// BrowserTool — browser_launch / browser_kill / browser_attach / browser_eval 等
// ═══════════════════════════════════════════════════════════════

pub struct BrowserTool {
    pub action: String,
    pub agent_id: Option<String>,
}

impl Tool for BrowserTool {
    fn name(&self) -> Cow<'static, str> {
        Cow::Borrowed("Browser")
    }

    fn get_path(&self) -> Option<PathBuf> {
        None // 浏览器控制不针对单个文件
    }

    fn is_read_only(&self) -> bool {
        matches!(
            self.action.as_str(),
            "targets"
                | "discover"
                | "inspect"
                | "report"
                | "status"
                | "snapshot"
                | "console"
                | "network"
                | "network_detail"
                | "network_har"
                | "screenshot"
                | "audit"
                | "content"
                | "wait"
                | "dialog_query"
                | "sessions"
                | "cookies_list"
        )
    }

    fn is_destructive(&self) -> bool {
        !self.is_read_only()
    }

    fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        use crate::permissions::PermissionUpdate;
        let rules = ctx.read_rules();
        // 1. 工具级 Deny — 最高优先级
        if let Some(rule) = rules.find_deny("Browser", None) {
            return PermissionResult::Deny {
                reason: rule.explain(),
            };
        }
        // 2. 工具级 Allow — 用户已批准"始终允许"
        if rules.find_allow("Browser", None).is_some() {
            return PermissionResult::Allow;
        }
        // 3. 只读动作放行（targets/inspect/content/wait/status — 不改变任何状态）
        if self.is_read_only() {
            return PermissionResult::Passthrough;
        }
        // 4. L2 普通页面动作放行：attach 已批过一次，页面内 navigate/back/forward/
        //    reload/click/type/press/scroll/select 不再重复弹窗；敏感目标与高危动作除外。
        if matches!(
            self.action.as_str(),
            "navigate"
                | "back"
                | "forward"
                | "reload"
                | "click"
                | "type"
                | "press"
                | "scroll"
                | "select"
                | "hover"
                | "dialog"
                | "upload"
                | "viewport"
                | "new_tab"
                | "close_tab"
                | "switch_session"
        ) {
            return PermissionResult::Passthrough;
        }
        // 5. 高危动作：launch/kill（受控浏览器进程）/ attach（接管外部页面）/
        //    eval（任意 JS）/ click_sensitive·type_sensitive（敏感目标，L3）→ Ask。
        //    文案写实：attach 批准意味着该页面内的普通点击/输入不再二次确认
        //    （click/type 依赖 attach 时的授权；敏感目标仍每次单独确认）。
        let reason = match self.action.as_str() {
            "attach" => "Agent 请求接管一个浏览器页面。批准后 Agent 可在该页面上执行点击、输入等操作，\
                 普通操作不会再次确认（敏感目标如提交按钮/已填值输入框仍会单独询问）——建议只对无敏感信息的页面批准。"
                .into(),
            "connect" => "Agent 请求连接你自己启动的浏览器实例（调试端口）。批准后 Agent 可操作\
                 该浏览器的全部页面——包括你的登录态、Cookie 和真实数据。\
                 kill 只会断开连接、不会终止该浏览器。建议只连接无敏感登录态的实例。"
                .into(),
            "eval" => "Agent 请求在该页面执行任意 JS（受基础白名单限制）".into(),
            "kill" => "Agent 请求终止其启动的受控浏览器（若为外部连接则仅断开）".into(),
            "cookies_set" => "Agent 请求写入浏览器 cookie（登录态/会话标识），可能改变当前登录身份".into(),
            "cookies_delete" => "Agent 请求删除浏览器 cookie（可能使当前账号登出）".into(),
            "click_sensitive" => "Agent 请求点击一个敏感目标（提交按钮 / 下载 / 含确认、支付、删除或 Pay now、Delete、Confirm、Unsubscribe 等文本的元素）".into(),
            "type_sensitive" => "Agent 请求向已填值的输入框（或密码框）输入文字".into(),
            _ => format!("Agent 请求控制浏览器（动作: {}）", self.action),
        };
        PermissionResult::Ask {
            reason,
            suggestions: vec![PermissionUpdate {
                rule: "Browser".into(),
                behavior: "allow".into(),
            }],
            danger: Some("browser 控制".into()),
        }
    }
}

// DesktopTool — desktop_probe / desktop_screenshot / desktop_uia_*
// ═══════════════════════════════════════════════════════════════
// 权限分层（2026-08 computer-use 改造，对齐 BrowserTool 的 attach 模式）：
//   1. 工具级 Deny（最高优先）
//   2. 工具级 Allow
//   3. 只读动作（probe/tree/find/read/wait/window_shot/audit）→ Passthrough
//   4. uia_pattern / uia_physical_granted（已有窗口级授权 DesktopGrant 的动作，
//      含无 pattern 可用的物理兜底路径）→ Passthrough
//   5. uia_grant（首次接管某窗口）→ Ask 一次，批准后 rpc 层记录 grant
//   6. uia_click_sensitive / uia_type_sensitive（敏感目标）→ 每次单独 Ask
//   7. uia_physical（**未授权窗口**的物理输入路径：坐标点击/键盘注入/滚轮）→
//      每次单独 Ask + 输入租约
//   8. screenshot（高隐私面）→ 每次单独 Ask（已从 read-only 移除）
//
// 2026-11 批 2（P0-2，computer use 四批计划）：第 4 层从「仅 pattern」扩到
// 「pattern + 物理兜底」——用户批准接管某窗口 = 批准该窗口内的结果面操作；
// 自绘界面（无 UIA pattern）若每点一次弹一次卡，多步任务根本跑不动。收紧面不变：
// 敏感目标（提交/支付/删除/密码/覆盖已填值）仍每次 Ask；热键 uia_keys 与抢前台
// uia_activate 影响面超出目标窗口，**永远**每次 Ask。kill switch：
// `HOLOGRAM_UIA_PHYSICAL_ON_GRANT=0` 恢复旧语义（物理路径每次 Ask）。
// 分类所需信息（name/patterns/hwnd）由 rpc 层先做只读 resolve 再构造本 Tool。
// 物理输入的串行化（DesktopInputLease）在 rpc 层执行时获取。

pub struct DesktopTool {
    pub action: String,
    pub agent_id: Option<String>,
    /// 目标窗口句柄（写动作分类后携带；grant 记录用）
    pub hwnd: Option<u64>,
    /// 目标窗口标题（Ask 文案展示用）
    pub window_title: Option<String>,
}

impl Tool for DesktopTool {
    fn name(&self) -> Cow<'static, str> {
        Cow::Borrowed("Desktop")
    }

    fn get_path(&self) -> Option<PathBuf> {
        None // 桌面快照/UIA 不针对单个文件
    }

    fn is_read_only(&self) -> bool {
        // 观察类: probe + UIA 读树/查找/读值/等待 + 窗口截图 + 审计查询。
        // screenshot 刻意不在列：高隐私面，走 Ask（第 8 层）。
        matches!(
            self.action.as_str(),
            "probe"
                | "uia_tree"
                | "uia_find"
                | "uia_read"
                | "uia_wait"
                | "uia_window_shot"
                | "audit"
        )
    }

    fn is_destructive(&self) -> bool {
        // 写动作(点击/输入/滚动/热键/激活)会改变目标应用状态。
        // uia_pattern 虽已获窗口级授权（check_permissions 放行），
        // 但它仍是真实写操作 —— is_destructive 保持 true（并发调度侧保守）。
        !self.is_read_only()
    }

    fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        use crate::permissions::PermissionUpdate;
        let rules = ctx.read_rules();
        // 1. 工具级 Deny — 最高优先级
        if let Some(rule) = rules.find_deny("Desktop", None) {
            return PermissionResult::Deny {
                reason: rule.explain(),
            };
        }
        // 2. 工具级 Allow
        if rules.find_allow("Desktop", None).is_some() {
            return PermissionResult::Allow;
        }
        // 3. 只读动作放行（不改变桌面状态）
        if self.is_read_only() {
            return PermissionResult::Passthrough;
        }
        // 4. 已授权窗口上的动作放行：pattern（标准控件）+ physical_granted（物理兜底，
        //    批 2：自绘界面没有 pattern 可用，接管后按结果面放行）。
        //    DesktopGrant 在 rpc 层记录/校验，check_permissions 保持纯函数 —
        //    沿 BrowserTool「attach 后页内动作放行」语义。
        if matches!(self.action.as_str(), "uia_pattern" | "uia_physical_granted") {
            return PermissionResult::Passthrough;
        }
        // 5-8. Ask 类：接管授权 / 敏感目标 / 物理输入 / 截图
        let title = self.window_title.as_deref().unwrap_or("未知窗口");
        let hwnd_note = self
            .hwnd
            .map(|h| format!("（hwnd={h}）"))
            .unwrap_or_default();
        let reason = match self.action.as_str() {
            "uia_grant" => format!(
                "Agent 请求接管桌面窗口「{title}」{hwnd_note}。批准后该窗口上的操作（点击/输入/\
                 选择/展开/滚动，含无标准 pattern 时走的物理输入）不再逐次确认——\
                 敏感目标（提交/支付/删除）仍会单独询问；建议只对无敏感内容的窗口批准。"
            ),
            "uia_click_sensitive" => format!(
                "Agent 请求点击窗口「{title}」中一个敏感控件（提交/支付/删除/确认/退订类文本）。\
                 点击可能触发不可逆操作，请确认目标与后果。"
            ),
            "uia_type_sensitive" => format!(
                "Agent 请求向窗口「{title}」中一个已填值（或密码）输入框写入文字，会覆盖现有内容。"
            ),
            "uia_physical" => format!(
                "Agent 请求对窗口「{title}」执行物理输入（坐标鼠标/键盘注入/滚轮）{hwnd_note}。\
                 真实输入会落进当前屏幕焦点，可能触发保存、发送、删除等副作用；\
                 若目标控件不支持标准 pattern（自绘界面），这是唯一可用路径。\
                 批准接管该窗口后，该窗口内的物理输入不再逐次询问（敏感目标仍每次单独确认，\
                 热键与抢前台仍每次询问）。"
            ),
            "screenshot" => "Agent 请求截取全屏。截图可能包含任意屏幕内容（高隐私面），请确认。".into(),
            "uia_keys" => "Agent 请求向目标窗口注入键盘热键（SendInput）。真实按键会落进焦点窗口，请确认目标与键位安全。".into(),
            "uia_activate" => "Agent 请求把目标窗口带到前台（会切换当前焦点窗口）。".into(),
            _ => format!("Agent 请求控制桌面应用（动作: {}）", self.action),
        };
        PermissionResult::Ask {
            reason,
            suggestions: vec![PermissionUpdate {
                rule: "Desktop".into(),
                behavior: "allow".into(),
            }],
            danger: Some("桌面自动化操作".into()),
        }
    }
}

/// UIA 写动作分类的输入：目标控件能力（来自只读 resolve）。
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct UiaTargetCaps {
    pub has_invoke: bool,
    pub has_toggle: bool,
    pub has_select: bool,
    pub has_value: bool,
    pub has_scroll: bool,
}

/// 分类：敏感目标 > 物理路径 > 已授权 pattern > 首次接管（优先级即安全收紧序）。
/// 输出是 DesktopTool 的 action 名（check_permissions 的分层输入）。
///
/// 物理路径的落地等级取决于「是否已接管该窗口」与 kill switch（批 2）：
/// 已接管 → `uia_physical_granted`（第 4 层放行）；未接管 / 开关关闭 → `uia_physical`（Ask）。
pub(crate) fn classify_uia_action(
    kind: &str,
    target_name: &str,
    password: bool,
    cur_value: &str,
    caps: &UiaTargetCaps,
    granted: bool,
) -> &'static str {
    classify_uia_action_with(
        kind,
        target_name,
        password,
        cur_value,
        caps,
        granted,
        physical_on_grant(),
    )
}

/// 物理输入是否在窗口接管授权内放行（批 2，P0-2）。
///
/// 语义：用户批准「接管某窗口」= 批准该窗口内的**结果面**操作——包括无 pattern 可用的
/// 物理兜底路径（坐标点击 / 滚轮 / 剪贴板粘贴）。自绘界面（微信/QQ/钉钉、画布类应用）
/// 没有 pattern，若每点一次弹一次卡，多步任务根本跑不动。
///
/// 收紧面不变（永不纳入本档）：敏感目标（提交/支付/删除/密码/覆盖已填值）每次单独 Ask；
/// `uia_keys`（SendInput 全局热键）与 `uia_activate`（抢前台）影响面超出目标窗口，永远 Ask。
///
/// kill switch：`HOLOGRAM_UIA_PHYSICAL_ON_GRANT=0`（或 `false`）恢复旧语义——物理路径
/// 每次单独 Ask。
pub(crate) fn physical_on_grant() -> bool {
    match std::env::var("HOLOGRAM_UIA_PHYSICAL_ON_GRANT") {
        Ok(v) => {
            let v = v.trim();
            !(v == "0" || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("off"))
        }
        Err(_) => true,
    }
}

/// 分类矩阵本体（纯函数，`physical_on_grant` 由调用方显式传入——两态可测）。
pub(crate) fn classify_uia_action_with(
    kind: &str,
    target_name: &str,
    password: bool,
    cur_value: &str,
    caps: &UiaTargetCaps,
    granted: bool,
    physical_on_grant: bool,
) -> &'static str {
    let sensitive = match kind {
        "click" | "right_click" => crate::sensitive::is_sensitive_click_text(target_name),
        "type" => password || !cur_value.is_empty(),
        _ => false,
    };
    if sensitive {
        if kind == "type" {
            "uia_type_sensitive"
        } else {
            "uia_click_sensitive"
        }
    } else if uia_action_needs_physical(kind, caps) {
        if granted && physical_on_grant {
            "uia_physical_granted"
        } else {
            "uia_physical"
        }
    } else if granted {
        "uia_pattern"
    } else {
        "uia_grant"
    }
}

/// 该动作在该控件上是否只能走物理输入路径（无可用 pattern）。
/// rpc 层据此决定执行前是否获取全局输入租约。
pub(crate) fn uia_action_needs_physical(kind: &str, caps: &UiaTargetCaps) -> bool {
    match kind {
        "click" => !(caps.has_invoke || caps.has_toggle || caps.has_select),
        "right_click" => true,
        "type" => !caps.has_value,
        "scroll" => !caps.has_scroll,
        // 批 2 坐标模式：天生等价不了任何标准 pattern 动作，一律物理路径
        "click_at" | "right_click_at" | "scroll_at" => true,
        _ => false,
    }
}

#[cfg(test)]
mod office_permission_tests {
    use super::*;

    /// 建一个临时项目根 + 可选 `.lantai/permissions.json`，返回 (根, ctx)。
    fn ctx_with_rules(tag: &str, rules_json: Option<&str>) -> (PathBuf, PermissionContext) {
        let dir =
            std::env::temp_dir().join(format!("lantai_office_perm_{}_{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".lantai")).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join("报告.xlsx"), b"x").unwrap();
        std::fs::write(dir.join(".git").join("config"), b"[core]\n").unwrap();
        if let Some(json) = rules_json {
            std::fs::write(dir.join(".lantai").join("permissions.json"), json).unwrap();
        }
        let ctx = PermissionContext::new(&dir);
        (dir, ctx)
    }

    fn office(targets: Vec<(String, bool)>) -> OfficeTool {
        OfficeTool {
            targets,
            agent_id: None,
        }
    }

    fn kind(r: &PermissionResult) -> &'static str {
        match r {
            PermissionResult::Allow => "allow",
            PermissionResult::Deny { .. } => "deny",
            PermissionResult::Ask { .. } => "ask",
            PermissionResult::Passthrough => "passthrough",
        }
    }

    /// 2026-09-15 R3 主判据：**项目内目标不弹卡**（这正是旧 Bash 家族判定做不到的），
    /// 项目外 / 敏感路径仍要问；无文件目标（playbook）直接放行。
    #[test]
    fn office_permission_matrix() {
        let (root, ctx) = ctx_with_rules("matrix", None);
        let inside = root.join("报告.xlsx").to_string_lossy().to_string();
        let inside_slash = inside.replace('\\', "/");
        // 项目内：读 / 写都放行（不弹卡）
        assert_eq!(
            kind(&office(vec![(inside_slash.clone(), false)]).check_permissions(&ctx)),
            "passthrough"
        );
        assert_eq!(
            kind(&office(vec![(inside_slash.clone(), true)]).check_permissions(&ctx)),
            "passthrough"
        );
        // 无文件目标（playbook 动作）：放行
        assert_eq!(kind(&office(vec![]).check_permissions(&ctx)), "passthrough");
        // 项目外：Ask（用户可"始终允许"）
        let outside = std::env::temp_dir()
            .join("lantai_office_outside")
            .join("x.xlsx")
            .to_string_lossy()
            .replace('\\', "/");
        assert_eq!(
            kind(&office(vec![(outside, true)]).check_permissions(&ctx)),
            "ask"
        );
        // 项目内但受保护路径（.git/config）：系统 Edit deny 规则**硬拒**（比 safety Ask 更严）
        let protected = root
            .join(".git")
            .join("config")
            .to_string_lossy()
            .replace('\\', "/");
        assert_eq!(
            kind(&office(vec![(protected, true)]).check_permissions(&ctx)),
            "deny",
            ".git/config 写入必须被系统 Edit deny 规则挡住"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    /// 规则面：裸 `Office` 可整体放行/拒绝（"始终允许"必须真的生效——旧 Bash 家族
    /// 判定里 allow 规则**在路径检查之后**，写进去也不生效）。
    #[test]
    fn office_bare_rules_take_effect() {
        let (root, ctx) = ctx_with_rules("allow", Some(r#"{"allow":["Office"]}"#));
        let outside = std::env::temp_dir()
            .join("lantai_office_outside2")
            .join("y.xlsx")
            .to_string_lossy()
            .replace('\\', "/");
        assert_eq!(
            kind(&office(vec![(outside.clone(), true)]).check_permissions(&ctx)),
            "allow",
            "裸 Office allow 规则必须能放行（否则等于没法允许）"
        );
        std::fs::remove_dir_all(&root).ok();

        let (root2, ctx2) = ctx_with_rules("deny", Some(r#"{"deny":["Office"]}"#));
        let inside = root2.join("报告.xlsx").to_string_lossy().replace('\\', "/");
        assert_eq!(
            kind(&office(vec![(inside, false)]).check_permissions(&ctx2)),
            "deny",
            "工具级 deny 最高优先"
        );
        std::fs::remove_dir_all(&root2).ok();
    }
}

#[cfg(test)]
mod desktop_permission_tests {
    use super::*;
    use crate::permissions::PermissionContext;

    /// 构造无规则上下文（空项目目录）——分类矩阵只测 Tool 自身分层。
    fn ctx_empty() -> PermissionContext {
        PermissionContext::new(std::path::Path::new(""))
    }

    fn desktop(action: &str) -> DesktopTool {
        DesktopTool {
            action: action.into(),
            agent_id: None,
            hwnd: Some(1234),
            window_title: Some("测试窗口".into()),
        }
    }

    fn kind(r: &PermissionResult) -> &'static str {
        match r {
            PermissionResult::Allow => "allow",
            PermissionResult::Deny { .. } => "deny",
            PermissionResult::Ask { .. } => "ask",
            PermissionResult::Passthrough => "passthrough",
        }
    }

    /// 六层矩阵：只读放行 / pattern 放行 / 接管与敏感与物理 Ask / screenshot Ask。
    #[test]
    fn desktop_permission_matrix() {
        let ctx = ctx_empty();
        // 只读 → Passthrough（引擎兜底放行）
        for a in [
            "probe",
            "uia_tree",
            "uia_find",
            "uia_read",
            "uia_wait",
            "uia_window_shot",
            "audit",
        ] {
            assert_eq!(
                kind(&desktop(a).check_permissions(&ctx)),
                "passthrough",
                "{a} 应只读放行"
            );
        }
        // 已授权窗口 pattern 动作 → Passthrough
        assert_eq!(
            kind(&desktop("uia_pattern").check_permissions(&ctx)),
            "passthrough"
        );
        // 批 2：已接管窗口内的物理兜底路径同样放行（敏感目标另有分层，仍 Ask）
        assert_eq!(
            kind(&desktop("uia_physical_granted").check_permissions(&ctx)),
            "passthrough"
        );
        // 首次接管 → Ask（文案含窗口标题）
        match desktop("uia_grant").check_permissions(&ctx) {
            PermissionResult::Ask { reason, .. } => {
                assert!(
                    reason.contains("测试窗口"),
                    "接管文案应含窗口标题: {reason}"
                );
            }
            other => panic!("uia_grant 应 Ask，实际 {}", kind(&other)),
        }
        // 敏感目标 → Ask（文案区分 click/type）
        for a in ["uia_click_sensitive", "uia_type_sensitive"] {
            assert_eq!(
                kind(&desktop(a).check_permissions(&ctx)),
                "ask",
                "{a} 应 Ask"
            );
        }
        // 物理输入 → Ask（含 hwnd）
        match desktop("uia_physical").check_permissions(&ctx) {
            PermissionResult::Ask { reason, .. } => {
                assert!(
                    reason.contains("hwnd=1234"),
                    "物理输入文案应含 hwnd: {reason}"
                );
            }
            other => panic!("uia_physical 应 Ask，实际 {}", kind(&other)),
        }
        // 全屏截图 → Ask（从 read-only 移除后的高隐私面收口）
        assert_eq!(kind(&desktop("screenshot").check_permissions(&ctx)), "ask");
        // keys/activate → Ask
        assert_eq!(kind(&desktop("uia_keys").check_permissions(&ctx)), "ask");
        assert_eq!(
            kind(&desktop("uia_activate").check_permissions(&ctx)),
            "ask"
        );
        // 旧名兜底 → Ask
        assert_eq!(kind(&desktop("whatever").check_permissions(&ctx)), "ask");
        // is_read_only：screenshot 不在列
        assert!(!desktop("screenshot").is_read_only());
        assert!(desktop("uia_tree").is_read_only());
        // uia_pattern 已授权但仍属真实写操作 —— is_destructive 保持 true（调度保守）
        assert!(desktop("uia_pattern").is_destructive());
    }

    /// 分类矩阵：敏感 > 物理 > 已授权 pattern > 首次接管。
    /// 与 desktop_uia_write 的编排逻辑共享此纯函数，矩阵锁住优先级序。
    #[test]
    fn classify_uia_action_matrix() {
        let full = UiaTargetCaps {
            has_invoke: true,
            has_toggle: true,
            has_select: true,
            has_value: true,
            has_scroll: true,
        };
        let bare = UiaTargetCaps::default();

        // 普通控件 + 已授权 → pattern 放行
        assert_eq!(
            classify_uia_action("click", "OK", false, "", &full, true),
            "uia_pattern"
        );
        // 普通控件 + 未授权 → 首次接管
        assert_eq!(
            classify_uia_action("click", "OK", false, "", &full, false),
            "uia_grant"
        );
        // 敏感词点击：即使已授权也每次单独 Ask（优先级最高）
        for name in ["确认支付", "Pay now", "Delete account"] {
            assert_eq!(
                classify_uia_action("click", name, false, "", &full, true),
                "uia_click_sensitive",
                "{name}"
            );
        }
        // 右键命中敏感词 → click_sensitive（物理性被敏感性覆盖）
        assert_eq!(
            classify_uia_action("right_click", "删除", false, "", &bare, true),
            "uia_click_sensitive"
        );
        // type：密码框 / 已填值 → sensitive（优先于 has_value 判定）
        assert_eq!(
            classify_uia_action("type", "Password", true, "", &full, true),
            "uia_type_sensitive"
        );
        assert_eq!(
            classify_uia_action("type", "搜索", false, "旧值", &full, true),
            "uia_type_sensitive"
        );
        // type：普通空输入框 + 已授权 → pattern
        assert_eq!(
            classify_uia_action("type", "搜索", false, "", &full, true),
            "uia_pattern"
        );
        // 无 pattern 可用（自绘界面）→ 批 2：已接管窗口内按结果面放行（physical_granted），
        // 未接管仍 Ask；执行前一律要租约（并发安全不变）。
        assert_eq!(
            classify_uia_action("click", "OK", false, "", &bare, true),
            "uia_physical_granted"
        );
        assert_eq!(
            classify_uia_action("right_click", "图标", false, "", &full, true),
            "uia_physical_granted"
        );
        assert_eq!(
            classify_uia_action("type", "画布输入", false, "", &bare, true),
            "uia_physical_granted"
        );
        assert_eq!(
            classify_uia_action("scroll", "列表", false, "", &bare, true),
            "uia_physical_granted"
        );
        // 未接管 + 无 pattern → 首次 Ask 走物理输入档（批准后 rpc 层一并记 grant，
        // 下次即进 physical_granted——自绘界面整窗无 pattern 时这条是唯一接管入口）。
        assert_eq!(
            classify_uia_action("click", "OK", false, "", &bare, false),
            "uia_physical"
        );
        assert_eq!(
            classify_uia_action("scroll", "列表", false, "", &bare, false),
            "uia_physical"
        );
        // select/expand：pattern-only，永不物理
        assert_eq!(
            classify_uia_action("select", "列表项", false, "", &bare, true),
            "uia_pattern"
        );
        assert_eq!(
            classify_uia_action("expand", "组合框", false, "", &bare, false),
            "uia_grant"
        );
        assert!(!uia_action_needs_physical("select", &bare));
        assert!(!uia_action_needs_physical("expand", &bare));

        // kill switch：放行关闭时物理路径回到逐次 Ask（批 2 的回滚口）
        assert_eq!(
            classify_uia_action_with("click", "OK", false, "", &bare, true, false),
            "uia_physical"
        );
        assert_eq!(
            classify_uia_action_with("scroll", "列表", false, "", &bare, true, false),
            "uia_physical"
        );
        // 开关开着但未接管 → 仍是 Ask 档（无 pattern 控件的首次 Ask 即接管入口）
        assert_eq!(
            classify_uia_action_with("click", "OK", false, "", &bare, false, true),
            "uia_physical"
        );
        // 敏感目标在放行档下依然每次 Ask（优先级最高，物理性被敏感性覆盖）
        assert_eq!(
            classify_uia_action_with("click", "确认支付", false, "", &bare, true, true),
            "uia_click_sensitive"
        );
        assert_eq!(
            classify_uia_action_with("type", "密码框", true, "", &bare, true, true),
            "uia_type_sensitive"
        );
        // 批 2 坐标模式：天然物理路径，已接管 → 放行，未接管 / 开关关 → Ask
        for at_kind in ["click_at", "right_click_at", "scroll_at"] {
            assert!(
                uia_action_needs_physical(at_kind, &full),
                "{at_kind} 必须走物理路径（坐标模式不等价任何 pattern）"
            );
            assert_eq!(
                classify_uia_action(at_kind, "", false, "", &bare, true),
                "uia_physical_granted",
                "{at_kind} 已接管应放行"
            );
            assert_eq!(
                classify_uia_action(at_kind, "", false, "", &bare, false),
                "uia_physical",
                "{at_kind} 未接管应 Ask"
            );
            assert_eq!(
                classify_uia_action_with(at_kind, "", false, "", &bare, true, false),
                "uia_physical",
                "{at_kind} kill switch 关闭放行后应回到 Ask"
            );
        }
    }
}

// WebFetchTool — web_fetch
// ═══════════════════════════════════════════════════════════════

pub struct WebFetchTool {
    pub url: String,
    pub agent_id: Option<String>,
}

impl Tool for WebFetchTool {
    fn name(&self) -> Cow<'static, str> {
        Cow::Borrowed("WebFetch")
    }

    fn get_path(&self) -> Option<PathBuf> {
        None
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_destructive(&self) -> bool {
        false
    }

    fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        let rules = ctx.read_rules();
        web::check(&self.url, &rules)
    }
}
