#!/bin/bash
# ============================================================
# 容器健康探针（Dockerfile HEALTHCHECK 调用）。
#
# 判定语义：**只要 3080 在监听就算健康**，不看 HTTP 状态码。
#   - DSH Web UI（3081）与桥接 API（3082）都要求认证，裸请求一律 401；
#     按状态码判定会让探针永远失败（FailingStreak 曾累积到 132）。
#   - 只有"连不上"（curl 退出非 0）才是真的挂了。
#
# ⚠️ 升级豁免（2026-09-27 二次踩坑）：
#   「一键更新」会在容器内跑 npm install（522 包 / 低功耗 ARM 约 10 分钟）。
#   期间 CPU 被吃满，3080 可能连续数分钟无法及时响应 —— 容器被标 unhealthy
#   → Supervisor watchdog 重启容器 → **npm install 被杀** → 留下半截 vendor.tmp，
#   更新永远失败（用户侧表现为"点了更新，结果版本没变甚至服务挂了"）。
#   现在：只要 /data/dsh/.installing 存在且未过期，探针直接放行，
#   让升级跑完；标记由 api_server.js 在安装结束时清除。
# ============================================================

INSTALL_FLAG="${DSH_INSTALL_FLAG:-/data/dsh/.installing}"
# 标记最长有效 30 分钟：超过即视为陈旧标记（安装进程已死），不再豁免，
# 避免一次失败残留把 watchdog 永久关掉。
MAX_FLAG_AGE_SEC=1800

if [ -f "${INSTALL_FLAG}" ]; then
    age=$(( $(date +%s) - $(stat -c %Y "${INSTALL_FLAG}" 2>/dev/null || echo 0) ))
    if [ "${age}" -lt "${MAX_FLAG_AGE_SEC}" ]; then
        echo "DSH update in progress (${age}s) - health check skipped"
        exit 0
    fi
    echo "stale install flag (${age}s) - ignoring"
fi

PROBE_URL="${DSH_HEALTHCHECK_URL:-http://127.0.0.1:3080/}"

if curl -s -o /dev/null --connect-timeout 10 "${PROBE_URL}"; then
    exit 0
fi
# curl 对 401/302/200 都返回 0；非 0 表示连不上（000）。
# 用 --connect-timeout 判"监听"而非要求 2xx，见上。
exit 1