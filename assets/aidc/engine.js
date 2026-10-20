/**
 * AIDC 給水設計工作台 — 計算引擎（純函式，不碰 DOM）
 * ------------------------------------------------------------------
 *   ENGINE.run(input, owner?) → result
 *
 * result.trace 是整份計算書的「單一真相來源」：
 *   畫面上的展開算式、A4 計算書、Word、Excel 都從同一份 trace 產生。
 *   每一步帶有：顯示用公式 f、代入值 sub、出處 src、以及 Excel 公式 xl。
 *   Excel 公式用 {id} 指向其他步驟，匯出時轉成活的儲存格公式，
 *   因此 Excel 重算的結果必須等於 JS 的結果（tests/verify-aidc.js 會用 LibreOffice 驗）。
 *
 * 參數優先序：使用者覆寫 > 業主設計基準（本機載入） > 法規區域 profile > AIDC 通用基準
 * 業主值與法規值不同時，記錄在 result.conflicts，不會靜默覆蓋。
 */
(function (root) {
  'use strict';
  const PR = (typeof module !== 'undefined' && module.exports)
    ? require('./profiles.js') : root.AIDC_PROFILES;
  const { SOURCES, PIPES, HUNTER, FIXTURES_IPC, TW_ZONES, MOTORS_KW, MOTORS_HP, WQ, REGIONS, AIDC_BASE } = PR;

  const VERSION = '1.0.0';
  const G = 9.81, CP = 4.186, GPM = 3.785411784, PSI_M = 0.70307, FT = 0.3048;

  /* ───────────── 共用小工具（亦被測試直接呼叫）───────────── */
  const U = {
    ceilTo(x, step) { return Math.ceil(x / step - 1e-9) * step; },
    firstGE(list, x) { for (const v of list) if (v >= x - 1e-9) return v; return NaN; },
    hunter(wsfu, flushValve) {
      const xs = HUNTER.wsfu, ys = flushValve ? HUNTER.valve : HUNTER.tank;
      if (!(wsfu > 0)) return 0;
      // 沖水閥欄從 5 WSFU 起；低於起點時取起點值（表格本身的下限）
      let lo = -1;
      for (let i = 0; i < xs.length; i++) if (ys[i] != null && xs[i] <= wsfu) lo = i;
      if (lo < 0) { const i0 = ys.findIndex(y => y != null); return ys[i0]; }
      if (lo === xs.length - 1) return ys[lo];
      const x0 = xs[lo], x1 = xs[lo + 1], y0 = ys[lo], y1 = ys[lo + 1];
      return y0 + (wsfu - x0) * (y1 - y0) / (x1 - x0);
    },
    hw(Qm3s, Dm, L, C) {               // Hazen-Williams 摩擦損失 (m)
      if (!(Qm3s > 0 && Dm > 0 && L > 0 && C > 0)) return 0;
      return 10.67 * L * Math.pow(Qm3s, 1.852) / (Math.pow(C, 1.852) * Math.pow(Dm, 4.87));
    },
    twSafety(V) { return V < 13.5 ? 1.5 : V <= 24.5 ? 1.4 : V <= 68.5 ? 1.2 : 1.1; },
    twSmallMeter(V) { return V < 13.5 ? 20 : V <= 24.5 ? 25 : V <= 68.5 ? 40 : null; },
    ecFromTds(tds) { return tds / 0.65; },
    /* 數值取用：null、undefined、空字串、純空白、非有限數值一律回傳預設 d（T-02）。
     * 注意：Number(null) === 0、Number('') === 0，舊寫法會讓「清空欄位」變成 0 而非預設值。 */
    num(x, d) {
      if (x === null || x === undefined) return d;
      if (typeof x === 'string' && x.trim() === '') return d;
      const n = Number(x);
      return isFinite(n) ? n : d;
    },
  };

  /* ───────────── 參數解析：帶出處 ───────────── */
  function makeParams(region, owner, over) {
    const used = {}, conflicts = [];
    const ownerP = (owner && owner.params) || {};
    function P(key) {
      if (over && over[key] !== undefined && over[key] !== null && over[key] !== '') {
        used[key] = { v: over[key], src: 'user' }; return over[key];
      }
      const base = (region.p && region.p[key]) || AIDC_BASE[key];
      if (ownerP[key] !== undefined) {
        const ov = ownerP[key];
        const v = (ov && typeof ov === 'object' && 'v' in ov) ? ov.v : ov;
        if (base && base.v !== null && base.v !== undefined && JSON.stringify(base.v) !== JSON.stringify(v)) {
          const t = SOURCES[base.src] && SOURCES[base.src].tier;
          conflicts.push({ key, ownerV: v, baseV: base.v, baseSrc: base.src,
            legal: t === 'law' || t === 'std' || t === 'gov',
            note: (ov && ov.note) || '' });
        }
        used[key] = { v, src: 'owner', note: (ov && ov.note) || '' }; return v;
      }
      if (!base) { used[key] = { v: undefined, src: 'assume' }; return undefined; }
      used[key] = { v: base.v, src: base.src, note: base.note || '' };
      return base.v;
    }
    return { P, used, conflicts };
  }

  /* ───────────── trace 建構器 ───────────── */
  function Tracer() {
    const steps = [], index = {}, checks = [], tables = {};
    let sec = '';
    return {
      steps, index, checks, tables,
      section(s) { sec = s; },
      input(id, label, v, unit, src, note) {
        const s = { id, kind: 'in', sec, label, v, unit, src: [].concat(src || 'user'), note: note || '' };
        steps.push(s); index[id] = s; return v;
      },
      step(id, label, v, unit, o) {
        o = o || {};
        const s = { id, kind: 'calc', sec, label, v, unit, f: o.f || '', sub: o.sub || '',
          src: [].concat(o.src || 'phys'), xl: o.xl || null, note: o.note || '', fmt: o.fmt };
        steps.push(s); index[id] = s; return v;
      },
      text(id, label, text, src) {
        const s = { id, kind: 'text', sec, label, v: text, src: [].concat(src || 'assume') };
        steps.push(s); index[id] = s; return text;
      },
      table(name, values) { tables[name] = values; },
      check(level, msg, src) { checks.push({ level, msg, src: [].concat(src || 'assume'), sec }); },
    };
  }

  const f2 = (x, d) => (isFinite(x) ? Number(x).toFixed(d === undefined ? 2 : d) : '—');

  /* ───────────── 水箱：舊欄位 → 等價 tanks（相容舊分享連結）─────────────
   * 舊版只有「生活水池」「空調水池」共用一個分格數 compartments，外加一個消防容量數字。
   * hours／fixedCells 留空（null）＝沿用「備援時數」「水池分格數」參數，因此舊的參數覆寫仍然有效。 */
  function legacyTanks(inp) {
    return [
      { id: 't_dom', name: '生活水池', role: 'domestic', feed: 'mains', ruleMode: 'hours', hours: null, cellsMode: 'fixed', fixedCells: null, redundancy: 'none', minCells: 1 },
      { id: 't_hvac', name: '空調水池', role: 'hvac', feed: 'mains', ruleMode: 'hours', hours: null, cellsMode: 'fixed', fixedCells: null, redundancy: 'none', minCells: 1 },
      { id: 't_fire', name: '消防水池', role: 'fire', feed: 'mains', ruleMode: 'fixed', fixedVolume: U.num(inp && inp.fireVolume, 0), cellsMode: 'fixed', fixedCells: 1, redundancy: 'none', minCells: 1 },
    ];
  }

  /* ═══════════════════════════ 主程式 ═══════════════════════════ */
  function run(inp, owner) {
    const region = REGIONS[inp.region] || REGIONS.TW;
    const { P, used, conflicts } = makeParams(region, owner, inp.over || {});
    const T = Tracer();
    const isTW = region.id === 'TW';
    const units = region.units;
    const res = { region: region.id, regionLabel: region.label, status: region.status,
      version: VERSION, profileVersion: region.version, ownerName: owner ? (owner.name || '業主設計基準') : null,
      ownerVersion: owner ? (owner.version || '') : null };

    /* ──────── 1. 冷卻／空調補水 ──────── */
    T.section('1 空調及製程用水');
    const c = inp.cooling || {};
    const evaporative = c.type === 'open_ct' || c.type === 'closed_ct' || c.type === 'adiabatic';
    let coolDaily = 0, coolMaxHour = 0;
    T.text('cool_type', '散熱方式', {
      dry: '乾式冷卻器（無蒸發耗水）', closed_ct: '密閉式冷卻水塔（蒸發式）',
      open_ct: '開放式冷卻水塔（蒸發式）', adiabatic: '絕熱／噴霧式乾冷器（部分時數蒸發）',
    }[c.type] || c.type, 'assume');

    if (c.basis === 'hvac' || !evaporative) {
      const d = T.input('hvac_daily', evaporative ? '空調補水量（空調組提供）' : '空調系統補水量（充水／洩漏補水，空調組提供）',
        U.num(c.hvacDaily, 0), 'm³/d', 'hvac');
      const mh = U.num(c.hvacMaxHour, 0);
      coolDaily = d;
      if (mh > 0) {
        coolMaxHour = T.input('hvac_maxh', '空調補水最大時流量（空調組提供）', mh, 'm³/h', 'hvac');
      } else {
        const pk = P('hvacPeak');
        T.input('hvac_pk', '空調補水尖峰係數', pk, '—', used.hvacPeak.src);
        coolMaxHour = T.step('hvac_maxh', '空調補水最大時流量', d / 24 * pk, 'm³/h',
          { f: 'Qmax = 日補水量 ÷ 24 × 尖峰係數', sub: `${f2(d)} ÷ 24 × ${pk}`, src: used.hvacPeak.src,
            xl: '={hvac_daily}/24*{hvac_pk}' });
      }
      if (!evaporative) T.check('info', '乾式冷卻器以顯熱散熱，正常運轉沒有蒸發耗水；補水只發生在系統初次充水、洩漏與排放後回填。用水量主體因此是生活用水與加濕器。', 'phys');
      /* T-10：空調組提供值與「排熱量→物理滿載值」並排比較（只提示，不改變採用值） */
      const heatX = U.num(c.heatKW, 0);
      if (evaporative && heatX > 0) {
        const cocX = U.num(c.coc, 3);
        if (cocX > 1) {
          const dtX = U.num(c.rangeC, 5);
          if (dtX > 0) {
            const ruleX = P('evapRule');
            const xq = T.input('xc_q', '〔交叉檢查〕冷卻塔排熱量', heatX, 'kW', 'hvac');
            const xdt = T.input('xc_dt', '〔交叉檢查〕冷卻水溫差 Range', dtX, '°C', 'hvac');
            const xwet = T.input('xc_wet', '〔交叉檢查〕蒸發散熱比例', U.num(c.wetFrac, 1), '—', 'hvac');
            const xcoc = T.input('xc_coc', '〔交叉檢查〕濃縮倍數 COC', cocX, '—', 'hvac');
            const xlf = T.input('xc_lf', '〔交叉檢查〕日平均負載率', U.num(c.loadFactor, 1), '—', 'hvac');
            const xrule = T.input('xc_rule', '〔交叉檢查〕蒸發率（每 °C 溫差佔循環水量比例）', ruleX, '1/°C', used.evapRule.src);
            const xcirc = T.step('xc_circ', '〔交叉檢查〕冷卻水循環量', xq / (CP * xdt) * 3.6, 'm³/h', { f: 'L = Q ÷ (cp·ΔT) × 3.6', sub: `${f2(xq, 0)} ÷ (4.186 × ${xdt}) × 3.6`, src: 'phys', xl: '={xc_q}/(4.186*{xc_dt})*3.6' });
            const xe = T.step('xc_e', '〔交叉檢查〕蒸發量 E', xcirc * xrule * xdt * xwet, 'm³/h', { f: 'E = L × 蒸發率 × ΔT × 蒸發比例', sub: `${f2(xcirc)} × ${xrule} × ${xdt} × ${xwet}`, src: 'epa_ct', xl: '={xc_circ}*{xc_rule}*{xc_dt}*{xc_wet}' });
            const xm = T.step('xc_m', '〔交叉檢查〕補給水量 M（物理滿載）', xe * xcoc / (xcoc - 1), 'm³/h', { f: 'M = E × COC ÷ (COC − 1)', sub: `${f2(xe)} × ${xcoc} ÷ (${xcoc} − 1)`, src: 'epa_ct', xl: '={xc_e}*{xc_coc}/({xc_coc}-1)' });
            const xday = T.step('xc_daily', '〔交叉檢查〕物理推算日補水量', xm * 24 * xlf, 'm³/d', { f: '日量 = M × 24 × 負載率', sub: `${f2(xm)} × 24 × ${xlf}`, src: 'phys', xl: '={xc_m}*24*{xc_lf}' });
            if (xday > 0) {
              const dif = (d - xday) / xday * 100;
              T.step('xc_diff', '〔交叉檢查〕空調組日量 相對 物理推算值', dif, '%', { f: '(空調組日量 − 物理推算) ÷ 物理推算 × 100', sub: `(${f2(d)} − ${f2(xday)}) ÷ ${f2(xday)}`, src: 'phys', xl: '=({hvac_daily}-{xc_daily})/{xc_daily}*100' });
              const big = Math.abs(dif) > 5;
              T.check(big ? 'warn' : 'info', `空調組日量 ${f2(d, 0)} m³/日 與排熱量推算的物理滿載值 ${f2(xday, 0)} m³/日 相差 ${dif > 0 ? '+' : ''}${f2(dif, 1)}%（採用值仍為空調組提供值）。${big ? '請確認空調組的數字是否含負載率、COC 或 Range 與本工具輸入是否一致。' : ''}`, 'epa_ct');
            }
          }
        }
      }
    } else {
      const Q = T.input('ct_q', '冷卻塔排熱量', U.num(c.heatKW, 0), 'kW', 'hvac');
      const dT = T.input('ct_dt', '冷卻水進出水溫差 Range', U.num(c.rangeC, 5), '°C', 'hvac');
      const wet = T.input('ct_wet', c.type === 'adiabatic' ? '濕式運轉時數比例' : '蒸發散熱比例', U.num(c.wetFrac, 1), '—', 'hvac',
        c.type === 'closed_ct' ? '密閉式在濕式運轉時熱量仍主要由噴灑水蒸發帶走，保守取 1.0' : '');
      const coc = T.input('ct_coc', '濃縮倍數 COC', U.num(c.coc, 3), '—', 'hvac');
      const rule = P('evapRule');
      T.input('ct_rule', '蒸發率（每 °C 溫差佔循環水量比例）', rule, '1/°C', used.evapRule.src);
      const dr = P('driftPct');
      T.input('ct_drift', '飛濺率 Drift（佔循環水量）', dr, '%', used.driftPct.src);
      const circ = T.step('ct_circ', '冷卻水循環量', Q / (CP * dT) * 3.6, 'm³/h',
        { f: 'L = Q ÷ (cp·ΔT) × 3.6', sub: `${f2(Q, 0)} ÷ (4.186 × ${dT}) × 3.6`, src: 'phys',
          xl: '={ct_q}/(4.186*{ct_dt})*3.6' });
      const E = T.step('ct_e', '蒸發量 E', circ * rule * dT * wet, 'm³/h',
        { f: 'E = L × 蒸發率 × ΔT × 蒸發比例', sub: `${f2(circ)} × ${rule} × ${dT} × ${wet}`, src: 'epa_ct',
          xl: '={ct_circ}*{ct_rule}*{ct_dt}*{ct_wet}' });
      const D = T.step('ct_d', '飛濺量 D', circ * dr / 100, 'm³/h',
        { f: 'D = L × Drift%', sub: `${f2(circ)} × ${dr}%`, src: 'epa_ct', xl: '={ct_circ}*{ct_drift}/100' });
      const M = T.step('ct_m', '補給水量 M', coc > 1 ? E * coc / (coc - 1) : NaN, 'm³/h',
        { f: 'M = E × COC ÷ (COC − 1)　（溶解固體質量平衡：M·Cm = (BD + D)·Cc）', sub: `${f2(E)} × ${coc} ÷ (${coc} − 1)`,
          src: 'epa_ct', xl: '={ct_e}*{ct_coc}/({ct_coc}-1)' });
      T.step('ct_bd', '排放量 BD', M / coc - D, 'm³/h',
        { f: 'BD = M ÷ COC − D', sub: `${f2(M)} ÷ ${coc} − ${f2(D, 3)}`, src: 'epa_ct', xl: '={ct_m}/{ct_coc}-{ct_d}' });
      const lf = T.input('ct_lf', '日平均負載率', U.num(c.loadFactor, 1), '—', 'hvac');
      coolMaxHour = M;
      coolDaily = T.step('hvac_daily', '空調補水日量', M * 24 * lf, 'm³/d',
        { f: '日量 = M × 24 × 負載率', sub: `${f2(M)} × 24 × ${lf}`, src: 'phys', xl: '={ct_m}*24*{ct_lf}' });
      T.step('hvac_maxh', '空調補水最大時流量', M, 'm³/h', { f: '= M（滿載）', sub: f2(M), src: 'phys', xl: '={ct_m}' });
      if (coc < 2 || coc > 8) T.check('warn', `COC = ${coc} 超出常見範圍 2~8：過低浪費水，過高需強化水處理。實際可達 COC 由補給水水質決定（見水質頁）。`, 'epa_ct');
    }
    const humid = T.input('humid', '加濕器補水量', U.num(c.humidDaily, 0), 'm³/d', 'hvac',
      '蒸發式加濕器（濕膜）耗水；由空調組依加濕負載提供');
    const others = (inp.others || []).filter(o => U.num(o.daily, 0) > 0);
    let otherSum = 0;
    others.forEach((o, i) => { otherSum += T.input('oth' + i, '其他用水：' + (o.name || '未命名'), U.num(o.daily, 0), 'm³/d', o.src || 'assume'); });
    const procRaw = T.step('proc_raw', '空調＋加濕＋其他用水 小計', coolDaily + humid + otherSum, 'm³/d',
      { f: '= 空調補水 + 加濕 + 其他', sub: `${f2(coolDaily)} + ${f2(humid)} + ${f2(otherSum)}`, src: 'phys',
        xl: '={hvac_daily}+{humid}' + others.map((o, i) => `+{oth${i}}`).join('') });

    /* ──────── 2. 生活用水與一日設計用水量 ──────── */
    T.section('2 一日設計用水量');
    let domRaw = 0, V, Vd, mDom = null, mProc = null;
    const hasV = x => x !== undefined && x !== null && x !== '';
    function marginP(key) {          // 生活／空調裕度；舊參數 designMargin 同時套用於兩者（T-03 向下相容）
      const ov = inp.over || {}, ownerP0 = (owner && owner.params) || {};
      if (!hasV(ov[key])) {
        if (hasV(ov.designMargin)) { used[key] = { v: ov.designMargin, src: 'user', note: '沿用舊參數 designMargin（生活與空調同值）' }; return ov.designMargin; }
        if (ownerP0[key] === undefined && ownerP0.designMargin !== undefined) { const o = ownerP0.designMargin; const vv = (o && typeof o === 'object' && 'v' in o) ? o.v : o; used[key] = { v: vv, src: 'owner', note: '沿用業主基準的舊參數 designMargin（生活與空調同值）' }; return vv; }
      }
      return P(key);
    }
    const dom = inp.domestic || {};
    if (region.method.demand === 'twc_area') {
      const rows = (dom.twRows || []).filter(r => U.num(r.area, 0) > 0);
      const parts = [];
      rows.forEach((r, i) => {
        const z = TW_ZONES[r.type] || TW_ZONES.office;
        const eff = U.num(r.eff, z.eff), den = U.num(r.density, z.density), unit = U.num(r.unit, z.unit);
        const A = T.input('tw_a' + i, `${z.label} 樓地板面積`, U.num(r.area, 0), 'm²', 'user');
        T.input('tw_e' + i, `${z.label} 有效面積比`, eff, '—', 'twc_form');
        T.input('tw_n' + i, `${z.label} 人員密度`, den, '人/m²', 'twc_form');
        T.input('tw_u' + i, `${z.label} 每人用水量`, unit, 'm³/人·日', 'twc_form');
        parts.push(T.step('tw_v' + i, `${z.label} 用水量`, A * eff * den * unit, 'm³/d',
          { f: '面積 × 有效面積比 × 人/m² × 每人用水量', sub: `${f2(A)} × ${eff} × ${den} × ${unit}`, src: 'twc_form',
            xl: `={tw_a${i}}*{tw_e${i}}*{tw_n${i}}*{tw_u${i}}` }));
      });
      domRaw = T.step('dom_raw', '生活用水小計 ΣV₂′', parts.reduce((a, b) => a + b, 0), 'm³/d',
        { f: 'Σ 各用途用水量', sub: parts.map(x => f2(x)).join(' + ') || '0', src: 'twc_form',
          xl: rows.length ? '=' + rows.map((r, i) => `{tw_v${i}}`).join('+') : '=0' });
      const adj = P('twAdj');
      T.input('tw_adj', '使用水量變化係數', adj, '—', used.twAdj.src, used.twAdj.note);
      const submit = (inp.twMode || 'submit') === 'submit';
      if (submit) {
        V = T.step('V', '一日用水量 V', (domRaw + procRaw) * adj, 'm³/d',
          { f: 'V = (ΣV₂′ + 空調等用水) × 變化係數　〔台水表格式：空調用水列於面積表內〕', sub: `(${f2(domRaw)} + ${f2(procRaw)}) × ${adj}`,
            src: 'twc_form', xl: '=({dom_raw}+{proc_raw})*{tw_adj}' });
      } else {
        V = T.step('V', '一日用水量 V', domRaw * adj + procRaw, 'm³/d',
          { f: 'V = ΣV₂′ × 變化係數 + 空調等用水　〔工程保守：製程用水不折減〕', sub: `${f2(domRaw)} × ${adj} + ${f2(procRaw)}`,
            src: 'assume', xl: '={dom_raw}*{tw_adj}+{proc_raw}' });
        T.check('info', '「工程保守」模式不把空調用水乘 0.9 變化係數；送審台水時請切回「送審格式」。', 'assume');
      }
      const sfAuto = U.twSafety(V);
      const sf = (inp.over && inp.over.twSF) ? inp.over.twSF : sfAuto;
      T.step('SF', '安全係數', sf, '—', { f: 'V<13.5→1.5；13.6~24.5→1.4；24.6~68.5→1.2；>68.5→1.1', sub: `V = ${f2(V)}`,
        src: 'twc_form', xl: '=IF({V}<13.5,1.5,IF({V}<=24.5,1.4,IF({V}<=68.5,1.2,1.1)))' });
      if (sf !== sfAuto) T.check('warn', `安全係數手動設為 ${sf}，台水級距應為 ${sfAuto}。`, 'twc_form');
      Vd = T.step('Vd', '一日設計用水量 Vd', V * sf, 'm³/d', { f: 'Vd = V × 安全係數', sub: `${f2(V)} × ${sf}`, src: 'twc_form', xl: '={V}*{SF}' });
    } else {
      const occ = T.input('occ', '常駐人數（含輪班最大同時在廠）', U.num(dom.occupants, 0), '人', 'user');
      const lpd = P('perCapLpd');
      T.input('lpd', '每人日用水量', lpd, 'L/人·日', used.perCapLpd.src, used.perCapLpd.note);
      domRaw = T.step('dom_raw', '生活用水', occ * lpd / 1000, 'm³/d', { f: '人數 × 每人日用水量 ÷ 1000', sub: `${occ} × ${lpd} ÷ 1000`,
        src: used.perCapLpd.src, xl: '={occ}*{lpd}/1000' });
      V = T.step('V', '一日用水量 V', domRaw + procRaw, 'm³/d', { f: 'V = 生活 + 空調等', sub: `${f2(domRaw)} + ${f2(procRaw)}`, src: 'phys', xl: '={dom_raw}+{proc_raw}' });
      /* T-03：設計裕度拆成「生活」與「空調／製程」兩個參數；舊參數 designMargin 有值時兩者同值（相容舊連結） */
      mDom = marginP('designMarginDom'); mProc = marginP('designMarginProc');
      T.input('margin_dom', '設計裕度—生活', mDom, '—', used.designMarginDom.src, used.designMarginDom.note);
      T.input('margin_proc', '設計裕度—空調／製程', mProc, '—', used.designMarginProc.src, used.designMarginProc.note);
      Vd = T.step('Vd', '一日設計用水量 Vd', domRaw * mDom + procRaw * mProc, 'm³/d', { f: 'Vd = 生活 × 裕度(生活) + 空調等 × 裕度(空調／製程)', sub: `${f2(domRaw)} × ${mDom} + ${f2(procRaw)} × ${mProc}`, src: [used.designMarginDom.src, used.designMarginProc.src], xl: '={dom_raw}*{margin_dom}+{proc_raw}*{margin_proc}' });
    }
    const shareDom = (domRaw + procRaw) > 0 ? domRaw / (domRaw + procRaw) : 1;

    /* ──────── 3. 生活用水尖峰流量 ──────── */
    T.section('3 尖峰流量');
    let qpDom = 0;           // L/min
    if (region.method.peak === 'tw_qp') {
      const hrs = P('useHours'), k = P('peakK');
      T.input('use_h', '使用時間', hrs, 'h', used.useHours.src, used.useHours.note);
      T.input('pk_k', '瞬時尖峰係數', k, '—', used.peakK.src, used.peakK.note);
      const Qh = T.step('qh', '時平均用水量 Qh', domRaw * 1000 / hrs, 'L/h', { f: 'Qh = 生活日用水量 ÷ 使用時間', sub: `${f2(domRaw)}×1000 ÷ ${hrs}`, src: 'tw_tech', xl: '={dom_raw}*1000/{use_h}' });
      qpDom = T.step('qp_dom', '生活用水瞬時尖峰 Qp', k * Qh / 60, 'L/min', { f: 'Qp = k × Qh ÷ 60', sub: `${k} × ${f2(Qh)} ÷ 60`, src: 'tw_tech', xl: '={pk_k}*{qh}/60' });
    } else if (region.method.peak === 'hunter') {
      const fx = dom.fixtures || {};
      let wsfu = 0, valve = false; const terms = [], xls = [];
      FIXTURES_IPC.forEach(F => {
        const n = U.num(fx[F.key], 0);
        if (n > 0) {
          T.input('fx_' + F.key, F.label + ' 數量', n, '組', 'user');
          wsfu += n * F.wsfu; if (F.valve) valve = true;
          terms.push(`${n}×${F.wsfu}`); xls.push(`{fx_${F.key}}*${F.wsfu}`);
        }
      });
      if (dom.flushValve === true) valve = true; if (dom.flushValve === false) valve = false;
      res.wsfuTot = wsfu; res.valveSys = valve;
      T.step('wsfu', '給水器具單位 ΣWSFU', wsfu, 'WSFU', { f: 'Σ 數量 × WSFU（Table E103.3(2)）', sub: terms.join(' + ') || '0', src: 'ipc_e', xl: xls.length ? '=' + xls.join('+') : '=0' });
      const gpm = U.hunter(wsfu, valve);
      T.table('hunter_x', HUNTER.wsfu);
      T.table('hunter_y', (valve ? HUNTER.valve : HUNTER.tank).map(v => v == null ? 0 : v));
      const g = T.step('qp_gpm', `尖峰需水量（Hunter，${valve ? '沖水閥' : '水箱式'}系統）`, gpm, 'gpm',
        { f: 'Table E103.3(3) 線性內插', sub: `ΣWSFU = ${f2(wsfu, 1)}`, src: 'ipc_e', xl: 'HUNTER' });
      qpDom = T.step('qp_dom', '生活用水瞬時尖峰 Qp', g * GPM, 'L/min', { f: 'gpm × 3.785', sub: `${f2(g, 1)} × 3.785`, src: 'phys', xl: '={qp_gpm}*3.785411784' });
      if (wsfu > 0 && wsfu < 5 && valve) T.check('info', '沖水閥欄自 5 WSFU 起列，低於 5 時取表列起點值。', 'ipc_e');
      T.check('info', 'Hunter 曲線源自 1940 年代器具用水量，對現代省水器具通常偏大；部分轄區已採 Water Demand Calculator，請以 AHJ 規定為準。', 'ipc_e');
    } else {
      qpDom = T.input('qp_dom', '生活用水瞬時尖峰 Qp（使用者輸入）', U.num(dom.peakLpm, 0), 'L/min', 'user');
      T.check('warn', `${region.label} 的尖峰流量計算方法尚未完成查證，請依當地規範自行計算後輸入。`, 'assume');
    }
    res.qpDom = qpDom;

    /* ──────── 4. 進水口徑／水表 ──────── */
    T.section('4 進水管口徑');
    /* T-05：基地供水能力（選填；空白＝不檢查） */
    const capDay = U.num(inp.supplyCapDay, 0), capFire = U.num(inp.supplyCapFire, 0);
    if (capDay > 0) T.input('sup_cap', '基地供水上限（使用者輸入）', capDay, 'm³/d', 'user', '供水單位或業主提供的基地日供水能力');
    if (region.method.service === 'twc_di') {
      const vi = P('diVel');
      T.input('di_v', 'Di 設計流速（24 小時均勻進水）', vi, 'm/s', used.diVel.src, used.diVel.note);
      const printed = (inp.twMode || 'submit') === 'submit' && vi === 0.7;
      const coef = printed
        ? T.step('di_k', 'Di 係數（台水表印定值）', 4.59, '—', { f: 'k = 4.59（= 1000·√(4 ÷ (π·86400·0.7)) 取兩位）', sub: 'υ = 0.7 m/s', src: 'twc_form', xl: '=4.59' })
        : T.step('di_k', 'Di 係數', 1000 * Math.sqrt(4 / (Math.PI * 86400 * vi)), '—',
          { f: 'k = 1000·√(4 ÷ (π·86400·υ))', sub: `υ = ${vi}`, src: 'twc_form', xl: '=1000*SQRT(4/(PI()*86400*{di_v}))' });
      const Di = T.step('Di', '進水管計算口徑 Di', coef * Math.sqrt(Vd), 'mm', { f: 'Di = k·√Vd', sub: `${f2(coef, 3)} × √${f2(Vd)}`, src: 'twc_form', xl: '={di_k}*SQRT({Vd})' });
      const list = P('meterList');
      T.table('meter_list', list);
      const small = U.twSmallMeter(V);
      const adopt = small !== null ? small : U.firstGE(list, Di);
      T.step('Di_adopt', '進水管（總表）採用口徑', adopt, 'mm',
        { f: small !== null ? 'V ≤ 68.5 依台水級距表' : '取 ≥ Di 之最小標準口徑', sub: small !== null ? `V = ${f2(V)}` : `Di = ${f2(Di, 1)}`,
          src: 'twc_form', xl: '=IF({V}<13.5,20,IF({V}<=24.5,25,IF({V}<=68.5,40,MINIFS(meter_list,meter_list,">="&{Di}))))' });
      res.service = { calc: Di, adopt, unit: 'mm' };
      const dpV = P('dpVel'), dpT = P('dpMin');
      T.input('dp_v', '揚水管流速', dpV, 'm/s', used.dpVel.src); T.input('dp_t', '揚水時間（送 0.1Vd）', dpT, 'min', used.dpMin.src);
      if (printed && dpV === 1.6 && dpT === 30) {
        T.step('Dp', '揚水管最小口徑 Dp', 6.65 * Math.sqrt(Vd), 'mm', { f: 'Dp = 6.65·√Vd（台水表印定值；t=30 min、υ=1.6 m/s）', sub: `6.65 × √${f2(Vd)}`, src: 'twc_form', xl: '=6.65*SQRT({Vd})' });
      } else {
        T.step('Dp', '揚水管最小口徑 Dp', 1000 * Math.sqrt(0.4 * Vd / (Math.PI * dpT * 60 * dpV)), 'mm',
          { f: 'Dp = 1000·√(0.4·Vd ÷ (π·t·υ))', sub: `Vd=${f2(Vd)}, t=${dpT}, υ=${dpV}`, src: 'twc_form',
            xl: '=1000*SQRT(0.4*{Vd}/(PI()*{dp_t}*60*{dp_v}))' });
      }
      if (inp.zonedSupply) T.check('info', '本案採分區供水：Dp 為「單一揚水管」的最低要求，各分區揚水管依下方泵浦表個別選定（台水表亦註明「本案採分區供水」）。', 'twc_form');
    } else {
      const vmax = P('vMax');
      T.input('svc_v', '進水管設計流速上限', vmax, 'm/s', used.vMax.src, used.vMax.note);
      /* T-04：有儲水池時，市政進水只需補水箱（24 h 均勻進水）；尖峰由水箱後泵浦承擔。'peak' 維持舊算式 */
      const svcBasis = (inp.svcBasis || (inp.over && inp.over.svcBasis) || 'storage') === 'peak' ? 'peak' : 'storage';
      res.svcBasis = svcBasis;
      T.text('svc_basis', '進水流量基準', svcBasis === 'storage' ? '儲水補水（Vd 24 h 均勻進水，市政水只補水箱）' : '尖峰直供（生活尖峰 + 空調補水最大時，同時相加）', 'assume');
      let qsvc;
      if (svcBasis === 'storage') {
        const qd = T.step('svc_qd', '進水流量—Vd 24 h 均勻', Vd * 1000 / 1440, 'L/min', { f: 'Q = Vd × 1000 ÷ 1440', sub: `${f2(Vd)} × 1000 ÷ 1440`, src: 'phys', xl: '={Vd}*1000/1440' });
        if (capDay > 0) {
          const qc = T.step('svc_qcap', '進水流量—基地供水上限折算', capDay * 1000 / 1440, 'L/min', { f: 'Q = 供水上限 × 1000 ÷ 1440', sub: `${f2(capDay)} × 1000 ÷ 1440`, src: 'phys', xl: '={sup_cap}*1000/1440' });
          qsvc = T.step('svc_q', '進水管設計流量', Math.min(qd, qc), 'L/min', { f: '= min(Vd 均勻流量, 供水上限折算流量)', sub: `min(${f2(qd, 1)}, ${f2(qc, 1)})`, src: 'phys', xl: '=MIN({svc_qd},{svc_qcap})' });
        } else qsvc = T.step('svc_q', '進水管設計流量', qd, 'L/min', { f: '= Vd 24 h 均勻進水流量', sub: `${f2(qd, 1)}`, src: 'phys', xl: '={svc_qd}' });
      } else {
        qsvc = T.step('svc_q', '進水管設計流量', qpDom + coolMaxHour * 1000 / 60, 'L/min',
          { f: '= 生活尖峰 Qp + 空調補水最大時流量', sub: `${f2(qpDom, 1)} + ${f2(coolMaxHour)}×1000/60`, src: 'phys', xl: '={qp_dom}+{hvac_maxh}*1000/60' });
      }
      const dreq = T.step('svc_dreq', '進水管最小內徑', 1000 * Math.sqrt(4 * qsvc / 60000 / (Math.PI * vmax)), 'mm',
        { f: 'd = √(4Q ÷ (π·v))', sub: `Q=${f2(qsvc, 1)} L/min, v=${vmax}`, src: 'cont', xl: '=1000*SQRT(4*{svc_q}/60000/(PI()*{svc_v}))' });
      const cat = PIPES[region.pipe];
      const pick = cat.rows.find(r => r.id >= dreq - 1e-9) || cat.rows[cat.rows.length - 1];
      T.table('svc_ids', cat.rows.map(r => r.id));
      T.step('svc_id', '進水管採用內徑', pick.id, 'mm', { f: `取 ${cat.label} 中 ID ≥ d 之最小管`, sub: pick.name, src: cat.src, xl: '=MINIFS(svc_ids,svc_ids,">="&{svc_dreq})', fmt: 1 });
      res.service = { calc: dreq, adopt: pick.dn, name: pick.name, unit: 'mm' };
      if (region.method.meter === 'pub') {
        const monthly = T.step('pub_month', '月用水量', Vd * 30.4, 'm³/月', { f: 'Vd × 30.4', sub: `${f2(Vd)} × 30.4`, src: 'phys', xl: '={Vd}*30.4' });
        const tbl = P('pubMeter');
        const m = tbl.find(r => r[1] >= monthly);
        T.text('pub_meter', 'PUB 建議水表口徑', m ? `${m[0]} mm（≤ ${m[1]} m³/月）` : '超過 150 mm 級距，洽 PUB', 'pub_hb');
        res.service.meter = m ? m[0] : null;
      } else {
        T.check('info', '水表口徑由供水單位（utility）依其表計規格核定；本工具只計算進水管尺寸。', 'assume');
      }
    }

    /* ──────── 5. 水池／水箱容量 ──────── */
    T.section('5 儲水容量');
    const vdDomV = isTW ? Vd * shareDom : domRaw * mDom;
    const vdCoolV = isTW ? Vd * (1 - shareDom) : Vd - vdDomV;
    T.step('vd_dom', '一日設計用水量—生活分量', vdDomV, 'm³/d', isTW
      ? { f: 'Vd × 生活占比', sub: `${f2(Vd)} × ${f2(shareDom, 4)}`, src: 'phys', xl: '=IF(({dom_raw}+{proc_raw})>0,{Vd}*{dom_raw}/({dom_raw}+{proc_raw}),{Vd})' }
      : { f: '生活用水 × 生活裕度', sub: `${f2(domRaw)} × ${mDom}`, src: 'phys', xl: '={dom_raw}*{margin_dom}' });
    T.step('vd_cool', '一日設計用水量—空調分量', vdCoolV, 'm³/d', { f: 'Vd − 生活分量', sub: '', src: 'phys', xl: '={Vd}-{vd_dom}' });
    const domH = P('domHours'), coolH = evaporative ? P('coolHours') : P('domHours');
    const coolHsrc = evaporative ? used.coolHours.src : used.domHours.src;
    T.input('h_dom', '生活用水備援時數（預設）', domH, 'h', used.domHours.src, used.domHours.note);
    T.input('h_cool', '空調補水備援時數（預設）', coolH, 'h', coolHsrc,
      evaporative ? used.coolHours.note : '非蒸發式散熱，比照生活用水');
    let codeTot = 0;
    if (region.method.storage === 'tw_std6') {
      const vg = P('vgMinPct'), tot = P('totMinPct'), mx = P('totMaxDays');
      T.input('vg_pct', '蓄水池下限（% Vd）', vg, '%', used.vgMinPct.src, used.vgMinPct.note);
      T.input('tot_pct', '蓄水池＋水塔合計下限（% Vd）', tot, '%', used.totMinPct.src,
        tot === 40 ? '§6 法定下限' : '依審查單位／業主要求（法定下限為 40%）');
      T.step('vg_min', '蓄水池最小容量', Vd * vg / 100, 'm³', { f: 'VG ≥ Vd × 20%', sub: `${f2(Vd)} × ${vg}%`, src: 'tw_std', xl: '={Vd}*{vg_pct}/100' });
      codeTot = T.step('tot_min', '蓄水池＋水塔 合計下限', Vd * tot / 100, 'm³', { f: 'VG+VT ≥ Vd × 合計下限%', sub: `${f2(Vd)} × ${tot}%`, src: tot === 40 ? 'tw_std' : 'twc_form', xl: '={Vd}*{tot_pct}/100' });
      T.step('tot_max', '蓄水池＋水塔 合計上限（二日）', Vd * mx, 'm³', { f: 'VG+VT ≤ 2 × Vd', sub: `2 × ${f2(Vd)}`, src: 'tw_std', xl: `={Vd}*${mx}` });
      res.twLimits = { vgMin: Vd * vg / 100, totMin: codeTot, totMax: Vd * mx };
    } else if (region.method.storage === 'pub') {
      const lo = P('pubLowFrac'), hi = P('pubHighDays');
      T.input('pub_lo', '低位水箱下限（日用水量比例）', lo, '—', used.pubLowFrac.src, used.pubLowFrac.note);
      T.input('pub_hi', '高位水箱容量（日）', hi, 'd', used.pubHighDays.src, used.pubHighDays.note);
      codeTot = T.step('tot_min', 'PUB 低位＋高位水箱合計', Vd * (lo + hi), 'm³', { f: 'Vd × (低位比例 + 高位日數)', sub: `${f2(Vd)} × (${lo} + ${hi})`, src: 'pub_hb', xl: '={Vd}*({pub_lo}+{pub_hi})' });
      T.check('info', 'PUB §2.2.3：須以泵浦送高位水箱者，泵浦應設備用機（duplicate）。', 'pub_hb');
    } else {
      codeTot = T.step('tot_min', '法規儲水下限', 0, 'm³', { f: '當地法規無儲水量下限 → 依業主備援時數', sub: '', src: 'assume', xl: '=0' });
    }
    const n = P('compartments');
    T.input('n_cell', '水池預設顆數（未個別指定顆數的水箱沿用；亦為新增水箱的預設最少顆數）', n, '格', used.compartments.src, used.compartments.note);

    /* ── 各水箱：容量規則 → 單顆尺寸 → 顆數 → 備援 → 占地 ── */
    const mxCell = P('maxCellVolume');
    const tankSrc = Array.isArray(inp.tanks) ? inp.tanks : legacyTanks(inp);
    const usedIds = {}, idMap = {};
    const tanks = tankSrc.map((t0, i) => {
      const r = t0 || {};
      let id = String(r.id !== undefined && r.id !== null && r.id !== '' ? r.id : ('t' + (i + 1))).replace(/[^A-Za-z0-9_]/g, '_');
      while (usedIds[id.toLowerCase()]) id += '_' + i;      // Excel 定義名稱不分大小寫，id 需不分大小寫唯一
      usedIds[id.toLowerCase()] = true; idMap[String(r.id)] = id;
      const role = ['receiving', 'domestic', 'hvac', 'fire', 'custom'].includes(r.role) ? r.role : 'custom';
      return { r, id, pre: 'tk_' + id, name: r.name || ('水箱 ' + (i + 1)), role, feedRaw: r.feed, feed: 'mains', D: undefined, out: null, needId: '', qDown: 0, qDownXl: '0' };
    });
    const byId = {}; tanks.forEach(t => { byId[t.id] = t; });
    tanks.forEach(t => {
      const f = t.feedRaw;
      if (f === undefined || f === null || f === '' || f === 'mains') t.feed = 'mains';
      else if (idMap[String(f)] && idMap[String(f)] !== t.id) t.feed = idMap[String(f)];
      else { t.feed = 'mains'; T.check('warn', `水箱「${t.name}」的水源指定了不存在的水箱（${f}），暫以市政水計。`, 'assume'); }
    });
    const fedBy = t => tanks.filter(x => x.feed === t.id);
    function demandOf(t, stack) {         // 下游日需求 D（m³/d）
      if (t.D !== undefined) return t.D;
      if (stack.indexOf(t.id) >= 0) return 0;
      let d = 0;
      if (t.role === 'domestic') d = vdDomV;
      else if (t.role === 'hvac') d = vdCoolV;
      else if (t.role === 'receiving') d = fedBy(t).reduce((a, x) => a + demandOf(x, stack.concat(t.id)), 0);
      else if (t.role === 'custom') d = U.num(t.r.demand, 0);
      return (t.D = d);
    }
    function qDownOf(t, stack) {          // 下游最大時需求 L/min（轉輸泵流量用）
      if (stack.indexOf(t.id) >= 0) return { v: 0, xl: '0' };
      if (t.role === 'domestic') return { v: qpDom, xl: '{qp_dom}' };
      if (t.role === 'hvac') return { v: coolMaxHour * 1000 / 60, xl: '{hvac_maxh}*1000/60' };
      if (t.role === 'receiving') {
        const parts = fedBy(t).map(x => qDownOf(x, stack.concat(t.id)));
        return { v: parts.reduce((a, p) => a + p.v, 0), xl: parts.length ? parts.map(p => '(' + p.xl + ')').join('+') : '0' };
      }
      return { v: 0, xl: '0' };
    }
    const roleLabel = { receiving: '受水箱', domestic: '生活', hvac: '空調', fire: '消防', custom: '自訂' };
    ['domestic', 'hvac'].forEach(role => { const k = tanks.filter(t => t.role === role).length; if (k > 1) T.check('warn', `有 ${k} 個「${roleLabel[role]}」角色的水箱：每個都以完整的${roleLabel[role]}分量計算需求容量，總儲水量會重複計入。分區水箱請改用「自訂」角色並手填日需求。`, 'assume'); });

    function emitTank(t) {
      const r = t.r, pre = t.pre, nm = t.name, role = t.role;
      const dm = (r.dims && typeof r.dims === 'object') ? r.dims : {};
      const ruleMode = ['hours', 'pctVd', 'fixed'].includes(r.ruleMode) ? r.ruleMode : (role === 'fire' ? 'fixed' : role === 'receiving' ? 'pctVd' : 'hours');
      const red = ['none', 'keepFull', 'keepHours'].includes(r.redundancy) ? r.redundancy : 'none';
      const D = demandOf(t, []);
      const dId = pre + '_d';
      const q = qDownOf(t, []); t.qDown = q.v; t.qDownXl = q.xl;
      if (role === 'custom') T.input(dId, `${nm}：下游日需求（使用者輸入）`, D, 'm³/d', 'user');
      else T.step(dId, `${nm}：下游日需求`, D, 'm³/d', {
        f: role === 'domestic' ? '= 生活分量' : role === 'hvac' ? '= 空調分量' : role === 'fire' ? '消防水箱不承擔日用水（容量由消防組提供）' : '= 由本水箱供水的下游水箱日需求之和',
        sub: role === 'receiving' ? (fedBy(t).map(x => `${x.name} ${f2(demandOf(x, []))}`).join(' + ') || '無下游水箱') : '', src: 'phys',
        xl: role === 'domestic' ? '={vd_dom}' : role === 'hvac' ? '={vd_cool}' : role === 'receiving' ? ('=' + (fedBy(t).map(x => `{${x.pre}_d}`).join('+') || '0')) : '=0' });
      /* 需求容量 */
      const hasFloor = (role === 'domestic' || role === 'hvac') && codeTot > 0 && ruleMode !== 'fixed';
      const needId = hasFloor ? pre + '_need' : pre + '_vreq';
      t.needId = needId;
      let need, hrs = null;
      if (ruleMode === 'hours') {
        hrs = hasV(r.hours) ? U.num(r.hours, role === 'hvac' ? coolH : domH) : (role === 'hvac' ? coolH : domH);
        const hsrc = hasV(r.hours) ? 'user' : (role === 'hvac' ? coolHsrc : used.domHours.src);
        T.input(pre + '_hrs', `${nm}：備援時數`, hrs, 'h', hsrc, hasV(r.hours) ? '' : '未個別指定，沿用「備援時數」參數');
        need = T.step(needId, `${nm}：${hasFloor ? '備援需求' : '需求容量'}`, D * hrs / 24, 'm³', { f: '下游日需求 × 時數 ÷ 24', sub: `${f2(D)} × ${hrs} ÷ 24`, src: 'phys', xl: `={${dId}}*{${pre}_hrs}/24` });
      } else if (ruleMode === 'pctVd') {
        const pct = U.num(r.pctVd, 20);
        T.input(pre + '_pct', `${nm}：容量占 Vd 比例`, pct, '%', role === 'receiving' ? 'assume' : 'user', role === 'receiving' ? '受水箱容量規則暫用「蓄水池 ≥ 20% Vd」佔位（台灣用水設備標準 §6），是否適用本案待確認' : '');
        need = T.step(needId, `${nm}：需求容量`, Vd * pct / 100, 'm³', { f: 'Vd × 比例%', sub: `${f2(Vd)} × ${pct}%`, src: 'phys', xl: `={Vd}*{${pre}_pct}/100` });
        if (role === 'receiving') T.check('info', `「${nm}」容量規則為佔位值（${pct}% Vd），受水箱的容量規則（%Vd／小時數／固定值）待業主或過往專案確認。`, 'assume');
      } else {
        need = T.input(needId, `${nm}：指定容量${role === 'fire' ? '（消防組提供）' : ''}`, U.num(r.fixedVolume, 0), 'm³', role === 'fire' ? 'fire' : 'user');
        if (role === 'fire') T.check('info', `「${nm}」容量由消防組依消防法規提供，工具只收數字、不計算；補水時間可用基地「消防補水」欄位檢核。`, 'fire');
      }
      let vreq = need;
      if (hasFloor) {
        vreq = Math.max(need, codeTot * D / Math.max(Vd, 1e-9));
        T.step(pre + '_vreq', `${nm}：採用需求容量`, vreq, 'm³', { f: 'max(備援需求, 法規合計下限 × 下游占比)', sub: `max(${f2(need)}, ${f2(codeTot * D / Math.max(Vd, 1e-9))})`, src: 'phys', xl: `=MAX({${needId}},{tot_min}*{${dId}}/MAX({Vd},1E-9))` });
      }
      /* 單顆尺寸與顆數 */
      const L = U.num(dm.L, 0), W = U.num(dm.W, 0), Hh = U.num(dm.H, 0), fb = U.num(dm.freeboard, 0.5), wall = U.num(dm.wall, 0);
      const dimsOK = L > 0 && W > 0 && (Hh - fb) > 0;
      let mode = r.cellsMode === 'fixed' ? 'fixed' : (r.cellsMode === 'byDims' || r.cellsMode === undefined || r.cellsMode === null) ? 'byDims' : 'fixed';
      if (mode === 'byDims' && !dimsOK) {
        if (r.cellsMode === 'byDims') T.check('warn', `「${nm}」選擇由尺寸算顆數，但長／寬／高（扣乾舷後水深）不完整，暫改用指定顆數。`, 'assume');
        mode = 'fixed';
      }
      const minc = Math.max(1, Math.round(U.num(r.minCells, n)));
      let vu, cells, area = null;
      if (mode === 'byDims') {
        T.input(pre + '_L', `${nm}：單顆長`, L, 'm', 'user'); T.input(pre + '_W', `${nm}：單顆寬`, W, 'm', 'user');
        T.input(pre + '_H', `${nm}：單顆高`, Hh, 'm', 'user'); T.input(pre + '_fb', `${nm}：乾舷（水面到頂）`, fb, 'm', 'user');
        if (wall !== 0) T.input(pre + '_wall', `${nm}：池壁／間距（每顆外加）`, wall, 'm', 'user');
        vu = T.step(pre + '_vu', `${nm}：單顆淨容量`, L * W * (Hh - fb), 'm³', { f: 'v = 長 × 寬 × (高 − 乾舷)', sub: `${L} × ${W} × (${Hh} − ${fb})`, src: 'phys', xl: `={${pre}_L}*{${pre}_W}*({${pre}_H}-{${pre}_fb})` });
        T.input(pre + '_minc', `${nm}：最少顆數`, minc, '顆', hasV(r.minCells) ? 'user' : used.compartments.src);
        const ncap = Math.ceil(vreq / vu - 1e-9);
        let nred = ncap, xlN;
        const base = `ROUNDUP({${pre}_vreq}/{${pre}_vu}-1E-9,0)`;
        if (red === 'keepFull') { nred = ncap + 1; xlN = `=IF({${pre}_vreq}<=0,0,MAX(${base}+1,{${pre}_minc}))`; }
        else if (red === 'keepHours') {
          const keep = U.num(r.keepHours, 24), hb = (ruleMode === 'hours' && hrs > 0) ? hrs : 24;
          T.input(pre + '_keep', `${nm}：一顆停用時至少維持`, keep, 'h', 'user');
          T.input(pre + '_hbase', `${nm}：備援基準時數`, hb, 'h', ruleMode === 'hours' ? 'phys' : 'assume', ruleMode === 'hours' ? '' : '容量規則不是「備援時數」，以 24 h 為基準');
          nred = Math.ceil(vreq * keep / hb / vu - 1e-9) + 1;
          xlN = `=IF({${pre}_vreq}<=0,0,MAX(${base},ROUNDUP({${pre}_vreq}*{${pre}_keep}/{${pre}_hbase}/{${pre}_vu}-1E-9,0)+1,{${pre}_minc}))`;
          if (ruleMode !== 'hours') T.check('info', `「${nm}」的容量規則不是備援時數，「一顆停用維持時數」以 24 h 為基準換算。`, 'assume');
        } else xlN = `=IF({${pre}_vreq}<=0,0,MAX(${base},{${pre}_minc}))`;
        cells = T.step(pre + '_n', `${nm}：顆數`, vreq <= 0 ? 0 : Math.max(ncap, nred, minc), '顆', {
          f: red === 'keepFull' ? 'n = max(⌈需求 ÷ 單顆⌉ + 1, 最少顆數)　〔一顆停用仍維持全量〕' : red === 'keepHours' ? 'n = max(⌈需求 ÷ 單顆⌉, ⌈需求 × 維持時數 ÷ 基準時數 ÷ 單顆⌉ + 1, 最少顆數)' : 'n = max(⌈需求 ÷ 單顆⌉, 最少顆數)',
          sub: `需求 ${f2(vreq)} ÷ 單顆 ${f2(vu)} = ${f2(vreq / vu, 3)}`, src: 'phys', xl: xlN });
      } else {
        const fc = Math.max(1, Math.round(U.num(r.fixedCells, n)));
        cells = T.input(pre + '_n', `${nm}：顆數（指定）`, fc, '顆', hasV(r.fixedCells) ? 'user' : used.compartments.src, hasV(r.fixedCells) ? '' : '未個別指定，沿用「水池分格數」參數');
        vu = T.step(pre + '_vu', `${nm}：單顆淨容量`, U.ceilTo(vreq / cells, 1), 'm³', { f: '⌈需求 ÷ 顆數⌉（取整至 1 m³）', sub: `${f2(vreq)} ÷ ${cells}`, src: 'phys', xl: `=CEILING({${pre}_vreq}/{${pre}_n},1)` });
        if (cells < minc && hasV(r.minCells)) T.check('info', `「${nm}」指定顆數 ${cells} 少於最少顆數 ${minc}。`, 'assume');
      }
      const vins = T.step(pre + '_vins', `${nm}：安裝總容量`, cells * vu, 'm³', { f: '= 顆數 × 單顆淨容量', sub: `${cells} × ${f2(vu)}`, src: 'phys', xl: `={${pre}_n}*{${pre}_vu}` });
      let hout = null;
      if (D > 0 && cells >= 1) hout = T.step(pre + '_hout', `${nm}：一顆停用時可支應時數`, (cells - 1) * vu / D * 24, 'h', { f: '= (顆數 − 1) × 單顆淨容量 ÷ 下游日需求 × 24', sub: `(${cells} − 1) × ${f2(vu)} ÷ ${f2(D)} × 24`, src: 'phys', xl: `=({${pre}_n}-1)*{${pre}_vu}/{${pre}_d}*24` });
      if (mode === 'byDims') {
        area = T.step(pre + '_area', `${nm}：淨占地`, cells * (L + wall) * (W + wall), 'm²', { f: '= 顆數 × (長 + 池壁) × (寬 + 池壁)', sub: `${cells} × (${L} + ${wall}) × (${W} + ${wall})`, src: 'phys', xl: `={${pre}_n}*({${pre}_L}${wall !== 0 ? `+{${pre}_wall}` : ''})*({${pre}_W}${wall !== 0 ? `+{${pre}_wall}` : ''})` });
      }
      const util = (vreq > 0 && vins > 0) ? T.step(pre + '_util', `${nm}：容量利用率`, vreq / vins, '—', { f: '= 需求容量 ÷ 安裝總容量', sub: `${f2(vreq)} ÷ ${f2(vins)}`, src: 'phys', xl: `={${pre}_vreq}/{${pre}_vins}`, fmt: 3 }) : null;
      /* 合理性檢查（只提示，不阻擋） */
      const mxT = hasV(r.maxCellVolume) ? U.num(r.maxCellVolume, null) : mxCell;
      if (mxT > 0 && vu > mxT + 1e-9) T.check('warn', `「${nm}」單顆淨容量 ${f2(vu)} m³ 超過所設單顆上限 ${mxT} m³，請縮小單顆尺寸或增加顆數。`, hasV(r.maxCellVolume) ? 'user' : used.maxCellVolume.src);
      if (cells > 30) T.check('warn', `「${nm}」需 ${cells} 顆，顆數過多，請確認單顆尺寸是否合理（過小的水箱會讓顆數與管閥數量暴增）。`, 'assume');
      if (mode === 'byDims' && util !== null && vins / vreq > 1.5) T.check('info', `「${nm}」容量利用率偏低（${f2(vreq / vins * 100, 0)}%，安裝 ${f2(vins, 0)} m³ 對需求 ${f2(vreq, 0)} m³），可調整單顆尺寸。`, 'phys');
      /* 平鋪式高程用：目標水位 */
      const zLow = hasV(r.zLow) && isFinite(Number(r.zLow)) ? Number(r.zLow) : null;
      const topDepth = mode === 'byDims' ? (Hh - fb) : null;
      const depth = mode === 'byDims' ? (Hh - fb) : 3.5;
      const side = vu > 0 ? Math.sqrt(vu / depth) : null;
      t.out = { id: t.id, name: nm, role, feed: t.feed, ruleMode, cellsMode: mode, redundancy: red, D, need, vreq, vu, n: cells, vins, hout, area, util,
        dims: { L, W, H: Hh, freeboard: fb, wall }, minCells: minc, zLow, zTop: (zLow !== null && topDepth !== null) ? zLow + topDepth : null,
        sqSide: side, sqDepth: depth, qDown: t.qDown, hours: hrs };
    }
    tanks.forEach(emitTank);
    const tankOut = tanks.map(t => t.out);
    const tById = {}, tankXl = {}; tankOut.forEach(o => { tById[o.id] = o; }); tanks.forEach(t => { tankXl[t.id] = t.qDownXl; });

    const stored = tanks.filter(t => t.role !== 'fire');
    const totalStore = T.step('st_total', '全廠儲水合計（不含消防）', stored.reduce((a, t) => a + t.out.vins, 0), 'm³', { f: 'Σ 各水箱（單顆淨容量 × 顆數），不含消防', sub: stored.map(t => `${t.name} ${f2(t.out.vins, 0)}`).join(' + ') || '0', src: 'phys', xl: stored.length ? '=' + stored.map(t => `{${t.pre}_vins}`).join('+') : '=0' });
    T.step('st_days', '可支應天數', Vd > 0 ? totalStore / Vd : NaN, 'd', { f: '合計 ÷ Vd', sub: `${f2(totalStore)} ÷ ${f2(Vd)}`, src: 'phys', xl: '={st_total}/{Vd}' });
    const areaTanks = tanks.filter(t => t.out.area !== null);
    const totalArea = areaTanks.reduce((a, t) => a + t.out.area, 0);
    if (areaTanks.length) T.step('st_area', '水箱淨占地合計（僅含由尺寸算顆數者）', totalArea, 'm²', { f: 'Σ 各水箱淨占地', sub: areaTanks.map(t => `${t.name} ${f2(t.out.area, 0)}`).join(' + '), src: 'phys', xl: '=' + areaTanks.map(t => `{${t.pre}_area}`).join('+') });
    const fireTanks = tanks.filter(t => t.role === 'fire');
    const fire = T.step('fire', '消防水源（消防組提供，獨立水池）', fireTanks.reduce((a, t) => a + t.out.vins, 0), 'm³', { f: 'Σ 消防水箱安裝容量', sub: fireTanks.map(t => t.name).join('、') || '無消防水箱', src: 'fire', xl: fireTanks.length ? '=' + fireTanks.map(t => `{${t.pre}_vins}`).join('+') : '=0' });
    /* 舊版代號（相容舊連結／報表）：生活、空調第一顆水箱 */
    const alias = (id, label, v, unit, ref) => { T.step(id, label + '（舊版代號）', v, unit, { f: `= ${ref}`, src: 'phys', xl: `={${ref}}` }); T.index[id].alias = true; };
    const tdom = tanks.find(t => t.role === 'domestic'), thv = tanks.find(t => t.role === 'hvac');
    let needDom = 0, needCool = 0, domStore = 0, coolStore = 0, cellDom = 0, cellCool = 0;
    if (tdom) { needDom = tdom.out.need; domStore = tdom.out.vreq; cellDom = tdom.out.vu; alias('need_dom', '生活儲水需求（備援）', needDom, 'm³', tdom.needId); alias('st_dom', '生活儲水 採用', domStore, 'm³', tdom.pre + '_vreq'); alias('cell_dom', '生活水池 每格容量', cellDom, 'm³', tdom.pre + '_vu'); }
    if (thv) { needCool = thv.out.need; coolStore = thv.out.vreq; cellCool = thv.out.vu; alias('need_cool', '空調儲水需求（備援）', needCool, 'm³', thv.needId); alias('st_cool', '空調儲水（Break tank）採用', coolStore, 'm³', thv.pre + '_vreq'); alias('cell_cool', '空調水池 每格容量', cellCool, 'm³', thv.pre + '_vu'); }
    res.storage = { domStore, coolStore, cellDom, cellCool, n: tdom ? tdom.out.n : n, total: totalStore, fire, needDom, needCool, codeTot, area: totalArea, days: Vd > 0 ? totalStore / Vd : null, tanks: tankOut };
    res.tanks = tankOut;

    /* ── T-05 基地供水能力 ── */
    if (capDay > 0) {
      const gap = T.step('sup_gap', '日設計用水量 − 基地供水上限', Vd - capDay, 'm³/d', { f: 'Vd − 供水上限', sub: `${f2(Vd)} − ${f2(capDay)}`, src: 'phys', xl: '={Vd}-{sup_cap}' });
      const gpct = T.step('sup_gap_pct', '缺口占供水上限比例', gap / capDay * 100, '%', { f: '缺口 ÷ 供水上限 × 100', sub: `${f2(gap)} ÷ ${f2(capDay)}`, src: 'phys', xl: '={sup_gap}/{sup_cap}*100' });
      let tfill = null;
      if (gap > 1e-9) T.check('fail', `日設計用水量超過供水上限 ${f2(gap, 0)} m³/日（${f2(gpct, 1)}%）：Vd ${f2(Vd, 0)} m³/日 > 供水上限 ${f2(capDay, 0)} m³/日。儲水無法彌補長期缺口，請與業主／供水單位確認用水量或供水能力。`, 'phys');
      else T.check('pass', `日設計用水量 ${f2(Vd, 0)} m³/日 ≤ 基地供水上限 ${f2(capDay, 0)} m³/日。`, 'phys');
      if (capDay - Vd > 1e-9) {
        tfill = T.step('sup_tfill', '全部水箱由空補滿所需天數', totalStore / (capDay - Vd), 'd', { f: '= 儲水合計 ÷ (供水上限 − Vd)', sub: `${f2(totalStore, 0)} ÷ (${f2(capDay, 0)} − ${f2(Vd, 0)})`, src: 'phys', xl: '={st_total}/({sup_cap}-{Vd})' });
        if (tfill > 7) T.check('warn', `水箱用空後以供水餘裕補滿需 ${f2(tfill, 1)} 天，補水恢復很慢，請確認備援策略。`, 'phys');
      } else T.check('warn', '供水上限不大於日設計用水量，水箱一旦用空便無法補滿。', 'phys');
      if (totalStore > 2 * capDay + 1e-9) T.check('warn', `全廠儲水合計 ${f2(totalStore, 0)} m³ 超過基地供水上限的 2 日量（${f2(2 * capDay, 0)} m³），請確認備援時數與水箱規模是否過大。`, 'phys');
      res.supply = { cap: capDay, gap, pct: gpct, tFill: tfill };
    }
    if (capFire > 0 && fire > 0) {
      T.input('sup_cap_fire', '消防補水量（使用者輸入，另計）', capFire, 'm³/d', 'user', '供水單位或消防組提供，不計入日設計用水量');
      const tf = T.step('sup_fire_t', '消防水箱補滿所需天數', fire / capFire, 'd', { f: '= 消防水箱容量 ÷ 消防補水量', sub: `${f2(fire, 0)} ÷ ${f2(capFire, 0)}`, src: 'fire', xl: '={fire}/{sup_cap_fire}' });
      T.check('info', `消防水箱 ${f2(fire, 0)} m³ 以 ${f2(capFire, 0)} m³/日 的消防補水量補滿需 ${f2(tf, 1)} 天（是否符合消防法規由消防組判定）。`, 'fire');
    }

    if (res.twLimits) {
      const adoptVG = U.num(inp.adoptVG, 0), adoptVT = U.num(inp.adoptVT, 0);
      if (adoptVG + adoptVT > 0) {
        T.input('adopt_vg', '實際採用 蓄水池 VG', adoptVG, 'm³', 'user');
        T.input('adopt_vt', '實際採用 水塔 VT', adoptVT, 'm³', 'user');
        const sum = adoptVG + adoptVT;
        T.check(adoptVG >= res.twLimits.vgMin ? 'pass' : 'fail', `蓄水池 ${f2(adoptVG, 1)} m³ ${adoptVG >= res.twLimits.vgMin ? '≥' : '<'} 下限 ${f2(res.twLimits.vgMin, 1)} m³（§6）`, 'tw_std');
        T.check(sum >= res.twLimits.totMin ? 'pass' : 'fail', `水池＋水塔 ${f2(sum, 1)} m³ ${sum >= res.twLimits.totMin ? '≥' : '<'} 合計下限 ${f2(res.twLimits.totMin, 1)} m³`, 'tw_std');
        if (sum > res.twLimits.totMax) T.check('warn', `水池＋水塔 ${f2(sum, 1)} m³ 超過《自來水用戶用水設備標準》§6「二日用水量以下」上限 ${f2(res.twLimits.totMax, 1)} m³。資料中心備援需求常超過此值，請事先與台水確認，或將超出部分改列為非自來水系統（獨立 Break tank）。`, 'tw_std');
      }
      if (totalStore > res.twLimits.totMax) T.check('warn', `建議儲水合計 ${f2(totalStore, 1)} m³ 超過 §6 二日上限 ${f2(res.twLimits.totMax, 1)} m³ — 請與台水確認或調整備援時數。`, 'tw_std');
    }
    if (evaporative) T.check('info', `冷卻塔屬高危害交叉連接：空調補水應經空氣間隙 Break tank 或 RPZ 與飲用水系統隔離${region.id === 'US' ? '（IPC §608 / Table 608.1）' : region.id === 'TW' ? '（用水設備標準 §7 空氣間隙、§18 自來水與非自來水系統分開）' : ''}。`, region.id === 'US' ? 'ipc_608' : 'tw_std');

    /* ──────── 6. 泵浦 ──────── */
    T.section('6 泵浦選定');
    const cat = PIPES[region.pipe];
    const vmax = P('vMax'), C = P('hwC'), fit = P('fittingPct'), eff = P('pumpEff'), margin = P('pumpMargin');
    const pmax = P('pressMaxM'), gradMax = P('gradMax');
    T.input('p_vmax', '管內流速上限', vmax, 'm/s', used.vMax.src, used.vMax.note);
    T.input('p_c', 'Hazen-Williams C', C, '—', used.hwC.src, used.hwC.note);
    T.input('p_fit', '管件當量長度加成', fit, '%', used.fittingPct.src, used.fittingPct.note);
    T.input('p_eff', '泵浦效率', eff, '—', used.pumpEff.src);
    T.input('p_mg', '馬達裕度', margin, '—', used.pumpMargin.src);
    T.input('p_grad', '摩擦損失梯度上限', gradMax || 0, 'm/100m', used.gradMax.src, used.gradMax.note);
    T.table('pipe_ids', cat.rows.map(r => r.id));
    const mList = P('motorList') === 'HP' ? MOTORS_HP : MOTORS_KW;
    const mUnit = P('motorList') === 'HP' ? 'HP' : 'kW';
    T.table('motor_list', mList);
    const resGen = P('resGeneral'), resFV = P('resFlushValve');
    const flushValveSys = !!dom.flushValve || (dom.fixtures && (U.num(dom.fixtures.wc_fv, 0) + U.num(dom.fixtures.ur_fv1, 0) + U.num(dom.fixtures.ur_fv3, 0)) > 0);
    res.pumps = [];
    /* T-06：樓層模型（multistory）或平鋪式（flat）。平鋪式沒有「屋頂」與多層立管，靜揚程＝出水點標高 − 吸水水位標高 */
    const layout = ((inp.net && inp.net.layout) || inp.layout) === 'flat' ? 'flat' : 'multistory';
    res.layout = layout;
    const tankRef = ref => (ref === undefined || ref === null || ref === '' ? null : (tById[idMap[String(ref)]] || null));
    const ng = (inp.net && inp.net.enable !== false) ? (() => { const nt = inp.net; const N = layout === 'flat' ? 1 : Math.max(1, Math.min(60, Math.round(U.num(nt.floors, 4)))), fh = U.num(nt.floorH, 5), th = U.num(nt.termH, 1.2); return { N, zTank: -U.num(nt.basement, 6), zTm: k => (k - 1) * fh + th, zRoof: N * fh }; })() : null;
    const roofHvacOn = !(inp.net && inp.net.roofHvac === false) && layout !== 'flat';
    (inp.pumps || []).forEach((z, i) => {
      const id = 'z' + i, nm = z.name || `泵組 ${i + 1}`;
      let Qlpm;
      if (z.kind === 'domestic') {
        const share = U.num(z.share, 100);
        T.input(id + '_sh', `${nm}：生活尖峰分配比例`, share, '%', 'user');
        Qlpm = T.step(id + '_q', `${nm}：設計流量`, qpDom * share / 100, 'L/min', { f: 'Qp × 分配比例', sub: `${f2(qpDom, 1)} × ${share}%`, src: 'phys', xl: `={qp_dom}*{${id}_sh}/100` });
      } else if (z.kind === 'hvac') {
        const share = U.num(z.share, 100);
        T.input(id + '_sh', `${nm}：空調補水分配比例`, share, '%', 'user');
        Qlpm = T.step(id + '_q', `${nm}：設計流量`, coolMaxHour * 1000 / 60 * share / 100, 'L/min', { f: '空調補水最大時 × 分配比例', sub: `${f2(coolMaxHour)} m³/h × ${share}%`, src: 'phys', xl: `={hvac_maxh}*1000/60*{${id}_sh}/100` });
      } else if (z.kind === 'transfer') {
        /* 轉輸泵：流量＝出水水箱（目標）下游的最大時需求；靜揚程由水箱標高自動帶入（T-11） */
        const share = U.num(z.share, 100), tTo = tankRef(z.to);
        T.input(id + '_sh', `${nm}：轉輸流量分配比例`, share, '%', 'user');
        if (tTo) {
          Qlpm = T.step(id + '_q', `${nm}：設計流量（${tTo.name} 下游最大時需求）`, tTo.qDown * share / 100, 'L/min', { f: '目標水箱下游最大時需求 × 分配比例', sub: `${f2(tTo.qDown, 1)} × ${share}%`, src: 'phys', xl: `=(${tankXl[tTo.id]})*{${id}_sh}/100` });
        } else {
          Qlpm = T.input(id + '_q', `${nm}：設計流量（使用者輸入；未指定出水水箱）`, U.num(z.qLpm, 0), 'L/min', 'user');
          T.check('warn', `${nm}：轉輸泵未指定出水水箱，流量改用手填值。`, 'assume');
        }
      } else {
        Qlpm = T.input(id + '_q', `${nm}：設計流量（使用者輸入）`, U.num(z.qLpm, 0), 'L/min', 'user');
      }
      const hsBlank = z.static === null || z.static === undefined || z.static === '';
      /* 高程來源優先序：① 泵組表的吸水／出水標高（或吸水／出水水箱）② 樓層模型（僅 multistory）③ 無 → 0 並警示 */
      const fromT = tankRef(z.from), toT0 = tankRef(z.to);
      const numOrNull = x => (hasV(x) && isFinite(Number(x))) ? Number(x) : null;
      const zFromV = numOrNull(z.zFrom) !== null ? numOrNull(z.zFrom) : (fromT && fromT.zLow !== null ? fromT.zLow : null);
      const zToV = numOrNull(z.zTo) !== null ? numOrNull(z.zTo) : (z.kind === 'transfer' && toT0 && toT0.zTop !== null ? toT0.zTop : null);
      let autoHs = null, hsBy = '';
      if (hsBlank && zFromV !== null && zToV !== null) { autoHs = zToV - zFromV; hsBy = 'elev'; }
      else if (hsBlank && ng && layout === 'multistory') {
        if (z.kind === 'hvac' && roofHvacOn) { autoHs = ng.zRoof - ng.zTank; hsBy = 'roof'; }
        else if (z.kind === 'domestic') { autoHs = ng.zTm(ng.N) - ng.zTank; hsBy = 'top'; }
      }
      let Hs;
      if (hsBy === 'elev') {
        const zf = T.input(id + '_zf', `${nm}：吸水水位標高`, zFromV, 'm', 'user', numOrNull(z.zFrom) !== null ? '' : `取自吸水水箱「${fromT && fromT.name}」最低有效水位`);
        const zt = T.input(id + '_zt', `${nm}：出水點標高`, zToV, 'm', 'user', numOrNull(z.zTo) !== null ? '' : `取自出水水箱「${toT0 && toT0.name}」滿水位`);
        Hs = T.step(id + '_hs', `${nm}：靜揚程（出水點標高 − 吸水水位標高）`, zt - zf, 'm', { f: '= 出水點標高 − 吸水水位標高', sub: `${zt} − (${zf})`, src: 'phys', xl: `={${id}_zt}-{${id}_zf}` });
      } else if (autoHs !== null) {
        Hs = T.step(id + '_hs', `${nm}：靜揚程（高低差，由系統昇位自動帶入）`, autoHs, 'm', { f: hsBy === 'roof' ? '= 屋頂補水點標高 − 泵房底標高' : '= 頂層末端標高 − 泵房底標高', sub: hsBy === 'roof' ? `${ng.zRoof} − (${ng.zTank})` : `${ng.zTm(ng.N)} − (${ng.zTank})`, src: 'phys', note: '於「6c 系統昇位與管徑」設定樓層高度；也可在泵組表直接輸入靜揚程覆蓋' });
      } else {
        Hs = T.input(id + '_hs', `${nm}：靜揚程（高低差）`, U.num(z.static, 0), 'm', 'user');
        if (hsBlank) T.check('warn', `${nm}：靜揚程未設定${layout === 'flat' ? '（平鋪式需在泵組表填吸水水位／出水點標高，或直接輸入靜揚程）' : z.kind === 'hvac' && !roofHvacOn ? '（空調補水不送屋頂，請填出水點標高或直接輸入靜揚程）' : '（請填吸水／出水標高或直接輸入靜揚程）'}，暫以 0 m 計，總揚程偏低。`, 'assume');
      }
      const L = T.input(id + '_l', `${nm}：管線長度`, U.num(z.length, 0), 'm', 'user');
      let res_m = (z.residual === null || z.residual === undefined || z.residual === '') ? NaN : U.num(z.residual, NaN);
      let resSrc = 'user';
      if (!isFinite(res_m)) {
        if (z.kind === 'domestic') { res_m = flushValveSys ? resFV : resGen; resSrc = flushValveSys ? used.resFlushValve.src : used.resGeneral.src; }
        else { res_m = 10; resSrc = 'assume'; }
      }
      T.input(id + '_res', `${nm}：末端所需壓力`, res_m, 'm', resSrc,
        z.kind === 'domestic' ? (flushValveSys ? '沖水閥系統' : '一般水栓') : '依設備入口需求（空調組／設備廠提供）');
      const Qs = Qlpm / 60000;
      const dV = 1000 * Math.sqrt(4 * Qs / (Math.PI * vmax));
      const dG = (Qs > 0 && gradMax > 0) ? 1000 * Math.pow(10.67 * Math.pow(Qs, 1.852) / (Math.pow(C, 1.852) * gradMax / 100), 1 / 4.87) : 0;
      const dreq = T.step(id + '_dreq', `${nm}：最小內徑`, Math.max(dV, dG), 'mm',
        { f: 'd = max( √(4Q ÷ (π·v_max)) , [10.67·Q^1.852 ÷ (C^1.852·S_max)]^(1/4.87) )　〔流速與摩擦梯度兩條件取大〕',
          sub: `Q=${f2(Qlpm, 1)} L/min → 流速條件 ${f2(dV, 1)} mm、梯度條件 ${f2(dG, 1)} mm`, src: ['cont', 'hw'],
          xl: `=MAX(1000*SQRT(4*{${id}_q}/60000/(PI()*{p_vmax})),IF({p_grad}>0,1000*(10.67*({${id}_q}/60000)^1.852/({p_c}^1.852*{p_grad}/100))^(1/4.87),0))` });
      let pipe = cat.rows.find(r => r.id >= dreq - 1e-9) || cat.rows[cat.rows.length - 1];
      if (z.dn) { const f = cat.rows.find(r => r.dn === Number(z.dn)); if (f) pipe = f; }
      const ID = T.step(id + '_id', `${nm}：採用管內徑`, pipe.id, 'mm', { f: z.dn ? '使用者指定管徑' : `${cat.label} 中 ID ≥ d 之最小管`, sub: pipe.name, src: cat.src,
        xl: z.dn ? `=${pipe.id}` : `=MINIFS(pipe_ids,pipe_ids,">="&{${id}_dreq})`, fmt: 1 });
      const v = T.step(id + '_v', `${nm}：管內流速`, Qs / (Math.PI / 4 * Math.pow(ID / 1000, 2)), 'm/s', { f: 'v = Q ÷ A', sub: `${f2(Qlpm, 1)} L/min ÷ A(${f2(ID, 1)} mm)`, src: 'cont', xl: `={${id}_q}/60000/(PI()/4*({${id}_id}/1000)^2)` });
      const hf = T.step(id + '_hf', `${nm}：摩擦損失`, U.hw(Qs, ID / 1000, L * (1 + fit / 100), C), 'm',
        { f: 'hf = 10.67·L′·Q^1.852 ÷ (C^1.852·D^4.87)，L′ = L × (1+管件加成)', sub: `L′=${f2(L * (1 + fit / 100), 1)} m, C=${C}`, src: 'hw',
          xl: `=IF({${id}_q}>0,10.67*{${id}_l}*(1+{p_fit}/100)*({${id}_q}/60000)^1.852/({p_c}^1.852*({${id}_id}/1000)^4.87),0)` });
      const H = T.step(id + '_h', `${nm}：總揚程 TDH`, Hs + hf + res_m, 'm', { f: 'TDH = 靜揚程 + 摩擦損失 + 末端所需壓力', sub: `${f2(Hs, 1)} + ${f2(hf)} + ${f2(res_m, 1)}`, src: 'phys', xl: `={${id}_hs}+{${id}_hf}+{${id}_res}` });
      const kW = T.step(id + '_kw', `${nm}：軸功率`, 1000 * G * Qs * H / 1000 / eff, 'kW', { f: 'P = ρ·g·Q·H ÷ η', sub: `1000×9.81×${f2(Qs, 5)}×${f2(H)} ÷ ${eff} ÷ 1000`, src: 'cont', xl: `=9.81*{${id}_q}/60000*{${id}_h}/{p_eff}` });
      const need = mUnit === 'HP' ? kW * margin / 0.7457 : kW * margin;
      T.step(id + '_pm', `${nm}：馬達需求（含裕度）`, need, mUnit, { f: mUnit === 'HP' ? 'kW × 裕度 ÷ 0.7457' : 'kW × 裕度', sub: `${f2(kW, 3)} × ${margin}`, src: 'assume', xl: mUnit === 'HP' ? `={${id}_kw}*{p_mg}/0.7457` : `={${id}_kw}*{p_mg}` });
      const motor = U.firstGE(mList, need);
      T.step(id + '_motor', `${nm}：選用馬達`, motor, mUnit, { f: '取 ≥ 需求之標準馬達容量', sub: `${f2(need, 2)} ${mUnit}`, src: 'assume', xl: `=MINIFS(motor_list,motor_list,">="&{${id}_pm})` });
      const duty = U.num(z.duty, P('pumpDuty')), sb = U.num(z.standby, P('pumpStandby'));
      const p = { name: nm, kind: z.kind, Qlpm, pipe: pipe.name, dn: pipe.dn, id: ID, v, hf, Hs, res: res_m, H, kW, motor, mUnit, duty, standby: sb };
      res.pumps.push(p);
      if (v > vmax + 1e-9) T.check('fail', `${nm}：流速 ${f2(v)} m/s 超過上限 ${vmax} m/s（已達管材表最大管徑）。`, used.vMax.src);
      if (gradMax && L > 0 && hf / (L * (1 + fit / 100)) * 100 > gradMax + 1e-6) T.check('warn', `${nm}：摩擦梯度 ${f2(hf / (L * (1 + fit / 100)) * 100)} m/100m 超過上限 ${gradMax}。`, used.gradMax.src);
      if (pmax && Hs + res_m > pmax) T.check('warn', `${nm}：末端靜壓約 ${f2((H - hf) / PSI_M, 0)} psi，若泵浦關斷揚程使系統靜壓 > 80 psi，須設減壓閥（§604.8）。`, 'ipc_604');
      if (!(Qlpm > 0)) T.check('warn', `${nm}：設計流量為 0，請確認分配比例或輸入。`, 'assume');
    });
    /* T-07：運轉台數 × 單台流量 與系統流量對照（只提示，不改使用者填的分配比例） */
    [['domestic', '生活尖峰', qpDom], ['hvac', '空調補水', coolMaxHour * 1000 / 60]].forEach(([kind, lab, Qsys]) => {
      const grp = res.pumps.filter(p => p.kind === kind);
      if (!grp.length || !(Qsys > 0)) return;
      const tot = grp.reduce((a, p) => a + p.duty * p.Qlpm, 0), ratio = tot / Qsys;
      const names = grp.map(p => p.name).join('、');
      if (ratio < 0.99) T.check('warn', `${lab}泵組（${names}）：運轉台數合計流量 ${f2(tot, 0)} L/min 只有系統流量 ${f2(Qsys, 0)} L/min 的 ${f2(ratio * 100, 0)}%，運轉台數合計流量不足。每台流量＝系統流量 × 分配比例，若 N 台同時運轉分擔全量，分配比例應約為 100 ÷ N（例如 2 台運轉 → 各 50%）。`, 'phys');
      else if (ratio > 1.05) T.check('warn', `${lab}泵組（${names}）：運轉台數合計流量 ${f2(tot, 0)} L/min 為系統流量 ${f2(Qsys, 0)} L/min 的 ${f2(ratio * 100, 0)}%，超過系統需求。每台流量＝系統流量 × 分配比例；若 N 台同時運轉分擔全量，分配比例應約為 100 ÷ N（例如 2 台運轉 → 各 50%）。工具不會自動修改你填的比例。`, 'phys');
    });

    /* ──────── 6b. 台水表格式：揚水泵（高置水塔）── 僅台灣、送審重現 ──────── */
    if (isTW && inp.twcHead && inp.twcHead.enable) {
      T.section('6b 台水表格式揚程（高置水塔）');
      const h = inp.twcHead;
      const bd = T.input('tw_bh', '樓高', U.num(h.building, 0), 'm', 'user');
      const tl = T.input('tw_len', '管長', U.num(h.L, 0), 'm', 'user');
      const td = T.input('tw_dia', '揚水管口徑', U.num(h.D, 0), 'mm', 'user');
      const tv = T.input('tw_vel', '流速', U.num(h.V, 0), 'm/s', 'twc_form');
      const hm = P('hammer'); T.input('tw_hamk', '水錘加重係數', hm, '—', used.hammer.src, used.hammer.note);
      const Hs = T.step('tw_Hs', '吸入揚程 Hs', 0.5 * tv * tv / (2 * 9.8), 'm', { f: 'Hs = 0.5·V²/2g', sub: `0.5 × ${tv}² ÷ 19.6`, src: 'twc_form', xl: '=0.5*{tw_vel}^2/(2*9.8)' });
      const Hd = T.step('tw_Hd', '出口揚程 Hd', bd + Hs, 'm', { f: 'Hd = 樓高 + Hs', sub: `${bd} + ${f2(Hs, 4)}`, src: 'twc_form', xl: '={tw_bh}+{tw_Hs}' });
      const Ht = T.step('tw_Ht', '摩擦損失 Ht', 0.02 * tl / (td / 1000) * tv / (2 * 9.8), 'm', { f: 'Ht = 0.02·L/D·V/2g（D 以公尺代入；台水表為 V 一次方）', sub: `0.02 × ${tl} ÷ ${td / 1000} × ${tv} ÷ 19.6`, src: 'twc_form', xl: '=0.02*{tw_len}/({tw_dia}/1000)*{tw_vel}/(2*9.8)' });
      const Hw = T.step('tw_Hw', '水錘加重水頭 Hw', (Hs + Hd + Ht) * hm, 'm', { f: 'Hw = (Hs+Hd+Ht) × 0.34', sub: `(${f2(Hs, 4)} + ${f2(Hd, 4)} + ${f2(Ht, 4)}) × ${hm}`, src: 'twc_form', xl: '=({tw_Hs}+{tw_Hd}+{tw_Ht})*{tw_hamk}' });
      const Htot = T.step('tw_H', '總揚程 H', Hs + Hd + Ht + Hw, 'm', { f: 'H = Hs + Hd + Ht + Hw', sub: '', src: 'twc_form', xl: '={tw_Hs}+{tw_Hd}+{tw_Ht}+{tw_Hw}' });
      const vt = T.input('tw_vt', '水塔容量 VT', U.num(h.vt, 0), 'm³', 'user');
      const q = T.step('tw_Q', '揚水量 Q（30 分鐘充滿水塔）', vt / 1800, 'm³/s', { f: 'Q = VT ÷ 1800', sub: `${vt} ÷ 1800`, src: 'twc_form', xl: '={tw_vt}/1800', fmt: 6 });
      T.step('tw_PS', '揚水泵馬力', 1000 * q * Htot / (75 * eff) * margin, 'PS', { f: 'HP = W·Q·H ÷ (75·E) × 1.1', sub: `1000 × ${f2(q, 6)} × ${f2(Htot, 4)} ÷ (75 × ${eff}) × ${margin}`, src: 'twc_form', xl: '=1000*{tw_Q}*{tw_H}/(75*{p_eff})*{p_mg}' });
      if (!(vt > 0)) T.check('info', '未設高置水塔（VT = 0）時，台水表的揚水量與馬力為 0 —— 這是表格算法的結果，不是漏算；分區加壓泵請看上方泵浦表。', 'twc_form');
      res.twHead = { H: Htot };
    }

    /* ──────── 6c. 系統昇位與管徑（System Flow）──────── */
    if (inp.net && inp.net.enable !== false) {
      res.net = buildNet(inp, { T, P, used, region, cat, qpDom, coolMaxHour, Vd, res, vmax, gradMax, C, fit, pmax, resGen, resFV, flushValveSys, dom, layout, roofHvacOn });
    }

    /* ──────── 7. 水質 ──────── */
    T.section('7 水質判定');
    res.wq = evaluateWQ(inp.wq || {}, region, P, used, evaporative ? U.num(c.coc, 3) : null, T, owner, { evaporative, coolType: c.type, humid: U.num(c.humidDaily, 0), region, tcsPremix: !!(inp.wq && inp.wq.tcsPremix) });

    /* ──────── 業主基準衝突 ──────── */
    conflicts.forEach(cf => {
      if (cf.legal) T.check('warn', `業主設計基準 ${cf.key} = ${JSON.stringify(cf.ownerV)} 與法規／主管機關值 ${JSON.stringify(cf.baseV)}（${SOURCES[cf.baseSrc].short}）不同：送審文件以法規為底線，請確認業主值為「加嚴」而非「放寬」。`, 'owner');
    });
    if (region.status === 'preview') T.check('warn', `${region.label} 法規對照為預覽版：方法與參數未完成逐項查證，結果只可作初篩，不可用於送審。`, 'assume');

    res.V = V; res.Vd = Vd; res.domRaw = domRaw; res.procRaw = procRaw; res.coolDaily = coolDaily; res.coolMaxHour = coolMaxHour;
    res.evaporative = evaporative; res.shareDom = shareDom;
    res.trace = T.steps; res.index = T.index; res.checks = T.checks; res.tables = T.tables;
    res.params = used; res.conflicts = conflicts; res.units = units;
    return res;
  }


  /* ═════════════ 系統昇位與管徑：由引入管到末端器具 ═════════════
   * 管段分四級：引入／幹管（市水→水池→泵→立管底）→ 立管（逐層遞減）→ 層內橫支管 → 末端器具接管
   * 管徑一律「流速上限」與「摩擦梯度上限」取大者，再取管材表中內徑 ≥ 需求的最小管（與泵浦表同一套規則）。
   * 立管與橫支管流量：Hunter（WSFU 累計 → Table E103.3(3)）；無 Hunter 的區域以各層負荷占比分配生活尖峰。
   * 器具末端接管：不以瞬時流量放大，採「最小口徑」規則（工程慣用，標示假設，須依器具廠商與當地規範覆核）。 */
  function buildNet(inp, X) {
    const { T, P, used, region, cat, qpDom, coolMaxHour, Vd, res, vmax, gradMax, C, fit, pmax } = X;
    const nt = inp.net;
    const N = X.layout === 'flat' ? 1 : Math.max(1, Math.min(60, Math.round(U.num(nt.floors, 4))));
    const floorH = U.num(nt.floorH, 5), basement = U.num(nt.basement, 6), termH = U.num(nt.termH, 1.2);
    const lenMain = U.num(nt.lenMain, 50), lenHdr = U.num(nt.lenHdr, 30), lenBr = U.num(nt.lenBranch, 35), lenTerm = U.num(nt.lenTerm, 8);
    T.section('6c 系統昇位與管徑');
    T.input('net_n', '服務樓層數', N, '層', 'user', '生活立管服務的地上樓層；器具與負荷假設各層均分');
    T.input('net_fh', '樓層高度', floorH, 'm', 'user');
    T.input('net_bs', '泵房／水池底標高（地下）', -basement, 'm', 'user', '地面層 ±0.00 為基準');
    T.input('net_th', '末端器具接管高度（距樓板）', termH, 'm', 'user');
    const minB = P('minBranchDN'), minF = P('minFlushDN');
    T.input('net_minb', '器具接管最小口徑 DN', minB, 'mm', used.minBranchDN.src, used.minBranchDN.note);
    T.input('net_minf', '沖水閥接管最小口徑 DN', minF, 'mm', used.minFlushDN.src, used.minFlushDN.note);
    const zTank = -basement, zFl = k => (k - 1) * floorH, zTm = k => zFl(k) + termH, zRoof = N * floorH;
    const hunterSys = region.method.peak === 'hunter';
    const wsfuTot = res.wsfuTot || 0, valveSys = !!res.valveSys;
    const floorQ = cnt => hunterSys ? U.hunter(wsfuTot * cnt / N, valveSys) * GPM : qpDom * cnt / N;
    const lastRow = cat.rows[cat.rows.length - 1];
    const rowByDN = dn => cat.rows.find(r => r.dn >= dn - 1e-9) || lastRow;
    const segs = [];
    function seg(o) {
      // o: id, name, kind, from, to, Q, L, rule('size'|'fixed'|'min'), minDN, fixedPipe, z0, z1, basis
      const Q = o.Q, L = o.L || 0, has = Q !== null && Q !== undefined;
      const Qs = has ? Q / 60000 : 0;
      const dV = Qs > 0 ? 1000 * Math.sqrt(4 * Qs / (Math.PI * vmax)) : 0;
      const dG = (Qs > 0 && gradMax > 0) ? 1000 * Math.pow(10.67 * Math.pow(Qs, 1.852) / (Math.pow(C, 1.852) * gradMax / 100), 1 / 4.87) : 0;
      const dreq = Math.max(dV, dG);
      let pipe, minID = null;
      if (o.rule === 'fixed') pipe = o.fixedPipe;
      else if (o.rule === 'min') pipe = rowByDN(o.minDN), minID = pipe.id;
      else {
        pipe = cat.rows.find(r => r.id >= dreq - 1e-9) || lastRow;
        if (o.minDN) { const m = rowByDN(o.minDN); minID = m.id; if (m.id > pipe.id) pipe = m; }
      }
      const ID = pipe.id;
      const v = (Qs > 0) ? Qs / (Math.PI / 4 * Math.pow(ID / 1000, 2)) : null;
      const Leq = L * (1 + fit / 100);
      const hf = (Qs > 0 && L > 0) ? U.hw(Qs, ID / 1000, Leq, C) : 0;
      const S = Leq > 0 ? hf / Leq * 100 : 0;
      const s = { id: o.id, name: o.name, kind: o.kind, from: o.from, to: o.to, Q: has ? Q : null, L, rule: o.rule || 'size', minDN: o.minDN || null, minID,
        dreq: has ? dreq : null, pipe: pipe.name, dn: pipe.dn, ID, v, hf, S, z0: o.z0, z1: o.z1, basis: o.basis || '' };
      segs.push(s); return s;
    }
    /* ① 市水引入管 */
    const twSvc = region.method.service === 'twc_di';
    const qSvc = twSvc ? Vd * 1000 / 1440 : (res.index && res.index.svc_q ? res.index.svc_q.v : qpDom + coolMaxHour * 1000 / 60);
    const svc = twSvc
      ? seg({ id: 'S1', name: '市水引入管', kind: 'service', from: '市水主管／水表', to: '受水池', Q: qSvc, L: lenMain, rule: 'fixed', fixedPipe: rowByDN(res.service.adopt), z0: 0, z1: zTank, basis: '台水 Di = 4.59√Vd（24 h 均勻進水）取標準口徑' })
      : seg({ id: 'S1', name: '市水引入管', kind: 'service', from: '市水主管／水表', to: '受水池', Q: qSvc, L: lenMain, z0: 0, z1: zTank, basis: res.svcBasis === 'peak' ? '生活尖峰 + 空調補水最大時；流速／梯度雙條件' : 'Vd 24 h 均勻進水（市政水只補水箱）；流速／梯度雙條件' });
    /* ② 泵出口幹管 */
    const pumps = res.pumps || [];
    const domP = pumps.find(p => p.kind === 'domestic'), hvP = pumps.find(p => p.kind === 'hvac');
    pumps.forEach((p, i) => { if (p.Qlpm > 0) seg({ id: 'M' + (i + 1), name: `${p.name} 泵出口幹管`, kind: 'main', from: `P-${String(i + 1).padStart(2, '0')}`, to: p.kind === 'hvac' ? '空調補水立管底' : '生活立管底', Q: p.Qlpm, L: lenHdr, z0: zTank, z1: zTank, basis: '泵組設計流量' }); });
    /* ③ 生活立管（逐層遞減）與層內橫支管 */
    const riserQ0 = domP ? domP.Qlpm : floorQ(N);
    if (riserQ0 > 0) {
      seg({ id: 'R0', name: '生活立管 底—1F', kind: 'riser', from: '立管底', to: '1F 分歧', Q: floorQ(N), L: Math.max(0, zFl(1) - zTank), z0: zTank, z1: zFl(1), basis: hunterSys ? `${N} 層 ΣWSFU ${(wsfuTot).toFixed(1)} → Hunter` : `${N} 層全部生活尖峰` });
      for (let k = 1; k < N; k++) {
        const cnt = N - k;
        seg({ id: 'R' + k, name: `生活立管 ${k}F—${k + 1}F`, kind: 'riser', from: `${k}F 分歧`, to: `${k + 1}F 分歧`, Q: floorQ(cnt), L: floorH, z0: zFl(k), z1: zFl(k + 1), basis: hunterSys ? `${k + 1}F 以上 ${cnt} 層 ΣWSFU ${(wsfuTot * cnt / N).toFixed(1)} → Hunter` : `${k + 1}F 以上 ${cnt}/${N} 層負荷` });
      }
      for (let k = 1; k <= N; k++) seg({ id: 'B' + k, name: `${k}F 層內橫支管`, kind: 'branch', from: `${k}F 分歧`, to: `${k}F 最遠器具群`, Q: floorQ(1), L: lenBr, minDN: minB, z0: zTm(k), z1: zTm(k), basis: hunterSys ? `單層 ΣWSFU ${(wsfuTot / N).toFixed(1)} → Hunter` : '單層負荷占比' });
      /* ④ 末端器具接管 */
      if (hunterSys) {
        FIXTURES_IPC.forEach(F => { const n = U.num((inp.domestic.fixtures || {})[F.key], 0); if (n > 0) seg({ id: 'T-' + F.key, name: `末端接管：${F.label}`, kind: 'terminal', from: '層內橫支管', to: '器具', Q: U.hunter(F.wsfu, !!F.valve) * GPM, L: lenTerm, rule: 'min', minDN: F.valve ? minF : minB, z0: zTm(1), z1: zTm(1), basis: `單一器具 ${F.wsfu} WSFU；採最小口徑規則（${F.valve ? '沖水閥' : '一般器具'}）` }); });
      } else {
        seg({ id: 'T-gen', name: '末端接管：一般水栓／洗面盆', kind: 'terminal', from: '層內橫支管', to: '器具', Q: null, L: lenTerm, rule: 'min', minDN: minB, z0: zTm(1), z1: zTm(1), basis: '最小口徑規則（工程慣用）' });
        seg({ id: 'T-fv', name: '末端接管：沖水閥', kind: 'terminal', from: '層內橫支管', to: '器具', Q: null, L: lenTerm, rule: 'min', minDN: minF, z0: zTm(1), z1: zTm(1), basis: '最小口徑規則（沖水閥 1 吋）' });
      }
    }
    /* ⑤ 空調補水立管到屋頂 */
    if (hvP && hvP.Qlpm > 0 && X.roofHvacOn) {
      const hi = pumps.indexOf(hvP);
      seg({ id: 'H1', name: '空調補水立管（至屋頂冷卻塔集水盤）', kind: 'riser', from: '空調補水立管底', to: '屋頂補水點', Q: hvP.Qlpm, L: zRoof - zTank, z0: zTank, z1: zRoof, basis: '空調補水最大時流量（全程同流量）' });
    }
    /* ⑥ 壓力剖面：以生活泵揚程與網路實際管長推算各樓層末端可用壓力 */
    const profile = [];
    let chk = null;
    if (domP && riserQ0 > 0) {
      const get = id => segs.find(s => s.id === id);
      const hdrIdx = pumps.indexOf(domP) + 1, hdr = get('M' + hdrIdx);
      let cum = hdr ? hdr.hf : 0;
      const term = segs.find(s => s.kind === 'terminal');
      const termHf = term ? term.hf : 0;
      for (let k = 1; k <= N; k++) {
        cum += (get('R' + (k - 1)) || { hf: 0 }).hf;       // R0 … R(k-1)
        const pathHf = cum + get('B' + k).hf + termHf;
        profile.push({ floor: k, z: zTm(k), hf: pathHf, avail: domP.H - (zTm(k) - zTank) - pathHf });
      }
      const top = profile[N - 1], low = profile[0];
      T.step('net_zrise', '最高末端相對泵房昇位', zTm(N) - zTank, 'm', { f: 'Δz = 頂層末端標高 − 泵房底標高', sub: `${zTm(N).toFixed(2)} − (${zTank.toFixed(2)})`, src: 'phys', note: '與泵浦表的「靜揚程」比對' });
      T.step('net_hf_top', '最遠末端路徑摩擦損失（網路實算）', top.hf, 'm', { f: 'Σ 幹管 + 立管各段 + 頂層橫支管 + 末端接管之 hf（Hazen-Williams）', sub: segs.filter(s => s.kind !== 'service').length + ' 管段，見管徑表', src: 'hw' });
      T.step('net_avail_top', '頂層末端可用壓力', top.avail, 'm', { f: 'H泵 − Δz − 路徑摩擦損失', sub: `${domP.H.toFixed(2)} − ${(zTm(N) - zTank).toFixed(2)} − ${top.hf.toFixed(2)}`, src: 'phys', note: `需求 ${domP.res.toFixed(1)} m` });
      const need = domP.res;
      if (top.avail + 1e-9 < need) T.check('fail', `頂層末端可用壓力 ${top.avail.toFixed(1)} m 低於所需 ${need.toFixed(1)} m：泵浦靜揚程（${domP.Hs} m）低於最高末端昇位 ${(zTm(N) - zTank).toFixed(1)} m，或網路摩擦損失大於泵浦表假設，請提高泵浦揚程或調整管徑。`, 'phys');
      else T.check('pass', `頂層末端可用壓力 ${top.avail.toFixed(1)} m ≥ 所需 ${need.toFixed(1)} m（依網路實際昇位與管長）。`, 'phys');
      if (domP.Hs + 0.5 < zTm(N) - zTank) T.check('warn', `泵浦表靜揚程 ${domP.Hs} m 小於系統最高末端昇位 ${(zTm(N) - zTank).toFixed(1)} m，請確認泵浦表的高低差輸入。`, 'phys');
      if (pmax) {
        const stat1 = domP.H - (zTm(1) - zTank);
        if (stat1 > pmax) T.check('warn', `低層（1F）末端靜壓約 ${stat1.toFixed(1)} m，超過 ${pmax} m（80 psi）：須設減壓閥或分區（IPC §604.8）。`, 'ipc_604');
      }
      chk = { top, low, need };
    } else if (riserQ0 > 0) T.check('info', '未設生活泵組，略過壓力剖面；管徑仍依流量計算。', 'assume');
    const bad = segs.filter(s => s.kind !== 'terminal' && s.v !== null && s.v > vmax + 1e-9);
    bad.forEach(s => T.check('fail', `管段 ${s.id}「${s.name}」流速 ${s.v.toFixed(2)} m/s 超過上限 ${vmax} m/s（已達管材表最大管徑）。`, used.vMax.src));
    segs.filter(s => s.kind !== 'terminal' && gradMax && s.S > gradMax + 1e-6).forEach(s => T.check('warn', `管段 ${s.id}「${s.name}」摩擦梯度 ${s.S.toFixed(2)} m/100m 超過上限 ${gradMax}（受最小口徑規則控制）。`, used.gradMax.src));
    T.check('info', 'System Flow 管徑規則：流速上限與摩擦梯度上限取大者→取管材表最小可用管；立管／橫支管流量採 Hunter 或負荷占比（各層均分）；器具末端接管採最小口徑規則。這是 30% 基礎設計階段的管徑，細部設計須以實際器具配置與廠商資料複核。', 'hw');
    return { N, floorH, basement, termH, zTank, zRoof, segs, profile, check: chk, hunter: hunterSys, cat: cat.label, catSrc: cat.src, vmax, gradMax, C, fit, roofHvac: !!segs.find(s => s.id === 'H1'), layout: X.layout,
      pumpNames: pumps.map(p => p.name), hasDomPump: !!domP };
  }

  /* ═════════════ 水質：補給水適用性與可達濃縮倍數 ═════════════ */
  function evaluateWQ(w, region, P, used, designCOC, T, owner, ctx) {
    ctx = ctx || {};
    const out = { items: [], cocMax: null, governing: null, actions: [] };
    const val = k => (w[k] === null || w[k] === undefined || w[k] === '' ? null : Number(w[k]));
    let ec = val('ec'); let ecEst = false;
    if (ec === null && val('tds') !== null) { ec = U.ecFromTds(val('tds')); ecEst = true; }
    /* 飲用水基準：使用者在水質頁指定者優先，否則用法規區域預設（T-09）*/
    const potKey = (w.potableBasis && WQ[w.potableBasis] && w.potableBasis) || P('potable'); const pot = WQ[potKey] || WQ.tw_potable;
    /* 冷卻水循環水基準：預設 JRA-GL02（開放式、不加藥）；密閉式噴淋水等請使用者自選，不替換（T-08）*/
    const cbKey = (w.circBasis && WQ.circ_bases[w.circBasis]) ? w.circBasis : 'jra';
    const cb = WQ.circ_bases[cbKey], cc = typeof cb.limits === 'string' ? WQ[cb.limits] : cb.limits;
    out.circBasis = cbKey; out.circLabel = cb.label; out.circNote = cb.note; out.circSrc = cb.src; out.potKey = potKey;
    const mk = WQ.jra_makeup;
    const defs = [
      { k: 'ph',   label: 'pH',                 unit: '',        v: val('ph') },
      { k: 'ec',   label: '導電度 EC',          unit: 'µS/cm',   v: ec, est: ecEst },
      { k: 'tds',  label: '總溶解固體 TDS',     unit: 'mg/L',    v: val('tds') },
      { k: 'hard', label: '總硬度（as CaCO₃）', unit: 'mg/L',    v: val('hard') },
      { k: 'alk',  label: '總鹼度／酸消費量 pH4.8', unit: 'mg/L', v: val('alk') },
      { k: 'cl',   label: '氯鹽 Cl⁻',           unit: 'mg/L',    v: val('cl') },
      { k: 'so4',  label: '硫酸鹽 SO₄²⁻',       unit: 'mg/L',    v: val('so4') },
      { k: 'sio2', label: '二氧化矽 SiO₂',      unit: 'mg/L',    v: val('sio2') },
      { k: 'turb', label: '濁度',               unit: 'NTU',     v: val('turb') },
    ];
    let cocMin = Infinity, gov = null;
    defs.forEach(d => {
      if (d.v === null || !isFinite(d.v)) return;
      const it = { ...d };
      const pl = pot[d.k];
      if (pl !== undefined) {
        it.potLimit = Array.isArray(pl) ? `${pl[0]}~${pl[1]}` : `≤ ${pl}`;
        it.potOk = Array.isArray(pl) ? (d.v >= pl[0] && d.v <= pl[1]) : d.v <= pl;
      }
      const ml = mk[d.k];
      if (ml !== undefined) {
        it.mkLimit = Array.isArray(ml) ? `${ml[0]}~${ml[1]}` : `≤ ${ml}`;
        it.mkOk = Array.isArray(ml) ? (d.v >= ml[0] && d.v <= ml[1]) : d.v <= ml;
      }
      const cl = cc[d.k];
      if (cl !== undefined && !Array.isArray(cl) && d.v > 0) {
        it.cocMax = cl / d.v;
        if (it.cocMax < cocMin) { cocMin = it.cocMax; gov = d; }
      }
      out.items.push(it);
    });
    if (isFinite(cocMin)) { out.cocMax = cocMin; out.governing = gov && gov.label; out.cocOver = cocMin < 1; }
    if (ecEst) T.check('info', '導電度未提供，依 TDS ÷ 0.65 估算（經驗換算，實際比值 0.55~0.75 視離子組成）。', 'assume');
    out.items.forEach(it => {
      if (it.potOk === false) T.check('warn', `${it.label} ${it.v} ${it.unit} 超出飲用水標準 ${it.potLimit}：原水不符飲用水標準，請洽供水單位。`, pot.src);
    });
    if (designCOC && out.cocMax !== null) {
      const cbSrc = cbKey === 'jra' ? 'jra_gl02' : cb.src;
      if (out.cocMax >= 1) {
        T.step('wq_cocmax', '未加藥可達最大濃縮倍數（受 ' + out.governing + ' 控制）', out.cocMax, '—',
          { f: 'COCmax = min(循環水上限 ÷ 補給水濃度)', sub: out.items.filter(i => i.cocMax).map(i => `${i.label}: ${f2(i.cocMax)}`).join('；'), src: cbSrc });
      }
      /* T-08：直接比較「循環水濃度 ≈ COC × 補給水濃度」與所選上限（比 COCmax 倍數直觀；COCmax < 1 時不再顯示成倍數）*/
      out.circ = [];
      const lims = out.items.filter(i => cc[i.k] !== undefined && !Array.isArray(cc[i.k]) && i.v > 0);
      if (lims.length) T.input('wq_coc', '設計 COC（循環水濃度比較用）', designCOC, '—', 'hvac');
      lims.forEach(i => {
        T.input('wq_mk_' + i.k, `補給水 ${i.label}`, i.v, i.unit, 'user');
        const cv = T.step('wq_circ_' + i.k, `循環水 ${i.label} ≈ COC × 補給水`, designCOC * i.v, i.unit,
          { f: '循環水濃度 ≈ COC × 補給水濃度（假設無析出、無藥劑去除的上限估計）', sub: `${designCOC} × ${i.v}　對上限 ${cc[i.k]}`, src: cbSrc, xl: `={wq_coc}*{wq_mk_${i.k}}` });
        out.circ.push({ k: i.k, label: i.label, unit: i.unit, v: i.v, circ: cv, limit: cc[i.k], ok: cv <= cc[i.k] + 1e-9, ratio: cv / cc[i.k] });
      });
      const exceed = out.circ.filter(x => !x.ok);
      if (out.cocMax < 1) {
        const bad = out.items.filter(i => i.cocMax && i.cocMax < 1);
        T.check('warn', `補給水 ${bad.map(i => `${i.label} ${smartN(i.v)} ${i.unit}（循環水上限 ${cc[i.k]}）`).join('、')} 已超過所選循環水基準：補給水本身已超限，不加藥無法運轉（這不是 COC 倍數問題，須由軟化／RO／加藥方案處理，或改選適用的基準）。以 COC ${designCOC} 計，循環水 ${exceed.map(x => `${x.label} ≈ ${smartN(x.circ)} ${x.unit}`).join('、')}。所選基準：${cb.label}。`, cbSrc);
      } else if (designCOC > out.cocMax) {
        T.check('warn', `設計 COC ${designCOC} 大於未加藥可達的 ${f2(out.cocMax)}（受 ${out.governing} 控制）：必須搭配水處理方案（阻垢／防蝕藥劑、軟化或 RO），否則需降低 COC、排放量增加。所選基準：${cb.label}。`, cbSrc);
      } else {
        T.check('pass', `設計 COC ${designCOC} ≤ 未加藥可達 ${f2(out.cocMax)}，以補給水水質而言可行（基準：${cb.label}）。`, cbSrc);
      }
      if (designCOC > out.cocMax) {
        out.items.filter(i => i.cocMax && i.cocMax < designCOC).forEach(i => {
          const act = { hard: '軟水器（離子交換）或阻垢劑', alk: '加酸控制鹼度或阻垢劑', cl: 'RO 或降低 COC（氯鹽不能被軟化去除）', so4: 'RO 或降低 COC', ec: '降低 COC 或 RO', sio2: '降低 COC（矽垢難以藥劑控制）' }[i.k];
          if (act) out.actions.push({ param: i.label, cocMax: i.cocMax, action: act });
        });
      }
      if (ctx.coolType === 'closed_ct' && cbKey === 'jra') T.check('info', 'JRA-GL02 循環水上限屬「開放式、不加藥」基準；密閉式冷卻塔噴淋水通常加藥運轉，此基準的結果不能直接當設計限制。請在水質頁自選適用基準（目前不會自動替換）。', 'jra_gl02');
      if (cbKey !== 'jra') T.check('warn', `所選循環水基準「${cb.label}」：${cb.note}`, 'assume');
    } else if (!designCOC) {
      T.check('info', '非蒸發式散熱：水質重點在系統充水（TCS／設施水迴路）與加濕器；充水水質依 CDU／冷卻液廠商與空調組規範（空調組 SCOPE）。', 'assume');
    }
    if (owner && owner.tcsFluid) out.tcs = owner.tcsFluid;
    Object.assign(out, treatmentPlan(out, val, ec, pot, potKey, designCOC, owner, ctx));
    return out;
  }


  /* ═════════════ 水質規範書：各用途比對 → 水處理設備報價提醒 ═════════════
   * 每個用途（飲用／冷卻塔補水／FWS／TCS／加濕）各自比對原水與其基準；
   * 依比對結果列出「報價時須編列／建議編列／請廠商確認／不需要」的水處理設備與系統。
   * 觸發條件只用已登錄出處的基準值；沒有數值依據的項目一律標為「請廠商確認」，不替廠商下結論。 */
  const fmtLim = l => Array.isArray(l) ? `${l[0]}~${l[1]}` : `≤ ${l}`;
  const inLim = (l, x) => Array.isArray(l) ? (x >= l[0] && x <= l[1]) : x <= l;
  function treatmentPlan(out, val, ec, pot, potKey, designCOC, owner, ctx) {
    const raw = { ph: val('ph'), ec, tds: val('tds'), hard: val('hard'), alk: val('alk'), cl: val('cl'), so4: val('so4'), sio2: val('sio2'), turb: val('turb') };
    const known = Object.keys(raw).filter(k => raw[k] !== null && isFinite(raw[k]));
    const label = {}; WQ.params.forEach(p => { label[p[0]] = p; });
    const ownerL = (owner && owner.wqLimits) || {};
    function evalSet(limits, extra) {
      const rows = [];
      Object.keys(limits).forEach(k => {
        if (k === 'src' || !label[k]) return;
        const x = raw[k];
        const r = { k, label: label[k][1], unit: label[k][2], limit: fmtLim(limits[k]), v: (x === null || !isFinite(x)) ? null : x };
        r.ok = r.v === null ? null : inLim(limits[k], r.v);
        if (extra && extra[k] !== undefined) { r.ownerLimit = fmtLim(extra[k]); r.ownerOk = r.v === null ? null : inLim(extra[k], r.v); }
        rows.push(r);
      });
      // 只在業主有、基準表沒有的參數補列
      if (extra) Object.keys(extra).forEach(k => { if (k === 'src' || k === 'note' || !label[k] || rows.find(r => r.k === k)) return; const x = raw[k]; rows.push({ k, label: label[k][1], unit: label[k][2], limit: '—', v: x === null || !isFinite(x) ? null : x, ok: null, ownerLimit: fmtLim(extra[k]), ownerOk: x === null || !isFinite(x) ? null : inLim(extra[k], x) }); });
      const exceed = rows.filter(r => r.ok === false || r.ownerOk === false);
      return { rows, exceed, unknown: rows.filter(r => r.v === null) };
    }
    const hasVal = known.length > 0;
    const systems = [];
    systems.push({ key: 'potable', label: '生活／飲用水回路', src: [pot.src], basis: `${region_label(ctx)} 飲用水基準`, ...evalSet(pot, ownerL.potable) });
    if (ctx.evaporative) systems.push({ key: 'ct', label: '冷卻塔補給水（蒸發式）', src: ['jra_gl02'], basis: 'JRA-GL02 補給水基準（不加藥）', ...evalSet(WQ.jra_makeup, ownerL.ct) });
    systems.push({ key: 'fws', label: '一次側／冷卻水迴路充水（FWS）', src: ['ashrae_td99'], basis: 'ASHRAE TC 9.9 設施水 FWS 建議值', ...evalSet(WQ.ashrae_fws, ownerL.fws) });
    systems.push({ key: 'tcs', label: '液冷二次側 TCS 充水', src: owner && ownerL.tcs ? ['ashrae_td99', 'owner'] : ['ashrae_td99'], basis: 'ASHRAE TC 9.9 二次側 TCS 建議值' + (ownerL.tcs ? ' ＋ 業主基準' : ''), ...evalSet(WQ.ashrae_tcs, ownerL.tcs) });
    if (ctx.humid > 0) systems.push({ key: 'humid', label: '加濕器（蒸發式濕膜）補水', src: ['assume'], basis: '無通用數值基準，依加濕設備廠商規格', rows: [], exceed: [], unknown: [] });
    const S = k => systems.find(x => x.key === k);
    const ex = (sys, ks) => sys && sys.exceed.filter(r => ks.includes(r.k));
    const fm = r => `${r.label} ${r.v}${r.unit ? ' ' + r.unit : ''}（基準 ${r.ownerOk === false ? r.ownerLimit : r.limit}）`;
    const A = out.actions || [];
    const aHard = A.find(a => a.param.startsWith('總硬度')), aAlk = A.find(a => a.param.startsWith('總鹼度'));
    const aSalt = A.filter(a => /氯鹽|硫酸鹽|導電度/.test(a.param));
    const plan = [];
    const add = (key, name, level, reasons, src, scope) => plan.push({ key, name, level, reason: reasons.length ? reasons.join('；') : '', src: [].concat(src), scope: scope || '' });
    const lv = { required: '必須編列', likely: '建議編列', confirm: '請廠商確認', none: '不需要' };

    /* 前處理過濾 */
    const turbLim = Array.isArray(pot.turb) ? pot.turb[1] : (pot.turb || 5);
    if (raw.turb === null) add('filter', '前處理過濾（多介質／濾網）', 'confirm', ['未提供濁度，無法判定；請提供原水濁度與懸浮物資料'], 'assume');
    else if (raw.turb > turbLim) add('filter', '前處理過濾（多介質／濾網）', 'likely', [`濁度 ${raw.turb} NTU 超過飲用水基準 ${turbLim} NTU`], pot.src);
    else add('filter', '前處理過濾（多介質／濾網）', 'none', [`濁度 ${raw.turb} NTU ≤ ${turbLim} NTU；仍須管路入口基本濾網`], pot.src);

    /* 軟化 */
    const r1 = [];
    if (aHard) r1.push(aHard.cocMax < 1 ? `補給水硬度 ${raw.hard} mg/L 已超過所選循環水基準（不加藥無法運轉；以設計 COC ${designCOC} 計，循環水硬度 ≈ ${smartN(designCOC * raw.hard)} mg/L）` : `冷卻塔設計 COC ${designCOC} 超過硬度可達 ${fmt2(aHard.cocMax)}（硬度為限制項）`);
    else if (ctx.evaporative && raw.hard !== null && raw.hard > WQ.jra_makeup.hard) r1.push(`硬度 ${raw.hard} mg/L 高於 JRA 補給水基準 ${WQ.jra_makeup.hard}，但設計 COC 在可達範圍內`);
    const fwsHard = ex(S('fws'), ['hard']);
    if (fwsHard && fwsHard.length) r1.push('FWS 充水：' + fm(fwsHard[0]));
    add('softener', '軟水設備（離子交換）或阻垢方案', aHard || (fwsHard && fwsHard.length) ? 'likely' : (r1.length ? 'confirm' : (raw.hard === null ? 'confirm' : 'none')), r1.length ? r1 : (raw.hard === null ? ['未提供硬度'] : [`硬度 ${raw.hard} mg/L 未超過各回路基準`]), ['jra_gl02', 'ashrae_td99']);

    /* RO */
    const r2 = [];
    aSalt.forEach(a => r2.push(a.cocMax < 1 ? `${a.param} 已超過循環水基準（補給水本身超限）` : `${a.param} 限制 COC ${fmt2(a.cocMax)} < 設計 COC ${designCOC}`));
    if (aSalt.length) r2.push('氯鹽與硫酸鹽無法由軟化去除，只能 RO 或降低 COC');
    const fwsSalt = ex(S('fws'), ['cl', 'so4']); if (fwsSalt && fwsSalt.length) fwsSalt.forEach(r => r2.push('FWS 充水：' + fm(r)));
    add('ro', 'RO 逆滲透（補水或充水製備）', r2.length ? 'likely' : (aSalt.length === 0 && ctx.evaporative && raw.cl === null ? 'confirm' : 'none'), r2.length ? r2 : ['氯鹽、硫酸鹽未造成 COC 或 FWS 超標（TCS 充水另列）'], ['jra_gl02', 'ashrae_td99']);

    /* TCS 充水製備 */
    const tcs = S('tcs'); const tcsEx = tcs.exceed;
    /* 觸發條件：原水任一項超過 ASHRAE TCS 建議值（或業主 TCS 基準）→「必須編列」；使用者標示「預混冷卻液」時不適用（T-12）*/
    if (ctx.tcsPremix) add('tcs_fill', '二次側 TCS 充水製備（RO ＋ 去離子／混床 ＋ 精密過濾）', 'none',
      ['使用者標示二次側 TCS 採預混冷卻液（由廠商供應），不需現場以原水製備 RO＋去離子充水。預混液規格、稀釋或補充用水仍依 CDU／冷卻液廠商規範確認'], 'assume');
    else add('tcs_fill', '二次側 TCS 充水製備（RO ＋ 去離子／混床 ＋ 精密過濾）',
      !hasVal ? 'confirm' : (tcsEx.length ? 'required' : 'likely'),
      !hasVal ? ['未提供原水水質'] : (tcsEx.length ? [`原水對 TCS 基準超標 ${tcsEx.length} 項：` + tcsEx.slice(0, 4).map(fm).join('、')] : ['原水已符合所列 TCS 基準，仍須廠商確認冷卻液與充水規格']),
      owner && ownerL.tcs ? ['ashrae_td99', 'owner'] : ['ashrae_td99']);
    if (owner && owner.tcsFluid) add('tcs_fluid', '預混冷卻液（PG25）與 CDU 過濾', 'confirm', [owner.tcsFluid.summary || '依業主基準'], 'owner');
    else add('tcs_fluid', '預混冷卻液與 CDU 過濾', 'confirm', ['依 CDU／冷卻液廠商與空調組規範（二次側不屬給排水範圍，報價時請確認由誰供應）'], 'assume');

    /* 冷卻水加藥、排放控制、旁濾 */
    if (ctx.evaporative) {
      const over = out.cocMax !== null && designCOC > out.cocMax;
      add('chem', '冷卻水化學處理（阻垢／防蝕／殺菌）', over || aAlk ? 'required' : 'likely',
        over ? [`設計 COC ${designCOC} 高於未加藥可達 ${cocTxt(out.cocMax)}（受 ${out.governing} 限制）：不加藥基準不再適用，須由水處理廠商以加藥方案保證`] : ['JRA 基準僅適用於「不加藥」；殺菌與微生物管理為通用做法，須編列'],
        over ? ['jra_gl02'] : ['assume']);
      add('bleed', '導電度連動排放控制（自動排放閥）', 'required', [`以 COC ${designCOC} 運轉須量測導電度並自動排放`], 'epa_ct');
      add('sidestream', '旁濾系統（側流過濾）', ctx.coolType === 'open_ct' ? 'likely' : 'confirm', [ctx.coolType === 'open_ct' ? '開放式冷卻塔循環水直接接觸空氣，易累積粉塵與微生物，建議旁濾' : '是否需要旁濾由水處理廠商依場址空氣品質判定'], 'assume');
    } else add('chem', '冷卻水化學處理', 'none', ['非蒸發式散熱，無冷卻塔補水系統；封閉迴路防蝕藥劑由空調組／冷卻液廠商規範'], 'assume');

    /* 飲用水回路 */
    const pe = S('potable').exceed;
    add('potable', '飲用水回路：引入端處理', !hasVal ? 'confirm' : (pe.length ? 'likely' : 'none'),
      !hasVal ? ['未提供原水水質'] : (pe.length ? pe.map(fm).concat(['原水不符飲用水基準：洽供水單位，必要時於引入端加裝處理']) : ['原水符合飲用水基準，不需另設']), pot.src);
    if (ctx.humid > 0) add('humid', '加濕補水處理（軟化／RO）', 'confirm', [`加濕器補水 ${ctx.humid} m³/d；硬度${raw.hard === null ? '未提供' : ' ' + raw.hard + ' mg/L'}。濕膜結垢與礦物粉塵取決於設備廠商水質限值，請廠商提供並回覆是否需處理`], 'assume');
    plan.forEach(p => { p.levelText = lv[p.level]; });
    const compare = ['tw_potable', 'us_potable', 'eu_potable', 'sg_potable', 'my_potable', 'th_pwa_2024'].map(key => {
      const L = WQ[key], u = WQ.uses.find(x => x.key === key);
      const set = evalSet(L);
      return { key, label: u ? u.label : key, region: u && u.region, src: L.src, rows: set.rows, exceed: set.exceed.length, checked: set.rows.filter(r => r.ok !== null).length };
    });
    return { systems, plan, compare, hasVal, levelText: lv };
  }
  const fmt2 = x => (isFinite(x) ? Number(x).toFixed(2) : '—');
  const smartN = x => (!isFinite(x) ? '—' : Number.isInteger(x) ? String(x) : Math.abs(x) >= 100 ? Number(x).toFixed(0) : Number(x).toFixed(2));
  const cocTxt = x => (isFinite(x) ? (x < 1 ? '（補給水已超過循環水上限）' : fmt2(x)) : '—');
  const region_label = ctx => (ctx.region && ctx.region.label) || '';

  const API = { VERSION, run, U, evaluateWQ, makeParams, legacyTanks, CONST: { G, CP, GPM, PSI_M, FT } };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.AIDC_ENGINE = API;
})(typeof window !== 'undefined' ? window : globalThis);
