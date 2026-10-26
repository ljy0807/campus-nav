#!/usr/bin/env bash
# 构建网页版：现有 C++ 业务代码 → WASM 单文件模块 + 内嵌数据 JS
# 用法：bash web/build_web.sh
# 产物：web/dist/campus_core.js（WASM 模块）、web/dist/data_campus.js（数据）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/web/dist"
mkdir -p "$DIST"

# 定位 emsdk：EMSDK / EMSDK_DIR 环境变量 > ~/emsdk > 明确报错（不再硬编码本机路径）
if [ -n "${EMSDK:-}" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
    SDK="$EMSDK"
elif [ -n "${EMSDK_DIR:-}" ] && [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    SDK="$EMSDK_DIR"
elif [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
    SDK="$HOME/emsdk"
else
    echo "未找到 emsdk：请设置 EMSDK（或 EMSDK_DIR）环境变量，或安装到 ~/emsdk；见 README.md 网页版章节" >&2
    exit 1
fi

# shellcheck disable=SC1091
source "$SDK/emsdk_env.sh" >/dev/null 2>&1

# -fwasm-exceptions：让 std::stoi 的异常可被 catch（parseTempId 依赖）
# SINGLE_FILE：wasm 内嵌进 JS，file:// 双击可直开（无 fetch）
# MAXIMUM_MEMORY=256MB：为移动端兜底的内存增长上限（数据量小，远低于上限；
#   防止开放式增长在低内存设备上被浏览器 OOM 杀掉）
em++ -O2 --bind -fwasm-exceptions \
    -s MODULARIZE=1 -s EXPORT_NAME=CampusNav \
    -s ENVIRONMENT=web,node -s SINGLE_FILE=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s MAXIMUM_MEMORY=268435456 \
    -I "$ROOT/include" \
    "$ROOT/web/bridge.cpp" \
    "$ROOT/src/app_state.cpp" "$ROOT/src/algorithm.cpp" "$ROOT/src/bike.cpp" \
    "$ROOT/src/csv_io.cpp" "$ROOT/src/graph.cpp" \
    "$ROOT/src/startup.cpp" \
    -o "$DIST/campus_core.js"

python3 "$ROOT/tools/gen_data_js.py"
bash "$ROOT/tools/web_source_hash.sh" > "$DIST/.source_sha256"
echo "构建完成：$DIST/campus_core.js ($(stat -c%s "$DIST/campus_core.js") 字节)"
