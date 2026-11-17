# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| Latest (桌面应用 1.0.x / 引擎 1.0.x) | :white_check_mark: |

Security patches will be released for the latest version.

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues.**

Use GitHub's private vulnerability reporting instead:

👉 **[Report a vulnerability](https://github.com/834063245-creator/LantaiAgent/security/advisories/new)**

Include:
- A clear description of the issue
- Steps to reproduce
- Affected versions
- Any potential mitigations you've identified

You should receive an acknowledgement within 48 hours. We will keep you updated on the progress and coordinate the disclosure timeline with you.

### Scope

Security-relevant areas of Lantai include:

1. **Agent tool execution** — The built-in Agent can execute shell commands and read/write files. Permission escalation bugs, sandbox escapes, or privilege bypasses in the tool guard layer (permission engine / sandbox / confined fs) are critical.
2. **Engine subprocess IPC** — The bundled Rust engine (`hologram-engine`) runs as a governed stdio MCP subprocess, driven by the frontend MCP bridge (`mcp-bridge.ts` → Rust `protocol_bridge.rs`); the shell only probes the binary path and never links engine crates. Injection vectors in MCP messages that could cause arbitrary code execution, or path/command smuggling that escapes the project boundary.
3. **Dynamic grammar loading** — `engine/grammars/*.dll` (tree-sitter Kotlin / Markdown / TOML) are loaded at runtime via `libloading`; supply-chain attacks via compromised grammar artifacts or release attachments.
4. **State and graph deserialization** — Malformed `.lantai/` state (sessions, boards, goals, permissions.json) parsed by the shell, or graph files under `.hologram/` parsed by the engine process, could trigger memory corruption or code execution in the respective native layer.
5. **LLM API keys & credentials** — API keys are stored in system-encrypted credential storage (Windows DPAPI / macOS Keychain / Linux secret-tool). Any vector that leaks these keys (including through the loopback LLM proxy or logs) is in scope.

### Out of Scope

- Prompt injection or jailbreaking the LLM — these are inherent to current LLM technology and not within our control.
- Phishing or social engineering attacks against users
- Denial of service through resource exhaustion (the app is a local tool)

## Security Best Practices for Users

- **API keys**: Store only through the app's credential store; never commit keys to the repository or `.env` files.
- **Agent permissions**: Run the Agent with the minimum necessary permissions. Review before approving shell execution (Ask cards), and keep an eye on the permission mode (Ask / Auto / Yolo).
- **Constraint gates (engine CLI only)**: `hologram.constraints.yaml` is consumed by the engine's `run_check`; the desktop app no longer reads it (in-app consumers were retired with the graph integration on 2026-09-09).
- **Project data**: Treat `.lantai/` (sessions, attachments, canvas, permissions) and `.hologram/` (engine index) as untrusted project data — do not open workspaces from sources you do not trust with full local privileges.