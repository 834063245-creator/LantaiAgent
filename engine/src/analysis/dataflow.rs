// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use hologram_graph::Graph;
use hologram_storage::MemoryIndex;
use crate::analysis::detect_cycles;
use crate::analysis::detect_cycles_from_index;
use serde_json::json;

/// 从 Tarjan SCC 分类循环：pure_code、data_persistent、llm_involved。
pub fn classify_cycles(graph: &Graph) -> serde_json::Value {
    classify_cycles_inner(graph.nodes_iter(), &detect_cycles(graph))
}

pub fn classify_cycles_from_index(idx: &MemoryIndex) -> serde_json::Value {
    let raw_cycles = detect_cycles_from_index(idx);
    let nodes: Vec<(&str, &hologram_graph::Node)> = idx.nodes_iter().map(|n| (n.id.as_str(), n)).collect();
    classify_cycles_inner(nodes.into_iter(), &raw_cycles)
}

fn classify_cycles_inner<'a>(
    nodes: impl Iterator<Item = (&'a str, &'a hologram_graph::Node)>,
    raw_cycles: &[serde_json::Value],
) -> serde_json::Value {
    let node_map: std::collections::HashMap<&str, &hologram_graph::Node> = nodes.collect();
    let mut pure = 0; let mut data = 0; let mut llm = 0;
    let annotated: Vec<_> = raw_cycles.iter().map(|c| {
        let node_ids: Vec<&str> = c["nodes"].as_array().map(|a|
            a.iter().filter_map(|v| v.as_str()).collect()
        ).unwrap_or_default();
        let has_medium = node_ids.iter().any(|id|
            node_map.get(id).map(|n| matches!(n.kind, hologram_graph::NodeKind::Medium)).unwrap_or(false));
        let has_llm = node_ids.iter().any(|id|
            node_map.get(id).and_then(|n| n.properties.get("llm")).is_some());
        let category = if has_llm { "llm_involved" } else if has_medium { "data_persistent" } else { "pure_code" };
        if has_llm { llm += 1; } else if has_medium { data += 1; } else { pure += 1; }
        serde_json::json!({
            "nodes": node_ids,
            "size": c["size"],
            "category": category,
        })
    }).collect();
    json!({ "total": annotated.len(), "pure_code": pure, "data_persistent": data,
        "llm_involved": llm, "cycles": annotated })
}

#[cfg(test)]
mod tests {
    use hologram_graph::{Edge, EdgeKind, Node, NodeKind};
    use super::*;

    #[test]
    fn test_classify_empty() {
        let g = Graph::new();
        let r = classify_cycles(&g);
        assert_eq!(r["total"], 0);
        assert_eq!(r["pure_code"], 0);
        assert_eq!(r["data_persistent"], 0);
    }

    #[test]
    fn test_classify_pure_code_cycle() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        g.add_edge_unchecked(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e2", "b", "a", EdgeKind::Calls));

        let r = classify_cycles(&g);
        assert_eq!(r["total"], 1);
        assert_eq!(r["pure_code"], 1);
        assert_eq!(r["data_persistent"], 0);
    }

    #[test]
    fn test_classify_data_cycle_with_medium() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("m", "db", NodeKind::Medium));
        g.add_edge_unchecked(Edge::new("e1", "a", "m", EdgeKind::Writes));
        g.add_edge_unchecked(Edge::new("e2", "m", "a", EdgeKind::Reads));

        let r = classify_cycles(&g);
        assert_eq!(r["total"], 1);
        assert_eq!(r["data_persistent"], 1);
        assert_eq!(r["pure_code"], 0);
    }
}
