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
    num(x, d) { const n = Number(x); return isFinite(n) ? n : d; },
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
    let domRaw = 0, V, Vd;
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
      const m = P('designMargin');
      T.input('margin', '設計裕度', m, '—', used.designMargin.src);
      Vd = T.step('Vd', '一日設計用水量 Vd', V * m, 'm³/d', { f: 'Vd = V × 設計裕度', sub: `${f2(V)} × ${m}`, src: used.designMargin.src, xl: '={V}*{margin}' });
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
      const qsvc = T.step('svc_q', '進水管設計流量', qpDom + coolMaxHour * 1000 / 60, 'L/min',
        { f: '= 生活尖峰 Qp + 空調補水最大時流量', sub: `${f2(qpDom, 1)} + ${f2(coolMaxHour)}×1000/60`, src: 'phys', xl: '={qp_dom}+{hvac_maxh}*1000/60' });
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
    T.step('vd_dom', '一日設計用水量—生活分量', Vd * shareDom, 'm³/d', { f: 'Vd × 生活占比', sub: `${f2(Vd)} × ${f2(shareDom, 4)}`, src: 'phys', xl: '=IF(({dom_raw}+{proc_raw})>0,{Vd}*{dom_raw}/({dom_raw}+{proc_raw}),{Vd})' });
    T.step('vd_cool', '一日設計用水量—空調分量', Vd * (1 - shareDom), 'm³/d', { f: 'Vd − 生活分量', sub: '', src: 'phys', xl: '={Vd}-{vd_dom}' });
    const vdDom = Vd * shareDom, vdCool = Vd * (1 - shareDom);
    const domH = P('domHours'), coolH = evaporative ? P('coolHours') : P('domHours');
    T.input('h_dom', '生活用水備援時數', domH, 'h', used.domHours.src, used.domHours.note);
    T.input('h_cool', '空調補水備援時數', coolH, 'h', evaporative ? used.coolHours.src : used.domHours.src,
      evaporative ? used.coolHours.note : '非蒸發式散熱，比照生活用水');
    const needDom = T.step('need_dom', '生活儲水需求（備援）', vdDom * domH / 24, 'm³', { f: '生活分量 × 時數 ÷ 24', sub: `${f2(vdDom)} × ${domH} ÷ 24`, src: 'phys', xl: '={vd_dom}*{h_dom}/24' });
    const needCool = T.step('need_cool', '空調儲水需求（備援）', vdCool * coolH / 24, 'm³', { f: '空調分量 × 時數 ÷ 24', sub: `${f2(vdCool)} × ${coolH} ÷ 24`, src: 'phys', xl: '={vd_cool}*{h_cool}/24' });
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
    T.input('n_cell', '每類水池分格數', n, '格', used.compartments.src, used.compartments.note);
    const domStore = T.step('st_dom', '生活儲水 採用', Math.max(needDom, codeTot * shareDom), 'm³',
      { f: 'max(備援需求, 法規合計下限 × 生活占比)', sub: `max(${f2(needDom)}, ${f2(codeTot * shareDom)})`, src: 'phys', xl: '=MAX({need_dom},{tot_min}*{vd_dom}/MAX({Vd},1E-9))' });
    const coolStore = T.step('st_cool', '空調儲水（Break tank）採用', Math.max(needCool, codeTot * (1 - shareDom)), 'm³',
      { f: 'max(備援需求, 法規合計下限 × 空調占比)', sub: `max(${f2(needCool)}, ${f2(codeTot * (1 - shareDom))})`, src: 'phys', xl: '=MAX({need_cool},{tot_min}*{vd_cool}/MAX({Vd},1E-9))' });
    const cellDom = T.step('cell_dom', '生活水池 每格容量', U.ceilTo(domStore / n, 1), 'm³', { f: '⌈採用量 ÷ 格數⌉（取整至 1 m³）', sub: `${f2(domStore)} ÷ ${n}`, src: 'phys', xl: '=CEILING({st_dom}/{n_cell},1)' });
    const cellCool = T.step('cell_cool', '空調水池 每格容量', U.ceilTo(coolStore / n, 1), 'm³', { f: '⌈採用量 ÷ 格數⌉', sub: `${f2(coolStore)} ÷ ${n}`, src: 'phys', xl: '=CEILING({st_cool}/{n_cell},1)' });
    const fire = T.input('fire', '消防水源（消防組提供，獨立水池）', U.num(inp.fireVolume, 0), 'm³', 'fire');
    const totalStore = T.step('st_total', '全廠儲水合計（不含消防）', (cellDom + cellCool) * n, 'm³', { f: '(生活每格 + 空調每格) × 格數', sub: `(${cellDom} + ${cellCool}) × ${n}`, src: 'phys', xl: '=({cell_dom}+{cell_cool})*{n_cell}' });
    T.step('st_days', '可支應天數', Vd > 0 ? totalStore / Vd : NaN, 'd', { f: '合計 ÷ Vd', sub: `${f2(totalStore)} ÷ ${f2(Vd)}`, src: 'phys', xl: '={st_total}/{Vd}' });
    res.storage = { domStore, coolStore, cellDom, cellCool, n, total: totalStore, fire, needDom, needCool, codeTot };

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
    const ng = (inp.net && inp.net.enable !== false) ? (() => { const nt = inp.net; const N = Math.max(1, Math.min(60, Math.round(U.num(nt.floors, 4)))), fh = U.num(nt.floorH, 5), th = U.num(nt.termH, 1.2); return { N, zTank: -U.num(nt.basement, 6), zTm: k => (k - 1) * fh + th, zRoof: N * fh }; })() : null;
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
      } else {
        Qlpm = T.input(id + '_q', `${nm}：設計流量（使用者輸入）`, U.num(z.qLpm, 0), 'L/min', 'user');
      }
      const hsBlank = z.static === null || z.static === undefined || z.static === '';
      const autoHs = (hsBlank && ng) ? (z.kind === 'hvac' ? ng.zRoof - ng.zTank : z.kind === 'domestic' ? ng.zTm(ng.N) - ng.zTank : null) : null;
      const Hs = autoHs !== null
        ? T.step(id + '_hs', `${nm}：靜揚程（高低差，由系統昇位自動帶入）`, autoHs, 'm', { f: z.kind === 'hvac' ? '= 屋頂補水點標高 − 泵房底標高' : '= 頂層末端標高 − 泵房底標高', sub: z.kind === 'hvac' ? `${ng.zRoof} − (${ng.zTank})` : `${ng.zTm(ng.N)} − (${ng.zTank})`, src: 'phys', note: '於「6c 系統昇位與管徑」設定樓層高度；也可在泵組表直接輸入靜揚程覆蓋' })
        : T.input(id + '_hs', `${nm}：靜揚程（高低差）`, U.num(z.static, 0), 'm', 'user');
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
      res.net = buildNet(inp, { T, P, used, region, cat, qpDom, coolMaxHour, Vd, res, vmax, gradMax, C, fit, pmax, resGen, resFV, flushValveSys, dom });
    }

    /* ──────── 7. 水質 ──────── */
    T.section('7 水質判定');
    res.wq = evaluateWQ(inp.wq || {}, region, P, used, evaporative ? U.num(c.coc, 3) : null, T, owner, { evaporative, coolType: c.type, humid: U.num(c.humidDaily, 0), region });

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
    const N = Math.max(1, Math.min(60, Math.round(U.num(nt.floors, 4))));
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
      : seg({ id: 'S1', name: '市水引入管', kind: 'service', from: '市水主管／水表', to: '受水池', Q: qSvc, L: lenMain, z0: 0, z1: zTank, basis: '生活尖峰 + 空調補水最大時；流速／梯度雙條件' });
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
    if (hvP && hvP.Qlpm > 0 && nt.roofHvac !== false) {
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
    return { N, floorH, basement, termH, zTank, zRoof, segs, profile, check: chk, hunter: hunterSys, cat: cat.label, catSrc: cat.src, vmax, gradMax, C, fit, roofHvac: !!segs.find(s => s.id === 'H1'),
      pumpNames: pumps.map(p => p.name), hasDomPump: !!domP };
  }

  /* ═════════════ 水質：補給水適用性與可達濃縮倍數 ═════════════ */
  function evaluateWQ(w, region, P, used, designCOC, T, owner, ctx) {
    ctx = ctx || {};
    const out = { items: [], cocMax: null, governing: null, actions: [] };
    const val = k => (w[k] === null || w[k] === undefined || w[k] === '' ? null : Number(w[k]));
    let ec = val('ec'); let ecEst = false;
    if (ec === null && val('tds') !== null) { ec = U.ecFromTds(val('tds')); ecEst = true; }
    const potKey = P('potable'); const pot = WQ[potKey] || WQ.tw_potable;
    const mk = WQ.jra_makeup, cc = WQ.jra_circ;
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
    if (isFinite(cocMin)) { out.cocMax = cocMin; out.governing = gov && gov.label; }
    if (ecEst) T.check('info', '導電度未提供，依 TDS ÷ 0.65 估算（經驗換算，實際比值 0.55~0.75 視離子組成）。', 'assume');
    out.items.forEach(it => {
      if (it.potOk === false) T.check('warn', `${it.label} ${it.v} ${it.unit} 超出飲用水標準 ${it.potLimit}：原水不符飲用水標準，請洽供水單位。`, pot.src);
    });
    if (designCOC && out.cocMax !== null) {
      T.step('wq_cocmax', '未加藥可達最大濃縮倍數（受 ' + out.governing + ' 控制）', out.cocMax, '—',
        { f: 'COCmax = min(循環水上限 ÷ 補給水濃度)', sub: out.items.filter(i => i.cocMax).map(i => `${i.label}: ${f2(i.cocMax)}`).join('；'), src: 'jra_gl02' });
      if (designCOC > out.cocMax) {
        T.check('warn', `設計 COC ${designCOC} 大於未加藥可達的 ${f2(out.cocMax)}（受 ${out.governing} 控制）：必須搭配水處理方案（阻垢／防蝕藥劑、軟化或 RO），否則需降低 COC、排放量增加。`, 'jra_gl02');
        out.items.filter(i => i.cocMax && i.cocMax < designCOC).forEach(i => {
          const act = { hard: '軟水器（離子交換）或阻垢劑', alk: '加酸控制鹼度或阻垢劑', cl: 'RO 或降低 COC（氯鹽不能被軟化去除）', so4: 'RO 或降低 COC', ec: '降低 COC 或 RO', sio2: '降低 COC（矽垢難以藥劑控制）' }[i.k];
          if (act) out.actions.push({ param: i.label, cocMax: i.cocMax, action: act });
        });
      } else {
        T.check('pass', `設計 COC ${designCOC} ≤ 未加藥可達 ${f2(out.cocMax)}，以補給水水質而言可行。`, 'jra_gl02');
      }
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
    if (aHard) r1.push(`冷卻塔設計 COC ${designCOC} 超過硬度可達 ${fmt2(aHard.cocMax)}（硬度為限制項）`);
    else if (ctx.evaporative && raw.hard !== null && raw.hard > WQ.jra_makeup.hard) r1.push(`硬度 ${raw.hard} mg/L 高於 JRA 補給水基準 ${WQ.jra_makeup.hard}，但設計 COC 在可達範圍內`);
    const fwsHard = ex(S('fws'), ['hard']);
    if (fwsHard && fwsHard.length) r1.push('FWS 充水：' + fm(fwsHard[0]));
    add('softener', '軟水設備（離子交換）或阻垢方案', aHard || (fwsHard && fwsHard.length) ? 'likely' : (r1.length ? 'confirm' : (raw.hard === null ? 'confirm' : 'none')), r1.length ? r1 : (raw.hard === null ? ['未提供硬度'] : [`硬度 ${raw.hard} mg/L 未超過各回路基準`]), ['jra_gl02', 'ashrae_td99']);

    /* RO */
    const r2 = [];
    aSalt.forEach(a => r2.push(`${a.param} 限制 COC ${fmt2(a.cocMax)} < 設計 COC ${designCOC}`));
    if (aSalt.length) r2.push('氯鹽與硫酸鹽無法由軟化去除，只能 RO 或降低 COC');
    const fwsSalt = ex(S('fws'), ['cl', 'so4']); if (fwsSalt && fwsSalt.length) fwsSalt.forEach(r => r2.push('FWS 充水：' + fm(r)));
    add('ro', 'RO 逆滲透（補水或充水製備）', r2.length ? 'likely' : (aSalt.length === 0 && ctx.evaporative && raw.cl === null ? 'confirm' : 'none'), r2.length ? r2 : ['氯鹽、硫酸鹽未造成 COC 或 FWS 超標（TCS 充水另列）'], ['jra_gl02', 'ashrae_td99']);

    /* TCS 充水製備 */
    const tcs = S('tcs'); const tcsEx = tcs.exceed;
    add('tcs_fill', '二次側 TCS 充水製備（RO ＋ 去離子／混床 ＋ 精密過濾）',
      !hasVal ? 'confirm' : (tcsEx.length ? 'required' : 'likely'),
      !hasVal ? ['未提供原水水質'] : (tcsEx.length ? [`原水對 TCS 基準超標 ${tcsEx.length} 項：` + tcsEx.slice(0, 4).map(fm).join('、')] : ['原水已符合所列 TCS 基準，仍須廠商確認冷卻液與充水規格']),
      owner && ownerL.tcs ? ['ashrae_td99', 'owner'] : ['ashrae_td99']);
    if (owner && owner.tcsFluid) add('tcs_fluid', '預混冷卻液（PG25）與 CDU 過濾', 'confirm', [owner.tcsFluid.summary || '依業主基準'], 'owner');
    else add('tcs_fluid', '預混冷卻液與 CDU 過濾', 'confirm', ['依 CDU／冷卻液廠商與空調組規範（二次側不屬給排水範圍，報價時請確認由誰供應）'], 'assume');

    /* 冷卻水加藥、排放控制、旁濾 */
    if (ctx.evaporative) {
      const over = out.cocMax !== null && designCOC > out.cocMax;
      add('chem', '冷卻水化學處理（阻垢／防蝕／殺菌）', over || aAlk ? 'required' : 'likely',
        over ? [`設計 COC ${designCOC} 高於未加藥可達 ${fmt2(out.cocMax)}（受 ${out.governing} 限制）：JRA-GL02 基準不再適用，須由水處理廠商以加藥方案保證`] : ['JRA 基準僅適用於「不加藥」；殺菌與微生物管理為通用做法，須編列'],
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
    const compare = ['tw_potable', 'us_potable', 'eu_potable', 'sg_potable', 'my_potable', 'th_potable'].map(key => {
      const L = WQ[key], u = WQ.uses.find(x => x.key === key);
      const set = evalSet(L);
      return { key, label: u ? u.label : key, region: u && u.region, src: L.src, rows: set.rows, exceed: set.exceed.length, checked: set.rows.filter(r => r.ok !== null).length };
    });
    return { systems, plan, compare, hasVal, levelText: lv };
  }
  const fmt2 = x => (isFinite(x) ? Number(x).toFixed(2) : '—');
  const region_label = ctx => (ctx.region && ctx.region.label) || '';

  const API = { VERSION, run, U, evaluateWQ, makeParams, CONST: { G, CP, GPM, PSI_M, FT } };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.AIDC_ENGINE = API;
})(typeof window !== 'undefined' ? window : globalThis);
