// topology.js —— F6C-B 路网拓扑全屏视图。
// 只读 Api.getGraph() 的数据并用 G6 5.x 做力导向可视化；不修改任何业务逻辑。
// 点击节点后关闭拓扑、飞到对应坐标，并以纯文本提示节点名称。
window.Topology = (function () {
  'use strict';

  // 与地图图例保持同一套类型语义（临时节点单独用紫色）。
  const TYPE_COLOR = {
    intersection: '#5eead4',
    building: '#6ea8fe',
    parking: '#34d399',
    temp: '#c084fc'
  };
  const TYPE_LABEL = {
    intersection: '路口',
    building: '建筑',
    parking: '停车场',
    temp: '临时节点'
  };

  let openFlag = false;
  let overlay = null;
  let canvasEl = null;
  let msgEl = null;
  let graph = null;
  let nodeLookup = new Map();
  let lastFocus = null;
  let keyHandler = null;
  let resizeHandler = null;
  let renderToken = 0;
  let resizeRaf = 0;

  let toastEl = null;
  let toastTimer = 0;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // 顶层文本提示（不拼 HTML；同名节点/用户导入名称也安全）。
  function showToast(text) {
    if (!toastEl) {
      toastEl = el('div', 'map-toast');
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    // 强制回流以便连续提示也能重播过渡
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      if (toastEl) toastEl.classList.remove('show');
    }, 2800);
  }

  function setMessage(text) {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.hidden = !text;
  }

  // 弹层焦点陷阱：Tab/Shift+Tab 只在 overlay 内循环（当前主要是「关闭」按钮）
  function focusables() {
    if (!overlay) return [];
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.filter.call(overlay.querySelectorAll(selector), function (node) {
      // G6 的 canvas 自带 tabindex=1；它没有可操作的键盘语义，不进焦点循环
      return node.tagName !== 'CANVAS' && node.tabIndex >= 0 && node.getClientRects().length > 0 &&
        window.getComputedStyle(node).visibility !== 'hidden';
    });
  }

  function trapTab(evt) {
    const list = focusables();
    if (!list.length) { evt.preventDefault(); return; }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    const inside = overlay && overlay.contains(active);
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

  function buildOverlay() {
    overlay = el('div', 'topology-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '校园路网拓扑');

    const head = el('header', 'topology-head');
    const titleWrap = el('div', 'topology-title-wrap');
    titleWrap.appendChild(el('div', 'topology-kicker', 'F6C-B · NETWORK TOPOLOGY'));
    titleWrap.appendChild(el('h2', 'topology-title', '校园路网拓扑'));
    const meta = el('div', 'topology-meta', '正在读取路网…');
    meta.id = 'topology-meta';
    const closeBtn = el('button', 'topology-close', '关闭');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭路网拓扑');
    closeBtn.addEventListener('click', close);
    head.append(titleWrap, meta, closeBtn);

    const stage = el('div', 'topology-stage');
    canvasEl = el('div', 'topology-canvas');
    canvasEl.id = 'topology-canvas';
    msgEl = el('div', 'topology-msg', '正在计算力导向布局…');
    msgEl.setAttribute('role', 'status');
    msgEl.setAttribute('aria-live', 'polite');
    stage.append(canvasEl, msgEl);

    const legend = el('div', 'topology-legend');
    legend.setAttribute('aria-label', '节点类型图例');
    Object.keys(TYPE_LABEL).forEach(function (type) {
      const item = el('span', 'topology-legend-item');
      const dot = el('i');
      dot.style.backgroundColor = TYPE_COLOR[type];
      item.append(dot, document.createTextNode(TYPE_LABEL[type]));
      legend.appendChild(item);
    });

    const hint = el('div', 'topology-hint', '拖拽节点 / 拖拽画布 / 滚轮缩放 · 点击节点定位');
    overlay.append(head, stage, legend, hint);
    document.body.appendChild(overlay);
    return meta;
  }

  function readGraph() {
    if (!window.Api || typeof window.Api.getGraph !== 'function') {
      throw new Error('桥层 API 不可用，无法读取路网');
    }
    const g = window.Api.getGraph();
    if (!g || !Array.isArray(g.nodes)) {
      throw new Error((g && g.error) || '图数据读取失败');
    }
    if (!g.nodes.length) throw new Error('当前图为空，暂无可视化节点');
    if (!Array.isArray(g.edges)) g.edges = [];
    return g;
  }

  function nodeKey(id) {
    return String(id);
  }

  function buildData(g) {
    const degree = new Map();
    const ids = new Set();
    for (const n of g.nodes) ids.add(nodeKey(n.id));
    for (const e of g.edges) {
      const a = nodeKey(e.from);
      const b = nodeKey(e.to);
      if (!ids.has(a) || !ids.has(b)) continue;
      degree.set(a, (degree.get(a) || 0) + 1);
      degree.set(b, (degree.get(b) || 0) + 1);
    }

    nodeLookup = new Map();
    const nodes = g.nodes.map(function (n) {
      const key = nodeKey(n.id);
      const deg = degree.get(key) || 0;
      const isTemp = !!n.isTemp || n.type === 'temp';
      const type = isTemp ? 'temp' : (TYPE_COLOR[n.type] ? n.type : 'intersection');
      const label = isTemp ? 'T' + Math.abs(Number(n.id)) : (n.name || '节点 ' + n.id);
      const size = 14 + Math.min(deg, 20) * 1.8;
      const entry = {
        id: key,
        name: label,
        type: type,
        lat: Number(n.lat),
        lon: Number(n.lon),
        color: TYPE_COLOR[type],
        size: size,
        degree: deg,
        showLabel: deg >= 6 || isTemp
      };
      nodeLookup.set(key, entry);
      return {
        id: key,
        data: entry
      };
    });

    const edges = [];
    for (let i = 0; i < g.edges.length; i++) {
      const e = g.edges[i];
      const a = nodeKey(e.from);
      const b = nodeKey(e.to);
      if (!nodeLookup.has(a) || !nodeLookup.has(b)) continue;
      // G6 要求边 id 唯一；平行边（同一对节点多条边）不能用 a-b 拼 id。
      edges.push({
        id: 'e-' + i,
        source: a,
        target: b,
        style: { stroke: '#92a8b8', lineWidth: 1, strokeOpacity: 0.45 }
      });
    }
    return { nodes: nodes, edges: edges };
  }

  function onNodeClick(evt) {
    let key = '';
    try { key = evt && evt.target ? String(evt.target.id) : ''; } catch (e) { key = ''; }
    let info = nodeLookup.get(key) || null;
    if (!info) {
      try {
        const datum = evt.target && typeof evt.target.getData === 'function' ? evt.target.getData() : null;
        info = datum && datum.data ? datum.data : null;
        if (info && info.id !== undefined) info = nodeLookup.get(String(info.id)) || info;
      } catch (e) { info = null; }
    }
    if (!info) return;

    const name = info.name || ('节点 ' + info.id);
    const lat = Number(info.lat);
    const lon = Number(info.lon);

    close(); // 先关 overlay，再操作地图，避免遮罩拦截镜头动画

    const map = window.MapCtl && typeof window.MapCtl.getMap === 'function'
      ? window.MapCtl.getMap()
      : null;
    if (!map) {
      showToast('地图尚未就绪，无法定位「' + name + '」');
      return;
    }
    if (!isFinite(lat) || !isFinite(lon)) {
      showToast('节点「' + name + '」缺少有效坐标');
      return;
    }
    map.flyTo([lat, lon], 18);
    showToast('已定位：' + name);
    // 大屏已开启时，顺便把节点名写进 HUD 状态栏（textContent，安全）
    const status = document.getElementById('bs-status');
    if (status) {
      status.textContent = '已定位：' + name;
      status.className = 'bs-status is-ok';
    }
  }

  let g6Promise = null;
  function ensureG6() {
    if (window.G6 && typeof window.G6.Graph === 'function') return Promise.resolve(true);
    if (g6Promise) return g6Promise;
    g6Promise = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = 'vendor/g6.min.js';
      s.async = true;
      s.onload = function () {
        resolve(!!(window.G6 && typeof window.G6.Graph === 'function'));
      };
      s.onerror = function () {
        g6Promise = null;  // 允许用户关掉再试
        reject(new Error('拓扑组件加载失败（vendor/g6.min.js）'));
      };
      document.head.appendChild(s);
    });
    return g6Promise;
  }

  function initGraph(g) {
    const token = ++renderToken;  // 本次初始化的令牌（关闭/重开会作废旧回调）
    const meta = document.getElementById('topology-meta');
    if (meta) meta.textContent = g.nodes.length + ' 个节点 · ' + g.edges.length + ' 条路段';
    if (!overlay || !canvasEl) return;
    if (!window.G6 || typeof window.G6.Graph !== 'function') {
      setMessage('正在加载拓扑组件…');
      ensureG6().then(function (ok) {
        // 关闭/重开期间旧回调必须失效；否则两次 ensureG6 会各建一个实例
        if (token !== renderToken || !openFlag || !overlay) return;
        if (ok) initGraph(g);
        else setMessage('拓扑组件未加载（vendor/g6.min.js）');
      }).catch(function (err) {
        if (token === renderToken && openFlag) setMessage((err && err.message) || String(err));
      });
      return;
    }

    const data = buildData(g);
    if (!data.nodes.length) {
      setMessage('当前图为空，暂无可视化节点');
      return;
    }

    const width = Math.max(1, canvasEl.clientWidth || overlay.clientWidth || window.innerWidth);
    const height = Math.max(1, canvasEl.clientHeight || window.innerHeight - 64);

    try {
      // 同一容器只允许一个 G6 实例；旧实例先销毁（关闭时通常已销毁，这里是双保险）
      if (graph && typeof graph.destroy === 'function') graph.destroy();
      graph = null;
      graph = new window.G6.Graph({
        container: canvasEl,
        width: width,
        height: height,
        padding: 44,
        data: data,
        node: {
          type: 'circle',
          style: {
            // 用函数读取节点数据：G6 5.x 的静态 node.style 会覆盖每个节点自己的样式
            fill: function (d) { return (d.data && d.data.color) || TYPE_COLOR.intersection; },
            size: function (d) { return (d.data && d.data.size) || 16; },
            stroke: 'rgba(232, 255, 249, 0.88)',
            lineWidth: function (d) { return d.data && d.data.degree >= 8 ? 2 : 1; },
            // 只给高连接度节点和临时节点挂常驻标签，避免 100+ 标签互相遮挡
            labelText: function (d) { return d.data && d.data.showLabel ? d.data.name : ''; },
            labelFill: '#dffcf4',
            labelFontSize: 10,
            labelPlacement: 'bottom',
            labelOffsetY: 4,
            cursor: 'pointer'
          }
        },
        edge: {
          type: 'line',
          style: { stroke: '#92a8b8', lineWidth: 1, strokeOpacity: 0.45 }
        },
        layout: {
          type: 'force',
          preventOverlap: true,
          linkDistance: 82,
          maxIteration: 300,
          gravity: 6,
          factor: 1,
          edgeStrength: 55
        },
        behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element'],
        autoFit: 'view',
        animation: false
      });
      graph.on('node:click', onNodeClick);
      // 便于自动化验证/调试：把实例挂到 overlay 的 DOM 属性上（不是全局变量）
      overlay.__topologyGraph = graph;
      // G6 canvas 默认 tabindex=1：移出 Tab 序列，键盘焦点只留在「关闭」按钮
      Array.prototype.forEach.call(canvasEl.querySelectorAll('canvas'), function (c) {
        c.setAttribute('tabindex', '-1');
      });

      Promise.resolve(graph.render()).then(function () {
        if (token !== renderToken || !openFlag) return;
        Array.prototype.forEach.call(canvasEl.querySelectorAll('canvas'), function (c) {
          c.setAttribute('tabindex', '-1');
        });
        setMessage('');
        try { graph.fitView(); } catch (e) { /* 力导向结果已自带 autoFit，失败不阻塞 */ }
      }).catch(function (err) {
        if (token !== renderToken) return;
        setMessage('拓扑渲染失败：' + ((err && err.message) || String(err)));
      });
    } catch (err) {
      setMessage('拓扑渲染失败：' + ((err && err.message) || String(err)));
    }
  }

  function open() {
    if (openFlag) return;
    if (!document.body) return;
    openFlag = true;
    lastFocus = document.activeElement;

    let g;
    try {
      g = readGraph();
    } catch (err) {
      // 仍然打开 overlay 并显示原因，避免“点了没反应”
      buildOverlay();
      document.body.classList.add('topology-open');
      setMessage((err && err.message) || String(err));
      const meta = document.getElementById('topology-meta');
      if (meta) meta.textContent = '0 个节点 · 0 条路段';
      bindGlobalEvents();
      const closeBtn = overlay.querySelector('.topology-close');
      if (closeBtn) closeBtn.focus();
      return;
    }

    buildOverlay();
    document.body.classList.add('topology-open');
    bindGlobalEvents();
    const closeBtn = overlay.querySelector('.topology-close');
    if (closeBtn) closeBtn.focus();
    // 等 overlay 进入布局后再量尺寸并启动力导向
    window.requestAnimationFrame(function () {
      if (!openFlag || !overlay) return;
      initGraph(g);
    });
  }

  function bindGlobalEvents() {
    keyHandler = function (evt) {
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

    resizeHandler = function () {
      if (!graph || !canvasEl || resizeRaf) return;
      resizeRaf = window.requestAnimationFrame(function () {
        resizeRaf = 0;
        if (!graph || !canvasEl) return;
        try {
          graph.setSize(
            Math.max(1, canvasEl.clientWidth),
            Math.max(1, canvasEl.clientHeight)
          );
        } catch (e) { /* 关闭过程中的 resize 失败可忽略 */ }
      });
    };
    window.addEventListener('resize', resizeHandler);
  }

  function close() {
    if (!openFlag) return;
    openFlag = false;
    renderToken++;

    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
    if (resizeHandler) window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
    if (resizeRaf) {
      window.cancelAnimationFrame(resizeRaf);
      resizeRaf = 0;
    }

    document.body.classList.remove('topology-open');
    try {
      if (graph && typeof graph.destroy === 'function') graph.destroy();
    } catch (e) { /* 已销毁/渲染中被关闭时忽略 */ }
    graph = null;
    nodeLookup = new Map();

    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    canvasEl = null;
    msgEl = null;

    if (lastFocus && typeof lastFocus.focus === 'function' && document.documentElement.contains(lastFocus)) {
      try { lastFocus.focus(); } catch (e) { /* 焦点恢复失败不影响关闭 */ }
    }
    lastFocus = null;
  }

  return { open: open, close: close };
})();
