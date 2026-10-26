// api.js —— WASM 桥层封装：初始化 CampusNav 引擎并把 JSON 字符串解析为对象。
// 所有业务逻辑都在 C++（src/）中，本层只做调用与解析，不重写任何业务规则。
window.Api = (function () {
  let mod = null;
  let initP = null; // 并发/重复调用共享同一个加载 Promise（幂等）
  const INIT_TIMEOUT_MS = 15000;

  async function init() {
    if (mod) return mod;
    if (!initP) {
      let timer = 0;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('WASM 引擎加载超时（15 秒），请重试'));
        }, INIT_TIMEOUT_MS);
      });
      // 工厂函数由 web/dist/campus_core.js 提供；超时/失败后清空 initP，
      // 让启动页的重试路径可以重新初始化，同时并发调用仍共享同一个 Promise。
      initP = Promise.race([Promise.resolve().then(() => CampusNav()), timeout])
        .then((m) => { mod = m; return m; })
        .catch((e) => { initP = null; throw e; })
        .finally(() => { if (timer) clearTimeout(timer); });
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

  // 统一调用兜底（P1-3）：mod 未初始化、WASM 侧抛异常等一律转为
  // { ok:false, error } 形状（与 J 的失败形状一致），调用方按 r.ok 分支即可；
  // 修复前是 J(mod.x(...))——mod.x(...) 先于 J 求值，异常会直接炸穿调用点。
  function call(name, ...args) {
    try {
      if (!mod) throw new Error('引擎尚未初始化');
      return J(mod[name](...args));
    } catch (e) {
      return { ok: false, error: '桥层调用异常（' + name + '）：' + (e && e.message ? e.message : String(e)) };
    }
  }

  return {
    init: init,
    load: (nodes, edges, bikes, temps) => call('load', nodes, edges, bikes, temps),
    getGraph: () => call('getGraph'),
    getBikes: () => call('getBikes'),
    getTemps: () => call('getTemps'),
    status: () => call('status'),
    snapshot: () => call('snapshot'),
    nearestNode: (lat, lon) => call('nearestNode', lat, lon),
    shortestPath: (from, to) => call('shortestPath', from, to),
    topPaths: (from, to, k) => call('topPaths', from, to, k),
    multiStep: (idsCsv) => call('multiStep', idsCsv),
    minHops: (from, to) => call('minHops', from, to),
    dijkstraTrace: (from, to) => call('dijkstraTrace', from, to),
    nearestParking: (lat, lon) => call('nearestParking', lat, lon),
    returnPreview: (lat, lon) => call('returnPreview', lat, lon),
    borrow: (bikeId) => call('borrow', bikeId),
    returnBike: (bikeId, lat, lon) => call('returnBike', bikeId, lat, lon),
    addTemp: (lat, lon, linkedParking) => call('addTemp', lat, lon, linkedParking),
    removeTemp: (nodeId) => call('removeTemp', nodeId),
    importBikes: (csv) => call('importBikes', csv),
    importTemps: (csv) => call('importTemps', csv),
    precheckBikes: (csv) => call('precheckBikes', csv),
    precheckTemps: (csv) => call('precheckTemps', csv),
    save: () => call('save'),
    markSaved: (revision) => call('markSaved', revision),
    repairGhosts: () => call('repairGhosts')
  };
})();
