// map3d.js —— 独立 3D 校园页：MapLibre fill-extrusion + 现有 WASM 业务数据。
// 只读渲染；路线查询调用 window.Api（src/ 业务逻辑），不在 JS 重写算法。
(function () {
  'use strict';

  const GAODE_URL = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';
  const $ = (id) => document.getElementById(id);
  const state = {
    map: null,
    graph: null,
    nodeIndex: new Map(),
    online: false,
    routeCoords: [],
    comet: null,
    animId: 0,
    ready: false
  };

  function setLoading(text, error) {
    const box = $('m3d-loading');
    if (!box) return;
    const textEl = $('m3d-loading-text');
    if (textEl) textEl.textContent = text;
    const active = !!text || !!error;
    box.classList.toggle('hidden', !active);
    box.classList.toggle('error', !!error); // 错误态：隐藏转圈，显示「重试」
    box.style.display = active ? 'flex' : 'none';
    box.setAttribute('aria-hidden', active ? 'false' : 'true');
    box.setAttribute('role', error ? 'alert' : 'status');
  }

  function setResult(text) {
    const el = $('result');
    if (el) el.textContent = text;
  }

  function nodeName(n) {
    return n ? (n.isTemp ? 'T' + (-n.id) : n.name) : '';
  }

  function featureCollection(features) {
    return { type: 'FeatureCollection', features };
  }

  function graphFeatures() {
    const g = state.graph;
    const edges = [];
    const nodes = [];
    for (const e of g.edges) {
      const a = state.nodeIndex.get(e.from);
      const b = state.nodeIndex.get(e.to);
      if (!a || !b) continue;
      edges.push({
        type: 'Feature',
        properties: { weight: e.weight },
        geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] }
      });
    }
    for (const n of g.nodes) {
      nodes.push({
        type: 'Feature',
        properties: { id: n.id, name: nodeName(n), type: n.type, isTemp: n.isTemp },
        geometry: { type: 'Point', coordinates: [n.lon, n.lat] }
      });
    }
    return { edges: featureCollection(edges), nodes: featureCollection(nodes) };
  }

  function addBaseLayers() {
    const map = state.map;
    const gf = graphFeatures();

    // 建筑：GBA 体块（高度来自 LoD1；无高度回退 12m 已在构建脚本处理）
    const buildings = window.CAMPUS_BUILDINGS || featureCollection([]);
    map.addSource('buildings', { type: 'geojson', data: buildings });
    map.addLayer({
      id: 'buildings',
      type: 'fill-extrusion',
      source: 'buildings',
      paint: {
        'fill-extrusion-color': [
          'interpolate', ['linear'], ['get', 'height'],
          3, '#0f3a29',
          18, '#1f7a55',
          45, '#2fa06b',
          90, '#54d6a0'
        ],
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.86
      }
    });

    // 路网：发光底线 + 细亮线
    map.addSource('edges', { type: 'geojson', data: gf.edges });
    map.addLayer({
      id: 'edges-glow', type: 'line', source: 'edges',
      paint: { 'line-color': '#2fa06b', 'line-width': 8, 'line-opacity': 0.12, 'line-blur': 6 }
    });
    map.addLayer({
      id: 'edges', type: 'line', source: 'edges',
      paint: { 'line-color': '#64e0ae', 'line-width': 1.6, 'line-opacity': 0.75 }
    });

    // 节点：路口/建筑/停车场/临时节点
    map.addSource('nodes', { type: 'geojson', data: gf.nodes });
    map.addLayer({
      id: 'nodes', type: 'circle', source: 'nodes',
      paint: {
        'circle-radius': ['case', ['==', ['get', 'type'], 'parking'], 7, 4.5],
        'circle-color': [
          'case',
          ['==', ['get', 'isTemp'], true], '#b388ff',
          ['==', ['get', 'type'], 'parking'], '#54d6a0',
          ['==', ['get', 'type'], 'building'], '#6aa9ff',
          '#d7e3db'
        ],
        'circle-stroke-color': '#06100b',
        'circle-stroke-width': 1.5
      }
    });

    // 路线：底层光晕 + 金色主线（初始空）
    const empty = featureCollection([]);
    map.addSource('route', { type: 'geojson', data: empty });
    map.addLayer({
      id: 'route-glow', type: 'line', source: 'route',
      paint: { 'line-color': '#ffd166', 'line-width': 16, 'line-opacity': 0.18, 'line-blur': 10 }
    });
    map.addLayer({
      id: 'route', type: 'line', source: 'route',
      paint: {
        'line-color': '#ffd166', 'line-width': 4,
        'line-opacity': 1, 'line-blur': 0.4
      }
    });

    // 在线高德底图（默认关闭；打开时插到建筑下方）
    map.on('click', 'nodes', (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      const p = f.properties || {};
      const c = f.geometry.coordinates.slice();
      new maplibregl.Popup({ className: 'm3d-popup', closeButton: false })
        .setLngLat(c).setText(p.name + (p.type ? ' · ' + p.type : '')).addTo(map);
    });
    map.on('mouseenter', 'nodes', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'nodes', () => { map.getCanvas().style.cursor = ''; });
  }

  function addOnline() {
    const map = state.map;
    if (!map || map.getSource('gaode')) return;
    // MapLibre 的 tiles 不支持 Leaflet 的 {s} 占位符：展开成 4 个具体子域。
    const tileUrls = ['1', '2', '3', '4'].map((s) => GAODE_URL.replace('{s}', s));
    map.addSource('gaode', {
      type: 'raster',
      tiles: tileUrls,
      tileSize: 256,
      attribution: '© 高德地图'
    });
    map.addLayer({
      id: 'gaode', type: 'raster', source: 'gaode',
      paint: { 'raster-opacity': 0.92, 'raster-saturation': -0.2, 'raster-brightness-min': 0.05 }
    }, map.getLayer('buildings') ? 'buildings' : undefined);
  }

  function removeOnline() {
    const map = state.map;
    if (!map) return;
    if (map.getLayer('gaode')) map.removeLayer('gaode');
    if (map.getSource('gaode')) map.removeSource('gaode');
  }

  function toggleOnline() {
    state.online = !state.online;
    if (state.online) addOnline(); else removeOnline();
    const btn = $('online-btn');
    if (btn) btn.textContent = state.online ? '离线底图' : '在线底图';
  }

  // 移动端面板在底部：按实际面板高度留白，避免固定 right:340 把小屏地图压没。
  function mapPadding() {
    const mobile = window.innerWidth <= 760;
    if (!mobile) return { top: 90, bottom: 70, left: 80, right: 340 };
    const panel = document.querySelector('.m3d-panel');
    const panelH = panel ? panel.getBoundingClientRect().height : 0;
    return {
      top: 96,
      bottom: Math.max(140, Math.round(panelH || window.innerHeight * 0.46) + 56),
      left: 12,
      right: 12
    };
  }

  function fitCampus() {
    const g = state.graph;
    if (!g || !g.nodes.length || !state.map) return;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const n of g.nodes) {
      minLon = Math.min(minLon, n.lon); maxLon = Math.max(maxLon, n.lon);
      minLat = Math.min(minLat, n.lat); maxLat = Math.max(maxLat, n.lat);
    }
    state.map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
      padding: mapPadding(),
      pitch: 52, bearing: -18, duration: 0
    });
  }

  function routeCoordsFromIds(ids) {
    const out = [];
    for (const id of ids) {
      const n = state.nodeIndex.get(id);
      if (n) out.push([n.lon, n.lat]);
    }
    return out;
  }

  function setRoute(coords) {
    state.routeCoords = coords;
    const src = state.map && state.map.getSource('route');
    if (src) {
      src.setData(coords.length >= 2
        ? { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } }
        : featureCollection([]));
    }
    if (state.comet) { state.comet.remove(); state.comet = null; }
    if (state.animId) { cancelAnimationFrame(state.animId); state.animId = 0; }
  }

  function animateComet(coords) {
    if (!state.map || coords.length < 2) return;
    const el = document.createElement('div');
    el.className = 'm3d-comet';
    state.comet = new maplibregl.Marker({ element: el }).setLngLat(coords[0]).addTo(state.map);
    const start = performance.now();
    const duration = 9000;
    const step = (now) => {
      if (!state.comet || coords.length < 2) { state.animId = 0; return; }
      const p = Math.max(0, Math.min(1, (now - start) / duration));
      const seg = p * (coords.length - 1);
      const i = Math.max(0, Math.min(coords.length - 2, Math.floor(seg)));
      const t = Math.max(0, Math.min(1, seg - i));
      const a = coords[i], b = coords[i + 1];
      state.comet.setLngLat([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      if (p < 1) state.animId = requestAnimationFrame(step);
      else state.animId = 0;
    };
    state.animId = requestAnimationFrame(step);
  }

  function planRoute() {
    const from = Number($('from').value);
    const to = Number($('to').value);
    if (!from || !to) return setResult('请选择起点和终点。');
    const r = window.Api.shortestPath(from, to);
    if (!r || !r.ok) {
      setResult('规划失败：' + ((r && r.error) || '未知错误'));
      return;
    }
    const coords = routeCoordsFromIds(r.path || []);
    if (coords.length < 2) return setResult('路线不足两个节点。');
    setRoute(coords);
    const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    state.map.fitBounds(bounds, {
      padding: mapPadding(),
      pitch: 58, bearing: -22, duration: 1600
    });
    const segs = Array.isArray(r.segments) ? r.segments.length : 0;
    setResult('距离 ' + Number(r.dist).toFixed(1) + ' 米 · ' +
      (r.path ? r.path.length : 0) + ' 个节点' + (segs ? ' · ' + segs + ' 段' : ''));
    animateComet(coords);
  }

  function flyRoute() {
    if (!state.map) return;
    if (state.routeCoords.length < 2) {
      fitCampus();
      return;
    }
    const mid = state.routeCoords[Math.floor(state.routeCoords.length / 2)];
    state.map.flyTo({
      center: mid, zoom: 18.2, pitch: 68, bearing: 28,
      duration: 2600, essential: true
    });
  }

  function populateSelects() {
    const g = state.graph;
    const from = $('from'), to = $('to');
    const nodes = g.nodes.filter((n) => !n.isTemp);
    for (const n of nodes) {
      const label = n.name + ' (' + n.id + ')';
      const o1 = document.createElement('option');
      o1.value = String(n.id); o1.textContent = label;
      const o2 = o1.cloneNode(true);
      from.appendChild(o1); to.appendChild(o2);
    }
    if (nodes.length > 1) {
      from.value = String(nodes[0].id);
      to.value = String(nodes[Math.min(1, nodes.length - 1)].id);
    }
  }

  function renderStats() {
    const g = state.graph;
    const bikes = window.Api.getBikes();
    const temps = window.Api.getTemps();
    const cards = [
      [g.nodes.length, '节点'],
      [g.edges.length, '路段'],
      [(bikes.bikes || []).length, '单车'],
      [(temps.temps || []).length, '临时节点']
    ];
    const box = $('stats');
    box.textContent = '';
    for (const [value, label] of cards) {
      const d = document.createElement('div');
      d.className = 'm3d-stat';
      const b = document.createElement('b'); b.textContent = String(value);
      const s = document.createElement('span'); s.textContent = label;
      d.appendChild(b); d.appendChild(s); box.appendChild(d);
    }
  }

  function boot() {
    try {
      if (!window.maplibregl) throw new Error('MapLibre 未加载');
      const map = new maplibregl.Map({
        container: 'map3d',
        style: {
          version: 8,
          sources: {},
          layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#06100b' } }]
        },
        center: [115.9237, 28.6778],
        zoom: 16.4,
        pitch: 52,
        bearing: -18,
        antialias: true,
        attributionControl: true
      });
      state.map = map;
      map.setMaxPitch(75);
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
      map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
      if (typeof map.setFog === 'function') {
        map.setFog({
          color: '#08150f', 'high-color': '#1b4a35', 'horizon-blend': 0.25,
          'space-color': '#020604', 'star-intensity': 0.06
        });
      }
      map.on('error', (e) => {
        // 瓦片错误不致命；地图源/WebGL 错误才提示
        if (!state.ready) {
          const msg = (e && e.error && e.error.message) || '三维地图初始化失败';
          setLoading('3D 加载失败：' + msg + '（可返回 2D 工作台）', true);
        }
      });
      map.on('load', () => {
        addBaseLayers();
        populateSelects();
        renderStats();
        fitCampus();
        state.ready = true;
        setLoading('', false); // 成功：display:none + aria-hidden，真正移出交互/读屏
        window.__3D_READY__ = true;
      });
      $('route-btn').addEventListener('click', planRoute);
      $('fly-btn').addEventListener('click', flyRoute);
      $('online-btn').addEventListener('click', toggleOnline);
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          if (state.comet) { state.comet.remove(); state.comet = null; }
        }
      });
    } catch (e) {
      setLoading('3D 加载失败：' + (e && e.message ? e.message : e) + '（可返回 2D 工作台）', true);
    }
  }

  async function init() {
    try {
      setLoading('正在加载三维校园…', false);
      await window.Api.init();
      const d = window.CAMPUS_DATA;
      if (!d) throw new Error('缺少 data_campus.js');
      const loaded = window.Api.load(d.nodes, d.edges, d.bikes, d.temps);
      if (!loaded || !loaded.ok) throw new Error((loaded && loaded.error) || '业务数据载入失败');
      state.graph = window.Api.getGraph();
      state.nodeIndex = new Map(state.graph.nodes.map((n) => [n.id, n]));
      boot();
    } catch (e) {
      setLoading('3D 加载失败：' + (e && e.message ? e.message : e) + '（可返回 2D 工作台）', true);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
