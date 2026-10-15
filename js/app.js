// app.js —— Vue3 + Element Plus 应用：面板交互、状态管理、桥层调用编排。
// 业务规则全部在 C++（src/）中，本文件只做 UI 流程与展示。
(function () {
  const { createApp, ref, reactive, computed, onMounted, nextTick, watch } = Vue;
  const { ElMessage, ElMessageBox } = ElementPlus;

  const App = {
    setup() {
      const booted = ref(false);
      const bootError = ref('');
      let bootParticles = null; // 启动页粒子实例（纯展示，加载失败静默降级）
      // 启动页分阶段文案（纯展示，不改变加载流程）
      const bootPhases = ['启动 WASM 导航引擎…', '加载校园路网与单车数据…', '初始化地图与渲染…', '准备就绪'];
      const bootPhase = ref(0);
      const activeTab = ref('query');
      const stats = reactive({ nodes: 0, edges: 0, bikes: 0, temps: 0 });
      const statsView = reactive({ nodes: 0, edges: 0, bikes: 0, temps: 0 }); // 展示用（数字滚动）

      // ---------- 数据 ----------
      const graphNodes = ref([]);
      const bikes = ref([]);
      const temps = ref([]);
      const bikesDirty = ref(false);
      const tempsDirty = ref(false);
      const saving = ref(false);
      const bikesInput = ref(null);
      const tempsInput = ref(null);
      const dark = ref(false);        // 夜模式（纯视觉，body.dark）
      const soundOn = ref(false);     // 提示音（默认关闭，WebAudio 零素材）
      const track = reactive({ playing: false, progress: 0, speed: 400 }); // 回放控制条状态
      const heat = ref(false);        // 节点连接热力图开关（纯视觉）
      let chartsInited = false;       // 数据洞察图表是否已初始化
      let chartDeg = null, chartTypes = null, chartWeights = null, chart3d = null;

      const nodeOptions = computed(() =>
        graphNodes.value.map((n) => ({
          id: n.id,
          label: n.isTemp ? 'T' + -n.id + '（临时节点）' : n.name + '（#' + n.id + '）'
        }))
      );

      // ---------- 查询 ----------
      const q = reactive({ from: null, to: null, stops: [] });
      const qResult = ref(null);
      const qKind = ref('');
      const qDistView = ref(0); // 结果卡数字滚动（总距离，米）
      const qHopsView = ref(0); // 结果卡数字滚动（最少跳数）

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

      function refreshAll() {
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
        stats.nodes = st.nodes;
        stats.edges = Api.getGraph().edges.length; // 与渲染同口径（含临时边）
        stats.bikes = st.bikes;
        stats.temps = st.temps;
        bikesDirty.value = st.bikesDirty;
        tempsDirty.value = st.tempsDirty;
        tweenNumber(statsView.nodes, stats.nodes, (v) => { statsView.nodes = Math.round(v); }, 650, 'nodes');
        tweenNumber(statsView.edges, stats.edges, (v) => { statsView.edges = Math.round(v); }, 650, 'edges');
        tweenNumber(statsView.bikes, stats.bikes, (v) => { statsView.bikes = Math.round(v); }, 650, 'bikes');
        tweenNumber(statsView.temps, stats.temps, (v) => { statsView.temps = Math.round(v); }, 650, 'temps');
        MapCtl.renderBikes(bikes.value); // 单车图层：与车辆状态同步刷新
        if (heat.value) { heat.value = MapCtl.addHeat(heatPoints()); } // 热力图开启时随图数据刷新
        updateCharts(); // 数据洞察图表（已初始化时才更新）
      }

      // 图数据变化后重绘（保留当前视图），并尽量恢复已绘制的路径
      function rerenderGraph() {
        const graph = Api.getGraph();
        graphNodes.value = graph.nodes;
        MapCtl.renderGraph(graph, { fit: false });
        pruneStaleQueryState();
        // 只重绘不重播：动画与自动回放关闭，回放状态由 onTrackHalt 统一复位
        if (qResult.value && qResult.value.path) {
          MapCtl.drawPath(qResult.value.path, { animate: false, autoplay: false, fit: false, speed: track.speed });
        }
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
        const path = qResult.value && qResult.value.path;
        if (path && path.some((id) => !present.has(id))) {
          qResult.value = null;
          qKind.value = '';
          MapCtl.clearPath();
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

      // ---------- 查询动作 ----------
      function doShortest(opts) {
        if (q.from == null || q.to == null) return ElMessage.warning('请先选择起点和终点');
        const r = Api.shortestPath(q.from, q.to);
        if (!r.ok) {
          qResult.value = null;
          MapCtl.clearPath();
          return ElMessage.error(r.error);
        }
        qKind.value = 'shortest';
        qResult.value = r;
        qDistView.value = 0;
        tweenNumber(0, r.dist, (v) => { qDistView.value = v; }, 650, 'dist');
        MapCtl.drawPath(r.path, { speed: track.speed, follow: !!(opts && opts.follow) });
        track.playing = true;
        track.progress = 0;
        beep(520, 0.08);
        if (typeof confetti === 'function') confetti({ particleCount: 60, spread: 55, origin: { y: 0.35 } });
      }

      function doMinHops(opts) {
        if (q.from == null || q.to == null) return ElMessage.warning('请先选择起点和终点');
        const r = Api.minHops(q.from, q.to);
        if (!r.ok) {
          qResult.value = null;
          MapCtl.clearPath();
          return ElMessage.error(r.error);
        }
        qKind.value = 'minhops';
        qResult.value = r;
        qHopsView.value = 0;
        tweenNumber(0, r.hops, (v) => { qHopsView.value = Math.round(v); }, 650, 'hops');
        MapCtl.drawPath(r.path, { speed: track.speed, follow: !!(opts && opts.follow) });
        track.playing = true;
        track.progress = 0;
        beep(520, 0.08);
      }

      function doMulti(opts) {
        if (!q.stops || q.stops.length < 2) return ElMessage.warning('多段导航至少选择 2 个节点');
        if (q.stops.length > 100) return ElMessage.warning('站点数量需在 2 ~ 100 之间');
        const r = Api.multiStep(q.stops.join(','));
        if (!r.ok) {
          qResult.value = null;
          MapCtl.clearPath();
          return ElMessage.error(r.error);
        }
        qKind.value = 'multi';
        qResult.value = r;
        qDistView.value = 0;
        tweenNumber(0, r.dist, (v) => { qDistView.value = v; }, 650, 'dist');
        MapCtl.drawPath(r.path, { speed: (opts && opts.speed) || track.speed, follow: !!(opts && opts.follow) });
        track.playing = true;
        track.progress = 0;
        beep(520, 0.08);
        if (typeof confetti === 'function') confetti({ particleCount: 60, spread: 55, origin: { y: 0.35 } });
      }

      function clearQuery() {
        qResult.value = null;
        qKind.value = '';
        qDistView.value = 0;
        qHopsView.value = 0;
        MapCtl.clearPath();
        MapCtl.clearMisc();
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
        refreshAll();
        rerenderGraph();
      }

      function startReturn(b) {
        pickFor('return', b);
      }

      async function doReturnAt(b, latlng) {
        MapCtl.showPick(latlng, b.bikeId);
        let msg = '还车位置：(' + latlng.lat.toFixed(6) + ', ' + latlng.lng.toFixed(6) + ')<br>';
        const rp = Api.returnPreview(latlng.lat, latlng.lng);
        if (rp.ok) {
          const rad = rp.radius; // 桥层已返回生效半径（radius>0 或默认 10），无需再兜底
          msg += rp.covered
            ? '距停车场「' + rp.name + '」约 ' + fmtDist(rp.dist) + ' 米（停放半径 ' + fmtDist(rad) + ' 米），将归位到该停车场。'
            : '距最近停车场「' + rp.name + '」约 ' + fmtDist(rp.dist) + ' 米（超出其停放半径 ' + fmtDist(rad) + ' 米），将创建临时节点（挂靠该停车场）。';
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
        refreshAll();
        rerenderGraph();
      }

      // ---------- 临时节点 ----------
      async function doAddTempAt(latlng) {
        MapCtl.showPick(latlng, '新临时节点');
        const np = Api.nearestParking(latlng.lat, latlng.lng);
        const pid = np.ok ? np.parkingId : 0;
        const pkName = np.ok ? np.name + '（约 ' + fmtDist(np.dist) + ' 米）' : '无';
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
        refreshAll();
        rerenderGraph();
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
        refreshAll();
        rerenderGraph();
      }

      // ---------- 数据自检修复 ----------
      // 幽灵车（available 且无位置）自动恢复：与控制台「数据体检」第 2 轮同源
      function repairGhosts() {
        const r = Api.repairGhosts();
        if (!r.ok) return ElMessage.error(r.error);
        if (r.repaired > 0) {
          ElMessage.success('已自动恢复 ' + r.repaired + ' 辆位置缺失单车' +
            (r.skipped > 0 ? '（另有 ' + r.skipped + ' 辆无法自动恢复）' : ''));
          refreshAll();
          rerenderGraph();
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
          const r = Api.save();
          if (!r.ok) throw new Error(r.error);
          try {
            download('bikes.csv', r.bikesCsv);
            download('temps.csv', r.tempsCsv);
          } catch (e) {
            ElMessage.warning('文件下载未完成（若浏览器拦截了多文件下载，请允许后重试），未保存标记已保留');
            return;
          }
          try {
            await ElMessageBox.confirm(
              '部分浏览器会静默拦截第二个文件的下载。请确认 bikes.csv 与 temps.csv 均已保存到本机，再点「均已保存」。',
              '确认保存结果',
              { confirmButtonText: '均已保存', cancelButtonText: '未全部保存', type: 'warning' }
            );
          } catch (e) {
            ElMessage.warning('未确认保存完成，未保存标记已保留');
            return;
          }
          Api.markSaved();
          refreshAll();
          ElMessage.success('已保存并下载 bikes.csv / temps.csv');
          if (typeof confetti === 'function') {
            confetti({ particleCount: 120, spread: 70, origin: { y: 0.3 } }); // 保存成功的小庆祝
          }
        } catch (e) {
          ElMessage.error(e.message);
        } finally {
          saving.value = false;
        }
      }

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
        ElMessageBox.confirm(
          '导入将覆盖当前单车列表（共 ' + bikes.value.length + ' 辆）且不可撤销，确认导入？' +
          (bikesDirty.value || tempsDirty.value ? '（当前有未保存的修改，导入后需重新保存）' : ''),
          '导入确认',
          { confirmButtonText: '导入', cancelButtonText: '取消', type: 'warning' }
        ).then(() => {
          readFileText(file, (text) => {
            const r = Api.importBikes(text);
            if (!r.ok) return ElMessage.error(r.error);
            ElMessage.success('已导入 ' + r.count + ' 辆单车' + (r.fixed > 0 ? '（修复悬空引用 ' + r.fixed + ' 处）' : '') + (r.skipped > 0 ? '（跳过 ' + r.skipped + ' 行异常数据）' : ''));
            refreshAll();
            rerenderGraph();
          });
        }).catch(() => {});
      }

      function onTempsFile(e) {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) return ElMessage.error('文件过大（超过 10MB），已取消导入');
        ElMessageBox.confirm(
          '导入将覆盖当前临时节点列表（共 ' + temps.value.length + ' 个）且不可撤销，确认导入？' +
          (bikesDirty.value || tempsDirty.value ? '（当前有未保存的修改，导入后需重新保存）' : ''),
          '导入确认',
          { confirmButtonText: '导入', cancelButtonText: '取消', type: 'warning' }
        ).then(() => {
          readFileText(file, (text) => {
            const r = Api.importTemps(text);
            if (!r.ok) return ElMessage.error(r.error);
            ElMessage.success('已导入 ' + r.count + ' 个临时节点' + (r.fixed > 0 ? '（修复悬空引用 ' + r.fixed + ' 处）' : '') + (r.skipped > 0 ? '（跳过 ' + r.skipped + ' 行异常数据）' : ''));
            refreshAll();
            rerenderGraph();
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
        if (soundOn.value) beep(660, 0.12); // 开启时给一声反馈
      }

      function toggleDark() {
        dark.value = !dark.value;
        document.body.classList.toggle('dark', dark.value);
        updateCharts(); // 图表墨色随夜模式同步（纯展示）
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
      MapCtl.onTrackProgress((p) => { track.progress = p; });
      MapCtl.onTrackFinished(() => {
        track.playing = false; track.progress = 1;
        burstAtEnd(); // 到点彩带反馈
        if (soundOn.value) { beep(660, .09); setTimeout(() => beep(880, .14), 95); } // 到点和弦
      });
      // 路径被新一次绘制/清理顶替（含图变化后的重绘）：回放状态归零
      MapCtl.onTrackHalt(() => { track.playing = false; track.progress = 0; });

      // ---------- 数据洞察（ECharts 仪表盘；数据全部来自 WASM 桥层） ----------
      // 图表墨色：随夜模式切换（纯展示配色）
      function chartInk() {
        return dark.value
          ? { text: '#cfdcd4', axis: '#93a89c', split: 'rgba(147,168,156,.22)' }
          : { text: '#33413a', axis: '#7d8a82', split: 'rgba(0,0,0,.08)' };
      }

      function updateCharts() {
        if (!chartsInited) return;
        const graph = Api.getGraph();
        const ink = chartInk();
        // 节点度数分布（无向边计度）
        const deg = {};
        graph.edges.forEach((e) => { deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; });
        const db = [0, 0, 0, 0, 0]; // 0 / 1 / 2 / 3-4 / 5+
        graph.nodes.forEach((n) => {
          const k = deg[n.id] || 0;
          db[k === 0 ? 0 : k === 1 ? 1 : k === 2 ? 2 : k <= 4 ? 3 : 4]++;
        });
        chartDeg.setOption({
          title: { text: '节点度数分布', left: 'center', textStyle: { fontSize: 12, color: ink.text } },
          grid: { left: 36, right: 12, top: 30, bottom: 22 },
          xAxis: { type: 'category', data: ['0', '1', '2', '3-4', '5+'], axisLabel: { fontSize: 10, color: ink.axis } },
          yAxis: { type: 'value', axisLabel: { fontSize: 10, color: ink.axis }, splitLine: { lineStyle: { color: ink.split } } },
          series: [{ type: 'bar', data: db, itemStyle: { color: '#1f9d6b' }, barWidth: '55%' }]
        });
        // 节点类型占比
        const types = {};
        graph.nodes.forEach((n) => {
          const t = n.isTemp ? 'temp' : (n.type || 'other');
          types[t] = (types[t] || 0) + 1;
        });
        const typeName = { intersection: '路口', building: '建筑', parking: '停车场', temp: '临时节点', other: '其他' };
        chartTypes.setOption({
          title: { text: '节点类型', left: 'center', textStyle: { fontSize: 12, color: ink.text } },
          series: [{
            type: 'pie', radius: ['34%', '60%'], center: ['50%', '58%'],
            label: { fontSize: 10, formatter: '{b} {c}', color: ink.text },
            data: Object.keys(types).map((k) => ({ name: typeName[k] || k, value: types[k] }))
          }]
        });
        // 路段长度分布（米）
        const wb = [0, 0, 0, 0, 0]; // <50 / 50-100 / 100-200 / 200-500 / 500+
        graph.edges.forEach((e) => { const m = e.weight; wb[m < 50 ? 0 : m < 100 ? 1 : m < 200 ? 2 : m < 500 ? 3 : 4]++; });
        chartWeights.setOption({
          title: { text: '路段长度分布（米）', left: 'center', textStyle: { fontSize: 12, color: ink.text } },
          grid: { left: 36, right: 12, top: 30, bottom: 22 },
          xAxis: { type: 'category', data: ['<50', '50-100', '100-200', '200-500', '500+'], axisLabel: { fontSize: 10, color: ink.axis } },
          yAxis: { type: 'value', axisLabel: { fontSize: 10, color: ink.axis }, splitLine: { lineStyle: { color: ink.split } } },
          series: [{ type: 'bar', data: wb, itemStyle: { color: '#4a7dbf' }, barWidth: '55%' }]
        });
        // 3D 大屏：连接度最强的节点柱群（echarts-gl；chart3d 为空时自动跳过）
        if (chart3d) {
          const top = graph.nodes
            .map((n) => ({ n: n, k: deg[n.id] || 0 }))
            .sort((a, b) => b.k - a.k || a.n.id - b.n.id)
            .slice(0, 14);
          chart3d.setOption({
            grid3D: { boxWidth: 100, boxDepth: 40, viewControl: { distance: 130, alpha: 28, beta: 12 } },
            xAxis3D: { type: 'category', data: top.map((x) => String(x.n.id)), axisLabel: { fontSize: 9 } },
            yAxis3D: { type: 'category', data: ['连接度'] },
            zAxis3D: { type: 'value' },
            series: [{
              type: 'bar3D',
              data: top.map((x, i) => [i, 0, x.k]),
              barSize: 4,
              shading: 'lambert',
              itemStyle: { color: '#1f9d6b' }
            }]
          });
        }
      }

      function initCharts() {
        if (chartsInited || !window.echarts) return;
        const d = document.getElementById('chart-degree');
        const t = document.getElementById('chart-types');
        const w = document.getElementById('chart-weights');
        if (!d || !t || !w) return;
        chartDeg = window.echarts.init(d);
        chartTypes = window.echarts.init(t);
        chartWeights = window.echarts.init(w);
        // 3D 大屏（echarts-gl；WebGL 不可用或库缺失时静默降级不渲染）
        const box3d = document.getElementById('chart-3d');
        try {
          const probe = document.createElement('canvas');
          const gl = probe.getContext('webgl') || probe.getContext('experimental-webgl');
          if (box3d && gl && window['echarts-gl']) chart3d = window.echarts.init(box3d);
        } catch (e) { chart3d = null; }
        window.addEventListener('resize', function () {
          if (chartDeg) chartDeg.resize();
          if (chartTypes) chartTypes.resize();
          if (chartWeights) chartWeights.resize();
          if (chart3d) chart3d.resize();
        });
        chartsInited = true;
        updateCharts();
      }

      // ---------- 节点连接热力图（数据来自桥层图数据；纯渲染） ----------
      // 依据当前图数据重算热力点（节点度数归一）；refreshAll 复用它保持热力最新
      function heatPoints() {
        const graph = Api.getGraph();
        const deg = {};
        graph.edges.forEach((e) => { deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; });
        return graph.nodes.map((n) => [n.lat, n.lon, Math.min(1, (deg[n.id] || 0) / 6)]);
      }

      function toggleHeat() {
        if (heat.value) {
          MapCtl.removeHeat();
          heat.value = false;
          return;
        }
        heat.value = MapCtl.addHeat(heatPoints());
        if (!heat.value) ElMessage.warning('热力图组件未加载');
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
        if (s.meters === 0 || s.deg < 0) return '重合点';
        return '向' + s.compass + '（≈' + s.deg + '°）约 ' + fmtMeters(s.meters);
      }

      function fitAll() {
        MapCtl.fitAll();
      }

      // ---------- 在线底图（高德 GCJ-02，与数据坐标系一致；失败自动回退离线） ----------
      function toggleOnline(opts) {
        const silent = opts === true; // 仅启动默认开启时静默，避免首屏弹提示
        ElMessage.closeAll(); // 快速连续切换时清掉过期提示，避免消息堆叠遮挡工具按钮
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

      // 切到「数据洞察」时初始化/刷新图表（容器在 tab 内，需等渲染完成）
      watch(activeTab, (tab) => {
        if (tab === 'insight') nextTick(initCharts);
        nextTick(bindAutoAnimate);
      });

      // ---------- 启动 ----------
      onMounted(async () => {
        const bootT0 = performance.now();
        // 启动页粒子背景（纯展示；tsParticles 不存在或加载失败时静默跳过）
        if (window.tsParticles) {
          window.tsParticles
            .load({
              element: document.getElementById('boot-particles'),
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
        // 分阶段节拍：每阶段至少展示约 350ms，总时长下限 1.5s（答辩开场观感；不影响真实加载）
        const pace = async (minTotal) => {
          const el = performance.now() - bootT0;
          if (el < minTotal) await new Promise((res) => setTimeout(res, minTotal - el));
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
          if (r.fixed > 0 || r.gc > 0) {
            ElMessage.info('启动自检：修复位置引用 ' + r.fixed + ' 处，回收孤儿临时节点 ' + r.gc + ' 个');
          }
          await pace(860);
          bootPhase.value = 3; // 准备就绪
          await pace(1500);
          booted.value = true;
          // 让启动页淡出后再销毁粒子实例（纯展示资源回收）
          setTimeout(() => {
            if (bootParticles) { bootParticles.destroy(); bootParticles = null; }
          }, 900);
          await nextTick();
          MapCtl.init('map');
          MapCtl.onMapClick(onMapClick);
          toggleOnline(true); // 默认开启在线底图；瓦片连续失败会自动回退离线
          const graph = Api.getGraph();
          graphNodes.value = graph.nodes;
          MapCtl.renderGraph(graph, { fit: true });
          refreshAll();
          bindAutoAnimate();
          window.__APP_READY__ = true;
        } catch (err) {
          bootError.value = String((err && err.message) || err);
          window.__APP_READY__ = 'error';
          if (bootParticles) { bootParticles.destroy(); bootParticles = null; } // 启动失败回收启动页粒子
        }
      });

      async function onMapClick(latlng) {
        if (!pick.active) return;
        const purpose = pick.purpose;
        const payload = pick.payload;
        pick.active = false;
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

      // Esc 取消地图点选模式
      function onKeydown(e) {
        if (e.key === 'Escape' && pick.active) {
          pick.active = false;
          pick.payload = null;
          pickHint.value = '';
          MapCtl.clearMisc();
        }
      }
      window.addEventListener('keydown', onKeydown);

      // 演示引导：driver.js 高亮关键区域，只指路不代点（不改变数据）
      function startTour() {
        const D = window.driver && ((window.driver.js && window.driver.js.driver) || window.driver.driver);
        if (!D) return ElMessage.warning('演示组件未加载');
        try {
          new D({
            showProgress: true,
            nextBtnText: '下一步',
            prevBtnText: '上一步',
            doneBtnText: '完成',
            steps: [
              { element: '#map', popover: { title: '校园地图', description: '离线矢量底图：节点/路段/单车；右上角可切换在线高德底图。', side: 'left', align: 'start' } },
              { element: '.tool-btn.wide', popover: { title: '在线底图', description: '点击切换在线/离线；连续失败自动回退。', side: 'bottom', align: 'end' } },
              { element: '#pane-query', popover: { title: '路径查询', description: '选起点/终点，点「最短路径」看红色路线与方向箭头，小车沿线回放。', side: 'left', align: 'start' } },
              { element: '#tab-bike', popover: { title: '共享单车', description: '借车/还车（地图点选）。', side: 'bottom', align: 'start' } },
              { element: '#tab-data', popover: { title: '数据管理', description: '保存并下载 CSV / 导入数据。', side: 'bottom', align: 'start' } }
            ]
          }).drive();
        } catch (e) {
          ElMessage.error('演示启动失败：' + e.message);
        }
      }

      // ---------- 自动演示导演（答辩一键演示：查询→回放→借还车；会修改数据，刷新页面可重置） ----------
      // 令牌用对象身份而非数字自增：停止后快速重启时，旧链的 finally 不会误杀新演示
      let demoToken = null; // null=未演示；非 null 时再次点击 🎬 即停止当前演示
      function demoWait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }
      // 等待回放自然结束（finished 事件）；capMs 为防卡死兜底上线
      async function waitPlaybackDone(capMs) {
        await Promise.race([MapCtl.waitTrackFinished(), demoWait(capMs)]);
      }
      // 大字幕章节名（与 01/07 ~ 07/07 对应）
      const DEMO_CHAPTERS = ['启程 · 校园路网', '求解 · 最短路径', '对比 · 最少跳数', '展示 · 多段导航', '业务 · 借车', '业务 · 还车', '收尾 · 数据持久化'];
      // GSAP 电影插件（3.13 全免费版；任一缺失时相关效果自动降级）
      try {
        if (window.gsap && window.SplitText) gsap.registerPlugin(window.SplitText, window.CustomEase, window.MotionPathPlugin);
      } catch (e) { /* 插件注册失败不影响演示 */ }
      let lastSplit = null; // 最近一次标题逐字拆分实例（换页时回收，防止残留 span）
      // 电影画幅：2.35:1 letterbox——按当前地图尺寸算上下黑边高度（CSS clamp 兜底）
      function enterCinema() {
        const el = document.querySelector('.map-side');
        if (!el) return;
        try {
          const r = el.getBoundingClientRect();
          const bar = Math.max(24, Math.min(72, (r.height - r.width / 2.35) / 2));
          if (bar > 0) el.style.setProperty('--cine-bar', bar.toFixed(1) + 'px');
        } catch (e) { /* 计算失败时用 CSS clamp 兜底 */ }
        el.classList.add('cinema');
        // 影院期显示小地图（在线底图时用在线瓦片；纯展示）
        MapCtl.showMiniMap(tileLayer ? ONLINE_TILE_URL : null, tileLayer ? ONLINE_TILE_OPTS : null);
      }
      function exitCinema() {
        const el = document.querySelector('.map-side');
        if (!el) return;
        el.classList.remove('cinema');
        el.style.removeProperty('--cine-bar');
        MapCtl.hideMiniMap();
        const ec = document.getElementById('cine-endcard');
        if (ec) ec.classList.remove('show');
      }
      function showEndcard() {
        const el = document.getElementById('cine-endcard');
        if (el) el.classList.add('show');
      }
      // 大字幕（textContent 构建，杜绝 HTML 注入）
      function demoCaption(step, title, desc) {
        const el = document.getElementById('demo-caption');
        if (!el) return;
        const g = window.gsap; // GSAP 渐进增强：未加载时回退纯 CSS 过渡
        if (!title) {
          if (lastSplit) { lastSplit.revert(); lastSplit = null; } // 回收标题逐字拆分
          if (g) { g.killTweensOf(el); g.to(el, { opacity: 0, duration: .3, onComplete: () => el.classList.remove('show') }); }
          else el.classList.remove('show');
          return;
        }
        el.textContent = '';
        const nums = /(\d+)\s*\/\s*(\d+)/.exec(step || '');
        if (nums) { // 7 段进度条：已过步骤填充、当前步骤高亮
          const bar = document.createElement('div'); bar.className = 'dc-bar';
          const cur = +nums[1], tot = +nums[2];
          for (let i = 1; i <= tot; i++) {
            const seg = document.createElement('i');
            if (i < cur) seg.className = 'done';
            else if (i === cur) seg.className = 'on';
            bar.appendChild(seg);
          }
          el.appendChild(bar);
        }
        const chapter = nums ? (DEMO_CHAPTERS[+nums[1] - 1] || '') : '';
        const s = document.createElement('div'); s.className = 'dc-step';
        s.textContent = chapter ? chapter + ' · ' + step : step;
        const t = document.createElement('div'); t.className = 'dc-title'; t.textContent = title;
        el.appendChild(s); el.appendChild(t);
        if (desc) { const d = document.createElement('div'); d.className = 'dc-desc'; d.textContent = desc; el.appendChild(d); }
        el.classList.add('show');
        beep(640, .05); // 字幕换页轻提示（beep 自带 soundOn 守卫）
        if (g) {
          g.killTweensOf(el); // 取消上一段淡出/入场，避免旧 onComplete 误移除 show 类
          el.style.transition = 'none'; // 交给 GSAP 接管，避免 CSS transition 追赶抖动
          // xPercent:-50 与 CSS translateX(-50%) 等价，保持底部居中
          g.fromTo(el, { opacity: 0, y: 16, xPercent: -50 },
            { opacity: 1, y: 0, xPercent: -50, duration: .45, ease: 'power2.out' });
          // 标题逐字上浮（SplitText 可用时；失败自动退回整体动画）
          if (window.SplitText && t) {
            try {
              if (lastSplit) lastSplit.revert();
              lastSplit = new window.SplitText(t, { type: 'chars' });
              g.fromTo(lastSplit.chars, { y: 18, opacity: 0 },
                { y: 0, opacity: 1, stagger: .028, duration: .5, ease: 'power2.out', overwrite: true, delay: .06 });
            } catch (e) { lastSplit = null; }
          }
        }
      }
      // ---------- 片尾烟花（fireworks-js；纯展示，库缺失时调用方走彩带降级） ----------
      let fx = null; // 当前烟花实例
      function stopFireworks() {
        try {
          if (fx) { fx.stop(); fx = null; }
          const host = document.getElementById('fx-layer');
          if (host) host.innerHTML = '';
        } catch (e) { /* 纯展示失败不影响功能 */ }
      }
      // 启动全屏烟花，ms 毫秒后自动收起；返回是否成功启动
      function showFireworks(ms) {
        try {
          // UMD 浏览器分支把类挂在命名空间对象上：window.Fireworks = { Fireworks: 类, default: 类 }
          const NS = window.Fireworks;
          const FW = (NS && NS.Fireworks) || NS;
          if (typeof FW !== 'function') return false;
          const host = document.getElementById('fx-layer');
          if (!host) return false;
          stopFireworks();
          fx = new FW(host, {
            hue: { min: 110, max: 190 }, // 青绿—蓝配色，贴合主题色
            delay: { min: 30, max: 60 },
            boundaries: { width: host.clientWidth || window.innerWidth, height: host.clientHeight || window.innerHeight }
          });
          fx.start();
          setTimeout(() => { if (fx) stopFireworks(); }, ms || 3400);
          return true;
        } catch (e) { return false; }
      }
      // 开锁“咔哒”声（两声短促提示；beep 自带提示音开关守卫）
      function clickSfx() { beep(1250, .03); setTimeout(() => beep(700, .045), 55); }
      // 还车归位声（上行两音）
      function returnSfx() { beep(460, .06); setTimeout(() => beep(700, .1), 80); }

      async function startDemo() {
        if (demoToken) {
          demoToken = null;
          demoCaption('', '');
          stopFireworks(); // 停止演示：立即收起片尾烟花（若有）
          exitCinema(); // 停止即收黑边，不等旧链退出
          ElMessage.info('演示已停止');
          return;
        }
        const token = {};
        demoToken = token;
        const alive = () => demoToken === token;
        const nodes = graphNodes.value.filter((n) => !n.isTemp);
        if (nodes.length < 3) { demoToken = null; return ElMessage.warning('节点数据不足，无法演示'); }
        const a = nodes[0];
        const b = nodes[Math.floor(nodes.length / 2)];
        try {
          clearQuery();
          pick.active = false; pickHint.value = ''; MapCtl.clearMisc();
          activeTab.value = 'query';
          enterCinema(); // 电影模式黑边（2.35:1 letterbox，纯展示）
          stopFireworks(); // 清理上一次演示残留的烟花（快速重启时）

          demoCaption('01 / 07', '校园路网总览', '离线矢量底图：' + stats.nodes + ' 个节点 · ' + stats.edges + ' 个路段 · ' + stats.bikes + ' 辆共享单车（可切换在线高德底图）');
          fitAll();
          await demoWait(2600); if (!alive()) return;

          demoCaption('02 / 07', '最短路径（Dijkstra + 优先队列）', '「' + a.name + '」→「' + b.name + '」：距离最短，红线为规划结果，小车沿线回放');
          q.from = a.id; q.to = b.id;
          await demoWait(500); if (!alive()) return;
          doShortest({ follow: true });
          await waitPlaybackDone(4000); if (!alive()) return;

          demoCaption('03 / 07', '最少跳数（BFS）', '同一对起终点：比较「距离最短」与「跳数最少」两条不同的路线');
          doMinHops({ follow: true });
          await waitPlaybackDone(4500); if (!alive()) return;

          const s1 = nodes[Math.floor(nodes.length / 3)];
          const s2 = nodes[Math.floor(nodes.length * 2 / 3)];
          demoCaption('04 / 07', '多段导航（分段 Dijkstra 合并）', a.name + ' → ' + s1.name + ' → ' + s2.name + ' → ' + b.name);
          q.stops = [a.id, s1.id, s2.id, b.id];
          await demoWait(400); if (!alive()) return;
          doMulti({ speed: 1000, follow: true }); // 演示提速 2.5x：多段全程播完（约 5.3s）再切下一步
          await waitPlaybackDone(9000); if (!alive()) return;

          activeTab.value = 'bike';
          const bike = bikes.value.find((x) => x.status === 'available' && x.nodeId !== 0);
          if (bike) {
            demoCaption('05 / 07', '共享单车 · 借车', '借出 ' + bike.bikeId + '（原位置：' + bikeLocation(bike) + '）');
            const rb = Api.borrow(bike.bikeId);
            if (rb.ok) { ElMessage.success(rb.msg); refreshAll(); rerenderGraph(); clickSfx(); } // 开锁“咔哒”反馈
            else { ElMessage.warning('演示：借车失败（' + rb.error + '）'); }
            await demoWait(2400); if (!alive()) return;

            const graph = Api.getGraph();
            const target = graph.nodes.find((n) => n.id === b.id) || graph.nodes[graph.nodes.length - 1];
            const lat = target.lat + 0.0004, lon = target.lon + 0.0004; // 约 45 米偏移，演示临时节点创建
            const rp = Api.returnPreview(lat, lon);
            demoCaption('06 / 07', '共享单车 · 还车', rp.ok ? (rp.covered
              ? '距停车场「' + rp.name + '」在停放半径内，归位到该停车场'
              : '距最近停车场「' + rp.name + '」超出停放半径，将创建临时节点（挂靠该停车场）') : '');
            MapCtl.showPick({ lat: lat, lng: lon }, bike.bikeId);
            if (rp.ok && rp.radius > 0) MapCtl.showRadius({ lat: lat, lng: lon }, rp.radius);
            await demoWait(2200); if (!alive()) return;
            const rr = Api.returnBike(bike.bikeId, lat, lon);
            if (rr.ok) { ElMessage.success(rr.msg); refreshAll(); rerenderGraph(); returnSfx(); } // 归位提示音
            else { ElMessage.warning('演示：还车失败（' + rr.error + '）'); }
            await demoWait(2600); if (!alive()) return;
          }

          activeTab.value = 'data';
          demoCaption('07 / 07', '数据持久化', '「保存并下载」导出 bikes.csv / temps.csv；导入校验与启动自检规则见 README 教学章节');
          await demoWait(2600); if (!alive()) return;

          demoCaption('', '');
          await demoWait(350); if (!alive()) return; // 等字幕淡出后出现片尾卡
          showEndcard(); // 片尾卡（约 2s 后进入完成提示）
          await demoWait(2000); if (!alive()) return;
          ElMessage.success('演示完成 🎉（修改的数据可保存导出，刷新页面即恢复初始数据）');
          const fxOn = showFireworks(3400); // 片尾全屏烟花（fireworks-js；库缺失时仅彩带）
          if (typeof confetti === 'function') confetti({ particleCount: fxOn ? 110 : 160, spread: 90, origin: { y: 0.4 } });
          if (fxOn) await demoWait(3400); // 等烟花跑完再收场（期间点停止会立即清理）
        } catch (e) {
          ElMessage.error('演示中断：' + ((e && e.message) || e));
        } finally {
          exitCinema();
          if (alive()) {
            demoCaption('', '');
            demoToken = null; // 仅当令牌仍属于本次演示时才归还，避免误杀后继演示
          }
        }
      }

      return {
        booted, bootError, bootPhase, bootPhases, activeTab, stats, statsView, graphNodes, nodeOptions,
        q, qResult, qKind, qDistView, qHopsView, pickHint, online,
        bikes, temps, bikesDirty, tempsDirty, saving, bikesInput, tempsInput,
        dark, soundOn, track, toggleDark, toggleSound, trackToggle, trackReplay, trackSetSpeed,
        pickFor, doShortest, doMinHops, doMulti, clearQuery, fitAll, toggleOnline,
        statusText, statusTagType, bikeLocation, borrow, startReturn, removeTemp, repairGhosts,
        doSave, onBikesFile, onTempsFile, fmtDist, segDir, startTour, startDemo,
        heat, toggleHeat,
      };
    }
  };

  const app = createApp(App);
  const epOpts = {};
  if (window.ElementPlusLocaleZhCn) epOpts.locale = window.ElementPlusLocaleZhCn;
  app.use(ElementPlus, epOpts);
  app.mount('#app');
})();
