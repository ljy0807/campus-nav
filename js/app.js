// app.js —— Vue3 + Element Plus 应用：面板交互、状态管理、桥层调用编排。
// 业务规则全部在 C++（src/）中，本文件只做 UI 流程与展示。
(function () {
  // ---------- 重库懒加载（P1-5） ----------
  // echarts/echarts-gl、gsap/SplitText、tsParticles、pinyin-pro 不在首屏同步加载，
  // 由各功能首次使用时注入；全部为纯展示增强，加载失败静默降级（调用点已有兜底）。
  const scriptCache = {};
  const SCRIPT_TIMEOUT_MS = 15000;
  function loadScript(src) {
    if (scriptCache[src]) return scriptCache[src];
    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      let settled = false;
      let timer = 0;
      const cleanup = () => {
        s.onload = null;
        s.onerror = null;
        if (timer) clearTimeout(timer);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (s.parentNode) s.parentNode.removeChild(s); // 超时/失败脚本不留在 DOM 中
        delete scriptCache[src]; // 立即允许下一次重试，不必等 catch 微任务
        reject(err);
      };
      s.src = src;
      s.onload = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      s.onerror = () => fail(new Error('脚本加载失败：' + src));
      timer = setTimeout(() => fail(new Error('脚本加载超时（15 秒）：' + src)), SCRIPT_TIMEOUT_MS);
      document.head.appendChild(s);
    });
    scriptCache[src] = p;
    p.catch(() => { if (scriptCache[src] === p) delete scriptCache[src]; }); // 失败后允许下次重试
    return p;
  }

  const { createApp, ref, reactive, computed, onMounted, nextTick, watch } = Vue;
  const { ElMessage, ElMessageBox } = ElementPlus;

  const App = {
    setup() {
      const booted = ref(false);
      const bootError = ref('');
      const BOOT_WATCHDOG_MS = 20000;
      let bootParticles = null; // 启动页粒子实例（纯展示，加载失败静默降级）
      // 启动页分阶段文案（纯展示，不改变加载流程）
      const bootPhases = ['启动 WASM 导航引擎…', '加载校园路网与单车数据…', '初始化地图与渲染…', '准备就绪'];
      const bootPhase = ref(0);
      // 启动节拍开关（P1-5）：?fast=1 或点「跳过动画」后不再等待展示节拍（真实加载不受影响）
      const fastMode = /[?&]fast=1(&|$)/.test(location.search);
      const skipPace = ref(false);
      let paceResolve = null; // 当前分阶段等待的 resolver（供跳过按钮提前唤醒）
      function skipBootPace() {
        skipPace.value = true;
        if (paceResolve) { const r = paceResolve; paceResolve = null; r(); }
      }
      const activeTab = ref('query');
      const stats = reactive({ nodes: 0, edges: 0, bikes: 0, temps: 0 });
      const statsView = reactive({ nodes: 0, edges: 0, bikes: 0, temps: 0 }); // 展示用（数字滚动）

      // ---------- 数据 ----------
      const graphNodes = ref([]);
      const graphEdges = ref([]); // 边缓存：refreshAll/rerenderGraph 更新，图表/热力图复用（避免重复桥层调用）
      const bikes = ref([]);
      const temps = ref([]);
      const bikesDirty = ref(false);
      const tempsDirty = ref(false);
      const saving = ref(false);
      const bikesInput = ref(null);
      const tempsInput = ref(null);
      // 单车列表分页：后端允许 2,000 辆，一次性渲染全部卡片会产生数万 DOM 节点。
      const BIKE_PAGE_SIZE = 50;
      const bikePage = ref(1);
      const bikePageCount = computed(() =>
        Math.max(1, Math.ceil(bikes.value.length / BIKE_PAGE_SIZE)));
      const pagedBikes = computed(() => {
        const page = Math.min(Math.max(1, bikePage.value), bikePageCount.value);
        const start = (page - 1) * BIKE_PAGE_SIZE;
        return bikes.value.slice(start, start + BIKE_PAGE_SIZE);
      });
      watch(() => bikes.value.length, () => {
        if (bikePage.value > bikePageCount.value) bikePage.value = bikePageCount.value;
      });
      // 设置持久化（localStorage，命名空间 campusNav.*）：只存开关状态，读失败一律回退默认值
      const SETTING_KEYS = { dark: 'campusNav.dark', soundOn: 'campusNav.soundOn', heat: 'campusNav.heat' };
      function readSetting(key) {
        try { return localStorage.getItem(key) === '1'; } catch (e) { return false; }
      }
      function writeSetting(key, on) {
        try { localStorage.setItem(key, on ? '1' : '0'); } catch (e) { /* 存储不可用不影响功能 */ }
      }
      const dark = ref(readSetting(SETTING_KEYS.dark));       // 夜模式（纯视觉，html/body.dark；启动恢复）
      const soundOn = ref(readSetting(SETTING_KEYS.soundOn)); // 提示音（WebAudio 零素材；启动恢复）
      const track = reactive({ playing: false, progress: 0, speed: 400 }); // 回放控制条状态
      const heat = ref(readSetting(SETTING_KEYS.heat));       // 节点连接热力图开关（纯视觉；启动后随 refreshAll 恢复渲染）
      // 先于首帧恢复夜模式：html.dark 驱动 EP 官方暗色变量，body.dark 供自定义浮层选择器使用
      if (dark.value) { document.documentElement.classList.add('dark'); document.body.classList.add('dark'); }
      const toolsOpen = ref(false); // 窄屏工具条展开状态（桌面端折叠按钮隐藏）

      const nodeOptions = computed(() =>
        graphNodes.value.map((n) => ({
          id: n.id,
          value: n.id, // el-select-v2 的取值字段；节点数上万时只渲染可视行
          label: n.isTemp ? 'T' + -n.id + '（临时节点）' : n.name + '（#' + n.id + '）'
        }))
      );

      // 节点搜索（pinyin-pro 本地化）：中文 / 全拼 / 首字母 / 编号混合匹配；
      // 库缺失时退回原有子串匹配。匹配只影响下拉候选，不改变已选值（仍是节点 id）。
      const nodeQuery = ref('');
      const pinyinReady = ref(false); // 拼音库懒加载完成标记（依赖它触发索引重建）
      // 拼音库懒加载（P1-5）：首次打开节点下拉时注入；未就绪期间退回子串匹配，不影响已选值
      let pinyinLoader = null;
      function ensurePinyin() {
        if (window.pinyinPro || pinyinLoader) return;
        pinyinLoader = loadScript('vendor/pinyin-pro.min.js')
          .then(() => { pinyinReady.value = true; })
          .catch(() => { pinyinLoader = null; });
      }
      const nodeSearchIndex = computed(() => {
        void pinyinReady.value; // 依赖：库加载完成后重建拼音索引
        const map = new Map();
        const pp = window.pinyinPro;
        const hasPy = !!(pp && typeof pp.pinyin === 'function');
        for (const n of graphNodes.value) {
          const base = n.isTemp ? 'T' + -n.id : n.name;
          let key = '';
          if (hasPy) {
            try {
              const full = pp.pinyin(base, { toneType: 'none', type: 'array' }).join('');
              const ini = pp.pinyin(base, { pattern: 'first', toneType: 'none', type: 'array' }).join('');
              key = (full + ' ' + ini).toLowerCase();
            } catch (e) { key = ''; }
          }
          map.set(n.id, key);
        }
        return map;
      });
      const nodeOptionsView = computed(() => {
        const qs = nodeQuery.value.trim().toLowerCase();
        if (!qs) return nodeOptions.value;
        const idx = nodeSearchIndex.value;
        return nodeOptions.value.filter((o) => o.label.toLowerCase().includes(qs) || (idx.get(o.id) || '').includes(qs));
      });
      function nodeFilter(v) { nodeQuery.value = String(v == null ? '' : v); }
      // 打开下拉时懒加载拼音库（P1-5）；关闭下拉即清空搜索
      function onNodeMenuToggle(visible) { if (visible) { ensurePinyin(); return; } nodeQuery.value = ''; }

      // ---------- 查询 ----------
      const q = reactive({ from: null, to: null, stops: [] });
      const qResult = ref(null);
      const qKind = ref('');
      const qRoutes = ref([]);  // 三条推荐路线的完整列表（qKind === 'top3' 时有效）
      const qRouteIdx = ref(0); // 当前选中/绘制的是第几条（0 起）
      const qDistView = ref(0); // 结果卡数字滚动（总距离，米）
      const qHopsView = ref(0); // 结果卡数字滚动（最少跳数）
      const qNotice = ref('');  // 零长度路径等查询提示（结果区 aria-live 文本）

      // ---------- 点选模式 ----------
      const pick = reactive({ active: false, purpose: null, payload: null });
      const pickHint = ref('');
      const online = ref(false);
      let tileLayer = null;
      // 在线瓦片地址与参数（底图与小地图共用，切换时保持同步）
      const ONLINE_TILE_URL = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';
      const ONLINE_TILE_OPTS = { subdomains: '1234', minZoom: 14, maxZoom: 19, maxNativeZoom: 18, attribution: '© 高德地图' };

      function pickFor(purpose, payload) {
        pick.active = true;
        pick.purpose = purpose;
        pick.payload = payload || null;
        const hints = {
          from: '点选地图任意位置，自动吸附为起点',
          to: '点选地图任意位置，自动吸附为终点',
          return: '点选地图上还车位置（' + (payload ? payload.bikeId : '') + '）',
          temp: '点选地图上要创建临时节点的位置',
          parking: '点选地图任意位置，查询最近的停车场'
        };
        pickHint.value = hints[purpose] || '点选地图位置';
      }

      // F4：取消地图点选（Esc 与「取消点选」按钮共用；清空模式/载荷/提示/临时图层）
      function cancelPick() {
        pick.active = false;
        pick.purpose = null;
        pick.payload = null;
        pickHint.value = '';
        MapCtl.clearMisc();
      }

      // 桥层返回兜底（P1-4）：getGraph 无 ok 字段（bridge.cpp web_getGraph），按形状判型；
      // 失败时（引擎未初始化/异常）返回 null，调用方保持现状，避免 .edges.length 炸穿 UI。
      function safeGraph() {
        const g = Api.getGraph();
        return (g && Array.isArray(g.nodes) && Array.isArray(g.edges)) ? g : null;
      }

      function refreshAll(opts) {
        const syncMap = !opts || opts.syncMap !== false;
        // P2：一次 snapshot 取回四块数据，减少 3 次 WASM 边界与 JSON 解析。
        const snap = Api.snapshot();
        if (snap && snap.ok && snap.graph && snap.bikes && snap.temps && snap.status) {
          bikes.value = snap.bikes.bikes || [];
          temps.value = snap.temps.temps || [];
          bikesDirty.value = snap.status.bikesDirty;
          tempsDirty.value = snap.status.tempsDirty;
          stats.nodes = snap.status.nodes;
          stats.bikes = snap.status.bikes;
          stats.temps = snap.status.temps;
          // F1：节点与边必须来自同一快照，避免图/车/临时节点跨版本。
          stats.edges = snap.graph.edges.length;
          graphNodes.value = snap.graph.nodes;
          graphEdges.value = snap.graph.edges;
        } else {
          // 兼容回退：snapshot 不可用时仍按旧路径逐项读取，保持界面可用。
          const gb = Api.getBikes();
          if (gb.bikes) {
            bikes.value = gb.bikes;
            bikesDirty.value = gb.dirty;
          }
          const gt = Api.getTemps();
          if (gt.temps) {
            temps.value = gt.temps;
            tempsDirty.value = gt.dirty;
          }
          const st = Api.status();
          const g = safeGraph();
          if (st && typeof st.nodes === 'number') {
            stats.nodes = st.nodes;
            stats.bikes = st.bikes;
            stats.temps = st.temps;
            bikesDirty.value = st.bikesDirty;
            tempsDirty.value = st.tempsDirty;
          }
          if (g) { stats.edges = g.edges.length; graphNodes.value = g.nodes; graphEdges.value = g.edges; }
        }
        tweenNumber(statsView.nodes, stats.nodes, (v) => { statsView.nodes = Math.round(v); }, 650, 'nodes');
        tweenNumber(statsView.edges, stats.edges, (v) => { statsView.edges = Math.round(v); }, 650, 'edges');
        tweenNumber(statsView.bikes, stats.bikes, (v) => { statsView.bikes = Math.round(v); }, 650, 'bikes');
        tweenNumber(statsView.temps, stats.temps, (v) => { statsView.temps = Math.round(v); }, 650, 'temps');
        if (syncMap) MapCtl.renderBikes(bikes.value); // 单车图层：与车辆状态同步刷新
        if (heat.value) { heat.value = MapCtl.addHeat(heatPoints()); } // 热力图开启时随图数据刷新
        charts.update(); // 数据洞察图表（已初始化时才更新）
      }

      // 数据变更后的统一刷新：refreshAll 先取快照，rerenderGraph 再统一重绘图/车，
      // 避免同一次变更把单车 marker 渲染两遍（普通 refreshAll 仍默认同步地图）。
      function applyWorldChange() {
        refreshAll({ syncMap: false });
        rerenderGraph();
      }

      // 图数据变化后重绘（保留当前视图），并尽量恢复已绘制的路径
      function rerenderGraph() {
        const graph = safeGraph();
        if (!graph) return; // 桥层失败：保持现状，不清空渲染与查询状态
        graphNodes.value = graph.nodes;
        graphEdges.value = graph.edges;
        MapCtl.renderGraph(graph, { fit: false });
        MapCtl.renderBikes(bikes.value); // nodeIndex 已更新：同步单车图层（refreshAll 可能先于重绘执行）
        pruneStaleQueryState();
        // 只重绘不重播：动画与自动回放关闭，回放状态由 onTrackHalt 统一复位
        if (qResult.value && qResult.value.path) {
          MapCtl.drawPath(qResult.value.path, { animate: false, autoplay: false, fit: false, speed: track.speed });
          // drawPath 内部 clearPath 会清掉灰色备选线，三线模式下需按当前选中重画
          if (qKind.value === 'top3' && qRoutes.value.length > 1) {
            MapCtl.drawVariants(qRoutes.value.filter((_, j) => j !== qRouteIdx.value).map((x) => x.path));
          }
        }
      }

      // 节点签名：id:lat:lon 拼接；用于识别同 T-id 但坐标已变（重新导入）的失效查询
      function nodeSignature() {
        return graphNodes.value.map((n) => n.id + ':' + n.lat + ':' + n.lon).join('|');
      }

      // 清空查询结果卡/推荐路线/地图残路/逐步演示（查询条件或图数据变化时共用）
      function clearQueryResult() {
        traceStop();
        qResult.value = null;
        qKind.value = '';
        qRoutes.value = [];
        qRouteIdx.value = 0;
        qNotice.value = '';
        MapCtl.clearPath();
      }

      // 图数据变化后清理失效的查询引用（起点/终点/多段站点/结果卡/残路/还车点选）
      function pruneStaleQueryState() {
        const present = new Set(graphNodes.value.map((n) => n.id));
        let changed = false;
        if (q.from != null && !present.has(q.from)) { q.from = null; changed = true; }
        if (q.to != null && !present.has(q.to)) { q.to = null; changed = true; }
        if (q.stops.some((id) => !present.has(id))) {
          q.stops = q.stops.filter((id) => present.has(id));
          changed = true;
        }
        // 节点 ID 仍在但坐标已变（同 T-id 重导入）：签名不一致同样视为失效
        if (qResult.value && qResult.value._nodeSig && qResult.value._nodeSig !== nodeSignature()) {
          clearQueryResult();
          changed = true;
        }
        const path = qResult.value && qResult.value.path;
        if (path && path.some((id) => !present.has(id))) {
          clearQueryResult();
          changed = true;
        }
        if (pick.active && pick.purpose === 'return') {
          const b = pick.payload;
          if (!b || !bikes.value.some((x) => x.bikeId === b.bikeId && x.status === 'borrowed')) {
            pick.active = false;
            pick.payload = null;
            pickHint.value = '';
            changed = true;
          }
        }
        if (changed) ElMessage.info('图数据已变化，已清除失效的查询引用');
      }

      // 起终点/途经点被用户改动后，旧结果卡/红线/回放不再代表当前查询条件
      watch(
        [() => q.from, () => q.to, () => q.stops.join(',')],
        () => {
          if (!qResult.value && !qRoutes.value.length && !traceRunning.value && !qNotice.value) return;
          clearQueryResult();
        }
      );

      // 零长度路径（起点=终点 / 桥层返回单节点路径）：明确提示且不进入播放态
      function showZeroPathNotice() {
        traceStop();
        qResult.value = null;
        qKind.value = '';
        qRoutes.value = [];
        qRouteIdx.value = 0;
        qDistView.value = 0;
        qHopsView.value = 0;
        track.playing = false;
        track.progress = 0;
        MapCtl.clearPath();
        qNotice.value = '起点=终点，无需导航';
        ElMessage.info(qNotice.value);
      }

      function isZeroPath(r) {
        const path = r && Array.isArray(r.path) ? r.path : [];
        return path.length < 2;
      }

      // ---------- 查询动作 ----------
      function doShortest(opts) {
        if (q.from == null || q.to == null) return ElMessage.warning('请先选择起点和终点');
        if (q.from === q.to) return showZeroPathNotice();
        traceStop(); // 新查询顶替当前逐步演示
        const r = Api.shortestPath(q.from, q.to);
        if (!r.ok) {
          qResult.value = null;
          qNotice.value = '';
          MapCtl.clearPath();
          return ElMessage.error(r.error);
        }
        if (isZeroPath(r)) return showZeroPathNotice();
        qNotice.value = '';
        qKind.value = 'shortest';
        qResult.value = r;
        r._nodeSig = nodeSignature(); // 记录当时的图节点签名（临时节点重导入后坐标变化时作废）
        qDistView.value = 0;
        tweenNumber(0, r.dist, (v) => { qDistView.value = v; }, 650, 'dist');
        MapCtl.drawPath(r.path, { speed: track.speed, follow: !!(opts && opts.follow), endsTour: !(opts && opts.follow) });
        track.playing = true;
        track.progress = 0;
        beep(520, 0.08);
        if (typeof confetti === 'function') confetti({ particleCount: 60, spread: 55, origin: { y: 0.35 } });
      }

      function doMinHops(opts) {
        if (q.from == null || q.to == null) return ElMessage.warning('请先选择起点和终点');
        if (q.from === q.to) return showZeroPathNotice();
        traceStop(); // 新查询顶替当前逐步演示
        const r = Api.minHops(q.from, q.to);
        if (!r.ok) {
          qResult.value = null;
          qNotice.value = '';
          MapCtl.clearPath();
          return ElMessage.error(r.error);
        }
        if (isZeroPath(r)) return showZeroPathNotice();
        qNotice.value = '';
        qKind.value = 'minhops';
        qResult.value = r;
        r._nodeSig = nodeSignature(); // 记录当时的图节点签名（临时节点重导入后坐标变化时作废）
        qHopsView.value = 0;
        tweenNumber(0, r.hops, (v) => { qHopsView.value = Math.round(v); }, 650, 'hops');
        MapCtl.drawPath(r.path, { speed: track.speed, follow: !!(opts && opts.follow), endsTour: !(opts && opts.follow) });
        track.playing = true;
        track.progress = 0;
        beep(520, 0.08);
      }

      function doMulti(opts) {
        if (!q.stops || q.stops.length < 2) return ElMessage.warning('多段导航至少选择 2 个节点');
        if (q.stops.length > 100) return ElMessage.warning('站点数量需在 2 ~ 100 之间');
        traceStop(); // 新查询顶替当前逐步演示
        const r = Api.multiStep(q.stops.join(','));
        if (!r.ok) {
          qResult.value = null;
          qNotice.value = '';
          MapCtl.clearPath();
          return ElMessage.error(r.error);
        }
        if (isZeroPath(r)) return showZeroPathNotice();
        qNotice.value = '';
        qKind.value = 'multi';
        qResult.value = r;
        r._nodeSig = nodeSignature(); // 记录当时的图节点签名（临时节点重导入后坐标变化时作废）
        qDistView.value = 0;
        tweenNumber(0, r.dist, (v) => { qDistView.value = v; }, 650, 'dist');
        MapCtl.drawPath(r.path, { speed: (opts && opts.speed) || track.speed, follow: !!(opts && opts.follow), endsTour: !(opts && opts.follow) });
        track.playing = true;
        track.progress = 0;
        beep(520, 0.08);
        if (typeof confetti === 'function') confetti({ particleCount: 60, spread: 55, origin: { y: 0.35 } });
      }

      // 三条推荐路线（Yen K 短路，K=3）：业务逻辑全在 src/，此处只做选择与渲染
      function doTopPaths(opts) {
        if (q.from == null || q.to == null) return ElMessage.warning('请先选择起点和终点');
        if (q.from === q.to) return showZeroPathNotice();
        traceStop(); // 新查询顶替当前逐步演示
        const r = Api.topPaths(q.from, q.to, 3);
        if (!r.ok) {
          qResult.value = null;
          qRoutes.value = [];
          qKind.value = '';
          qNotice.value = '';
          MapCtl.clearPath();
          return ElMessage.error(r.error);
        }
        const routes = (r.routes || []).filter((x) => x && Array.isArray(x.path) && x.path.length >= 2);
        if (!routes.length) return showZeroPathNotice();
        qNotice.value = '';
        qKind.value = 'top3';
        qRoutes.value = routes;
        qRouteIdx.value = 0;
        drawRouteAt(0, opts);
        beep(520, 0.08);
        if (typeof confetti === 'function') confetti({ particleCount: 60, spread: 55, origin: { y: 0.35 } });
      }

      // 选中并绘制第 i 条推荐路线；其余路线以灰色备选折线叠加展示
      function drawRouteAt(i, opts) {
        const r = qRoutes.value[i];
        if (!r) return;
        if (isZeroPath(r)) return showZeroPathNotice();
        qNotice.value = '';
        qRouteIdx.value = i;
        qResult.value = r; // 复用结果卡（距离/分段/回放）
        r._nodeSig = nodeSignature(); // 记录当时的图节点签名（临时节点重导入后坐标变化时作废）
        qDistView.value = 0;
        tweenNumber(0, r.dist, (v) => { qDistView.value = v; }, 650, 'dist');
        MapCtl.drawPath(r.path, { speed: track.speed, follow: !!(opts && opts.follow), endsTour: !(opts && opts.follow) });
        MapCtl.drawVariants(qRoutes.value.filter((_, j) => j !== i).map((x) => x.path));
        track.playing = true;
        track.progress = 0;
      }

      function pickRoute(i) {
        drawRouteAt(i);
      }

      function clearQuery() {
        traceStop(); // 清空结果同时停止逐步演示
        qResult.value = null;
        qKind.value = '';
        qRoutes.value = [];
        qRouteIdx.value = 0;
        qDistView.value = 0;
        qHopsView.value = 0;
        qNotice.value = '';
        track.playing = false;
        track.progress = 0;
        MapCtl.clearPath();
        MapCtl.clearMisc();
      }

      // 途经顺序列表（SortableJS 拖拽排序；独立于 el-select 多选，仅调整 q.stops 顺序）
      const stopsListEl = ref(null);
      let stopsSortable = null;
      function stopName(id) {
        const n = graphNodes.value.find((x) => x.id === id);
        return n ? (n.isTemp ? 'T' + -n.id + '（临时节点）' : n.name + '（#' + n.id + '）') : '节点 #' + id;
      }
      function syncStopsSortable() {
        try {
          if (!window.Sortable) return;
          const el = stopsListEl.value;
          if (el && !stopsSortable) {
            stopsSortable = window.Sortable.create(el, {
              animation: 150,
              ghostClass: 'stop-ghost',
              onEnd: () => {
                const ids = Array.from(el.querySelectorAll('.stop-row')).map((row) => Number(row.dataset.id));
                if (ids.length === q.stops.length && ids.every((x) => x !== 0)) q.stops = ids; // 与 Vue 数组对齐（长度一致才写回）
              }
            });
          } else if (!el && stopsSortable) {
            stopsSortable.destroy();
            stopsSortable = null;
          }
        } catch (e) { /* 拖拽库缺失/失败不影响查询 */ }
      }
      watch(() => q.stops.length, () => nextTick(syncStopsSortable));

      // ---------- 逐步演示（Dijkstra 确定顺序；只读接口，区别于沿最终路径行走的「回放」） ----------
      const traceRunning = ref(false);
      const traceCaption = ref('');
      let traceToken = null;
      const TRACE_TAIL_MS = 1600; // 演示完成后的高亮/字幕停留时间
      function traceStop() {
        traceToken = null;
        traceRunning.value = false;
        traceCaption.value = '';
        MapCtl.traceClear();
      }
      function traceToggle() {
        if (traceRunning.value) { traceStop(); return; }
        if (q.from == null || q.to == null) return ElMessage.warning('请先选择起点和终点');
        const r = Api.dijkstraTrace(q.from, q.to);
        if (!r.ok) return ElMessage.error(r.error);
        const order = r.order || [];
        if (r.dist < 0 || !order.length) return ElMessage.error('两点之间不可达，无法演示');
        const token = {};
        traceToken = token;
        traceRunning.value = true;
        const delay = order.length > 60 ? 120 : order.length > 30 ? 200 : 320; // 节点多则提速，避免演示过长
        let i = 0;
        const step = () => {
          if (traceToken !== token) return;
          if (i >= order.length) {
            traceCaption.value = '逐步演示完成 · 共确定 ' + order.length + ' 个节点 · 终点最短距离 ' + fmtDist(r.dist);
            traceRunning.value = false;
            setTimeout(() => { if (traceToken === token) traceStop(); }, TRACE_TAIL_MS);
            return;
          }
          const it = order[i++];
          MapCtl.traceHighlight(it.id);
          traceCaption.value = '逐步演示 ' + i + '/' + order.length + ' · 确定「' + it.name + '」（#' + it.id + '）· 当前最短距离 ' + fmtDist(it.dist);
          setTimeout(step, delay);
        };
        step();
      }

      // ---------- 分享链接（LZ-String；压入 location.hash，启动时保守预填不自动查询） ----------
      async function shareQuery() {
        if (q.from == null && q.to == null && !(q.stops && q.stops.length)) {
          return ElMessage.warning('请先选择起点/终点或途经点，再生成分享链接');
        }
        if (!window.LZString || typeof LZString.compressToEncodedURIComponent !== 'function') {
          return ElMessage.warning('分享组件未加载');
        }
        let packed = '';
        try {
          packed = LZString.compressToEncodedURIComponent(JSON.stringify({ f: q.from, t: q.to, s: (q.stops || []).slice() }));
        } catch (e) { packed = ''; }
        if (!packed) return ElMessage.warning('分享链接生成失败');
        const url = location.href.split('#')[0] + '#q=' + packed;
        location.hash = 'q=' + packed; // 同步压入地址栏，方便直接复制整条地址
        let copied = false;
        try {
          await navigator.clipboard.writeText(url);
          copied = true;
        } catch (e) { copied = false; } // file:// / 未授权时回退手动复制
        if (copied) {
          ElMessage.success('分享链接已复制到剪贴板');
        } else {
          ElMessageBox.prompt('当前环境无法自动复制，请手动复制以下链接：', '分享查询', {
            inputValue: url, confirmButtonText: '完成', cancelButtonText: '关闭'
          }).catch(() => {});
        }
      }

      // 启动恢复：解析 #q= 压缩载荷，仅预填表单并提示（保守：不自动执行查询）
      function applyShareHash() {
        try {
          const m = /(?:^|[#&])q=([^&]+)/.exec(location.hash || '');
          if (!m || !window.LZString || typeof LZString.decompressFromEncodedURIComponent !== 'function') return false;
          const raw = LZString.decompressFromEncodedURIComponent(decodeURIComponent(m[1]));
          if (!raw) return false;
          const d = JSON.parse(raw);
          const present = new Set(graphNodes.value.map((n) => n.id));
          let restored = 0;
          if (d && present.has(d.f)) { q.from = d.f; restored++; }
          if (d && present.has(d.t)) { q.to = d.t; restored++; }
          if (d && Array.isArray(d.s)) {
            const stops = d.s.filter((x) => present.has(x));
            if (stops.length) { q.stops = stops; restored += stops.length; }
          }
          if (!restored) return false;
          activeTab.value = 'query';
          ElMessage.info('已从分享链接恢复查询条件，请核对后点击「最短路径」执行');
          return true;
        } catch (e) { return false; }
      }

      // ---------- 借还车 ----------
      function statusText(s) {
        return s === 'available' ? '可借' : s === 'borrowed' ? '已借出' : s;
      }

      function statusTagType(s) {
        return s === 'available' ? 'success' : s === 'borrowed' ? 'warning' : 'info';
      }

      function bikeLocation(b) {
        if (b.status === 'borrowed') return '已借出（位置随借用人）';
        if (b.nodeId === 0) return '位置缺失（不可借）';
        if (b.nodeId > 0) {
          const n = MapCtl.nodeById(b.nodeId);
          return n ? n.name : '节点 #' + b.nodeId;
        }
        if (b.nodeId < 0) return '临时节点 T' + -b.nodeId;
        return '未知位置';
      }

      async function borrow(b) {
        try {
          await ElMessageBox.confirm('确认借出 ' + b.bikeId + ' ？', '借车确认', {
            confirmButtonText: '确认借车', cancelButtonText: '取消', type: 'info'
          });
        } catch (e) {
          return;
        }
        const r = Api.borrow(b.bikeId);
        if (!r.ok) return ElMessage.error(r.error);
        ElMessage.success(r.msg);
        beep(700, 0.1);
        applyWorldChange();
      }

      function startReturn(b) {
        pickFor('return', b);
      }

      // ---------- 坐标输入降级（键盘可达）：地图点选之外的替代入口 ----------
      // 只做坐标语法与范围校验（含 (0,0) 哨兵拒绝）；吸附/停车场/还车语义仍全部由桥层判定
      async function promptLatLon(title) {
        let val = '';
        try {
          const r = await ElMessageBox.prompt('请输入「纬度,经度」', title, {
            confirmButtonText: '确定', cancelButtonText: '取消',
            inputPlaceholder: '纬度,经度（例如 28.677800,115.925400）'
          });
          val = r && r.value != null ? String(r.value) : '';
        } catch (e) {
          return null; // 用户取消：不提示错误
        }
        const parts = val.split(',');
        if (parts.length !== 2) {
          ElMessage.error('坐标格式错误：请输入「纬度,经度」（例如 28.677800,115.925400）');
          return null;
        }
        const lat = Number(parts[0].trim());
        const lng = Number(parts[1].trim());
        if (!isFinite(lat) || !isFinite(lng)) {
          ElMessage.error('坐标必须是数字：请输入「纬度,经度」（例如 28.677800,115.925400）');
          return null;
        }
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          ElMessage.error('坐标超出范围：纬度 -90 ~ 90，经度 -180 ~ 180');
          return null;
        }
        if (lat === 0 || lng === 0) {
          ElMessage.error('纬度和经度不能为 0（(0,0) 是无效位置哨兵）');
          return null;
        }
        return { lat: lat, lng: lng };
      }

      async function doReturnAt(b, latlng) {
        MapCtl.showPick(latlng, b.bikeId);
        let msg = '还车位置：(' + latlng.lat.toFixed(6) + ', ' + latlng.lng.toFixed(6) + ')<br>';
        const rp = Api.returnPreview(latlng.lat, latlng.lng);
        if (rp.ok && rp.radius > 0) MapCtl.showRadius(latlng, rp.radius); // 与自动演示同口径：显示停车半径圈（纯渲染）
        if (rp.ok) {
          const rad = rp.radius; // 桥层已返回生效半径（radius>0 或默认 10），无需再兜底
          msg += rp.covered
            ? '距停车场「' + esc(rp.name) + '」约 ' + fmtDist(rp.dist) + ' 米（停放半径 ' + fmtDist(rad) + ' 米），将归位到该停车场。'
            : '距最近停车场「' + esc(rp.name) + '」约 ' + fmtDist(rp.dist) + ' 米（超出其停放半径 ' + fmtDist(rad) + ' 米），将创建临时节点（挂靠该停车场）。';
        }
        try {
          await ElMessageBox.confirm(msg + '<br>确认还车？', '还车确认', {
            dangerouslyUseHTMLString: true, confirmButtonText: '确认还车', cancelButtonText: '取消', type: 'warning'
          });
        } catch (e) {
          MapCtl.clearMisc();
          return;
        }
        const r = Api.returnBike(b.bikeId, latlng.lat, latlng.lng);
        if (!r.ok) {
          MapCtl.clearMisc();
          return ElMessage.error(r.error);
        }
        ElMessage.success(r.msg);
        beep(440, 0.12);
        applyWorldChange();
      }

      // 坐标输入还车：与地图点选共用同一桥层流程（doReturnAt）
      async function promptReturn(b) {
        const ll = await promptLatLon('输入还车坐标');
        if (!ll) return;
        await doReturnAt(b, ll);
      }

      // ---------- 临时节点 ----------
      async function doAddTempAt(latlng) {
        MapCtl.showPick(latlng, '新临时节点');
        const np = Api.nearestParking(latlng.lat, latlng.lng);
        const pid = np.ok ? np.parkingId : 0;
        const pkName = np.ok ? esc(np.name) + '（约 ' + fmtDist(np.dist) + ' 米）' : '无';
        try {
          await ElMessageBox.confirm(
            '位置：(' + latlng.lat.toFixed(6) + ', ' + latlng.lng.toFixed(6) + ')<br>挂靠停车场：' + pkName +
            '<br>确认创建临时节点？',
            '添加临时节点',
            { dangerouslyUseHTMLString: true, confirmButtonText: '创建', cancelButtonText: '取消', type: 'info' }
          );
        } catch (e) {
          MapCtl.clearMisc();
          return;
        }
        const r = Api.addTemp(latlng.lat, latlng.lng, pid);
        if (!r.ok) {
          MapCtl.clearMisc();
          return ElMessage.error(r.error);
        }
        ElMessage.success(r.msg);
        applyWorldChange();
      }

      // 坐标输入添加临时节点：与地图点选共用同一桥层流程（doAddTempAt）
      async function promptAddTemp() {
        const ll = await promptLatLon('输入临时节点坐标');
        if (!ll) return;
        await doAddTempAt(ll);
      }

      async function removeTemp(t) {
        try {
          await ElMessageBox.confirm('确认删除临时节点 ' + t.displayId + ' ？', '删除确认', {
            confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning'
          });
        } catch (e) {
          return;
        }
        const r = Api.removeTemp(t.nodeId);
        if (!r.ok) return ElMessage.error(r.error);
        ElMessage.success(r.msg);
        applyWorldChange();
      }

      // ---------- 数据自检修复 ----------
      // 幽灵车（available 且无位置）自动恢复：与控制台「数据体检」第 2 轮同源
      function repairGhosts() {
        const r = Api.repairGhosts();
        if (!r.ok) return ElMessage.error(r.error);
        if (r.repaired > 0) {
          ElMessage.success('已自动恢复 ' + r.repaired + ' 辆位置缺失单车' +
            (r.skipped > 0 ? '（另有 ' + r.skipped + ' 辆无法自动恢复）' : ''));
          applyWorldChange();
        } else if (r.skipped > 0) {
          ElMessage.warning('有 ' + r.skipped + ' 辆单车位置缺失且无法自动恢复（缺少坐标），请编辑 bikes.csv 后重新导入');
        } else {
          ElMessage.info('没有需要恢复的单车位置');
        }
      }

      // ---------- 保存 / 导入 ----------
      function download(name, text) {
        const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      }

      async function doSave() {
        saving.value = true;
        try {
          await new Promise((r) => setTimeout(r, 0)); // 让出宏任务，先渲染 loading 态
          // P0-C：存在行级异常数据时，保存会丢弃这些行；先确认并提示会下载备份。
          const st = Api.status();
          const skipped = (st && (st.bikesSkipped || 0)) + (st && (st.tempsSkipped || 0));
          if (skipped > 0) {
            try {
              await ElMessageBox.confirm(
                '有 ' + skipped + ' 行异常数据未载入；保存会丢弃这些行，' +
                '原文件将作为 .pre-save.bak 一并下载。确认保存？',
                '异常数据确认',
                { confirmButtonText: '保存并下载备份', cancelButtonText: '取消', type: 'warning' }
              );
            } catch (e) {
              return;
            }
          }
          const r = Api.save();
          if (!r.ok && !r.partial) throw new Error(r.error);
          try {
            if (r.bikesCsv) download('bikes.csv', r.bikesCsv);
            if (r.tempsCsv) download('temps.csv', r.tempsCsv);
            if (r.bikesBackupCsv) download('bikes.csv.pre-save.bak', r.bikesBackupCsv);
            if (r.tempsBackupCsv) download('temps.csv.pre-save.bak', r.tempsBackupCsv);
          } catch (e) {
            ElMessage.warning('文件下载未完成（若浏览器拦截了多文件下载，请允许后重试），未保存标记已保留');
            return;
          }
          if (r.partial) {
            // 部分成功：成功侧文件已下载，失败侧未落盘；两边都保留脏标记，避免误报“已同步”
            refreshAll();
            ElMessage.warning((r.error || '保存部分成功') + '；已下载成功侧文件，未保存标记已保留。');
            return;
          }
          try {
            await ElMessageBox.confirm(
              '部分浏览器会静默拦截多个文件的下载。请确认 bikes.csv、temps.csv 及备份文件均已保存到本机，再点「均已保存」。',
              '确认保存结果',
              { confirmButtonText: '均已保存', cancelButtonText: '未全部保存', type: 'warning' }
            );
          } catch (e) {
            ElMessage.warning('未确认保存完成，未保存标记已保留');
            return;
          }
          const ms = Api.markSaved(r.revision);
          refreshAll();
          if (!ms || ms.ok === false) {
            // 桥层调用失败时 cleared 缺省，不能落入成功分支误报“已保存”
            ElMessage.error('保存标记失败：' + ((ms && ms.error) || '未知错误') + '；未保存标记已保留，请重试。');
            return;
          }
          if (ms.cleared !== true) {
            // 保存快照之后又有借还车/导入等修改：不能把脏标记清零
            ElMessage.warning('保存快照后数据又发生变化；已保留“未保存”提示，请再次保存。');
          } else {
            ElMessage.success('已保存并下载 bikes.csv / temps.csv');
            if (typeof confetti === 'function') {
              confetti({ particleCount: 120, spread: 70, origin: { y: 0.3 } }); // 保存成功的小庆祝
            }
          }
        } catch (e) {
          ElMessage.error(e.message);
        } finally {
          saving.value = false;
        }
      }

      // 导入行数上限（P2）：10MB 体积上限之外的兜底，防止超大行数拖垮解析/渲染
      const MAX_IMPORT_LINES = 10000;
      // 网页端单车/临时节点数量上限：超过后 UI 渲染与交互会明显变慢，引导拆分导入或使用控制台
      const MAX_WEB_BIKES = 2000;
      const MAX_WEB_TEMPS = 1000;
      const BIKES_CSV_HEADER = 'bike_id,status,node_id,lat,lon';
      const TEMPS_CSV_HEADER = 'temp_id,lat,lon,linked_parking';
      // 连续选择两个文件时，旧 FileReader/确认框的迟到回调不得覆盖新导入。
      let bikesImportGen = 0;
      let tempsImportGen = 0;
      function tooManyLines(text) {
        // 统计行数：尾换行不额外算一行（10000 行 + 尾换行应放行）
        let lines = 0;
        for (let i = 0; i < text.length; i++) {
          if (text.charCodeAt(i) === 10) lines++;
        }
        if (text.length && text.charCodeAt(text.length - 1) !== 10) lines++;
        return lines > MAX_IMPORT_LINES;
      }

      // CSV 非空数据行数（仅首个非空行与表头逐字匹配时跳过表头；空行/尾换行不计数）。
      // 纯 CR 换行无法可靠计数，返回 -1 由调用方拒绝，避免绕过网页端数量上限。
      function countCsvRows(text, header) {
        if (text.indexOf('\r') !== -1 && text.indexOf('\n') === -1) return -1;
        const rows = text.replace(/\r\n/g, '\n').split('\n');
        let count = 0;
        let firstNonEmpty = true;
        for (let i = 0; i < rows.length; i++) {
          let line = rows[i].replace(/\r$/, '');
          if (firstNonEmpty && line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
          if (!line) continue;
          if (firstNonEmpty) {
            firstNonEmpty = false;
            if (line === header) continue;
          }
          count++;
        }
        return count;
      }
      function countBikeRows(text) { return countCsvRows(text, BIKES_CSV_HEADER); }
      function countTempRows(text) { return countCsvRows(text, TEMPS_CSV_HEADER); }

      function readFileText(file, cb) {
        const reader = new FileReader();
        reader.onload = () => cb(String(reader.result));
        reader.onerror = () => ElMessage.error('文件读取失败');
        reader.readAsText(file, 'utf-8');
      }

      function onBikesFile(e) {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) return ElMessage.error('文件过大（超过 10MB），已取消导入');
        const gen = ++bikesImportGen;
        ElMessageBox.confirm(
          '导入将覆盖当前单车列表（共 ' + bikes.value.length + ' 辆）且不可撤销；不会删除现有临时节点。确认导入？' +
          (bikesDirty.value || tempsDirty.value ? '（当前有未保存的修改，导入后需重新保存）' : ''),
          '导入确认',
          { confirmButtonText: '导入', cancelButtonText: '取消', type: 'warning' }
        ).then(() => {
          if (gen !== bikesImportGen) return; // 已选择更新的文件
          readFileText(file, (text) => {
            if (gen !== bikesImportGen) return;
            if (tooManyLines(text)) return ElMessage.error('文件行数超过 ' + MAX_IMPORT_LINES + ' 行上限，已取消导入');
            const bikeRows = countBikeRows(text);
            if (bikeRows < 0) return ElMessage.error('文件使用纯 CR 换行（不支持），请转换为 LF 或 CRLF 后重试');
            if (bikeRows > MAX_WEB_BIKES) {
              return ElMessage.error('网页端最多支持 2000 辆单车，请拆分后导入或使用控制台');
            }
            // 先预检后提交（P2）：异常行会被跳过且不会进入新存档；
            // 存在异常行时先二次确认，避免用户误以为整份都导入了
            const pre = Api.precheckBikes(text);
            if (!pre.ok) return ElMessage.error(pre.error);
            const commit = () => {
              if (gen !== bikesImportGen) return;
              const r = Api.importBikes(text);
              if (!r.ok) return ElMessage.error(r.error);
              ElMessage.success('已导入 ' + r.count + ' 辆单车' + (r.fixed > 0 ? '（修复悬空引用 ' + r.fixed + ' 处）' : '') + (r.skipped > 0 ? '（跳过 ' + r.skipped + ' 行异常数据）' : ''));
              applyWorldChange();
            };
            if (pre.skipped > 0) {
              ElMessageBox.confirm(
                '解析到 ' + pre.count + ' 行有效、' + pre.skipped + ' 行格式异常；异常行将被跳过，且不会进入新存档（原文件不受影响）。继续导入？',
                '部分行无法导入',
                { confirmButtonText: '继续导入', cancelButtonText: '取消', type: 'warning' }
              ).then(commit).catch(() => {});
            } else {
              commit();
            }
          });
        }).catch(() => {});
      }

      function onTempsFile(e) {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) return ElMessage.error('文件过大（超过 10MB），已取消导入');
        const gen = ++tempsImportGen;
        ElMessageBox.confirm(
          '导入将覆盖当前临时节点列表（共 ' + temps.value.length + ' 个）且不可撤销，确认导入？' +
          (bikesDirty.value || tempsDirty.value ? '（当前有未保存的修改，导入后需重新保存）' : ''),
          '导入确认',
          { confirmButtonText: '导入', cancelButtonText: '取消', type: 'warning' }
        ).then(() => {
          if (gen !== tempsImportGen) return; // 已选择更新的文件
          readFileText(file, (text) => {
            if (gen !== tempsImportGen) return;
            if (tooManyLines(text)) return ElMessage.error('文件行数超过 ' + MAX_IMPORT_LINES + ' 行上限，已取消导入');
            const tempRows = countTempRows(text);
            if (tempRows < 0) return ElMessage.error('文件使用纯 CR 换行（不支持），请转换为 LF 或 CRLF 后重试');
            if (tempRows > MAX_WEB_TEMPS) {
              return ElMessage.error('网页端最多支持 ' + MAX_WEB_TEMPS + ' 个临时节点，请拆分后导入或使用控制台');
            }
            // 先预检后提交（P2）：同 onBikesFile，异常行需二次确认
            const pre = Api.precheckTemps(text);
            if (!pre.ok) return ElMessage.error(pre.error);
            const commit = () => {
              if (gen !== tempsImportGen) return;
              const r = Api.importTemps(text);
              if (!r.ok) return ElMessage.error(r.error);
              ElMessage.success('已导入 ' + r.count + ' 个临时节点' + (r.fixed > 0 ? '（修复悬空引用 ' + r.fixed + ' 处）' : '') + (r.skipped > 0 ? '（跳过 ' + r.skipped + ' 行异常数据）' : ''));
              applyWorldChange();
            };
            if (pre.skipped > 0) {
              ElMessageBox.confirm(
                '解析到 ' + pre.count + ' 个有效、' + pre.skipped + ' 行格式异常；异常行将被跳过，且不会进入新存档（原文件不受影响）。继续导入？',
                '部分行无法导入',
                { confirmButtonText: '继续导入', cancelButtonText: '取消', type: 'warning' }
              ).then(commit).catch(() => {});
            } else {
              commit();
            }
          });
        }).catch(() => {});
      }

      // ---------- 展示辅助 ----------
      // 零依赖提示音（WebAudio 振荡器；默认关闭；无外部音频素材）
      let audioCtx = null;
      function beep(freq, dur) {
        if (!soundOn.value) return;
        try {
          audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
          const o = audioCtx.createOscillator();
          const g = audioCtx.createGain();
          o.type = 'sine';
          o.frequency.value = freq;
          g.gain.setValueAtTime(0.06, audioCtx.currentTime);
          g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
          o.connect(g);
          g.connect(audioCtx.destination);
          o.start();
          o.stop(audioCtx.currentTime + dur);
        } catch (e) { /* 音频失败不影响功能 */ }
      }

      // 回放到达终点：在该点的屏幕位置撒一小撮彩带（到点反馈；纯展示）
      function burstAtEnd() {
        try {
          const path = (qResult.value && qResult.value.path) || [];
          if (!path.length) return;
          const last = graphNodes.value.find((n) => n.id === path[path.length - 1]);
          const map = MapCtl.getMap();
          if (!last || !map || typeof confetti !== 'function') return;
          const p = map.latLngToContainerPoint([last.lat, last.lon]);
          const r = map.getContainer().getBoundingClientRect();
          confetti({
            particleCount: 70, spread: 65, startVelocity: 30, scalar: .9, ticks: 160,
            origin: { x: (r.left + p.x) / window.innerWidth, y: (r.top + p.y) / window.innerHeight }
          });
        } catch (e) { /* 纯展示失败不影响功能 */ }
      }

      // 数字滚动（纯展示）：easeOutCubic 把显示值从 from 动画到 to
      // key：同一展示目标的滚动动画互斥（连点/连续刷新时取消上一条，防止多条 rAF 抢写）
      const tweenRafs = {};
      function tweenNumber(from, to, upd, dur, key) {
        if (key && tweenRafs[key]) { cancelAnimationFrame(tweenRafs[key]); tweenRafs[key] = 0; }
        const d = dur || 650;
        if (!isFinite(to)) { upd(to); return; }
        const t0 = performance.now();
        const step = (t) => {
          const k = Math.max(0, Math.min(1, (t - t0) / d)); // rAF 首帧时间戳可能早于 t0，钳位防负值闪现
          const e = 1 - Math.pow(1 - k, 3);
          upd(from + (to - from) * e);
          if (k < 1) { const raf = requestAnimationFrame(step); if (key) tweenRafs[key] = raf; }
          else if (key) tweenRafs[key] = 0;
        };
        const raf0 = requestAnimationFrame(step);
        if (key) tweenRafs[key] = raf0;
      }

      function toggleSound() {
        soundOn.value = !soundOn.value;
        writeSetting(SETTING_KEYS.soundOn, soundOn.value);
        if (soundOn.value) beep(660, 0.12); // 开启时给一声反馈
      }

      function toggleDark() {
        dark.value = !dark.value;
        writeSetting(SETTING_KEYS.dark, dark.value);
        document.documentElement.classList.toggle('dark', dark.value);
        document.body.classList.toggle('dark', dark.value);
        charts.update(); // 图表墨色随夜模式同步（纯展示）
      }

      // 回放控制条（包装 map.js 的 TrackPlayer 接口；不改任何业务数据）
      function trackToggle() {
        track.playing = MapCtl.trackToggle();
      }
      function trackReplay() {
        if (!MapCtl.trackReplay()) return;
        track.playing = true;
        track.progress = 0;
      }
      function trackSetSpeed(v) {
        track.speed = v;
        MapCtl.trackSetSpeed(v);
      }
      // 拖动进度条定位（优先原生 input[type=range]；与 track 对象联动，播放态由 vendor 继续推进）
      function trackSeekOnInput(e) {
        const playing = MapCtl.trackSeek(Number(e.target.value) / 1000);
        if (playing == null) return;
        track.progress = Number(e.target.value) / 1000;
        track.playing = playing;
      }
      MapCtl.onTrackProgress((p) => { track.progress = p; });
      MapCtl.onTrackFinished(() => {
        track.playing = false; track.progress = 1;
        burstAtEnd(); // 到点彩带反馈
        if (soundOn.value) { beep(660, .09); setTimeout(() => beep(880, .14), 95); } // 到点和弦
      });
      // 路径被新一次绘制/清理顶替（含图变化后的重绘）：回放状态归零
      MapCtl.onTrackHalt(() => { track.playing = false; track.progress = 0; });

      // ---------- 数据洞察（app-charts.js composable；数据来自 WASM 桥层） ----------
      const charts = window.CampusCharts.create({
        loadScript: loadScript,
        ElMessage: ElMessage,
        nextTick: nextTick,
        getNodes: () => graphNodes.value,
        getEdges: () => graphEdges.value,
        fillEdges: () => { const g = safeGraph(); if (!g) return null; graphEdges.value = g.edges; return g.edges; },
        isDark: () => dark.value,
        isActive: () => activeTab.value === 'insight'
      });


      // 节点连接热力图（数据来自缓存图数据；纯渲染）
      // 依据当前图数据重算热力点（节点度数归一）；refreshAll 复用它保持热力最新
      function heatPoints() {
        if (!graphNodes.value.length) return []; // 无图数据：空热力点
        const deg = {};
        graphEdges.value.forEach((e) => { deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; });
        return graphNodes.value.map((n) => [n.lat, n.lon, Math.min(1, (deg[n.id] || 0) / 6)]);
      }

      function toggleHeat() {
        if (heat.value) {
          MapCtl.removeHeat();
          heat.value = false;
          writeSetting(SETTING_KEYS.heat, false);
          return;
        }
        heat.value = MapCtl.addHeat(heatPoints());
        writeSetting(SETTING_KEYS.heat, heat.value);
        if (!heat.value) ElMessage.warning('热力图组件未加载');
      }

      // HTML 转义（P1-5）：桥层/CSV 来源的文本拼进 ElMessageBox 的
      // dangerouslyUseHTMLString 消息前必须转义，防止名称含标记破坏布局/注入。
      function esc(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      function fmtDist(m) {
        if (m == null || !isFinite(m)) return '?';
        return m >= 1000 ? (m / 1000).toFixed(2) + ' 公里' : m.toFixed(1) + ' 米';
      }

      function fmtMeters(m) {
        if (m == null) return '?';
        return m >= 1000 ? (m / 1000).toFixed(2) + ' 公里' : m + ' 米';
      }

      function segDir(s) {
        if (s.anomalous) return '距离数据异常';
        if (s.meters === 0 || s.deg < 0) return '重合点';
        return '向' + s.compass + '（≈' + s.deg + '°）约 ' + fmtMeters(s.meters);
      }

      // 推荐路线对比标签：第 1 条最优；与最优距离相同（浮点容差）标「并列」，其余附与最优的距离差
      function routeTag(i) {
        const r = qRoutes.value[i];
        if (!r) return '';
        if (i === 0) return '最优';
        const d = r.dist - qRoutes.value[0].dist;
        return Math.abs(d) < 1e-6 ? '并列' : '备选 +' + fmtMeters(Math.round(d));
      }

      function fitAll() {
        MapCtl.fitAll();
      }

      // ---------- 在线底图（高德 GCJ-02，与数据坐标系一致；失败自动回退离线） ----------
      function toggleOnline(opts) {
        const silent = opts === true; // 仅启动默认开启时静默，避免首屏弹提示
        // 用户切换时清掉过期提示，避免消息堆叠遮挡工具按钮；静默启动不清，
        // 否则会吞掉启动自检/异常行警告。启动警告本身也已移到 toggleOnline(true) 之后。
        if (!silent) ElMessage.closeAll();
        if (online.value) {
          if (tileLayer) tileLayer.off('tileerror');
          MapCtl.removeLayer(tileLayer);
          tileLayer = null;
          online.value = false;
          ElMessage.info('已切换回离线矢量底图');
        } else {
          tileLayer = MapCtl.addTile(ONLINE_TILE_URL, ONLINE_TILE_OPTS);
          online.value = true;
          let errs = 0;
          const layer = tileLayer;
          layer.on('tileerror', () => {
            if (layer !== tileLayer) return; // 忽略旧会话迟到的错误事件
            errs++;
            if (errs >= 3 && online.value) {
              toggleOnline(); // 先切回离线（内部会清掉旧提示），再显示回退警告
              ElMessage.warning('在线瓦片加载失败，已回退离线底图');
            }
          });
          if (!silent) ElMessage.success('已开启在线底图（高德地图）');
        }
        MapCtl.setMiniMapBase(online.value ? ONLINE_TILE_URL : null, online.value ? ONLINE_TILE_OPTS : null); // 小地图底图随主图同步
      }

      // 列表增删的自动动画（auto-animate；纯展示，失败不影响功能）
      function bindAutoAnimate() {
        try {
          if (!window.AutoAnimate || typeof window.AutoAnimate.autoAnimate !== 'function') return;
          document.querySelectorAll('.bike-list, .temp-list').forEach((elm) => {
            if (elm.dataset.aaBound) return;
            elm.dataset.aaBound = '1';
            window.AutoAnimate.autoAnimate(elm, { duration: 220, easing: 'ease-out' });
          });
        } catch (e) { /* 纯展示 */ }
      }

      // 切到「数据洞察」时懒加载并初始化图表（容器在 tab 内，需等渲染完成）；
      // 切走时取消未完成的隐藏容器初始化并保留已初始化实例（安全 setOption），
      // 避免 0×0 画布/迟到回调，也保证离屏新增数据后切回立即可见。
      watch(activeTab, (tab) => {
        if (tab === 'insight') charts.ensure();
        else charts.leave();
        nextTick(bindAutoAnimate);
      });

      // 启动页粒子懒加载（P1-5）：异步注入，不阻塞首帧；跳过/失败时静态启动页照常展示
      let particlesLoader = null;
      function ensureParticles() {
        if (fastMode || particlesLoader) return;
        particlesLoader = loadScript('vendor/tsparticles.slim.bundle.min.js')
          .then(() => startParticles())
          .catch(() => {}); // 纯展示：失败静默
      }
      function startParticles() {
        // 已启动/已进入主界面/库缺失时跳过（晚到的加载结果不再建实例）
        if (bootParticles || booted.value || !window.tsParticles) return;
        const host = document.getElementById('boot-particles');
        if (!host) return;
        window.tsParticles
          .load({
            element: host,
            fpsLimit: 60,
            detectRetina: true,
            particles: {
              number: { value: 40, density: { enable: true } },
              color: { value: ['#7fd3ab', '#8ab4ff', '#ffffff'] },
              opacity: { value: { min: 0.15, max: 0.5 } },
              size: { value: { min: 1, max: 2.5 } },
              move: { enable: true, speed: 1.1, direction: 'top', outModes: { default: 'out' } },
              links: { enable: true, distance: 120, color: '#7fd3ab', opacity: 0.12, width: 1 },
            },
          })
          .then((inst) => { bootParticles = inst; })
          .catch(() => { bootParticles = null; });
      }

      // ---------- 启动 ----------
      onMounted(async () => {
        // 静态启动壳已完成使命：Vue 已挂载，后续启动/错误反馈由 Vue 启动页接管。
        const bootShell = document.getElementById('boot-fallback');
        if (bootShell) bootShell.remove();
        // 启动看门狗：任何阶段无响应（例如引擎/地图初始化挂起）都要给出可重试的明确提示。
        let bootWatchdog = setTimeout(() => {
          if (booted.value) return;
          bootError.value = '启动超时（超过 20 秒），请点击重试或刷新页面';
          window.__APP_READY__ = 'error';
        }, BOOT_WATCHDOG_MS);
        const bootT0 = performance.now();
        ensureParticles(); // 启动页粒子按需注入（纯展示，失败静默）
        // 分阶段节拍：每阶段至少展示约 350ms，总时长下限 1.5s（答辩开场观感；不影响真实加载）
        // ?fast=1 或点过「跳过动画」后不再等待（数据加载本身不受影响）
        const pace = async (minTotal) => {
          if (fastMode || skipPace.value) return;
          const remain = minTotal - (performance.now() - bootT0);
          if (remain <= 0) return;
          await new Promise((res) => {
            paceResolve = res;
            setTimeout(() => { if (paceResolve === res) paceResolve = null; res(); }, remain);
          });
        };
        try {
          await Api.init();
          bootPhase.value = 1; // 加载校园路网与单车数据…
          await pace(430);
          const D = window.CAMPUS_DATA;
          const r = Api.load(D.nodes, D.edges, D.bikes, D.temps);
          if (!r.ok) throw new Error(r.error);
          bootPhase.value = 2; // 初始化地图与渲染…
          stats.edges = r.edges;
          await pace(860);
          bootPhase.value = 3; // 准备就绪
          await pace(1500);
          // F2：booted 是「全部初始化成功」的标记，必须在 MapCtl.init/refreshAll/
          // applyShareHash/bindAutoAnimate 之后才置 true；布局常驻（启动页为遮罩层），
          // 因此 catch 时 booted 保持 false，启动页仍可显示 bootError 与「重试」。
          setTimeout(() => {
            if (bootParticles) { bootParticles.destroy(); bootParticles = null; }
          }, 900);
          await nextTick();
          MapCtl.init('map');
          MapCtl.onMapClick(onMapClick);
          toggleOnline(true); // 默认开启在线底图；瓦片连续失败会自动回退离线
          // 启动自检提示放在 toggleOnline(true) 之后：后者会 closeAll 清理过期消息，
          // 若先提示会被静默启动路径一并清掉，导致异常行警告不可见。
          if (r.fixed > 0 || r.gc > 0) {
            ElMessage.info('启动自检：修复位置引用 ' + r.fixed + ' 处，回收孤儿临时节点 ' + r.gc + ' 个');
          }
          // 局部载入必须可见：节点/边/单车/临时节点任一被跳过，或临时节点文件不可读，
          // 都要提示；否则查询/保存会在残缺世界上继续。
          {
            const issues = [];
            if (r.nodesSkipped > 0) issues.push('节点 ' + r.nodesSkipped + ' 行');
            if (r.edgesSkipped > 0) issues.push('边 ' + r.edgesSkipped + ' 行');
            if (r.bikesSkipped > 0) issues.push('单车 ' + r.bikesSkipped + ' 行');
            if (r.tempsSkipped > 0) issues.push('临时节点 ' + r.tempsSkipped + ' 行');
            if (r.tempsLoadOk === false) issues.push('temps.csv 无法读取');
            if (r.bikesLoadOk === false) issues.push('单车数据不完整');
            if (issues.length) {
              ElMessage.warning(
                '部分数据未完整载入：' + issues.join('；') +
                '。本次启动未回收孤儿临时节点，请检查对应 CSV 后重新导入。'
              );
            }
          }
          const graph = safeGraph(); // 复用形状兜底（P2：消除重复 getGraph 裸调用）
          if (!graph) throw new Error('图数据读取失败');
          graphNodes.value = graph.nodes;
          graphEdges.value = graph.edges;
          MapCtl.renderGraph(graph, { fit: true });
          refreshAll();
          applyShareHash(); // 分享链接恢复：仅预填表单（保守，不自动查询）
          bindAutoAnimate();
          await nextTick();
          labelQuerySelects();
          clearTimeout(bootWatchdog);
          bootWatchdog = 0;
          bootError.value = '';
          booted.value = true;
          window.__APP_READY__ = true;
        } catch (err) {
          clearTimeout(bootWatchdog);
          bootWatchdog = 0;
          booted.value = false; // MapCtl.init 等中途失败时退回启动页（布局可能已挂载）
          bootError.value = String((err && err.message) || err);
          window.__APP_READY__ = 'error';
          if (bootParticles) { bootParticles.destroy(); bootParticles = null; } // 启动失败回收启动页粒子
        }
      });

      // F2：启动失败重试（整页重载，WASM/地图/数据全部重新初始化）
      function retryBoot() {
        location.reload();
      }

      // 查询下拉的可访问名称：Element Plus 把 aria-label 落在组件根节点，
      // 这里补到真正的 combobox input 上（屏幕阅读器/自动化都按 input 识别）。
      function labelQuerySelects() {
        const labels = ['起点', '终点', '途经点（多段导航）'];
        const wraps = document.querySelectorAll('#pane-query .el-select');
        wraps.forEach((wrap, i) => {
          const label = labels[i];
          if (!label) return;
          wrap.setAttribute('aria-label', label);
          const input = wrap.querySelector('input.el-select__input');
          if (input) input.setAttribute('aria-label', label);
        });
      }

      // F3：skip link 跳到查询面板；若当前在其它标签页，先切回查询再聚焦
      function skipToQuery() {
        activeTab.value = 'query';
        nextTick(() => {
          labelQuerySelects();
          const pane = document.getElementById('pane-query');
          if (!pane) return;
          pane.setAttribute('tabindex', '-1');
          try { pane.focus({ preventScroll: true }); } catch (e) { pane.focus(); }
          pane.scrollIntoView({ block: 'start' });
        });
      }

      async function onMapClick(latlng) {
        if (!pick.active) return;
        const purpose = pick.purpose;
        const payload = pick.payload;
        pick.active = false;
        pick.purpose = null;
        pick.payload = null;
        pickHint.value = '';
        if (purpose === 'from' || purpose === 'to') {
          const r = Api.nearestNode(latlng.lat, latlng.lng);
          if (!r.ok) return ElMessage.error(r.error);
          q[purpose] = r.id;
          MapCtl.showPick(latlng, r.name);
          ElMessage.success('已选择' + (purpose === 'from' ? '起点' : '终点') + '：' + r.name);
        } else if (purpose === 'return') {
          await doReturnAt(payload, latlng);
        } else if (purpose === 'temp') {
          await doAddTempAt(latlng);
        } else if (purpose === 'parking') {
          const r = Api.nearestParking(latlng.lat, latlng.lng);
          if (!r.ok) return ElMessage.error(r.error);
          MapCtl.showPick(latlng, r.name);
          ElMessage.success('最近停车场：' + r.name + '（约 ' + fmtDist(r.dist) + ' 米）');
        }
      }

      // 未保存修改时拦截刷新/关闭（浏览器弹原生确认框，文案由浏览器决定）
      function onBeforeUnload(e) {
        if (!bikesDirty.value && !tempsDirty.value) return;
        e.preventDefault();
        e.returnValue = '';
      }
      window.addEventListener('beforeunload', onBeforeUnload);

      // Esc 取消地图点选模式（与「取消点选」按钮共用 cancelPick）
      function onKeydown(e) {
        if (e.key === 'Escape' && pick.active) cancelPick();
      }
      window.addEventListener('keydown', onKeydown);

      // 演示引导：Element Plus 内置 Tour（无额外依赖），只指路不代点（不改变数据）；
      // 步骤用 el-tour-step 子组件声明（EP 2.14 的 Tour 无 steps prop）
      const tourOpen = ref(false);
      function startTour() { tourOpen.value = true; }

      // ---------- 自动演示导演（app-demo.js composable；会修改数据，刷新页面可重置） ----------
      const demoDirector = window.CampusDemo.create({
        loadScript: loadScript,
        ElMessage: ElMessage,
        beep: beep,
        graphNodes: graphNodes,
        bikes: bikes,
        stats: stats,
        q: q,
        activeTab: activeTab,
        pick: pick,
        pickHint: pickHint,
        fitAll: fitAll,
        refreshAll: refreshAll,
        rerenderGraph: rerenderGraph,
        clearQuery: clearQuery,
        doShortest: doShortest,
        doMinHops: doMinHops,
        doMulti: doMulti,
        bikeLocation: bikeLocation,
        pausePlayback: () => {
          try { MapCtl.trackPause(); } catch (e) { /* 无回放实例时忽略 */ }
          track.playing = false;
        },
        onlineTiles: () => (tileLayer ? { url: ONLINE_TILE_URL, opts: ONLINE_TILE_OPTS } : null)
      });
      const startDemo = demoDirector.startDemo;

      return {
        booted, bootError, bootPhase, bootPhases, fastMode, skipBootPace, activeTab, stats, statsView, graphNodes, nodeOptions,
        nodeOptionsView, nodeFilter, onNodeMenuToggle,
        q, qResult, qKind, qDistView, qHopsView, qNotice, pickHint, online, qRoutes, qRouteIdx,
        bikes, pagedBikes, bikePage, bikePageCount, BIKE_PAGE_SIZE,
        temps, bikesDirty, tempsDirty, saving, bikesInput, tempsInput,
        dark, soundOn, track, toggleDark, toggleSound, trackToggle, trackReplay, trackSetSpeed, trackSeekOnInput,
        pickFor, doShortest, doMinHops, doMulti, doTopPaths, pickRoute, clearQuery, fitAll, toggleOnline,
        cancelPick, retryBoot, skipToQuery,
        shareQuery, stopName, traceToggle, traceRunning, traceCaption, stopsListEl,
        statusText, statusTagType, bikeLocation, borrow, startReturn, removeTemp, repairGhosts,
        promptReturn, promptAddTemp,
        doSave, onBikesFile, onTempsFile, fmtDist, segDir, routeTag, startTour, startDemo,
        heat, toggleHeat, toolsOpen, tourOpen,
      };
    }
  };

  const app = createApp(App);
  const epOpts = {};
  if (window.ElementPlusLocaleZhCn) epOpts.locale = window.ElementPlusLocaleZhCn;
  app.use(ElementPlus, epOpts);
  app.mount('#app');
})();
