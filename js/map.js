// map.js —— Leaflet 地图控制：离线矢量底图（图数据自绘）、路径绘制、点选交互。
// 只负责渲染与坐标换算；任何业务判定（吸附/最近停车场等）都调用桥层 API。
window.MapCtl = (function () {
  let map = null;
  let layers = {};
  let nodeIndex = new Map(); // id -> node
  let graphBounds = null;
  let clickCb = null;
  let pathRed = null;     // 当前红色路径（用于清理方向箭头）
  let trackPlayer = null; // 当前轨迹回放实例
  let trackProgressCb = null; // 回放进度回调（转发给 UI 控制条）
  let trackFinishedCb = null; // 回放结束回调
  let trackWaiters = [];      // 等待"本段回放结束/被清理"的 settle 函数（可多个等待者）
  let trackHaltCb = null;     // 回放被清理/中断的通知（供 UI 复位状态）
  let lastPathPts = null;     // 最近一次路径点（供重播/状态查询）
  let radiusCircle = null;    // 停车半径圈（还车预览，纯渲染）
  let heatLayerRef = null;    // 节点连接热力图（leaflet.heat，纯渲染）
  let pathWhite = null;   // 当前白色描边（与红线同步生长）
  let drawSeq = 0;        // 绘制序号（防跨次定时器/监听误生长）
  let growState = null;   // 生长进行中状态 { els, readyEl, timer, zoomHandler }
  let pendingGrow = null; // 等待相机停稳后启动生长的 { seq, cancel }

  const STYLE = {
    intersection: { radius: 4, color: '#ffffff', weight: 1, fillColor: '#94a3a0', fillOpacity: 1 },
    building: { radius: 4.5, color: '#ffffff', weight: 1, fillColor: '#4a7dbf', fillOpacity: 1 },
    parking: { radius: 6, color: '#ffffff', weight: 2, fillColor: '#2fa06b', fillOpacity: 1 },
    temp: { radius: 6, color: '#ffffff', weight: 2, fillColor: '#8b5cf6', fillOpacity: 1 }
  };

  // tooltip 内容统一走 DOM 文本节点：Leaflet 对字符串内容直接赋 innerHTML，
  // 而节点名/单车编号可来自用户导入的 CSV，必须避免 HTML 注入。
  function tipEl(text) {
    const el = document.createElement('span');
    el.textContent = text;
    return el;
  }

  // 单车图层：内联 lucide bike 图标（ISC），divIcon 由 CSS 着色
  const BIKE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>';

  function bikeIcon() {
    return L.divIcon({
      className: 'bike-marker',
      html: '<span class="bike-marker-inner">' + BIKE_SVG + '</span>',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
  }

  // 渲染单车：nodeId>0 用图上节点坐标；nodeId<0 优先查节点索引（临时节点），否则用自带经纬度
  // 自带经纬度仅在有限且非 (0,0) 哨兵时生效；无位置（已借出）不画
  function renderBikes(bikes) {
    layers.bikes.clearLayers();
    if (!bikes) return;
    for (const b of bikes) {
      let latlng = null;
      if (b.nodeId > 0) {
        const n = nodeIndex.get(b.nodeId);
        if (n) latlng = [n.lat, n.lon];
      } else if (b.nodeId < 0) {
        const n = nodeIndex.get(b.nodeId);
        if (n) latlng = [n.lat, n.lon];
        else if (isFinite(b.lat) && isFinite(b.lon) && !(b.lat === 0 && b.lon === 0)) latlng = [b.lat, b.lon];
      }
      if (!latlng) continue;
      L.marker(latlng, { icon: bikeIcon(), keyboard: false })
        .bindTooltip(tipEl(b.bikeId + '（' + (b.status === 'available' ? '可借' : b.status) + '）'), { direction: 'top', offset: [0, -10] })
        .addTo(layers.bikes);
    }
  }

  function init(elId) {
    map = L.map(elId, {
      zoomControl: false,
      minZoom: 15,
      maxZoom: 19,
      attributionControl: true,
      fullscreenControl: true,
      fullscreenControlOptions: { position: 'bottomleft', title: '全屏显示' }
    });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.attributionControl.setPrefix(false);
    map.on('click', (e) => {
      if (clickCb) clickCb(e.latlng);
    });
    layers.edges = L.layerGroup().addTo(map);
    layers.nodes = L.layerGroup().addTo(map);
    layers.path = L.layerGroup().addTo(map);
    layers.misc = L.layerGroup().addTo(map);
    layers.bikes = L.layerGroup().addTo(map);
    layers.trace = L.layerGroup().addTo(map); // 逐步演示高亮（独立图层，随路径清理）
    map.setView([28.6778, 115.9237], 17);
  }

  function nodeById(id) {
    return nodeIndex.get(id) || null;
  }

  // 渲染图：节点圆点 + 边线；fit=true 时缩放到全校范围
  function renderGraph(graph, opts) {
    opts = opts || {};
    layers.edges.clearLayers();
    layers.nodes.clearLayers();
    layers.misc.clearLayers();
    nodeIndex = new Map();
    const latlngs = [];
    for (const n of graph.nodes) {
      nodeIndex.set(n.id, n);
      latlngs.push([n.lat, n.lon]);
    }
    if (!latlngs.length) return;
    graphBounds = L.latLngBounds(latlngs);

    for (const e of graph.edges) {
      const a = nodeIndex.get(e.from);
      const b = nodeIndex.get(e.to);
      if (!a || !b) continue;
      L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
        color: '#cbd5cf', weight: 2.5, opacity: 0.9, interactive: false
      }).addTo(layers.edges);
    }

    for (const n of graph.nodes) {
      const st = n.isTemp ? STYLE.temp : (STYLE[n.type] || STYLE.intersection);
      const m = L.circleMarker([n.lat, n.lon], st).addTo(layers.nodes);
      const display = n.isTemp ? 'T' + (-n.id) + '（临时节点）' : n.name;
      m.bindTooltip(tipEl(display), { direction: 'top', offset: [0, -6], opacity: 0.95 });
      if (n.type === 'parking' && !n.isTemp) {
        m.bindTooltip(tipEl(n.name), {
          permanent: true, direction: 'right', className: 'parking-label', offset: [8, 0]
        });
      }
    }
    if (opts.fit !== false) map.flyToBounds(graphBounds, { padding: [30, 30], duration: 1.2 });
  }

  // 生长动画收尾：清行内样式并挂流动虚线类（幂等）
  function endGrow() {
    if (!growState) return;
    const st = growState;
    growState = null;
    if (st.timer) clearTimeout(st.timer);
    if (st.zoomHandler) map.off('zoomend', st.zoomHandler);
    for (const el of st.els) {
      if (!el) continue;
      el.style.transition = '';
      el.style.strokeDasharray = '';
      el.style.strokeDashoffset = '';
    }
    if (st.readyEl) st.readyEl.classList.add('flow-ready'); // 生长完成后才启用流动虚线（避免被 CSS 动画抢 dashoffset）
  }

  // 立即遮罩：按当前长度满偏移，线路整体不可见
  function maskLine(el) {
    const len = el.getTotalLength();
    if (!len) return false;
    el.style.transition = 'none';
    el.style.strokeDasharray = len + 'px';
    el.style.strokeDashoffset = len + 'px';
    return true;
  }

  // 生长动画：量当前长度→满偏移→reflow→1.6s 过渡到 0；zoomend 兜底直接收尾（防重投影后 dash 失配）
  function growPath(lines) {
    endGrow();
    try {
      const els = [];
      for (const ln of lines) {
        const el = ln && ln.getElement && ln.getElement();
        if (el && typeof el.getTotalLength === 'function') els.push(el);
      }
      if (!els.length) return;
      for (const el of els) maskLine(el);
      void els[0].getBoundingClientRect(); // 强制 reflow，确保过渡从起点开始
      for (const el of els) {
        el.style.transition = 'stroke-dashoffset 1.6s ease-out';
        el.style.strokeDashoffset = '0px';
      }
      growState = { els: els, readyEl: lines[lines.length - 1].getElement(), timer: null, zoomHandler: null };
      growState.zoomHandler = function () { endGrow(); };
      map.on('zoomend', growState.zoomHandler);
      growState.timer = setTimeout(endGrow, 1800);
    } catch (e) { /* 动画失败不影响功能 */ }
  }

  // fit 时等相机停稳再生长：飞行前已遮罩，moveend 后按新缩放重测量再生长；超时兜底防卡死
  function scheduleGrow(seq, lines, flyMs) {
    let done = false;
    const start = () => {
      if (done || seq !== drawSeq) return;
      done = true;
      if (pendingGrow && pendingGrow.seq === seq) pendingGrow = null;
      growPath(lines);
    };
    const h = () => start();
    map.once('moveend', h);
    const t = setTimeout(start, (flyMs || 1200) + 350);
    pendingGrow = { seq: seq, cancel: function () { map.off('moveend', h); clearTimeout(t); } };
  }

  // 绘制路径（含白色描边与起终点标记）
  // opts: { animate=true 生长动画, autoplay=true 建后自动回放, fit=true 视野跟随, speed=400 回放速度 }
  function drawPath(pathIds, opts) {
    opts = opts || {};
    const animate = opts.animate !== false;
    const autoplay = opts.autoplay !== false;
    const speed = opts.speed || 400;
    clearPath();
    if (!pathIds || pathIds.length < 2) return;
    const pts = [];
    for (const id of pathIds) {
      const n = nodeIndex.get(id);
      if (n) pts.push([n.lat, n.lon]);
    }
    if (pts.length !== pathIds.length || pts.length < 2) {
      console.warn('[map] drawPath 缺少节点，已跳过绘制：', pathIds.filter((id) => !nodeIndex.has(id)));
      return; // 任一节点缺失则不画残线
    }
    pathWhite = L.polyline(pts, { color: '#ffffff', weight: 8, opacity: 0.75, interactive: false }).addTo(layers.path);
    pathRed = L.polyline(pts, { color: '#e5484d', weight: 4.5, opacity: 0.95, interactive: false, className: 'flow-line' }).addTo(layers.path);
    drawSeq++;
    if (animate && opts.fit !== false) {
      // 先遮罩（按起飞前长度）→ 相机停稳后重测量再生长（修首绘跨缩放 dash 失配）
      try {
        if (pathWhite && pathWhite.getElement()) maskLine(pathWhite.getElement());
        if (pathRed && pathRed.getElement()) maskLine(pathRed.getElement());
      } catch (e) { /* 遮罩失败退化为可见，不影响功能 */ }
      scheduleGrow(drawSeq, [pathWhite, pathRed], 1200);
    } else if (animate) {
      growPath([pathWhite, pathRed]); // 描画生长动画（纯视觉，不改变任何数据）
    } else {
      try { const el = pathRed.getElement(); if (el) el.classList.add('flow-ready'); } catch (e) { /* 忽略 */ }
    }
    try {
      if (pathRed.arrowheads) pathRed.arrowheads({ size: '10px', frequency: '70px', yawn: 40 });
    } catch (e) { /* 方向箭头失败不影响功能 */ }
    try {
      // 光带：缓慢流动的白色虚线叠加在红线之上（leaflet-ant-path；纯视觉，不改变任何数据）
      if (L.polyline && L.polyline.antPath) {
        L.polyline.antPath(pts, {
          color: '#ffd166', pulseColor: '#ffffff', weight: 2, opacity: 0.8,
          dashArray: [4, 22], delay: 700, hardwareAcceleration: true, interactive: false
        }).addTo(layers.path);
      }
    } catch (e) { /* 光带失败不影响功能 */ }
    lastPathPts = pts;
    try {
      if (L.TrackPlayer) {
        trackPlayer = new L.TrackPlayer(pts, {
          speed: speed, weight: 0,
          passedLineColor: 'rgba(0,0,0,0)', notPassedLineColor: 'rgba(0,0,0,0)',
          polylineDecoratorOptions: { patterns: [] },
          panTo: opts.follow === true, markerRotation: false,
          markerIcon: bikeIcon()
        });
        trackPlayer.addTo(map);
        if (trackProgressCb) trackPlayer.on('progress', trackProgressCb);
        trackPlayer.on('finished', () => { settleTrackWaiters(); if (trackFinishedCb) trackFinishedCb(); });
        if (autoplay) trackPlayer.start();
      }
    } catch (e) { trackPlayer = null; }
    const s = nodeIndex.get(pathIds[0]);
    const t = nodeIndex.get(pathIds[pathIds.length - 1]);
    if (s) {
      L.circleMarker([s.lat, s.lon], { radius: 7, color: '#ffffff', weight: 2, fillColor: '#2fa06b', fillOpacity: 1, className: 'pulse-start' })
        .bindTooltip(tipEl('起点：' + s.name), { direction: 'top' }).addTo(layers.path);
    }
    if (t) {
      L.circleMarker([t.lat, t.lon], { radius: 7, color: '#ffffff', weight: 2, fillColor: '#e5484d', fillOpacity: 1, className: 'pulse-end' })
        .bindTooltip(tipEl('终点：' + t.name), { direction: 'top' }).addTo(layers.path);
      // 雷达锁点（纯展示）：终点雷达扩散 + 四角锁定框，clearPath 时随 layers.path 一起清除
      L.marker([t.lat, t.lon], {
        interactive: false,
        icon: L.divIcon({
          className: 'radar-lock',
          html: '<i class="rl-ring"></i><i class="rl-ring rl-ring2"></i><b class="rl-c rl-tl"></b><b class="rl-c rl-tr"></b><b class="rl-c rl-bl"></b><b class="rl-c rl-br"></b><s class="rl-dot"></s>',
          iconSize: [44, 44], iconAnchor: [22, 22]
        })
      }).addTo(layers.path);
    }
    if (opts.fit !== false) map.flyToBounds(L.latLngBounds(pts), { padding: [40, 40], duration: 1.2 });
  }

  function clearPath() {
    drawSeq++; // 使旧的待生长回调失效
    if (pendingGrow) { pendingGrow.cancel(); pendingGrow = null; }
    endGrow();
    pathWhite = null;
    lastPathPts = null;
    settleTrackWaiters(); // 清理即视为"本段回放结束"，放行等待者
    if (trackPlayer) {
      try { trackPlayer.remove(); } catch (e) { /* 忽略 */ }
      trackPlayer = null;
    }
    if (pathRed) {
      try { if (pathRed._arrowheads) pathRed._arrowheads.remove(); } catch (e) { /* 忽略 */ }
      pathRed = null;
    }
    layers.path.clearLayers();
    traceClear(); // 逐步演示高亮随路径清理
    if (trackHaltCb) trackHaltCb(); // 通知 UI：回放已被清理（状态复位）
  }

  // 备选路线（纯展示）：在主路径之外叠画灰色虚线；随 clearPath（layers.path）一起清除
  function drawVariants(pathLists) {
    if (!pathLists || !pathLists.length) return;
    for (const ids of pathLists) {
      if (!ids || ids.length < 2) continue;
      const pts = [];
      let ok = true;
      for (const id of ids) {
        const n = nodeIndex.get(id);
        if (!n) { ok = false; break; }
        pts.push([n.lat, n.lon]);
      }
      if (!ok) continue; // 任一节点缺失则不画残线（与 drawPath 同口径）
      L.polyline(pts, { color: '#7a8a99', weight: 3, opacity: 0.55, dashArray: '6 8', interactive: false })
        .addTo(layers.path);
    }
  }

  function showPick(latlng, label) {
    layers.misc.clearLayers();
    const m = L.circleMarker(latlng, {
      radius: 7, color: '#ffffff', weight: 2, fillColor: '#f59e0b', fillOpacity: 1,
      className: 'pulse-pick'
    }).addTo(layers.misc);
    if (label) m.bindTooltip(tipEl(label), { direction: 'top' }).openTooltip();
  }

  // 逐步演示高亮（Dijkstra 确定顺序；纯展示，独立图层，随 clearPath/traceClear 清除）
  function traceHighlight(id) {
    const n = nodeIndex.get(id);
    if (!n) return false;
    traceClear();
    L.circleMarker([n.lat, n.lon], {
      radius: 9, color: '#ffd166', weight: 3, fillColor: '#ffb703', fillOpacity: .55,
      className: 'pulse-trace', interactive: false
    }).bindTooltip(tipEl(n.name), { direction: 'top', offset: [0, -8], opacity: .95 }).openTooltip()
      .addTo(layers.trace);
    return true;
  }

  function traceClear() {
    if (layers.trace) layers.trace.clearLayers();
  }

  // 节点连接热力图（leaflet.heat）：数据由 app.js 从桥层图数据计算，此处只渲染
  function addHeat(pts) {
    removeHeat();
    if (!L.heatLayer) return false;
    heatLayerRef = L.heatLayer(pts, { radius: 24, blur: 20, maxZoom: 17, minOpacity: .35 }).addTo(map);
    return true;
  }

  function removeHeat() {
    if (heatLayerRef) {
      map.removeLayer(heatLayerRef);
      heatLayerRef = null;
    }
  }

  // 停车半径圈：半径值由桥层 returnPreview 返回（生效半径），此处只画不算
  function showRadius(latlng, radiusMeters) {
    if (radiusCircle) {
      layers.misc.removeLayer(radiusCircle);
      radiusCircle = null;
    }
    if (!latlng || !(radiusMeters > 0)) return;
    radiusCircle = L.circle(latlng, {
      radius: radiusMeters, color: '#2fa06b', weight: 1.5, opacity: 0.85,
      fillColor: '#2fa06b', fillOpacity: 0.12, interactive: false
    }).addTo(layers.misc);
  }

  // 回放控制：TrackPlayer 已有能力的薄封装，只做 UI，不改变业务数据
  function trackToggle() {
    if (!trackPlayer) return false;
    if (trackPlayer.finished || trackPlayer.isPaused) {
      trackPlayer.start(); // 结束态 start() 会重置并重播（progress===1）
      return true;
    }
    trackPlayer.pause();
    return false;
  }

  function trackReplay() {
    if (!trackPlayer) return false;
    // vendor 语义：暂停态 setProgress 只渲染不驱 rAF（需 start() 重新出发）；
    // 结束态 setProgress(0) 自带重播；播放中由下一帧重置时间戳从 0 继续。
    trackPlayer.setProgress(0);
    if (trackPlayer.isPaused) trackPlayer.start();
    return true;
  }

  function trackSetSpeed(speed) {
    if (!trackPlayer) return;
    trackPlayer.setSpeed(speed);
  }

  // 进度条拖动定位（vendor setProgress 语义）：暂停态只重绘；播放态下一帧从新位置继续；
  // 结束态 seek 后按暂停处理（视频播放器语义：拖到某点停住，待用户再点回放续播）。
  // 返回定位后的播放状态；null 表示当前没有回放实例。
  function trackSeek(progress) {
    if (!trackPlayer) return null;
    const p = Math.max(0, Math.min(1, Number(progress) || 0));
    const wasFinished = !!trackPlayer.finished;
    trackPlayer.setProgress(p);
    if (wasFinished) trackPlayer.pause(); // vendor 结束态 setProgress 会自动续播，这里收回为暂停
    return !trackPlayer.isPaused && !trackPlayer.finished;
  }

  function onTrackProgress(cb) { trackProgressCb = cb; }
  function onTrackFinished(cb) { trackFinishedCb = cb; }
  function onTrackHalt(cb) { trackHaltCb = cb; }

  // 多等待者：finished 或 clearPath 时放行；无实例/已结束立即放行
  function settleTrackWaiters() {
    if (trackWaiters.length) {
      const fns = trackWaiters;
      trackWaiters = [];
      for (const fn of fns) fn();
    }
  }

  function waitTrackFinished() {
    if (!trackPlayer || trackPlayer.finished) return Promise.resolve();
    return new Promise((resolve) => { trackWaiters.push(resolve); });
  }

  function clearMisc() {
    layers.misc.clearLayers();
    radiusCircle = null;
  }

  function fitAll() {
    if (graphBounds) map.flyToBounds(graphBounds, { padding: [30, 30], duration: 1.0 });
  }

  function onMapClick(cb) {
    clickCb = cb;
  }

  function addTile(url, opts) {
    const t = L.tileLayer(url, opts);
    t.addTo(map);
    return t;
  }

  function removeLayer(t) {
    if (t && map) map.removeLayer(t);
  }

  // 小地图（纯展示）：影院期显示，随主图底图同步切换
  let miniMap = null;
  function showMiniMap(url, tileOpts) {
    try {
      if (miniMap || !map) return;
      const base = url ? L.tileLayer(url, tileOpts || {}) : L.layerGroup();
      miniMap = new L.Control.MiniMap(base, {
        position: 'topright', width: 110, height: 74,
        zoomLevelOffset: -4, toggleDisplay: false
      }).addTo(map);
    } catch (e) { miniMap = null; }
  }
  function hideMiniMap() {
    try { if (miniMap) { miniMap.remove(); miniMap = null; } } catch (e) { miniMap = null; }
  }
  function setMiniMapBase(url, tileOpts) {
    try {
      if (!miniMap) return;
      const base = url ? L.tileLayer(url, tileOpts || {}) : L.layerGroup();
      miniMap.changeLayer(base);
    } catch (e) { /* 小地图切换失败不影响功能 */ }
  }

  return {
    init: init,
    nodeById: nodeById,
    renderGraph: renderGraph,
    drawPath: drawPath,
    drawVariants: drawVariants,
    renderBikes: renderBikes,
    clearPath: clearPath,
    showPick: showPick,
    clearMisc: clearMisc,
    fitAll: fitAll,
    onMapClick: onMapClick,
    addTile: addTile,
    removeLayer: removeLayer,
    showMiniMap: showMiniMap,
    hideMiniMap: hideMiniMap,
    setMiniMapBase: setMiniMapBase,
    addHeat: addHeat,
    removeHeat: removeHeat,
    traceHighlight: traceHighlight,
    traceClear: traceClear,
    showRadius: showRadius,
    trackToggle: trackToggle,
    trackReplay: trackReplay,
    trackSetSpeed: trackSetSpeed,
    trackSeek: trackSeek,
    onTrackProgress: onTrackProgress,
    onTrackFinished: onTrackFinished,
    onTrackHalt: onTrackHalt,
    waitTrackFinished: waitTrackFinished,
    getMap: () => map
  };
})();
