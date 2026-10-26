// app-charts.js —— 「数据洞察」ECharts 仪表盘 composable（批 4 从 app.js 拆出）：
// 懒加载 echarts/echarts-gl、四张图表渲染、墨色随夜模式切换；
// 数据通过 ctx 读取（节点/边缓存），仅缓存为空时才回源桥层。
// 用法：const charts = window.CampusCharts.create({...}); charts.ensure() / charts.update()。
window.CampusCharts = (function () {
  function create(ctx) {
    // ctx: { loadScript, ElMessage, nextTick, getNodes, getEdges, fillEdges, isDark, isActive }
    let inited = false; // 是否已初始化（echarts 已加载且容器已挂载）
    let chartDeg = null, chartTypes = null, chartWeights = null, chart3d = null;
    let loader = null;       // 仅缓存脚本加载 Promise；初始化不再被它永久锁死
    let scriptsReady = !!window.echarts;
    let initTimer = 0;       // 隐藏容器重试定时器
    let retryCount = 0;
    let initGen = 0;         // 初始化令牌：切走/重试/重复 ensure 会作废旧回调
    let loadGen = 0;         // 脚本加载令牌：dispose 后旧 then 不得再 init
    let onResize = null;

    // 图表墨色：随夜模式切换（纯展示配色）
    function ink() {
      return ctx.isDark()
        ? { text: '#cfdcd4', axis: '#93a89c', split: 'rgba(147,168,156,.22)' }
        : { text: '#33413a', axis: '#7d8a82', split: 'rgba(0,0,0,.08)' };
    }

    function isActive() {
      return typeof ctx.isActive === 'function' ? !!ctx.isActive() : true;
    }

    // 数据洞察按需加载（P1-5）：首次切到该标签页时注入 echarts / echarts-gl。
    // 脚本加载与图表初始化分离：脚本加载失败/初始化时容器隐藏都不会让 loader
    // 永久停在已完成状态，下一次 ensure 仍会重新尝试。
    function ensure() {
      if (inited) {
        // 从隐藏 tab 切回来时容器尺寸可能刚恢复：先 resize 再刷新
        ctx.nextTick(function () { resize(); update(); });
        return Promise.resolve();
      }
      if (scriptsReady && window.echarts) {
        scheduleInit();
        return Promise.resolve();
      }
      if (loader) return loader;
      const myLoad = ++loadGen;
      loader = ctx.loadScript('vendor/echarts.min.js')
        .then(() => ctx.loadScript('vendor/echarts-gl.min.js').catch(() => {})) // 3D 为增强项，失败静默
        .then(() => {
          if (myLoad !== loadGen) return; // 加载期间已切走/失效
          scriptsReady = true;
          loader = null;
          scheduleInit();
        })
        .catch((e) => {
          if (myLoad !== loadGen) return;
          loader = null;
          scriptsReady = false;
          ctx.ElMessage.warning('图表组件加载失败：' + e.message);
        });
      return loader;
    }

    // 等本轮 DOM 布局完成后再尝试 init；频繁 ensure 只保留最新令牌
    function scheduleInit() {
      if (inited || !scriptsReady || !window.echarts || !isActive()) return;
      const token = ++initGen;
      retryCount = 0;
      if (initTimer) { clearTimeout(initTimer); initTimer = 0; }
      ctx.nextTick(function () {
        if (token === initGen) tryInit(token);
      });
    }

    function disposeCharts() {
      if (chartDeg) { try { chartDeg.dispose(); } catch (e) { /* 忽略 */ } }
      if (chartTypes) { try { chartTypes.dispose(); } catch (e) { /* 忽略 */ } }
      if (chartWeights) { try { chartWeights.dispose(); } catch (e) { /* 忽略 */ } }
      if (chart3d) { try { chart3d.dispose(); } catch (e) { /* 忽略 */ } }
      chartDeg = chartTypes = chartWeights = chart3d = null;
    }

    function tryInit(token) {
      if (token !== initGen || inited || !isActive()) return;
      if (!scriptsReady || !window.echarts) return;
      const d = document.getElementById('chart-degree');
      const t = document.getElementById('chart-types');
      const w = document.getElementById('chart-weights');
      if (!d || !t || !w) return;
      // 隐藏 tab 的容器尺寸为 0：此时 init 会得到 0×0 画布，切回来也不恢复。
      // 短暂重试；耗尽后保持未初始化，下一次 ensure（切回标签页）会重新尝试。
      if (!d.clientWidth || !d.clientHeight || !t.clientWidth || !t.clientHeight || !w.clientWidth || !w.clientHeight) {
        if (retryCount++ < 8) {
          initTimer = setTimeout(function () {
            initTimer = 0;
            tryInit(token);
          }, 100);
        }
        return;
      }
      retryCount = 0;
      try {
        chartDeg = window.echarts.init(d);
        chartTypes = window.echarts.init(t);
        chartWeights = window.echarts.init(w);
      } catch (e) {
        disposeCharts();
        return;
      }
      // 3D 大屏（echarts-gl；WebGL 不可用或库缺失时静默降级不渲染）
      const box3d = document.getElementById('chart-3d');
      try {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl') || probe.getContext('experimental-webgl');
        if (box3d && box3d.clientWidth && gl && window['echarts-gl']) chart3d = window.echarts.init(box3d);
      } catch (e) { chart3d = null; }
      onResize = resize;
      window.addEventListener('resize', onResize);
      inited = true;
      update();
    }

    // 取边：优先缓存；为空时回源桥层一次（P2：合并重复 getGraph）
    function edgesOrNull() {
      let list = ctx.getEdges();
      if (!list.length) {
        list = ctx.fillEdges();
        if (!list) return null; // 桥层失败：保留现有图表，不清数据
      }
      return list;
    }

    function update() {
      if (!inited || !chartDeg || !chartTypes || !chartWeights) return;
      if (!isActive()) return; // 标签页隐藏时不更新；切回时 ensure() 会补一次 update（含夜模式配色）
      const edges = edgesOrNull();
      if (!edges) return;
      const nodes = ctx.getNodes();
      const color = ink();
      // 节点度数分布（无向边计度）
      const deg = {};
      edges.forEach((e) => { deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; });
      const db = [0, 0, 0, 0, 0]; // 0 / 1 / 2 / 3-4 / 5+
      nodes.forEach((n) => {
        const k = deg[n.id] || 0;
        db[k === 0 ? 0 : k === 1 ? 1 : k === 2 ? 2 : k <= 4 ? 3 : 4]++;
      });
      chartDeg.setOption({
        aria: { enabled: true },
        title: { text: '节点度数分布', left: 'center', textStyle: { fontSize: 12, color: color.text } },
        tooltip: { trigger: 'item', formatter: '{b} 度：{c} 个节点' },
        grid: { left: 36, right: 12, top: 30, bottom: 22 },
        xAxis: { type: 'category', data: ['0', '1', '2', '3-4', '5+'], axisLabel: { fontSize: 10, color: color.axis } },
        yAxis: { type: 'value', axisLabel: { fontSize: 10, color: color.axis }, splitLine: { lineStyle: { color: color.split } } },
        series: [{ type: 'bar', data: db, itemStyle: { color: '#1f9d6b' }, barWidth: '55%' }]
      });
      // 节点类型占比
      const types = {};
      nodes.forEach((n) => {
        const t = n.isTemp ? 'temp' : (n.type || 'other');
        types[t] = (types[t] || 0) + 1;
      });
      const typeName = { intersection: '路口', building: '建筑', parking: '停车场', temp: '临时节点', other: '其他' };
      chartTypes.setOption({
        aria: { enabled: true },
        title: { text: '节点类型', left: 'center', textStyle: { fontSize: 12, color: color.text } },
        tooltip: { trigger: 'item', formatter: '{b}：{c} 个（{d}%）' },
        series: [{
          type: 'pie', radius: ['34%', '60%'], center: ['50%', '58%'],
          label: { fontSize: 10, formatter: '{b} {c}', color: color.text },
          data: Object.keys(types).map((k) => ({ name: typeName[k] || k, value: types[k] }))
        }]
      });
      // 路段长度分布（米）
      const wb = [0, 0, 0, 0, 0]; // <50 / 50-100 / 100-200 / 200-500 / 500+
      edges.forEach((e) => { const m = e.weight; wb[m < 50 ? 0 : m < 100 ? 1 : m < 200 ? 2 : m < 500 ? 3 : 4]++; });
      chartWeights.setOption({
        aria: { enabled: true },
        title: { text: '路段长度分布（米）', left: 'center', textStyle: { fontSize: 12, color: color.text } },
        tooltip: { trigger: 'item', formatter: '{b} 米：{c} 条路段' },
        grid: { left: 36, right: 12, top: 30, bottom: 22 },
        xAxis: { type: 'category', data: ['<50', '50-100', '100-200', '200-500', '500+'], axisLabel: { fontSize: 10, color: color.axis } },
        yAxis: { type: 'value', axisLabel: { fontSize: 10, color: color.axis }, splitLine: { lineStyle: { color: color.split } } },
        series: [{ type: 'bar', data: wb, itemStyle: { color: '#4a7dbf' }, barWidth: '55%' }]
      });
      // 3D 大屏：连接度最强的节点柱群（echarts-gl；chart3d 为空时自动跳过）
      if (chart3d) {
        const top = nodes
          .map((n) => ({ n: n, k: deg[n.id] || 0 }))
          .sort((a, b) => b.k - a.k || a.n.id - b.n.id)
          .slice(0, 14);
        chart3d.setOption({
          aria: { enabled: true },
          grid3D: { boxWidth: 100, boxDepth: 40, viewControl: { distance: 130, alpha: 28, beta: 12 } },
          tooltip: { formatter: (p) => { const d = (p && p.value) ? top[p.value[0]] : null; return d ? '节点 #' + d.n.id + '：连接度 ' + d.k : ''; } },
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

    function resize() {
      if (!inited || !isActive()) return;
      if (chartDeg) chartDeg.resize();
      if (chartTypes) chartTypes.resize();
      if (chartWeights) chartWeights.resize();
      if (chart3d) chart3d.resize();
    }

    // 切走标签：取消未完成的 0×0 初始化尝试；已初始化的图表保留实例，
    // 数据变化仍可安全 setOption（例如新增临时节点后切回立即可见），
    // 但 resize 会在隐藏期间跳过，待切回 ensure 时再校准。
    function leave() {
      initGen++;
      if (initTimer) { clearTimeout(initTimer); initTimer = 0; }
      retryCount = 0;
    }

    function dispose() {
      initGen++;
      loadGen++;
      if (initTimer) { clearTimeout(initTimer); initTimer = 0; }
      retryCount = 0;
      loader = null;
      scriptsReady = !!window.echarts;
      if (onResize) window.removeEventListener('resize', onResize);
      onResize = null;
      disposeCharts();
      inited = false;
    }

    return { ensure: ensure, update: update, resize: resize, leave: leave, dispose: dispose };
  }

  return { create: create };
})();
