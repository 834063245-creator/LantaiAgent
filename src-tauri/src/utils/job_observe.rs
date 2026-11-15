// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 后台任务观测面 — 名册投影 + 按绝对偏移的非消费读取。
//
// 从 bg_jobs.rs 拆出（2026-11-15 上帝文件治理）：这一层**只读**——不 spawn、不结算、
// 不碰通知队列、不移动模型游标。役册（UI）与状态栏据此看「还有什么在跑」，
// 与「Agent 忙不忙」是两套信号（见 landmine L5 的裁定）。

use std::path::PathBuf;
use crate::utils::bg_jobs::{BG_JOBS, BgJob, JobStatus, SETTLED_HISTORY, SettledRecord, STALL_THRESHOLD};
use crate::utils::ipc_guard::lock_or_recover;
use crate::utils::stream_ring::StreamRing;
// ═══════════════════════════════════════════════════════
// 观测面（非消费）：名册 + 按偏移读取
// ═══════════════════════════════════════════════════════

fn ring_coords(ring: &StreamRing) -> (u64, u64) {
    ring.coords()
}

fn spill_json(path: Option<&PathBuf>) -> serde_json::Value {
    match path {
        Some(p) => serde_json::Value::String(p.display().to_string()),
        None => serde_json::Value::Null,
    }
}

fn job_projection(id: u32, job: &BgJob) -> serde_json::Value {
    let (out_total, out_earliest) = ring_coords(&job.shared.stdout);
    let (err_total, err_earliest) = ring_coords(&job.shared.stderr);
    serde_json::json!({
        "id": id,
        "kind": job.kind,
        "label": job.label,
        "owner": job.owner,
        "status": job.status.as_str(),
        "startedAt": job.started_ms,
        "finishedAt": job.finished_ms,
        "exitCode": job.exit_code,
        "detail": job.detail,
        "stalled": job.status == JobStatus::Running
            && job.last_output_time.elapsed() > STALL_THRESHOLD,
        "output": {
            "stdout": { "total": out_total, "earliest": out_earliest },
            "stderr": { "total": err_total, "earliest": err_earliest },
            "spill": {
                "stdout": spill_json(job.shared.stdout.spill_path()),
                "stderr": spill_json(job.shared.stderr.spill_path()),
            }
        }
    })
}

fn history_projection(rec: &SettledRecord) -> serde_json::Value {
    serde_json::json!({
        "id": rec.id,
        "kind": rec.kind,
        "label": rec.label,
        "owner": rec.owner,
        "status": rec.status.as_str(),
        "startedAt": rec.started_ms,
        "finishedAt": rec.finished_ms,
        "exitCode": rec.exit_code,
        "detail": rec.detail,
        "stalled": false,
        "output": {
            "stdout": { "total": rec.stdout_total, "earliest": rec.stdout_tail_start },
            "stderr": { "total": rec.stderr_total, "earliest": rec.stderr_tail_start },
            "spill": {
                "stdout": spill_json(rec.stdout_spill.as_ref()),
                "stderr": spill_json(rec.stderr_spill.as_ref()),
            }
        }
    })
}

/// 名册：在役 + 已结算（含已归档历史）。纯读，不做任何消费。
pub(crate) fn job_list() -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    {
        let jobs = lock_or_recover(&BG_JOBS);
        for (id, job) in jobs.iter() {
            out.push(job_projection(*id, job));
        }
    }
    {
        let history = lock_or_recover(&SETTLED_HISTORY);
        for rec in history.iter() {
            out.push(history_projection(rec));
        }
    }
    out.sort_by_key(|v| v["id"].as_u64().unwrap_or(0));
    out
}

/// 从历史尾巴里按绝对偏移读（`tail_start` 之前的部分已丢失，如实标 lossy）。
fn read_tail(tail: &str, tail_start: u64, total: u64, from: u64) -> serde_json::Value {
    let lossy = from < tail_start;
    let (text, next) = if from >= total {
        (String::new(), total)
    } else if lossy {
        (tail.to_string(), total)
    } else {
        let skip = (from - tail_start) as usize;
        let bytes = tail.as_bytes();
        let mut start = skip.min(bytes.len());
        while start < bytes.len() && (bytes[start] & 0xC0) == 0x80 {
            start += 1;
        }
        (String::from_utf8_lossy(&bytes[start..]).into_owned(), total)
    };
    serde_json::json!({ "text": text, "next": next, "lossy": lossy })
}

/// 观测读取：从两个绝对偏移读各自新增的字节，不消费、不惊动模型。
pub(crate) fn job_read_at(id: u32, stdout_from: u64, stderr_from: u64) -> Result<String, String> {
    {
        let jobs = lock_or_recover(&BG_JOBS);
        if let Some(job) = jobs.get(&id) {
            let so = job.shared.stdout.read_from(stdout_from);
            let se = job.shared.stderr.read_from(stderr_from);
            return Ok(serde_json::json!({
                "stdout": { "text": so.text, "next": so.next, "lossy": so.lossy },
                "stderr": { "text": se.text, "next": se.next, "lossy": se.lossy },
                "total": { "stdout": so.total, "stderr": se.total },
                "earliest": { "stdout": so.earliest, "stderr": se.earliest },
            })
            .to_string());
        }
    }
    let history = lock_or_recover(&SETTLED_HISTORY);
    if let Some(rec) = history.iter().find(|r| r.id == id) {
        return Ok(serde_json::json!({
            "stdout": read_tail(&rec.stdout_tail, rec.stdout_tail_start, rec.stdout_total, stdout_from),
            "stderr": read_tail(&rec.stderr_tail, rec.stderr_tail_start, rec.stderr_total, stderr_from),
            "total": { "stdout": rec.stdout_total, "stderr": rec.stderr_total },
            "earliest": { "stdout": rec.stdout_tail_start, "stderr": rec.stderr_tail_start },
        })
        .to_string());
    }
    Err(format!("后台任务不存在: {id}"))
}
