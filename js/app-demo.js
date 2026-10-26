// app-demo.js —— 「自动演示导演」composable（批 4 从 app.js 拆出）：
// 一键演示：查询 → 回放 → 借还车 → 展示保存入口（不自动下载；会修改数据，刷新页面可重置）；
// 含电影画幅（letterbox）、GSAP 大字幕、片尾烟花/彩带、提示音。
// 用法：const demo = window.CampusDemo.create(ctx); demo.startDemo()；再次调用即停止。
window.CampusDemo = (function () {
  function create(ctx) {
    // ctx: { loadScript, ElMessage, beep, graphNodes, bikes, stats, q, activeTab, pick, pickHint,
    //        fitAll, refreshAll, rerenderGraph, clearQuery, doShortest, doMinHops, doMulti,
    //        bikeLocation, pausePlayback, onlineTiles }
    // 令牌用对象身份而非数字自增：停止后快速重启时，旧链的 finally 不会误杀新演示
    let demoToken = null; // null=未演示；非 null 时再次点击 🎬 即停止当前演示
    // 演示定时器统一登记：停止时清除全部 setTimeout 并放行等待者，旧链随后按令牌退出
    const demoTimers = new Set();
    function later(fn, ms) {
      const entry = { id: 0, fn: fn, resolve: null };
      entry.id = setTimeout(() => {
        demoTimers.delete(entry);
        try { fn(); } catch (e) { /* 演示步骤失败由主链兜底 */ }
      }, ms);
      demoTimers.add(entry);
      return entry.id;
    }
    function demoWait(ms) {
      return new Promise((resolve) => {
        const entry = { id: 0, fn: null, resolve: resolve };
        entry.id = setTimeout(() => {
          demoTimers.delete(entry);
          resolve();
        }, ms);
        demoTimers.add(entry);
      });
    }
    function clearDemoTimers() {
      const list = Array.from(demoTimers);
      demoTimers.clear();
      for (const entry of list) {
        clearTimeout(entry.id);
        if (entry.resolve) entry.resolve();
      }
    }
    // 等待回放自然结束（finished 事件）；capMs 为防卡死兜底上线
    async function waitPlaybackDone(capMs) {
      await Promise.race([MapCtl.waitTrackFinished(), demoWait(capMs)]);
    }
    // 大字幕章节名（与 01/07 ~ 07/07 对应）
    const DEMO_CHAPTERS = ['启程 · 校园路网', '求解 · 最短路径', '对比 · 最少跳数', '展示 · 多段导航', '业务 · 借车', '业务 · 还车', '收尾 · 数据持久化'];
    // GSAP 电影插件懒加载（P1-5）：自动演示开始时注入（3.13 全免费版；任一缺失时相关效果自动降级）
    let gsapLoader = null;
    function ensureGsap() {
      if (window.gsap && window.SplitText) return Promise.resolve();
      if (gsapLoader) return gsapLoader;
      gsapLoader = ctx.loadScript('vendor/gsap.min.js')
        .then(() => ctx.loadScript('vendor/SplitText.min.js'))
        .then(() => { try { gsap.registerPlugin(window.SplitText); } catch (e) { /* 注册失败不影响演示 */ } })
        .catch(() => { gsapLoader = null; }); // 失败静默：演示各步已有降级
      return gsapLoader;
    }
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
      const t = ctx.onlineTiles();
      MapCtl.showMiniMap(t ? t.url : null, t ? t.opts : null);
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
      ctx.beep(640, .05); // 字幕换页轻提示（beep 自带 soundOn 守卫）
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
    // 立即清空字幕：停 GSAP 补间、还原 SplitText、移除 show 与行内样式（停止演示时调用）
    function resetCaption() {
      const el = document.getElementById('demo-caption');
      if (lastSplit) {
        try { lastSplit.revert(); } catch (e) { /* 已还原时忽略 */ }
        lastSplit = null;
      }
      if (el) {
        const g = window.gsap;
        if (g) { try { g.killTweensOf(el); } catch (e) { /* 忽略 */ } }
        el.classList.remove('show');
        el.textContent = '';
        el.removeAttribute('style');
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
        later(() => { if (fx) stopFireworks(); }, ms || 3400);
        return true;
      } catch (e) { return false; }
    }
    // 开锁“咔哒”声（两声短促提示；beep 自带提示音开关守卫）
    function clickSfx() { ctx.beep(1250, .03); later(() => ctx.beep(700, .045), 55); }
    // 还车归位声（上行两音）
    function returnSfx() { ctx.beep(460, .06); later(() => ctx.beep(700, .1), 80); }

    // 停止演示（幂等）：取消令牌 → 清定时器/字幕动画/烟花/彩带 → 收黑边 → 暂停回放
    function stopDemo() {
      if (!demoToken) return false;
      demoToken = null;
      clearDemoTimers();
      resetCaption();
      stopFireworks(); // 立即收起片尾烟花（若有）
      try { if (typeof window.confetti === 'function' && typeof window.confetti.reset === 'function') window.confetti.reset(); } catch (e) { /* 纯展示 */ }
      exitCinema(); // 停止即收黑边，不等旧链退出
      if (typeof ctx.pausePlayback === 'function') {
        try { ctx.pausePlayback(); } catch (e) { /* 回放已结束/无实例时忽略 */ }
      }
      ctx.ElMessage.info('演示已停止');
      return true;
    }

    async function startDemo() {
      if (demoToken) {
        stopDemo();
        return;
      }
      const token = {};
      demoToken = token;
      const alive = () => demoToken === token;
      const nodes = ctx.graphNodes.value.filter((n) => !n.isTemp);
      if (nodes.length < 3) { demoToken = null; return ctx.ElMessage.warning('节点数据不足，无法演示'); }
      const a = nodes[0];
      const b = nodes[Math.floor(nodes.length / 2)];
      try {
        await ensureGsap(); // 演示动画按需注入（P1-5；失败自动降级为 CSS）
        if (!alive()) return; // 等待期间用户点停止：旧链不得再进入电影模式
        ctx.clearQuery();
        ctx.pick.active = false; ctx.pickHint.value = ''; MapCtl.clearMisc();
        ctx.activeTab.value = 'query';
        enterCinema(); // 电影模式黑边（2.35:1 letterbox，纯展示）
        stopFireworks(); // 清理上一次演示残留的烟花（快速重启时）

        demoCaption('01 / 07', '校园路网总览', '离线矢量底图：' + ctx.stats.nodes + ' 个节点 · ' + ctx.stats.edges + ' 个路段 · ' + ctx.stats.bikes + ' 辆共享单车（可切换在线高德底图）');
        ctx.fitAll();
        await demoWait(2600); if (!alive()) return;

        demoCaption('02 / 07', '最短路径（Dijkstra + 优先队列）', '「' + a.name + '」→「' + b.name + '」：距离最短，红线为规划结果，小车沿线回放');
        ctx.q.from = a.id; ctx.q.to = b.id;
        await demoWait(500); if (!alive()) return;
        ctx.doShortest({ follow: true });
        await waitPlaybackDone(4000); if (!alive()) return;

        demoCaption('03 / 07', '最少跳数（BFS）', '同一对起终点：比较「距离最短」与「跳数最少」两条不同的路线');
        ctx.doMinHops({ follow: true });
        await waitPlaybackDone(4500); if (!alive()) return;

        const s1 = nodes[Math.floor(nodes.length / 3)];
        const s2 = nodes[Math.floor(nodes.length * 2 / 3)];
        demoCaption('04 / 07', '多段导航（分段 Dijkstra 合并）', a.name + ' → ' + s1.name + ' → ' + s2.name + ' → ' + b.name);
        ctx.q.stops = [a.id, s1.id, s2.id, b.id];
        await demoWait(400); if (!alive()) return;
        ctx.doMulti({ speed: 1000, follow: true }); // 演示提速 2.5x：多段全程播完（约 5.3s）再切下一步
        await waitPlaybackDone(9000); if (!alive()) return;

        ctx.activeTab.value = 'bike';
        const bike = ctx.bikes.value.find((x) => x.status === 'available' && x.nodeId !== 0);
        if (bike) {
          demoCaption('05 / 07', '共享单车 · 借车', '借出 ' + bike.bikeId + '（原位置：' + ctx.bikeLocation(bike) + '）');
          const rb = Api.borrow(bike.bikeId);
          if (rb.ok) { ctx.ElMessage.success(rb.msg); ctx.refreshAll(); ctx.rerenderGraph(); clickSfx(); } // 开锁“咔哒”反馈
          else { ctx.ElMessage.warning('演示：借车失败（' + rb.error + '）'); }
          await demoWait(2400); if (!alive()) return;

          const target = ctx.graphNodes.value.find((n) => n.id === b.id) || ctx.graphNodes.value[ctx.graphNodes.value.length - 1];
          const lat = target.lat + 0.0004, lon = target.lon + 0.0004; // 约 45 米偏移，演示临时节点创建
          const rp = Api.returnPreview(lat, lon);
          demoCaption('06 / 07', '共享单车 · 还车', rp.ok ? (rp.covered
            ? '距停车场「' + rp.name + '」在停放半径内，归位到该停车场'
            : '距最近停车场「' + rp.name + '」超出停放半径，将创建临时节点（挂靠该停车场）') : '');
          MapCtl.showPick({ lat: lat, lng: lon }, bike.bikeId);
          if (rp.ok && rp.radius > 0) MapCtl.showRadius({ lat: lat, lng: lon }, rp.radius);
          await demoWait(2200); if (!alive()) return;
          const rr = Api.returnBike(bike.bikeId, lat, lon);
          if (rr.ok) { ctx.ElMessage.success(rr.msg); ctx.refreshAll(); ctx.rerenderGraph(); returnSfx(); } // 归位提示音
          else { ctx.ElMessage.warning('演示：还车失败（' + rr.error + '）'); }
          await demoWait(2600); if (!alive()) return;
        }

        ctx.activeTab.value = 'data';
        demoCaption('07 / 07', '数据持久化入口', '本演示不自动下载；可点「保存并下载」导出 bikes.csv / temps.csv；导入校验与启动自检规则见 README 教学章节');
        await demoWait(2600); if (!alive()) return;

        demoCaption('', '');
        await demoWait(350); if (!alive()) return; // 等字幕淡出后出现片尾卡
        showEndcard(); // 片尾卡（约 2s 后进入完成提示）
        await demoWait(2000); if (!alive()) return;
        ctx.ElMessage.success('演示完成 🎉（修改的数据可保存导出，刷新页面即恢复初始数据）');
        const fxOn = showFireworks(3400); // 片尾全屏烟花（fireworks-js；库缺失时仅彩带）
        if (typeof confetti === 'function') confetti({ particleCount: fxOn ? 110 : 160, spread: 90, origin: { y: 0.4 } });
        if (fxOn) await demoWait(3400); // 等烟花跑完再收场（期间点停止会立即清理）
      } catch (e) {
        ctx.ElMessage.error('演示中断：' + ((e && e.message) || e));
      } finally {
        // 仅当本次演示仍存活时才收场：停止后立即重启时，旧链不得误收新演示的黑边
        if (alive()) {
          exitCinema();
          clearDemoTimers();
          resetCaption();
          demoToken = null; // 仅当令牌仍属于本次演示时才归还，避免误杀后继演示
        }
      }
    }

    return { startDemo: startDemo, stopDemo: stopDemo };
  }

  return { create: create };
})();
