// api.js —— WASM 桥层封装：初始化 CampusNav 引擎并把 JSON 字符串解析为对象。
// 所有业务逻辑都在 C++（src/）中，本层只做调用与解析，不重写任何业务规则。
window.Api = (function () {
  let mod = null;
  let initP = null; // 并发/重复调用共享同一个加载 Promise（幂等）

  async function init() {
    if (mod) return mod;
    if (!initP) {
      initP = CampusNav().then((m) => { mod = m; return m; }) // 工厂函数由 web/dist/campus_core.js 提供
        .catch((e) => { initP = null; throw e; });
    }
    return initP;
  }

  function J(s) {
    try {
      return JSON.parse(s);
    } catch (e) {
      return { ok: false, error: '桥层返回了非法 JSON：' + e.message };
    }
  }

  return {
    init: init,
    load: (nodes, edges, bikes, temps) => J(mod.load(nodes, edges, bikes, temps)),
    getGraph: () => J(mod.getGraph()),
    getBikes: () => J(mod.getBikes()),
    getTemps: () => J(mod.getTemps()),
    status: () => J(mod.status()),
    nearestNode: (lat, lon) => J(mod.nearestNode(lat, lon)),
    shortestPath: (from, to) => J(mod.shortestPath(from, to)),
    multiStep: (idsCsv) => J(mod.multiStep(idsCsv)),
    minHops: (from, to) => J(mod.minHops(from, to)),
    nearestParking: (lat, lon) => J(mod.nearestParking(lat, lon)),
    returnPreview: (lat, lon) => J(mod.returnPreview(lat, lon)),
    borrow: (bikeId) => J(mod.borrow(bikeId)),
    returnBike: (bikeId, lat, lon) => J(mod.returnBike(bikeId, lat, lon)),
    addTemp: (lat, lon, linkedParking) => J(mod.addTemp(lat, lon, linkedParking)),
    removeTemp: (nodeId) => J(mod.removeTemp(nodeId)),
    importBikes: (csv) => J(mod.importBikes(csv)),
    importTemps: (csv) => J(mod.importTemps(csv)),
    save: () => J(mod.save()),
    markSaved: () => J(mod.markSaved()),
    repairGhosts: () => J(mod.repairGhosts())
  };
})();
