// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// constraints 能力口（R4 小面清偿，kernel-capability-d4-handle-design.md §6
// R4-4）——hologram.constraints.yaml 读写族直呼入口，不经 tool_call 信封 /
// PluginRegistry / PluginToolAdapter（builtin.constraints 插件随本批退役）。
//
// 权限形状（插件原语义）：原命令本就无权限检查（commands/constraints.rs 只做
// `..` 穿越校验）——口保持同款，不声明 permission、无家族闸（行为零漂移；
// 物理层校验 = 路径非法字符拒绝即本口的强制面）。
//
// 键语言：口收顶层 snake（project_path/content）；TS 工具面键 = manifest
// 语言（camelCase：projectPath），映射在 TS execute 层。返回 Text
// （read = YAML 原文；write = "null"——插件 Ok(Value::Null) 的 dispatch
// 序列化字节保持）。

use serde_json::Value;
use tauri::State;

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(String::from)
}

/// read_constraints — 读 hologram.constraints.yaml（业务自插件原样迁入）。
async fn read_constraints(args: &Value) -> Result<String, String> {
    let project_path = arg_str(args, "project_path")
        .ok_or_else(|| "read_constraints: missing 'projectPath'".to_string())?;
    if project_path.contains("..") || project_path.contains('\0') {
        return Err("路径包含非法字符".into());
    }
    let yaml_path = std::path::PathBuf::from(&project_path).join("hologram.constraints.yaml");
    if !yaml_path.exists() {
        let default_path = crate::utils::project_root().join("hologram.constraints.yaml");
        let content = std::fs::read_to_string(&default_path)
            .map_err(|e| format!("无法读取默认约束文件: {}", e))?;
        return Ok(content);
    }
    let content = std::fs::read_to_string(&yaml_path)
        .map_err(|e| format!("无法读取约束文件: {}", e))?;
    Ok(content)
}

/// write_constraints — 临时文件原子替换 hologram.constraints.yaml（业务原样迁入）。
async fn write_constraints(args: &Value) -> Result<String, String> {
    let project_path = arg_str(args, "project_path")
        .ok_or_else(|| "write_constraints: missing 'projectPath'".to_string())?;
    let content = arg_str(args, "content")
        .ok_or_else(|| "write_constraints: missing 'content'".to_string())?;
    if project_path.contains("..") || project_path.contains('\0') {
        return Err("路径包含非法字符".into());
    }
    let yaml_path = std::path::PathBuf::from(&project_path).join("hologram.constraints.yaml");
    let tmp_path = yaml_path.with_extension("yaml.tmp");
    std::fs::write(&tmp_path, &content).map_err(|e| format!("无法写入临时文件: {}", e))?;
    std::fs::rename(&tmp_path, &yaml_path).map_err(|e| format!("无法保存约束文件: {}", e))?;
    // ok_unit 同款：unit → "null"（与旧 RPC 分支/插件 Value::Null 的序列化字节一致）。
    Ok("null".into())
}

/// constraints_cap 能力口分派（R4 小面清偿立口即唯一入口——builtin.constraints
/// 同批退役，无信封过渡面）。action = 退役前 builtin.constraints 2 工具名；
/// 参数顶层 snake；返回文本。
pub(crate) async fn constraints_cap(
    action: String,
    params: Value,
    is_agent: bool,
    agent_id: Option<String>,
    state: &State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    // 统一契约键 + 身份参数：constraints 无权限闸（原语义），口内不消费。
    let _ = (is_agent, agent_id, state, app);
    match action.as_str() {
        "read_constraints" => read_constraints(&params).await,
        "write_constraints" => write_constraints(&params).await,
        other => Err(format!("constraints_cap: 未知 action '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    /// 2 动作全集（= 退役前 builtin.constraints manifest.tools 名单）。
    #[test]
    fn action_table_is_exactly_two() {
        let actions = ["read_constraints", "write_constraints"];
        assert_eq!(actions.len(), 2);
        assert!(actions.iter().all(|a| a.ends_with("_constraints")));
    }
}
