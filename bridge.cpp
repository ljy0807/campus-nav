// WASM 桥层：把现有 C++ 业务代码（src/ 全部逻辑）暴露给网页前端。
// 本文件不包含任何业务逻辑，只做「参数校验 + 调用现有函数 + JSON 序列化」。
// 编译时不链接 main.cpp / menu.cpp，故与 main.cpp 相同职责的全局定义在此。
#include "common.h"
#include "graph.h"
#include "algorithm.h"
#include "app_state.h"
#include "bike.h"
#include "csv_io.h"
#include "startup.h"

#include <emscripten/bind.h>

#include <cstdio>
#include <functional>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

// 全局状态定义统一在 src/app_state.cpp；此处只保留桥层自己的 UI 状态。
// 当前 bikes 是否处于“完整载入”状态（>0 行且无跳过/归一化）。
// 用于 status/后续提示；导入不再据此触发跨表 GC（D7）。
static bool gBikesLoadOk = false;

// 最近一次成功载入/导入的源文本：web_save 的 .pre-save.bak 必须来自它，
// 而不是保存目标 scratch 文件（save_bikes.csv）的历史内容。
static std::string gBikesSourceCsv;
static std::string gTempsSourceCsv;

// 网页世界修订号：每次借还车/临时节点增删/导入/修复 +1。
// save 返回快照修订号；markSaved(rev) 只在世界未变化时清脏，避免
// “保存快照后自动演示又改数据，却把脏标记清零”的竞态（P1-N1）。
static int gWorldRevision = 0;

namespace {

// JSON 字符串转义（保留 UTF-8 原文，只转义控制字符与引号/反斜杠）
std::string jsonStr(const std::string& s) {
    std::string o = "\"";
    for (unsigned char c : s) {
        switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n";  break;
            case '\r': o += "\\r";  break;
            case '\t': o += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    o += buf;
                } else {
                    o += static_cast<char>(c);
                }
        }
    }
    o += "\"";
    return o;
}

std::string errJson(const std::string& msg) {
    return "{\"ok\":false,\"error\":" + jsonStr(msg) + "}";
}

// 统一显示名：临时节点显示 T{k}，固定节点显示节点名。
// 避免内部名（graph.cpp 中的 "Temp Parking T{k}"）泄漏到前端提示/接口数据里。
std::string displayName(const Node& n) {
    return n.isTemp ? formatTempId(n.id) : n.name;
}

// validLatLon 统一由 common.h 提供（加载器/图修改入口/桥层共用同一约束）

// 导入文本硬上限由 csv_io.cpp 的 csvWithinLimits 统一提供（与读取侧同口径）。
// 桥层保留独立调用：直接调 Api.importBikes 可绕过前端，百万逗号会在 splitCSV
// 中放大成数百万 std::string，足以拖垮 256MB WASM 堆。

// 网页端单车渲染上限：列表/marker 一次性渲染，2,000 辆是当前实测可接受规模；
// 不是 CSV 格式上限（CSV 仍允许 10,000 行）。桥层作为 API 边界必须独立兜底。
constexpr size_t WEB_MAX_BIKES = 2000;
constexpr size_t WEB_MAX_TEMPS = 1000;

constexpr const char* BIKES_CSV_HEADER = "bike_id,status,node_id,lat,lon";
constexpr const char* TEMPS_CSV_HEADER = "temp_id,lat,lon,linked_parking";

// 统计 CSV 非空数据行：仅当首个非空行与表头逐字匹配时才跳过表头；
// 尾换行与空行不额外计数。调用前应已通过 csvWithinLimits（导入路径），
// 因此这里只需处理 LF/CRLF；CR-only 会在限额检查阶段被拒。
size_t csvDataRows(const std::string& csv, const char* header) {
    size_t rows = 0;
    bool firstNonEmpty = true;
    size_t pos = 0;
    while (pos < csv.size()) {
        size_t end = csv.find('\n', pos);
        if (end == std::string::npos) end = csv.size();
        std::string line = csv.substr(pos, end - pos);
        if (!line.empty() && line.back() == '\r') line.pop_back(); // CRLF 行尾
        // 首个非空行若是 UTF-8 BOM + 表头，BOM 不是数据；否则 2000 行合法文件
        // 在网页端会被误算成 2001 行并拒绝。
        if (firstNonEmpty && line.size() >= 3 &&
            static_cast<unsigned char>(line[0]) == 0xEF &&
            static_cast<unsigned char>(line[1]) == 0xBB &&
            static_cast<unsigned char>(line[2]) == 0xBF) {
            line.erase(0, 3);
        }
        if (!line.empty()) {
            if (firstNonEmpty) {
                firstNonEmpty = false;
                if (line != header) ++rows;
            } else {
                ++rows;
            }
        }
        if (end == csv.size()) break;
        pos = end + 1;
    }
    return rows;
}

bool webBikesWithinLimit(const std::string& csv, std::string& err) {
    if (csvDataRows(csv, BIKES_CSV_HEADER) <= WEB_MAX_BIKES) return true;
    err = "导入失败：网页端最多支持 " + std::to_string(WEB_MAX_BIKES) +
          " 辆单车，请拆分后导入或使用控制台";
    return false;
}

bool webTempsWithinLimit(const std::string& csv, std::string& err) {
    if (csvDataRows(csv, TEMPS_CSV_HEADER) <= WEB_MAX_TEMPS) return true;
    err = "导入失败：网页端最多支持 " + std::to_string(WEB_MAX_TEMPS) +
          " 个临时节点，请拆分后导入或使用控制台";
    return false;
}

bool writeFileRaw(const char* path, const std::string& content) {
    FILE* f = std::fopen(path, "wb");
    if (!f) return false;
    const size_t wrote = std::fwrite(content.data(), 1, content.size(), f);
    // 先无条件关闭再判定：短写时也必须 fclose（原 && 短路会漏关文件泄漏 FILE*）
    const bool wroteAll = (wrote == content.size());
    const bool closeOk = (std::fclose(f) == 0);
    return wroteAll && closeOk;
}

bool readFileRaw(const char* path, std::string& out) {
    FILE* f = std::fopen(path, "rb");
    if (!f) return false;
    out.clear();
    char buf[4096];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) out.append(buf, n);
    const bool ok = (std::ferror(f) == 0);
    std::fclose(f);
    return ok;
}

// 逐段方位与距离（与 printHopDirections 同一套口径），输出 JSON 数组字段
void appendSegments(std::ostringstream& os, const std::vector<int>& path) {
    os << "\"segments\":[";
    bool first = true;
    for (size_t k = 0; k + 1 < path.size(); ++k) {
        int a = path[k], b = path[k + 1];
        int ai = findNodeById(g, a), bi = findNodeById(g, b);
        if (ai < 0 || bi < 0) continue;
        const SegmentInfo seg = describeSegment(g, a, b);
        if (!first) os << ",";
        first = false;
        os << "{\"fromId\":" << a << ",\"fromName\":" << jsonStr(displayName(g.nodes[ai]))
           << ",\"toId\":" << b << ",\"toName\":" << jsonStr(displayName(g.nodes[bi]))
           << ",\"anomalous\":" << (seg.anomalous ? "true" : "false")
           << ",\"meters\":" << seg.meters << ",\"deg\":" << seg.deg
           << ",\"compass\":" << jsonStr(seg.compass) << "}";
    }
    os << "]";
}

void appendPathIds(std::ostringstream& os, const std::vector<int>& path) {
    os << "\"path\":[";
    for (size_t i = 0; i < path.size(); ++i) {
        if (i) os << ",";
        os << path[i];
    }
    os << "]";
}

void appendNames(std::ostringstream& os, const std::vector<int>& path) {
    os << "\"names\":[";
    for (size_t i = 0; i < path.size(); ++i) {
        int idx = findNodeById(g, path[i]);
        if (i) os << ",";
        os << jsonStr(idx >= 0 ? displayName(g.nodes[idx]) : std::string("(不存在)"));
    }
    os << "]";
}

std::string pathResult(bool ok, const std::string& err, double d,
                       const std::vector<int>& path) {
    if (!ok) return errJson(err);
    std::ostringstream os;
    os << std::setprecision(10);
    // 注意：此处 hops 为路径节点数（与控制台展示口径一致）；minHops API 的 hops 为边数。
    os << "{\"ok\":true,\"dist\":" << d
       << ",\"hops\":" << (path.empty() ? 0 : static_cast<int>(path.size())) << ",";
    appendPathIds(os, path);
    os << ",";
    appendNames(os, path);
    os << ",";
    appendSegments(os, path);
    os << "}";
    return os.str();
}

// 严格整数解析（拒绝前缀解析，如 "12abc"）
bool strictInt(const std::string& tok, int& out) {
    try {
        size_t pos = 0;
        int v = std::stoi(tok, &pos);
        if (pos != tok.size()) return false;
        out = v;
        return true;
    } catch (...) {
        return false;
    }
}

}  // namespace

// ---------- 数据加载（镜像 main.cpp 的启动顺序） ----------
std::string web_load(const std::string& nodesCsv, const std::string& edgesCsv,
                     const std::string& bikesCsv, const std::string& tempsCsv) {
    // 入口级预算：四个字符串来自外部/嵌入式数据，先验后写 MEMFS。
    // 这里只设整文件字节上限，不套 import 的逐行严格口径：启动管线允许
    // “某份文件损坏后部分载入并封锁保存”（tempsLoadFailed），若在入口按
    // CR/列数直接整批拒绝，会改变这条既有契约。内存放大由 10MB 上限兜住。
    if (nodesCsv.size() > MAX_CSV_BYTES || edgesCsv.size() > MAX_CSV_BYTES ||
        bikesCsv.size() > MAX_CSV_BYTES || tempsCsv.size() > MAX_CSV_BYTES) {
        return errJson("载入失败：CSV 文件超过 10MB 上限");
    }
    std::string limitErr;
    if (!webBikesWithinLimit(bikesCsv, limitErr)) return errJson(limitErr);
    if (!webTempsWithinLimit(tempsCsv, limitErr)) return errJson(limitErr);

    // 失败时恢复加载前的完整状态，避免留下“半加载”（如只有节点没有边）导致后续查询误报
    const Graph gBackup = g;
    const std::vector<Bike> bikesBackup = bikes;
    const std::vector<TempNode> tempsBackup = tempNodes;
    const bool bikesDirtyBackup = bikesDirty;
    const bool tempsDirtyBackup = tempsDirty;
    const bool tempsLoadFailedBackup = tempsLoadFailed;
    const int nodesSkippedBackup = nodesLoadSkipped;
    const int edgesSkippedBackup = edgesLoadSkipped;
    const int bikesSkippedBackup = bikesLoadSkipped;
    const int tempsSkippedBackup = tempsLoadSkipped;
    const int revisionBackup = gWorldRevision;
    const std::string bikesSourceBackup = gBikesSourceCsv;
    const std::string tempsSourceBackup = gTempsSourceCsv;
    const auto rollback = [&]() {
        g = gBackup;
        bikes = bikesBackup;
        tempNodes = tempsBackup;
        bikesDirty = bikesDirtyBackup;
        tempsDirty = tempsDirtyBackup;
        tempsLoadFailed = tempsLoadFailedBackup;
        nodesLoadSkipped = nodesSkippedBackup;
        edgesLoadSkipped = edgesSkippedBackup;
        bikesLoadSkipped = bikesSkippedBackup;
        tempsLoadSkipped = tempsSkippedBackup;
        gWorldRevision = revisionBackup;
        gBikesSourceCsv = bikesSourceBackup;
        gTempsSourceCsv = tempsSourceBackup;
        // g 是"同尺寸原地换内容"，图指纹已能识别（见 ensureFloyd）；
        // 这里显式失效作为双保险，不依赖缓存探测能力
        // （回滚后仍用回滚前矩阵属于严重正确性事故，两处防线的成本都可忽略）
        invalidateFloyd();
    };

    // 允许重复加载：先整体复位（与 runStartup 共用同一份清空语义）
    resetWorldState();
    gWorldRevision = 0;  // 新世界从修订号 0 开始

    if (!writeFileRaw("nodes.csv", nodesCsv) || !writeFileRaw("edges.csv", edgesCsv) ||
        !writeFileRaw("bikes.csv", bikesCsv) || !writeFileRaw("temps.csv", tempsCsv)) {
        rollback();
        return errJson("写入内存文件系统失败");
    }
    // 复用控制台同一条启动管线（startup.cpp），不再在桥层复制加载顺序：
    // 之后任何加载/修复顺序调整只改 runStartup 一处。
    StartupStats stats;
    if (!runStartup(".", &stats)) {
        rollback();
        return errJson("节点或边文件为空或无法解析");
    }
    gBikesLoadOk = stats.bikesLoadOk;
    gBikesSourceCsv = bikesCsv;
    gTempsSourceCsv = tempsCsv;

    std::ostringstream os;
    os << "{\"ok\":true,\"nodes\":" << stats.nodes
       << ",\"edges\":" << stats.edges
       << ",\"bikes\":" << stats.bikes
       << ",\"temps\":" << stats.temps
       << ",\"fixed\":" << stats.fixed << ",\"gc\":" << stats.gc
       << ",\"bikesLoadOk\":" << (stats.bikesLoadOk ? "true" : "false")
       << ",\"tempsLoadOk\":" << (stats.tempsLoadOk ? "true" : "false")
       << ",\"nodesSkipped\":" << nodesLoadSkipped
       << ",\"edgesSkipped\":" << edgesLoadSkipped
       << ",\"bikesSkipped\":" << bikesLoadSkipped
       << ",\"tempsSkipped\":" << tempsLoadSkipped
       << ",\"graphNodes\":" << g.nodes.size() << "}";
    return os.str();
}

// ---------- 图数据（渲染用） ----------
std::string web_getGraph() {
    std::ostringstream os;
    os << std::setprecision(10);
    os << "{\"nodes\":[";
    for (size_t i = 0; i < g.nodes.size(); ++i) {
        const Node& n = g.nodes[i];
        if (i) os << ",";
        os << "{\"id\":" << n.id << ",\"name\":" << jsonStr(displayName(n))
           << ",\"type\":" << jsonStr(n.type) << ",\"lat\":" << n.lat
           << ",\"lon\":" << n.lon << ",\"radius\":" << n.radius
           << ",\"isTemp\":" << (n.isTemp ? "true" : "false") << "}";
    }
    os << "],\"edges\":[";
    bool first = true;
    // 防御：adj 行数应等于 nodes 数（行数缺失时跳过越界行，与算法层 A2 同思路）
    for (size_t u = 0; u < g.adj.size() && u < g.nodes.size(); ++u) {
        int a = g.nodes[u].id;
        std::vector<double> selfWeights;  // 自环在 adj 里成对出现：同权重只输出一次
        for (const Edge& e : g.adj[u]) {
            // 无向边去重：只保留 id 较小的一侧；自环（to == a）例外，必须可见
            if (e.to < a) continue;
            if (e.to == a) {
                bool duplicate = false;
                for (double w : selfWeights) {
                    if (w == e.weight) { duplicate = true; break; }
                }
                if (duplicate) continue;
                selfWeights.push_back(e.weight);
            }
            if (!first) os << ",";
            first = false;
            os << "{\"from\":" << a << ",\"to\":" << e.to
               << ",\"weight\":" << e.weight << "}";
        }
    }
    os << "]}";
    return os.str();
}

// ---------- 单车 / 临时节点列表 ----------
std::string web_getBikes() {
    std::ostringstream os;
    os << std::setprecision(10);
    os << "{\"bikes\":[";
    for (size_t i = 0; i < bikes.size(); ++i) {
        const Bike& b = bikes[i];
        if (i) os << ",";
        os << "{\"bikeId\":" << jsonStr(b.bikeId) << ",\"status\":" << jsonStr(b.status)
           << ",\"nodeId\":" << b.nodeId << ",\"lat\":" << b.lat
           << ",\"lon\":" << b.lon << "}";
    }
    os << "],\"dirty\":" << (bikesDirty ? "true" : "false") << "}";
    return os.str();
}

std::string web_getTemps() {
    std::ostringstream os;
    os << std::setprecision(10);
    os << "{\"temps\":[";
    for (size_t i = 0; i < tempNodes.size(); ++i) {
        const TempNode& t = tempNodes[i];
        if (i) os << ",";
        os << "{\"nodeId\":" << t.nodeId << ",\"lat\":" << t.lat
           << ",\"lon\":" << t.lon << ",\"linkedParking\":" << t.linkedParking
           << ",\"displayId\":" << jsonStr(formatTempId(t.nodeId)) << "}";
    }
    os << "],\"dirty\":" << (tempsDirty ? "true" : "false") << "}";
    return os.str();
}

// 一次调用返回图/单车/临时节点/状态：首屏与每次刷新少 3 次 WASM 边界与 JSON 解析。
// 各子对象复用现有函数，字段语义与单独 API 完全一致。
std::string web_status();

std::string web_snapshot() {
    return "{\"ok\":true,\"graph\":" + web_getGraph() +
           ",\"bikes\":" + web_getBikes() +
           ",\"temps\":" + web_getTemps() +
           ",\"status\":" + web_status() + "}";
}

std::string web_status() {
    std::ostringstream os;
    os << "{\"bikesDirty\":" << (bikesDirty ? "true" : "false")
       << ",\"tempsDirty\":" << (tempsDirty ? "true" : "false")
       << ",\"bikesLoadOk\":" << (gBikesLoadOk ? "true" : "false")
       << ",\"nodesSkipped\":" << nodesLoadSkipped
       << ",\"edgesSkipped\":" << edgesLoadSkipped
       << ",\"bikesSkipped\":" << bikesLoadSkipped
       << ",\"tempsSkipped\":" << tempsLoadSkipped
       << ",\"bikes\":" << bikes.size()
       << ",\"temps\":" << tempNodes.size()
       << ",\"nodes\":" << g.nodes.size()
       << ",\"revision\":" << gWorldRevision << "}";
    return os.str();
}

// ---------- 节点检索 ----------
std::string web_nearestNode(double lat, double lon) {
    if (!validLatLon(lat, lon)) return errJson("坐标非法");
    if (!usableLatLon(lat, lon)) return errJson("坐标非法：(0,0) 或含 0 表示无位置");
    double best = 0.0;
    const int id = findNearestNode(g, lat, lon, &best);  // 检索逻辑下沉 algorithm.cpp
    if (id == 0) return errJson("图为空");
    const int idx = findNodeById(g, id);
    std::ostringstream os;
    os << std::setprecision(10);
    os << "{\"ok\":true,\"id\":" << id << ",\"dist\":" << best
       << ",\"name\":" << jsonStr(idx >= 0 ? displayName(g.nodes[idx]) : "") << "}";
    return os.str();
}

// ---------- 路径查询 ----------
std::string web_shortestPath(int from, int to) {
    if (findNodeById(g, from) < 0 || findNodeById(g, to) < 0)
        return errJson("节点不存在");
    std::vector<int> path;
    double d = dijkstra(g, from, to, path);
    if (d < 0) return errJson("两点之间不可达");
    return pathResult(true, "", d, path);
}

std::string web_multiStep(const std::string& idsCsv) {
    std::vector<int> stops;
    std::istringstream is(idsCsv);
    std::string tok;
    while (std::getline(is, tok, ',')) {
        if (tok.empty()) continue;
        int v = 0;
        if (!strictInt(tok, v)) return errJson("站点列表包含非法编号");
        stops.push_back(v);
    }
    if (stops.size() < 2) return errJson("多段导航至少需要 2 个节点");
    if (stops.size() > 100) return errJson("站点数量需在 2 ~ 100 之间");
    for (int id : stops) {
        if (findNodeById(g, id) < 0)
            return errJson("站点 " + std::to_string(id) + " 不存在");
    }
    std::vector<int> full;
    double total = 0.0;
    for (size_t i = 0; i + 1 < stops.size(); ++i) {
        std::vector<int> leg;
        double d = dijkstra(g, stops[i], stops[i + 1], leg);
        if (d < 0)
            return errJson("第 " + std::to_string(i + 1) + " 段不可达（" +
                           std::to_string(stops[i]) + " → " +
                           std::to_string(stops[i + 1]) + "）");
        total += d;
        if (i == 0) {
            full = leg;
        } else if (!leg.empty()) {
            full.insert(full.end(), leg.begin() + 1, leg.end());
        }
    }
    return pathResult(true, "", total, full);
}

// 三条推荐路线（Yen K 短路）：业务逻辑在 src/algorithm.cpp 的 kShortestPaths，
// 本函数只做参数校验与 JSON 组装（与 pathResult 同口径：hops 为路径节点数）。
std::string web_topPaths(int from, int to, int k) {
    if (k < 1 || k > 10) return errJson("k 需在 1 ~ 10 之间");
    if (findNodeById(g, from) < 0) return errJson("起点不存在");
    if (findNodeById(g, to) < 0) return errJson("终点不存在");
    std::vector<std::vector<int>> paths;
    std::vector<double> dists;
    const int n = kShortestPaths(g, from, to, k, paths, dists);
    if (n <= 0) return errJson("两点之间不可达");
    std::ostringstream os;
    os << std::setprecision(10);
    os << "{\"ok\":true,\"count\":" << n << ",\"routes\":[";
    for (int i = 0; i < n; ++i) {
        if (i) os << ",";
        os << "{\"dist\":" << dists[i]
           << ",\"hops\":" << static_cast<int>(paths[i].size()) << ",";
        appendPathIds(os, paths[i]);
        os << ",";
        appendNames(os, paths[i]);
        os << ",";
        appendSegments(os, paths[i]);
        os << "}";
    }
    os << "]}";
    return os.str();
}

std::string web_minHops(int from, int to) {
    // 与 shortestPath 同口径：节点存在性单独归类，桥层不把两类失败合并成一条含混文案
    if (findNodeById(g, from) < 0 || findNodeById(g, to) < 0)
        return errJson("节点不存在");
    std::vector<int> path;
    int hops = bfsMinHops(g, from, to, &path);
    if (hops < 0) return errJson("两点之间不可达");
    std::ostringstream os;
    os << std::setprecision(10);
    os << "{\"ok\":true,\"hops\":" << hops << ",";
    appendPathIds(os, path);
    os << ",";
    appendNames(os, path);
    os << "}";
    return os.str();
}

// 最短路径逐步演示：复用 algorithm.cpp 的 dijkstraTrace（同算法、同确定顺序），
// 桥层只做 JSON 序列化，不再维护第二份 Dijkstra。
std::string web_dijkstraTrace(int from, int to) {
    if (findNodeById(g, from) < 0 || findNodeById(g, to) < 0) return errJson("节点不存在");
    std::vector<int> path;
    std::vector<DijkstraStep> trace;
    const double d = dijkstraTrace(g, from, to, path, &trace);
    if (d < 0) return errJson("两点之间不可达");
    std::ostringstream os;
    os << std::setprecision(10);
    os << "{\"ok\":true,\"order\":[";
    for (size_t i = 0; i < trace.size(); ++i) {
        if (i) os << ",";
        const Node& n = g.nodes[trace[i].idx];
        os << "{\"id\":" << n.id
           << ",\"name\":" << jsonStr(displayName(n))
           << ",\"dist\":" << trace[i].dist << "}";
    }
    os << "],\"count\":" << trace.size() << ",\"dist\":" << d << "}";
    return os.str();
}

std::string web_nearestParking(double lat, double lon) {
    if (!validLatLon(lat, lon)) return errJson("坐标非法");
    if (!usableLatLon(lat, lon)) return errJson("坐标非法：(0,0) 或含 0 表示无位置");
    double d = 0.0;
    int pid = findNearestParking(g, lat, lon, d);
    if (pid < 0) return errJson("没有可用停车场");
    int idx = findNodeById(g, pid);
    std::ostringstream os;
    os << std::setprecision(10);
    os << "{\"ok\":true,\"parkingId\":" << pid << ",\"dist\":" << d
       << ",\"name\":" << jsonStr(idx >= 0 ? g.nodes[idx].name : "") << "}";
    return os.str();
}

// ---------- 借车 / 还车 ----------
std::string web_borrow(const std::string& bikeId) {
    Bike* b = findBikeById(bikes, bikeId);
    if (!b) return errJson("借车失败：车辆 " + bikeId + " 不存在");
    if (b->status != "available") return errJson("该车当前不可借。");
    if (b->nodeId == 0)
        return errJson("该车位置信息缺失（异常数据），无法借出");
    std::string where = "未知位置";
    int idx = findNodeById(g, b->nodeId);
    if (idx >= 0) where = displayName(g.nodes[idx]);
    if (!borrowBike(g, bikes, tempNodes, bikeId)) return errJson("借车失败。");
    ++gWorldRevision;
    return "{\"ok\":true,\"msg\":" +
           jsonStr("借车成功：" + bikeId + "（原位置：" + where + "）") + "}";
}

std::string web_returnBike(const std::string& bikeId, double lat, double lon) {
    Bike* b = findBikeById(bikes, bikeId);
    if (!b) return errJson("还车失败：车辆 " + bikeId + " 不存在");
    if (b->status != "borrowed") return errJson("该车不在借出状态，无法归还。");
    if (!validLatLon(lat, lon))
        return errJson("坐标非法：纬度需在 [-90,90]、经度在 [-180,180]");
    if (!usableLatLon(lat, lon))
        return errJson("坐标非法：(0,0) 或含 0 表示无位置，不能作为还车点");  // 与 returnBike 同口径
    if (!returnBike(g, bikes, tempNodes, bikeId, lat, lon)) return errJson("还车失败。");
    ++gWorldRevision;

    Bike* rb = findBikeById(bikes, bikeId);
    const int nodeId = rb ? rb->nodeId : 0;
    std::ostringstream os;
    os << std::setprecision(10);
    if (nodeId > 0) {
        int idx = findNodeById(g, nodeId);
        // 距离取「实际归位停车场」到还车点的直线距离（与 returnPreview 同口径）；
        // 不能用 findNearestParking 的最近距离（可能不是同一个停车场）
        double d = idx >= 0 ? haversine(lat, lon, g.nodes[idx].lat, g.nodes[idx].lon) : 0.0;
        os << "{\"ok\":true,\"kind\":\"parking\",\"parkingId\":" << nodeId
           << ",\"name\":" << jsonStr(idx >= 0 ? g.nodes[idx].name : "")
           << ",\"dist\":" << d << ",\"msg\":"
           << jsonStr("还车成功：已归位到" + (idx >= 0 ? g.nodes[idx].name : std::string("停车场")))
           << "}";
    } else if (nodeId < 0) {
        os << "{\"ok\":true,\"kind\":\"temp\",\"tempId\":" << nodeId
           << ",\"displayId\":" << jsonStr(formatTempId(nodeId)) << ",\"msg\":"
           << jsonStr("还车成功：已停放至临时节点 " + formatTempId(nodeId)) << "}";
    } else {
        os << "{\"ok\":true,\"kind\":\"none\",\"msg\":" + jsonStr("还车成功") + "}";
    }
    return os.str();
}

// 还车预判：与 returnBike 的归位判定同源（findCoveringParking），供前端确认框使用，
// 避免前端自行按"最近停车场"计算而产生口径分叉。
std::string web_returnPreview(double lat, double lon) {
    if (!validLatLon(lat, lon)) return errJson("坐标非法");
    if (!usableLatLon(lat, lon)) return errJson("坐标非法：(0,0) 或含 0 表示无位置");  // 与 returnBike 同口径
    const int covering = findCoveringParking(g, lat, lon);
    std::ostringstream os;
    os << std::setprecision(10);
    if (covering > 0) {
        int cIdx = findNodeById(g, covering);
        double cd = cIdx >= 0 ? haversine(lat, lon, g.nodes[cIdx].lat, g.nodes[cIdx].lon) : 0.0;
        os << "{\"ok\":true,\"covered\":true,\"parkingId\":" << covering
           << ",\"name\":" << jsonStr(cIdx >= 0 ? g.nodes[cIdx].name : "")
           << ",\"dist\":" << cd
           // radius 返回生效半径（与 returnBike/returnPreview 判定同源：复用 effectiveRadius）
           << ",\"radius\":" << (cIdx >= 0 ? effectiveRadius(g.nodes[cIdx]) : PARK_RADIUS)
           << "}";
    } else {
        double d = 0.0;
        int nearest = findNearestParking(g, lat, lon, d);
        if (nearest < 0) return errJson("没有可用停车场");
        int nIdx = findNodeById(g, nearest);
        os << "{\"ok\":true,\"covered\":false,\"nearestParkingId\":" << nearest
           << ",\"name\":" << jsonStr(nIdx >= 0 ? g.nodes[nIdx].name : "")
           << ",\"dist\":" << d
           << ",\"radius\":"
           << (nIdx >= 0 ? effectiveRadius(g.nodes[nIdx]) : PARK_RADIUS)
           << "}";
    }
    return os.str();
}

// ---------- 临时节点管理 ----------
std::string web_addTemp(double lat, double lon, int linkedParking) {
    if (!validLatLon(lat, lon)) return errJson("参数非法：坐标无效");
    if (!usableLatLon(lat, lon)) return errJson("参数非法：(0,0) 或含 0 表示无位置");  // 与 addTempNode 同口径
    // 覆盖半径内不建临时节点：与控制台 interactiveAddTemp 同口径
    // （findCoveringParking 无覆盖返回 -1；该规则必须在桥层也复用，不能只在菜单层）
    const int covering = findCoveringParking(g, lat, lon);
    if (covering > 0) {
        const int ci = findNodeById(g, covering);
        return errJson("坐标在停车场 " +
                       (ci >= 0 ? displayName(g.nodes[ci]) : std::to_string(covering)) +
                       " 的覆盖半径内，还车会直接归位，无需添加临时节点");
    }
    // 同坐标复用：与控制台菜单「添加临时节点」口径一致，避免同一位置重出多份台账
    const int existing = findTempNodeAt(tempNodes, lat, lon);
    if (existing != 0) {
        std::ostringstream eos;
        eos << std::setprecision(10);
        eos << "{\"ok\":true,\"tempId\":" << existing
            << ",\"displayId\":" << jsonStr(formatTempId(existing)) << ",\"reused\":true,\"msg\":"
            << jsonStr("已复用同坐标临时节点 " + formatTempId(existing) +
                       "（节点 ID = " + std::to_string(existing) + "）")
            << "}";
        return eos.str();
    }
    // 图节点 + 台账由核心唯一入口一起写，桥层不再自己 push 台账
    const int t = addTempNodeRecorded(g, tempNodes, lat, lon, linkedParking, 0);
    if (t == 0) return errJson("添加失败：停车场不存在或参数非法");
    ++gWorldRevision;
    std::ostringstream os;
    os << std::setprecision(10);
    os << "{\"ok\":true,\"tempId\":" << t
       << ",\"displayId\":" << jsonStr(formatTempId(t)) << ",\"reused\":false,\"msg\":"
       << jsonStr("已创建临时节点 " + formatTempId(t)) << "}";
    return os.str();
}

std::string web_removeTemp(int nodeId) {
    // 检查规则下沉 bike.cpp（checkRemoveTempNode），与控制台菜单共用同一业务判定
    int cnt = 0;
    const int chk = checkRemoveTempNode(g, bikes, nodeId, &cnt);
    if (chk == 1) return errJson("只能删除临时节点");
    if (chk == 2) return errJson("临时节点不存在");
    if (chk == 3)
        return errJson("该临时节点上还有 " + std::to_string(cnt) +
                       " 辆车，删除被拒绝（请先借走可借车辆）");
    removeTempNodeRecorded(g, tempNodes, nodeId);
    ++gWorldRevision;
    return "{\"ok\":true,\"msg\":" +
           jsonStr("已删除临时节点 " + formatTempId(nodeId)) + "}";
}

// ---------- 导入 / 保存（MEMFS，前端负责下载/上传） ----------
std::string web_importBikes(const std::string& csv) {
    std::string limitErr;
    if (!csvWithinLimits(csv, &limitErr)) return errJson(limitErr);
    if (!webBikesWithinLimit(csv, limitErr)) return errJson(limitErr);
    const bool wasDirty = bikesDirty;  // 失败/取消时恢复导入前的脏标记，避免幻影未保存态
    const int wasSkipped = bikesLoadSkipped;
    if (!writeFileRaw("import_bikes.csv", csv)) return errJson("写入失败");
    std::vector<Bike> nb;
    int skipped = 0;
    int n = loadBikes("import_bikes.csv", nb, &g, &skipped);
    // n < 0（文件打不开）在 MEMFS 刚写入成功的前提下不可达，统一按取消导入处理
    if (n <= 0) {
        bikesDirty = wasDirty;
        bikesLoadSkipped = wasSkipped;  // 失败导入不得污染真实保存提示
        return errJson("单车文件为空或没有有效数据行，已取消导入");
    }
    bikes = std::move(nb);
    bikesDirty = true; // 导入的数据与磁盘初始数据不同，必须标记为未保存
    gBikesSourceCsv = csv;
    gBikesLoadOk = (n > 0 && skipped == 0);
    const int fixed = fixDanglingBikeRefs(bikes, tempNodes, g);
    if (fixed > 0) bikesDirty = true;
    // D7：导入单车只替换单车列表，不自动回收未被引用的临时节点。
    // 跨表 GC 会删除用户未预期的临时节点/图边；留给下次完整启动按全存档回收。
    ++gWorldRevision;
    std::ostringstream os;
    os << "{\"ok\":true,\"count\":" << bikes.size() << ",\"fixed\":" << fixed
       << ",\"skipped\":" << skipped << ",\"gc\":0}";
    return os.str();
}

// 回滚辅助（仅本文件用）：把备份的临时节点按原 id/坐标重新登记回图与台账。
// 返回 true 表示回滚完整；false 表示有节点未能重建（调用方应提示刷新页面重置数据）。
static bool restoreTempNodes(Graph& g, std::vector<TempNode>& tempNodes,
                             const std::vector<TempNode>& backup) {
    bool ok = true;
    for (const TempNode& t : backup) {
        const int id = addTempNodeRecorded(g, tempNodes, t.lat, t.lon, t.linkedParking, t.nodeId);
        if (id == 0) {
            std::cerr << "警告: 回滚临时节点失败: " << formatTempId(t.nodeId) << "\n";
            ok = false;
        }
    }
    return ok;
}

std::string web_importTemps(const std::string& csv) {
    // 先验后换（D1）：先在副本图上试载，成功才动真实图/台账——拒收路径零副作用，
    // 不再依赖"变更到一半再回滚"，消除回滚不完整窗口（对照 importBikes 的 n==0 拦截）
    std::string limitErr;
    if (!csvWithinLimits(csv, &limitErr)) return errJson(limitErr);
    if (!webTempsWithinLimit(csv, limitErr)) return errJson(limitErr);
    const bool wasDirty = tempsDirty;
    const bool wasLoadFailed = tempsLoadFailed;
    const int wasSkipped = tempsLoadSkipped;
    if (!writeFileRaw("import_temps.csv", csv)) return errJson("写入失败");
    {
        // 副本图先清掉现有临时节点：与真实图替换时的初始 id 空间一致，避免同 id 误判冲突
        Graph scratch = g;
        for (size_t i = 0; i < tempNodes.size(); ++i) removeTempNode(scratch, tempNodes[i].nodeId);
        std::vector<TempNode> probe;
        int probeSkipped = 0;
        const int probeN = loadTemps("import_temps.csv", probe, scratch, &probeSkipped);
        if (probeN < 0 || (probeN == 0 && probeSkipped > 0)) {
            // 预检失败：副本图上的 remove/addTempNode 会写全局脏标记，恢复为导入前的值；
            // 解析失败还会置 tempsLoadFailed，同样恢复（预检不得改变任何全局状态）
            tempsDirty = wasDirty;
            tempsLoadFailed = wasLoadFailed;
            tempsLoadSkipped = wasSkipped;
            return errJson(probeN < 0
                               ? "临时节点文件无法解析，已取消导入"
                               : "临时节点文件没有有效数据行（" +
                                     std::to_string(probeSkipped) + " 行异常），已取消导入");
        }
    }
    // 预检通过（同一文件、同一初始状态，重建必然成功；仍保留备份兜底极端异常）
    const std::vector<TempNode> backup = tempNodes;
    for (size_t i = 0; i < tempNodes.size(); ++i) removeTempNode(g, tempNodes[i].nodeId);
    tempNodes.clear();
    int skipped = 0;
    int n = loadTemps("import_temps.csv", tempNodes, g, &skipped);
    if (n < 0 || (n == 0 && skipped > 0)) {
        const bool rolledBack = restoreTempNodes(g, tempNodes, backup);
        tempsDirty = wasDirty;
        tempsLoadFailed = wasLoadFailed;  // 回滚旧世界：解析失败置位的封锁一并恢复
        tempsLoadSkipped = wasSkipped;
        const std::string why = n < 0 ? "临时节点文件无法解析"
                                      : "临时节点文件没有有效数据行";
        return errJson(rolledBack
                           ? why + "，已取消导入"
                           : why + "，已取消导入（回滚不完整，建议刷新页面重置数据）");
    }
    tempsDirty = true; // 导入即产生未保存修改
    gTempsSourceCsv = csv;
    // loadTemps 内部 addTempNode 已维护 adj/idToIdx；fixDangling 的恢复路径同样自行维护，无需再 buildAdj
    const int fixed = fixDanglingBikeRefs(bikes, tempNodes, g);
    if (fixed > 0) bikesDirty = true;
    // D7：导入临时节点不自动回收“无单车引用”的记录；启动时按完整存档 GC。
    ++gWorldRevision;
    std::ostringstream os;
    os << "{\"ok\":true,\"count\":" << tempNodes.size() << ",\"fixed\":" << fixed
       << ",\"skipped\":" << skipped << ",\"gc\":0}";
    return os.str();
}

// ---------- 导入预检（P2 部分导入确认） ----------
// 只解析不提交：前端先看到“有效 N 行 / 异常 M 行”，确认后才调用 import*。
// 预检不得改变任何全局状态（脏标记、tempsLoadFailed 均恢复）。
std::string web_precheckBikes(const std::string& csv) {
    std::string limitErr;
    if (!csvWithinLimits(csv, &limitErr)) return errJson(limitErr);
    if (!webBikesWithinLimit(csv, limitErr)) return errJson(limitErr);
    const bool wasDirty = bikesDirty;
    const int wasSkipped = bikesLoadSkipped;
    if (!writeFileRaw("import_bikes.csv", csv)) return errJson("写入失败");
    std::vector<Bike> nb;
    int skipped = 0;
    const int n = loadBikes("import_bikes.csv", nb, &g, &skipped);
    bikesDirty = wasDirty;  // 预检不产生未保存修改
    bikesLoadSkipped = wasSkipped;  // 预检不得污染真实保存提示
    if (n <= 0) return errJson("单车文件为空或没有有效数据行");
    std::ostringstream os;
    os << "{\"ok\":true,\"count\":" << n << ",\"skipped\":" << skipped << "}";
    return os.str();
}

std::string web_precheckTemps(const std::string& csv) {
    std::string limitErr;
    if (!csvWithinLimits(csv, &limitErr)) return errJson(limitErr);
    if (!webTempsWithinLimit(csv, limitErr)) return errJson(limitErr);
    const bool wasDirty = tempsDirty;
    const bool wasLoadFailed = tempsLoadFailed;
    const int wasSkipped = tempsLoadSkipped;
    if (!writeFileRaw("import_temps.csv", csv)) {
        tempsLoadFailed = wasLoadFailed;
        return errJson("写入失败");
    }
    Graph scratch = g;
    for (size_t i = 0; i < tempNodes.size(); ++i) removeTempNode(scratch, tempNodes[i].nodeId);
    std::vector<TempNode> probe;
    int skipped = 0;
    const int n = loadTemps("import_temps.csv", probe, scratch, &skipped);
    tempsDirty = wasDirty;
    tempsLoadFailed = wasLoadFailed;  // 预检解析失败不得封锁后续保存
    tempsLoadSkipped = wasSkipped;
    // 纯表头/空文件是合法空态（saveTemps 允许空表）；只有解析失败或全部行异常才拒绝。
    if (n < 0 || (n == 0 && skipped > 0)) {
        return errJson(n < 0 ? "临时节点文件无法解析"
                             : "临时节点文件没有有效数据行（" + std::to_string(skipped) +
                                   " 行异常）");
    }
    std::ostringstream os;
    os << "{\"ok\":true,\"count\":" << n << ",\"skipped\":" << skipped << "}";
    return os.str();
}

std::string web_save() {
    // 整世界保存入口：先做跨表引用校验，避免把悬空 T 引用写进下载文件。
    // 低层 saveBikes/saveTemps 保持纯序列化语义；此校验只覆盖 save/web/export。
    std::string worldErr;
    if (!validateWorldForSave(g, bikes, tempNodes, &worldErr)) {
        return errJson("保存前一致性校验失败：" + worldErr);
    }
    // 两侧独立尝试并合并报告（与菜单「3. 保存所有数据」同语义，D2）：
    // 一边失败不阻止另一边落盘；仅两侧都成功才返回 ok=true（前端据此清脏）
    const int bikeSkippedBeforeSave = bikesLoadSkipped;
    const int tempSkippedBeforeSave = tempsLoadSkipped;
    std::string errBikes, errTemps;
    bool okBikes = false, okTemps = false;
    if (bikes.empty()) errBikes = "单车列表为空，拒绝写入（防止用空列表覆盖存档）";
    else if (!saveBikes(g, "save_bikes.csv", bikes)) errBikes = "保存单车文件失败";
    else okBikes = true;
    if (!saveTemps(g, "save_temps.csv", tempNodes)) errTemps = "保存临时节点文件失败";
    else okTemps = true;
    const bool both = okBikes && okTemps;
    if (!both && !okBikes && !okTemps) {
        return errJson("保存结果: 单车数据失败: " + errBikes +
                       "；临时节点数据失败: " + errTemps);
    }
    // saveBikes/saveTemps 成功作用于 scratch 目标后会清全局 skipped 计数；
    // web 的下载尚未确认，先恢复计数，等 markSaved 再清。必须在读回文件
    // 之前恢复：读回失败会提前 return，不能留下“skipped 已被清零”的假状态。
    if (okBikes) bikesLoadSkipped = bikeSkippedBeforeSave;
    if (okTemps) tempsLoadSkipped = tempSkippedBeforeSave;
    // 部分成功也把成功侧文件返回给前端下载：成功侧目标已在 MEMFS 覆盖、
    // skipped 计数已清零；若只返回错误，用户既拿不到新文件也拿不到备份（P2-N4）。
    std::string bc, tc, bb, tb;
    if (okBikes) {
        if (!readFileRaw("save_bikes.csv", bc)) return errJson("读回单车保存文件失败");
        readFileRaw("save_bikes.csv.pre-save.bak", bb);  // 仅 skipped>0 时存在
    }
    if (okTemps) {
        if (!readFileRaw("save_temps.csv", tc)) return errJson("读回临时节点保存文件失败");
        readFileRaw("save_temps.csv.pre-save.bak", tb);
    }
    // 脏标记不在这里清：等前端下载都成功后再调用 markSaved
    // （下载被浏览器拦截/失败时不丢"未保存"提示；部分成功也不清脏）
    std::ostringstream os;
    os << std::setprecision(10);
    os << "{\"ok\":" << (both ? "true" : "false")
       << ",\"partial\":" << (both ? "false" : "true");
    if (!both) {
        os << ",\"error\":" << jsonStr(
            "保存结果: 单车数据" + (okBikes ? std::string("已保存") : "失败: " + errBikes) +
            "；临时节点数据" + (okTemps ? std::string("已保存") : "失败: " + errTemps));
    }
    if (okBikes)
        os << ",\"bikesCsv\":" << jsonStr(bc)
           << ",\"bikesSkipped\":" << bikeSkippedBeforeSave;
    if (okTemps)
        os << ",\"tempsCsv\":" << jsonStr(tc)
           << ",\"tempsSkipped\":" << tempSkippedBeforeSave;
    os << ",\"revision\":" << gWorldRevision;
    if (okBikes && bikeSkippedBeforeSave > 0) {
        const std::string& backup = gBikesSourceCsv.empty() ? bb : gBikesSourceCsv;
        if (!backup.empty())
            os << ",\"bikesBackupCsv\":" << jsonStr(backup);
    }
    if (okTemps && tempSkippedBeforeSave > 0) {
        const std::string& backup = gTempsSourceCsv.empty() ? tb : gTempsSourceCsv;
        if (!backup.empty())
            os << ",\"tempsBackupCsv\":" << jsonStr(backup);
    }
    os << "}";
    return os.str();
}

// 前端确认两次 CSV 下载动作都执行成功后调用。
// 只有世界修订号仍等于保存快照的修订号才清脏；保存对话框打开期间若
// 自动演示/其他操作改了数据，返回 cleared=false，保留未保存提示（P1-N1）。
std::string web_markSaved(int savedRevision) {
    const bool cleared = (savedRevision == gWorldRevision);
    if (cleared) {
        bikesDirty = false;
        tempsDirty = false;
        // 保存文件与备份都已下载确认后，异常行提示才可清除（web_save 暂存计数）。
        bikesLoadSkipped = 0;
        tempsLoadSkipped = 0;
    }
    std::ostringstream os;
    os << "{\"ok\":true,\"cleared\":" << (cleared ? "true" : "false")
       << ",\"revision\":" << gWorldRevision << "}";
    return os.str();
}

// 幽灵车（available 且无位置，nodeId==0）自动恢复：与控制台「体检修复」第 2 轮同源。
// 注：正常载入流程（load/importBikes）都会先跑 fixDanglingBikeRefs，此入口主要覆盖
// 手工编辑存档等场景；无坐标的幽灵车无法自动恢复，计入 skipped 由使用者决定。
std::string web_repairGhosts() {
    int repaired = 0, skipped = 0;
    for (Bike& bike : bikes) {
        if (bike.status != "available" || bike.nodeId != 0) continue;
        if (recoverBikePosition(bike, tempNodes, g) != 0) ++repaired;
        else ++skipped;
    }
    if (repaired > 0) {
        bikesDirty = true;
        ++gWorldRevision;
    }
    std::ostringstream os;
    os << "{\"ok\":true,\"repaired\":" << repaired << ",\"skipped\":" << skipped << "}";
    return os.str();
}

EMSCRIPTEN_BINDINGS(campus) {
    emscripten::function("load", &web_load);
    emscripten::function("getGraph", &web_getGraph);
    emscripten::function("getBikes", &web_getBikes);
    emscripten::function("getTemps", &web_getTemps);
    emscripten::function("status", &web_status);
    emscripten::function("snapshot", &web_snapshot);
    emscripten::function("nearestNode", &web_nearestNode);
    emscripten::function("shortestPath", &web_shortestPath);
    emscripten::function("topPaths", &web_topPaths);
    emscripten::function("multiStep", &web_multiStep);
    emscripten::function("minHops", &web_minHops);
    emscripten::function("dijkstraTrace", &web_dijkstraTrace);
    emscripten::function("nearestParking", &web_nearestParking);
    emscripten::function("returnPreview", &web_returnPreview);
    emscripten::function("borrow", &web_borrow);
    emscripten::function("returnBike", &web_returnBike);
    emscripten::function("addTemp", &web_addTemp);
    emscripten::function("removeTemp", &web_removeTemp);
    emscripten::function("importBikes", &web_importBikes);
    emscripten::function("importTemps", &web_importTemps);
    emscripten::function("precheckBikes", &web_precheckBikes);
    emscripten::function("precheckTemps", &web_precheckTemps);
    emscripten::function("save", &web_save);
    emscripten::function("markSaved", &web_markSaved);
    emscripten::function("repairGhosts", &web_repairGhosts);
}
