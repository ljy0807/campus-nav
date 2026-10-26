// bigscreen.js —— F6C-A 指挥中心大屏。
// 只做展示与调用桥层/地图控制层，不重写任何路径或单车业务规则。
// 所有动态文本（节点名、错误信息、统计值）统一走 textContent，禁止 innerHTML。
window.BigScreen = (function () {
  'use strict';

  const STATS_INTERVAL = 5000;

  let opened = false;
  let hud = null;
  let els = null;
  let mapSideEl = null;
  let panelEl = null;
  let lastFocus = null;
  let clockTimer = 0;
  let statsTimer = 0;
  let resizeTimer = 0;
  let relayoutTimer = 0;
  let routeTimer = 0;
  let keyHandler = null;
  let resizeHandler = null;
  let nodeById = new Map();
  let nodeSignature = '';
  let routing = false;
  let lastGraph = null;
  let lastView = null; // 进入大屏前的主视图；退出时恢复，避免临时规划改变主查询视野

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function fmtDist(meters) {
    const m = Number(meters);
    if (!isFinite(m)) return '—';
    return m >= 1000 ? (m / 1000).toFixed(2) + ' 公里' : m.toFixed(1) + ' 米';
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function tempLabel(id) {
    return 'T' + Math.abs(Number(id));
  }

  function displayLabel(node) {
    const isTemp = !!node.isTemp || node.type === 'temp';
    if (isTemp) return tempLabel(node.id);
    return node.name || ('节点 ' + node.id);
  }

  // 焦点陷阱：大屏打开期间 Tab 只在 HUD 内循环，避免落到被隐藏/遮蔽的主界面
  function focusables(root) {
    if (!root) return [];
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.filter.call(root.querySelectorAll(selector), function (node) {
      return node.tabIndex >= 0 && node.getClientRects().length > 0 &&
        window.getComputedStyle(node).visibility !== 'hidden';
    });
  }

  function trapTab(evt) {
    if (!hud) return;
    const list = focusables(hud);
    if (!list.length) { evt.preventDefault(); return; }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    const inside = hud.contains(active);
    if (evt.shiftKey) {
      if (!inside || active === first) {
        evt.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      evt.preventDefault();
      first.focus();
    }
  }

  function buildHud() {
    hud = el('div', 'bs-hud');
    hud.setAttribute('role', 'region');
    hud.setAttribute('aria-label', '指挥中心大屏');

    // ---------- 左上：标题 / 时钟 / 退出 ----------
    const head = el('header', 'bs-head');
    const brand = el('div', 'bs-brand');
    brand.appendChild(el('div', 'bs-kicker', 'CAMPUS COMMAND CENTER'));
    brand.appendChild(el('h1', 'bs-title', '校园路网指挥中心'));
    const clock = el('div', 'bs-clock', '');
    clock.id = 'bs-clock';
    brand.appendChild(clock);
    const exitBtn = el('button', 'bs-btn bs-exit', '退出');
    exitBtn.type = 'button';
    exitBtn.setAttribute('aria-label', '退出指挥中心大屏');
    exitBtn.addEventListener('click', close);
    head.append(brand, exitBtn);

    // ---------- 右上：KPI ----------
    const side = el('aside', 'bs-side');
    const kpis = el('section', 'bs-card bs-kpis');
    kpis.setAttribute('aria-label', '路网关键指标');
    const kpiDefs = [
      { key: 'nodes', label: '节点', cls: 'is-cyan' },
      { key: 'edges', label: '路段', cls: 'is-green' },
      { key: 'bikes', label: '单车', cls: 'is-gold' },
      { key: 'temps', label: '临时节点', cls: 'is-violet' }
    ];
    const kpiValues = {};
    for (const def of kpiDefs) {
      const card = el('div', 'bs-kpi ' + def.cls);
      card.appendChild(el('span', 'bs-kpi-label', def.label));
      const value = el('span', 'bs-kpi-value', '—');
      card.appendChild(value);
      kpiValues[def.key] = value;
      kpis.appendChild(card);
    }

    // ---------- 右侧玻璃面板：路线规划 ----------
    const panel = el('section', 'bs-card bs-panel');
    panel.setAttribute('aria-label', '路线规划');
    panel.appendChild(el('h2', 'bs-panel-title', '路线规划'));

    function field(labelText, selectId) {
      const wrap = el('div', 'bs-field');
      const label = el('label', '', labelText);
      label.setAttribute('for', selectId);
      const select = el('select', 'bs-select');
      select.id = selectId;
      const placeholder = el('option', '', '请选择' + labelText + '…');
      placeholder.value = '';
      select.appendChild(placeholder);
      wrap.append(label, select);
      return { wrap: wrap, select: select };
    }

    const fromField = field('起点', 'bs-from');
    const toField = field('终点', 'bs-to');
    panel.append(fromField.wrap, toField.wrap);

    const actions = el('div', 'bs-actions');
    const planBtn = el('button', 'bs-btn bs-primary', '规划路线');
    planBtn.type = 'button';
    planBtn.addEventListener('click', function () { plan('shortest'); });
    const topBtn = el('button', 'bs-btn bs-gold', '推荐 3 条');
    topBtn.type = 'button';
    topBtn.addEventListener('click', function () { plan('top3'); });
    actions.append(planBtn, topBtn);

    const subActions = el('div', 'bs-actions bs-actions-sub');
    const topoBtn = el('button', 'bs-btn bs-ghost', '路网拓扑');
    topoBtn.type = 'button';
    topoBtn.setAttribute('aria-label', '打开路网拓扑图');
    topoBtn.addEventListener('click', function () {
      if (window.Topology && typeof window.Topology.open === 'function') {
        window.Topology.open();
      } else {
        setStatus('拓扑组件未加载', 'is-warn');
      }
    });
    subActions.appendChild(topoBtn);
    panel.append(actions, subActions);

    const summary = el('div', 'bs-summary');
    const summaryHead = el('div', 'bs-summary-head');
    summaryHead.appendChild(el('span', '', '路线摘要'));
    const status = el('span', 'bs-status', '待规划');
    status.id = 'bs-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    summaryHead.appendChild(status);
    const summaryBody = el('div', 'bs-summary-body');
    summaryBody.id = 'bs-summary';
    summaryBody.appendChild(el('div', 'bs-summary-empty', '选择起点与终点后开始规划'));
    summary.append(summaryHead, summaryBody);
    panel.append(summary);

    side.append(kpis, panel);

    const foot = el('footer', 'bs-foot');
    foot.append(
      el('span', '', '拖拽平移 · 滚轮缩放'),
      el('span', 'bs-foot-sep', '·'),
      el('span', '', 'Dijkstra / Yen K · WASM')
    );

    hud.append(head, side, foot);
    if (mapSideEl) mapSideEl.appendChild(hud);

    els = {
      clock: clock,
      exit: exitBtn,
      kpis: kpiValues,
      from: fromField.select,
      to: toField.select,
      plan: planBtn,
      top3: topBtn,
      topology: topoBtn,
      summary: summaryBody,
      status: status
    };
  }

  function tickClock() {
    if (!els || !els.clock) return;
    const d = new Date();
    const date = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    const time = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    els.clock.textContent = date + '  ' + time;
  }

  function setStatus(text, kind) {
    if (!els || !els.status) return;
    els.status.textContent = text;
    els.status.className = 'bs-status' + (kind ? ' ' + kind : '');
  }

  function setBusy(busy) {
    if (!els) return;
    els.plan.disabled = busy;
    els.top3.disabled = busy;
    els.plan.setAttribute('aria-busy', busy ? 'true' : 'false');
    els.top3.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function clearNode(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function populateSelects(graph) {
    if (!els || !graph || !Array.isArray(graph.nodes)) return;
    const prevFrom = els.from.value;
    const prevTo = els.to.value;
    const lists = [els.from, els.to];
    const sig = graph.nodes.length + ':' + graph.nodes.map(function (n) { return n.id; }).join(',');
    nodeSignature = sig;

    nodeById = new Map();
    const labels = graph.nodes.map(function (n) {
      nodeById.set(Number(n.id), n);
      return { id: String(n.id), label: displayLabel(n) };
    });

    for (const select of lists) {
      clearNode(select);
      const placeholder = el('option', '', select === els.from ? '请选择起点…' : '请选择终点…');
      placeholder.value = '';
      select.appendChild(placeholder);
      for (const item of labels) {
        const option = el('option', '', item.label);
        option.value = item.id;
        select.appendChild(option);
      }
      // 数据刷新后尽量保留用户已选节点
      const prev = select === els.from ? prevFrom : prevTo;
      if (prev && labels.some(function (x) { return x.id === prev; })) {
        select.value = prev;
      }
    }
  }

  function readGraph() {
    if (!window.Api || typeof window.Api.getGraph !== 'function') {
      throw new Error('桥层 API 不可用');
    }
    const g = window.Api.getGraph();
    if (!g || !Array.isArray(g.nodes)) {
      throw new Error((g && g.error) || '图数据读取失败');
    }
    if (!Array.isArray(g.edges)) g.edges = [];
    return g;
  }

  function refreshStats() {
    if (!opened || !els) return;
    let graph = null;
    try {
      graph = readGraph();
      lastGraph = graph;
      const sig = graph.nodes.length + ':' + graph.nodes.map(function (n) { return n.id; }).join(',');
      if (sig !== nodeSignature) populateSelects(graph);
      els.kpis.nodes.textContent = String(graph.nodes.length);
      els.kpis.edges.textContent = String(graph.edges.length);
    } catch (e) {
      if (lastGraph) {
        els.kpis.nodes.textContent = String(lastGraph.nodes.length);
        els.kpis.edges.textContent = String(lastGraph.edges.length);
      } else {
        els.kpis.nodes.textContent = '—';
        els.kpis.edges.textContent = '—';
      }
    }

    try {
      if (window.Api && typeof window.Api.status === 'function') {
        const s = window.Api.status();
        if (s && typeof s.bikes === 'number') els.kpis.bikes.textContent = String(s.bikes);
        if (s && typeof s.temps === 'number') els.kpis.temps.textContent = String(s.temps);
        if (s && typeof s.nodes === 'number' && els.kpis.nodes.textContent === '—') {
          els.kpis.nodes.textContent = String(s.nodes);
        }
      }
    } catch (e) { /* 统计失败保留上一帧数值，不影响路线规划 */ }
  }

  function summaryLine(tag, text, extraClass) {
    const row = el('div', 'bs-route-line' + (extraClass ? ' ' + extraClass : ''));
    row.appendChild(el('span', 'bs-route-tag', tag));
    row.appendChild(el('span', 'bs-route-text', text));
    return row;
  }

  function routeNames(r) {
    if (!r) return '';
    const names = Array.isArray(r.names) ? r.names : [];
    const start = names.length ? names[0] : (nodeById.get(Number(r.path && r.path[0])) ? displayLabel(nodeById.get(Number(r.path[0]))) : '');
    const end = names.length ? names[names.length - 1] : (nodeById.get(Number(r.path && r.path[r.path.length - 1])) ? displayLabel(nodeById.get(Number(r.path[r.path.length - 1]))) : '');
    if (!start && !end) return '';
    return start + ' → ' + end;
  }

  function routeStats(r) {
    const nodes = Array.isArray(r.path) ? r.path.length : (r.hops || 0);
    const segs = Array.isArray(r.segments) ? r.segments.length : Math.max(0, nodes - 1);
    return fmtDist(r.dist) + ' · ' + nodes + ' 个节点 · ' + segs + ' 个分段';
  }

  function showShortest(r) {
    clearNode(els.summary);
    els.summary.appendChild(summaryLine('最短路径', routeStats(r), 'is-best'));
    const names = routeNames(r);
    if (names) els.summary.appendChild(el('div', 'bs-route-names', names));
    setStatus('完成 · 最短路径', 'is-ok');
  }

  function showTop3(routes) {
    clearNode(els.summary);
    routes.forEach(function (r, i) {
      els.summary.appendChild(summaryLine('方案 ' + (i + 1), routeStats(r), i === 0 ? 'is-best' : ''));
    });
    const note = el('div', 'bs-route-names', routes.length > 1
      ? '实线为主方案，灰色虚线为备选路线'
      : '备选路线不足，当前仅显示 1 条方案');
    els.summary.appendChild(note);
    setStatus('完成 · 推荐 ' + routes.length + ' 条', 'is-ok');
  }

  function plan(mode) {
    if (!opened || routing || !els) return;
    if (!els.from.value || !els.to.value) {
      setStatus('请先选择起点与终点', 'is-warn');
      return;
    }
    const from = Number(els.from.value);
    const to = Number(els.to.value);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      setStatus('节点编号无效，请重新选择', 'is-warn');
      return;
    }
    if (from === to) {
      setStatus('起点=终点，无需导航', 'is-warn');
      return;
    }
    if (!window.Api || typeof window.Api.shortestPath !== 'function') {
      setStatus('桥层 API 不可用', 'is-error');
      return;
    }
    const map = window.MapCtl && typeof window.MapCtl.getMap === 'function'
      ? window.MapCtl.getMap()
      : null;
    if (!map) {
      setStatus('地图尚未就绪，请稍后再试', 'is-error');
      return;
    }

    routing = true;
    setBusy(true);
    setStatus(mode === 'top3' ? '正在计算推荐路线…' : '正在计算最短路径…', '');
    // 让按钮的忙碌态先落屏，再进入同步 WASM 调用
    routeTimer = window.setTimeout(function () {
      routeTimer = 0;
      if (!opened) {
        routing = false;
        return;
      }
      try {
        if (mode === 'top3') {
          const r = window.Api.topPaths(from, to, 3);
          if (!r || r.ok === false) {
            setStatus((r && r.error) || '推荐路线计算失败', 'is-error');
            return;
          }
          const routes = (Array.isArray(r.routes) ? r.routes : []).filter(function (x) {
            return x && Array.isArray(x.path) && x.path.length >= 2;
          });
          if (!routes.length) {
            setStatus('两点之间不可达', 'is-error');
            return;
          }
          // 大屏规划使用独立临时图层：不清主查询路径、不动主回放状态
          window.MapCtl.drawTempPath(routes[0].path, { fit: true });
          if (routes.length > 1 && typeof window.MapCtl.drawTempVariants === 'function') {
            window.MapCtl.drawTempVariants(routes.slice(1).map(function (x) { return x.path; }));
          }
          showTop3(routes);
        } else {
          const r = window.Api.shortestPath(from, to);
          if (!r || r.ok === false) {
            setStatus((r && r.error) || '最短路径计算失败', 'is-error');
            return;
          }
          if (!Array.isArray(r.path) || r.path.length < 2) {
            setStatus('起点与终点相同，无需规划', 'is-warn');
            return;
          }
          window.MapCtl.drawTempPath(r.path, { fit: true });
          showShortest(r);
        }
      } catch (e) {
        setStatus('规划失败：' + ((e && e.message) || String(e)), 'is-error');
      } finally {
        routing = false;
        if (opened) setBusy(false);
      }
    }, 20);
  }

  function invalidateMapSoon() {
    const map = window.MapCtl && typeof window.MapCtl.getMap === 'function'
      ? window.MapCtl.getMap()
      : null;
    if (map && typeof map.invalidateSize === 'function') {
      window.requestAnimationFrame(function () {
        try { map.invalidateSize({ pan: false }); } catch (e) { /* 地图未就绪时忽略 */ }
      });
    }
  }

  function onResize() {
    if (!opened) return;
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      resizeTimer = 0;
      if (!opened) return;
      const map = window.MapCtl && typeof window.MapCtl.getMap === 'function'
        ? window.MapCtl.getMap()
        : null;
      if (map && typeof map.invalidateSize === 'function') {
        try { map.invalidateSize({ pan: false }); } catch (e) { /* 忽略 */ }
      }
    }, 120);
  }

  function open() {
    if (opened) return;
    mapSideEl = document.querySelector('.map-side');
    if (!mapSideEl) {
      console.warn('[bigscreen] 未找到 .map-side，无法进入大屏');
      return;
    }
    opened = true;
    lastFocus = document.activeElement;
    panelEl = document.querySelector('.panel');
    if (panelEl) panelEl.setAttribute('aria-hidden', 'true');
    document.body.classList.add('bigscreen');
    if (window.MapCtl && typeof window.MapCtl.clearTempPath === 'function') window.MapCtl.clearTempPath();
    try {
      const map = window.MapCtl && typeof window.MapCtl.getMap === 'function' ? window.MapCtl.getMap() : null;
      if (map) lastView = { center: map.getCenter(), zoom: map.getZoom() };
    } catch (e) { lastView = null; }

    buildHud();
    tickClock();
    clockTimer = window.setInterval(tickClock, 1000);

    try {
      const g = readGraph();
      lastGraph = g;
      populateSelects(g);
    } catch (e) {
      setStatus('路网读取失败：' + ((e && e.message) || String(e)), 'is-error');
    }
    refreshStats();
    statsTimer = window.setInterval(refreshStats, STATS_INTERVAL);

    keyHandler = function (evt) {
      // 拓扑 overlay 在顶层时由 topology.js 处理 Esc/Tab，避免一次按键关闭两层或抢走焦点
      if (document.body.classList.contains('topology-open')) return;
      if (evt.key === 'Tab') {
        trapTab(evt);
        return;
      }
      if (evt.key !== 'Escape' && evt.key !== 'Esc') return;
      if (evt.defaultPrevented) return;
      evt.preventDefault();
      close();
    };
    document.addEventListener('keydown', keyHandler);
    resizeHandler = onResize;
    window.addEventListener('resize', resizeHandler);

    // 右侧面板隐藏后地图容器宽度变化：立即与过渡后各校准一次
    invalidateMapSoon();
    if (relayoutTimer) window.clearTimeout(relayoutTimer);
    relayoutTimer = window.setTimeout(function () {
      relayoutTimer = 0;
      if (opened) invalidateMapSoon();
    }, 260);

    if (els && els.from) {
      try { els.from.focus(); } catch (e) { /* 焦点设置失败不影响功能 */ }
    }
  }

  function close() {
    if (!opened) return;
    opened = false;
    routing = false;

    if (clockTimer) window.clearInterval(clockTimer);
    clockTimer = 0;
    if (statsTimer) window.clearInterval(statsTimer);
    statsTimer = 0;
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = 0;
    if (relayoutTimer) window.clearTimeout(relayoutTimer);
    relayoutTimer = 0;
    if (routeTimer) window.clearTimeout(routeTimer);
    routeTimer = 0;

    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
    if (resizeHandler) window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;

    // 如果拓扑仍开着，一并关闭，避免残留全屏遮罩
    if (document.body.classList.contains('topology-open') && window.Topology && typeof window.Topology.close === 'function') {
      try { window.Topology.close(); } catch (e) { /* 忽略 */ }
    }

    document.body.classList.remove('bigscreen');
    if (panelEl) panelEl.removeAttribute('aria-hidden');
    panelEl = null;

    if (hud && hud.parentNode) hud.parentNode.removeChild(hud);
    hud = null;
    els = null;
    lastGraph = null;
    nodeById = new Map();
    nodeSignature = '';
    // 临时规划图层只属于大屏；退出即清理，并恢复进入前的主查询视野。
    // 等右侧面板恢复布局后再 setView，避免先按全屏尺寸定位、随后 resize 造成偏移。
    if (window.MapCtl && typeof window.MapCtl.clearTempPath === 'function') window.MapCtl.clearTempPath();
    const restoreView = lastView;
    lastView = null;
    if (restoreView) {
      window.requestAnimationFrame(function () {
        try {
          const map = window.MapCtl && typeof window.MapCtl.getMap === 'function' ? window.MapCtl.getMap() : null;
          if (!map) return;
          if (typeof map.invalidateSize === 'function') map.invalidateSize({ pan: false });
          map.setView(restoreView.center, restoreView.zoom, { animate: false });
        } catch (e) { /* 视图恢复失败不影响主查询结果 */ }
      });
    }

    invalidateMapSoon();
    if (relayoutTimer) window.clearTimeout(relayoutTimer);
    relayoutTimer = window.setTimeout(function () {
      relayoutTimer = 0;
      if (!opened) invalidateMapSoon();
    }, 260);

    if (lastFocus && typeof lastFocus.focus === 'function' && document.documentElement.contains(lastFocus)) {
      try { lastFocus.focus(); } catch (e) { /* 焦点恢复失败不影响关闭 */ }
    }
    lastFocus = null;
  }

  function toggle() {
    if (opened) close();
    else open();
  }

  return { toggle: toggle, open: open, close: close };
})();
