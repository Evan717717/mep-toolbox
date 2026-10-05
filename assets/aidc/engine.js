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
      const Hs = T.input(id + '_hs', `${nm}：靜揚程（高低差）`, U.num(z.static, 0), 'm', 'user');
      const L = T.input(id + '_l', `${nm}：管線長度`, U.num(z.length, 0), 'm', 'user');
      let res_m = U.num(z.residual, NaN);
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

    /* ──────── 7. 水質 ──────── */
    T.section('7 水質判定');
    res.wq = evaluateWQ(inp.wq || {}, region, P, used, evaporative ? U.num(c.coc, 3) : null, T, owner);

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

  /* ═════════════ 水質：補給水適用性與可達濃縮倍數 ═════════════ */
  function evaluateWQ(w, region, P, used, designCOC, T, owner) {
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
    return out;
  }

  const API = { VERSION, run, U, evaluateWQ, makeParams, CONST: { G, CP, GPM, PSI_M, FT } };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.AIDC_ENGINE = API;
})(typeof window !== 'undefined' ? window : globalThis);
