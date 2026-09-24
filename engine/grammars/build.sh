#!/usr/bin/env bash
# Build tree-sitter grammar shared libs for HoloGram dynamic loading.
# Usage: ./build.sh <language>
#        ./build.sh --all        # batch build from grammars.txt list
#
# Requires: git, gcc/g++
# Output:  grammars/tree-sitter-<lang>.so    (Linux)
#          grammars/tree-sitter-<lang>.dylib  (macOS)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
OUT_DIR="$SCRIPT_DIR"

# Detect platform: .so on Linux, .dylib on macOS
case "$(uname -s)" in
    Darwin) EXT="dylib" ;;
    *)      EXT="so" ;;
esac

build_grammar() {
    local lang="$1"
    local repo_url="https://github.com/tree-sitter-grammars/tree-sitter-$lang.git"
    local repo_dir="$BUILD_DIR/tree-sitter-$lang"
    local out_name="tree-sitter-$lang.$EXT"
    local out_path="$OUT_DIR/$out_name"

    echo -e "\033[36m=== Building $lang ===\033[0m"

    if [ ! -d "$repo_dir" ]; then
        echo "  cloning $repo_url ..."
        git clone --depth 1 "$repo_url" "$repo_dir" 2>&1 | tail -1
    fi

    local parser_c
    # ⚠ markdown 是 monorepo，里面有**两个**语法：block（tree-sitter-markdown/）
    # 与 inline（tree-sitter-markdown-inline/）。两者导出符号不同名
    # （tree_sitter_markdown vs tree_sitter_markdown_inline），而本脚本产出的文件名
    # 一律是 tree-sitter-markdown.<ext>，引擎按文基名找符号
    # （grammar_loader：`tree_sitter_{grammar}`）——选中 inline 就等于发一个
    # **永远加载不上**的语法库，且只留一行日志、不报错。
    # 而 `find | head -1` 选谁全看目录遍历顺序（2026-09-24 实测：同一份脚本
    # ubuntu 腿选到 inline、macOS 腿选到 block；ext4 的 hashed dir 顺序本就不保证），
    # 故 markdown 钉死在 block（与 build.ps1、仓库里那份 tree-sitter-markdown.dll 同源）。
    case "$lang" in
        markdown) parser_c="$repo_dir/tree-sitter-markdown/src/parser.c" ;;
        *)        parser_c=$(find "$repo_dir" -name "parser.c" -type f | head -1) ;;
    esac
    if [ ! -f "$parser_c" ]; then
        echo -e "\033[31m  ERROR: no parser.c found in $repo_dir\033[0m"
        return 1
    fi

    local src_dir
    src_dir="$(dirname "$parser_c")"
    local src_files=("$parser_c")
    [ -f "$src_dir/scanner.c" ]  && src_files+=("$src_dir/scanner.c")
    [ -f "$src_dir/scanner.cc" ] && src_files+=("$src_dir/scanner.cc")

    local gcc_args=(
        -shared -o "$out_path"
        -I "$src_dir"
        -fPIC -O2
        "${src_files[@]}"
    )

    # markdown 的 C++ scanner 需要这个 flag（见本脚本头部注释与 build.ps1）。
    # 纯 C 的 kotlin / toml 不受影响，只出 unused-function 警告。
    if [ "$lang" = "markdown" ]; then
        gcc_args+=(-DTREE_SITTER_MARKDOWN_AVOID_CRASH)
    fi

    echo "  gcc ${gcc_args[*]}"
    gcc "${gcc_args[@]}"

    local size_kb
    size_kb=$(du -k "$out_path" | cut -f1)
    echo -e "\033[32m  OK -> $out_name (${size_kb} KB)\033[0m"
}

if [ "${1:-}" = "--all" ]; then
    list_file="$SCRIPT_DIR/grammars.txt"
    if [ ! -f "$list_file" ]; then
        echo "No grammars.txt found." >&2
        exit 1
    fi
    while IFS= read -r line; do
        line="$(echo "$line" | sed 's/#.*//' | xargs)"
        [ -n "$line" ] && build_grammar "$line"
    done < "$list_file"
elif [ -n "${1:-}" ]; then
    build_grammar "$1"
else
    echo "Usage:"
    echo "  ./build.sh kotlin       # build one grammar"
    echo "  ./build.sh --all         # batch build from grammars.txt"
    echo ""
    echo "Requires: git, gcc"
    echo "Output:   grammars/tree-sitter-<lang>.$EXT"
fi
