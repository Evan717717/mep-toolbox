/**
 * 計算驗證 — 用 jsdom 真的把四支工具跑起來，對純計算層 CALC 做數值驗證。
 *
 *   npm install jsdom     （只有跑測試需要，工具本身不依賴任何套件）
 *   node tests/verify.js
 *
 * 回歸基準：龍慶 27MW 案送審文件
 *   MIC-VB-WS-CAL-0001 水理計算書 B 版（2026/07/17）
 *   MIC-VB-WS-DWG-0003 用水平衡圖 A 版（2026/07/31）
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const failures = [];

function load(tool, hash) {
  const file = path.join(ROOT, 'tools', tool, 'index.html');
  const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
    runScripts: 'dangerously',
    url: 'https://example.test/tools/' + tool + '/' + (hash || ''),
    pretendToBeVisual: true,
  });
  return dom.window;
}

/* 在 jsdom 裡模擬真人輸入：設值後派送 input 事件（不是直接改 state） */
function type(win, id, value) {
  const el = win.document.getElementById(id);
  if (!el) throw new Error('找不到輸入欄位 #' + id);
  el.value = value;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  return el;
}
function blur(win, id) {
  const el = win.document.getElementById(id);
  el.dispatchEvent(new win.Event('blur', { bubbles: true }));
  return el;
}
function txt(win, id) {
  const el = win.document.getElementById(id);
  return el ? el.textContent : null;
}

function near(name, got, want, tol) {
  const ok = Number.isFinite(got) && Math.abs(got - want) <= tol;
  if (ok) { pass++; }
  else { fail++; failures.push(`${name}\n    got  ${got}\n    want ${want} ± ${tol}`); }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${typeof got === 'number' ? got.toPrecision(8) : got}`);
}
function is(name, got, want) {
  const ok = got === want;
  if (ok) { pass++; } else { fail++; failures.push(`${name}\n    got  ${got}\n    want ${want}`); }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${got}`);
}
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 62 - t.length))); }

/* ══════════════════════════════════════════════════════════════════════
   HYD-03 給水 — 逐格重現 MIC-VB-WS-CAL-0001
   ══════════════════════════════════════════════════════════════════════ */
section('HYD-03 給水：重現送審計算書 MIC-VB-WS-CAL-0001 B 版');
{
  const w = load('water-supply-demand');
  const C = w.CALC;

  // 台水表：辦公室 663.64 × 0.6 × 0.2 × 100/1000 = 7.96 M³/日
  near('V2\' 辦公室 663.64 m²', C.v2Row({ area: 663.64, eff: 0.6, density: 0.2, unit: 0.1 }), 7.96, 0.005);

  // 送審模式：(7.96 + 443.52) × 0.9 = 406.33（計算書印 406.34，差在小計取位）
  const st = {
    mode: 'submit', v1: { studio: 0, house: 0, villa: 0, unit: 250 },
    v2rows: [{ area: 663.64, eff: 0.6, density: 0.2, unit: 0.1 }],
    v2adj: 0.9, vProcess: 443.52,
  };
  const T = C.totals(st);
  near('小計 ΣV2\' + V製程 = 451.48', T.sub + st.vProcess, 451.48, 0.01);
  near('V = 小計 × 0.9 = 406.34', T.V, 406.34, 0.02);

  const Vd = T.V * 1.1;
  near('Vd = V × 1.1 = 446.97', Vd, 446.97, 0.03);
  is('安全係數自動帶入（V > 68.5 → 1.1）', C.autoSafety(T.V), 1.1);
  is('安全係數級距 V=10 → 1.5', C.autoSafety(10), 1.5);
  is('安全係數級距 V=20 → 1.4', C.autoSafety(20), 1.4);
  is('安全係數級距 V=50 → 1.2', C.autoSafety(50), 1.2);

  // Di = 4.59√Vd = 97 mm；係數由流速 0.7 m/s 反推應為 4.588
  near('Di 係數（υ=0.7 m/s）≈ 4.59', C.diCoef(0.7), 4.588, 0.005);
  near('Di = 97 mm', C.di(Vd, 0.7), 97, 0.3);

  // Dp = 6.65√Vd = 140.59 mm；係數由 t=30min、υ=1.6 反推應為 6.649
  near('Dp 係數（t=30min, υ=1.6）≈ 6.65', C.dpCoef(1.6, 1800), 6.649, 0.005);
  near('Dp = 140.59 mm', C.dp(Vd, 1.6, 1800), 140.59, 0.3);

  // 蓄水池
  near('VG 下限 20%Vd = 89.39', Vd * 0.2, 89.39, 0.02);
  near('VG+VT 下限 300%Vd = 1340.91', Vd * 3, 1340.91, 0.05);

  // ── 揚程：2026-08 稽核前的版本在此有量綱錯誤 ──
  const hp = { building: 10.9, L: 12, Dmm: 150, V: 1.6, f: 0.02, hammer: 0.34, minorK: 0, htMode: 'official' };
  const H = C.head(hp);
  near('Hs = 0.5·V²/2g = 0.0653', H.Hs, 0.0653, 0.0002);
  near('Hd = 10.9 + Hs = 10.9653', H.Hd, 10.9653, 0.0002);
  near('Ht = 0.02·(L/D_公尺)·V/2g = 0.1305  ← 以 mm 代入會得 0.00013，少 1000 倍',
       H.Ht, 0.1305, 0.0005);
  near('Hw = (Hs+Hd+Ht)×0.34 = 3.7948', H.Hw, 3.7948, 0.001);
  near('H 總揚程 = 14.9559', H.H, 14.9559, 0.002);

  // 保留錯誤值的對照，確認這個量綱缺陷不會再回來
  const wrongHt = 0.02 * (12 / 150) * 1.6 / (2 * 9.8);
  near('（對照）以 mm 代入的錯誤值 ≈ 0.000131', wrongHt, 0.000131, 1e-6);
  is('正確值/錯誤值 比值 ≈ 1000', Math.round(H.Ht / wrongHt), 1000);

  // Darcy–Weisbach 對照：Ht = f·(L/D)·V²/2g
  const Hd2 = C.head(Object.assign({}, hp, { htMode: 'darcy' }));
  near('Darcy Ht = 0.02·80·1.6²/19.6 = 0.2090', Hd2.Ht, 0.2090, 0.001);

  // 泵浦：Q 由 D=150mm、V=1.6 m/s 得 0.028274 m³/s
  const A = C.areaFromD(150);
  near('A(150mm) = 0.0176715 m²', A, 0.0176715, 1e-6);
  const Q = A * 1.6;
  near('Q = A·V = 0.0282743 m³/s = 1696.5 L/min', Q * 60000, 1696.5, 0.5);
  near('P = 1000·Q·H/(75×0.6)×1.1 = 10.34 PS', C.pumpPS(Q, H.H, 0.6, 1.1), 10.34, 0.02);

  // 冷卻水塔：用水平衡圖 443.5 = 335 蒸發 + 108.5 排放 → COC = 4.087
  const ct = C.cooling({ E: 335, COC: 4.087, circ: 0, driftPct: 0.01, convention: 'A' });
  near('BD = E/(COC−1) = 108.5', ct.BD, 108.5, 0.15);
  near('Makeup = E + BD = 443.5（與用水平衡圖一致）', ct.Makeup, 443.5, 0.15);

  // 保守模式與送審模式的差異必須是可預期的
  const T2 = C.totals(Object.assign({}, st, { mode: 'strict' }));
  near('保守模式 V = 7.96×0.9 + 443.52 = 450.68', T2.V, 450.68, 0.02);
  near('兩模式差異 = V製程×(1−0.9) = 44.35', T2.V - T.V, 44.352, 0.02);
}

/* ══════════════════════════════════════════════════════════════════════
   HYD-01 Manning
   ══════════════════════════════════════════════════════════════════════ */
section('HYD-01 Manning：幾何式、互解一致性、多重根');
{
  const w = load('manning-calculator');
  const C = w.CALC;

  // 滿管幾何解析解：R = D/4，A = πD²/4
  near('滿管 R/D = 0.25', C.shapeF(1.0), 0.25, 1e-9);
  near('滿管 A/D² = π/4 = 0.785398', C.shapeG(1.0), Math.PI / 4, 1e-9);
  // 半滿：R = D/4（與滿管相同，經典結果），A = πD²/8
  near('半滿 R/D = 0.25', C.shapeF(0.5), 0.25, 1e-9);
  near('半滿 A/D² = π/8 = 0.392699', C.shapeG(0.5), Math.PI / 8, 1e-9);

  // 教科書經典比值
  const solV = C.solveR(Infinity, false, 0.3, 0.013, 0.01);
  const solQ = C.solveR(Infinity, true, 0.3, 0.013, 0.01);
  const Vfull = C.V(0.3, 1, 0.013, 0.01), Qfull = C.Q(0.3, 1, 0.013, 0.01);
  near('V_max 發生在 r ≈ 0.813', solV.peakR, 0.8128, 0.003);
  near('V_max / V_full ≈ 1.140', solV.peakV / Vfull, 1.1396, 0.002);
  near('Q_max 發生在 r ≈ 0.938', solQ.peakR, 0.9381, 0.003);
  near('Q_max / Q_full ≈ 1.076', solQ.peakV / Qfull, 1.0757, 0.002);

  // 互解一致性：V → D → V 應回到原值
  const n = 0.010, S = 1 / 100, r = 0.5;
  const V0 = C.V(0.1, r, n, S);
  const Dback = C.dFromV(V0, n, S, r);
  near('D 反解一致性（V→D→D=0.1 m）', Dback, 0.1, 1e-9);
  const Q0 = C.Q(0.1, r, n, S);
  near('D 反解一致性（Q→D→D=0.1 m）', C.dFromQ(Q0, n, S, r), 0.1, 1e-9);
  near('S 反解一致性', C.sFromV(V0, 0.1, r, n), S, 1e-12);
  near('n 反解一致性', C.nFromV(V0, 0.1, r, S), n, 1e-12);

  // 100mm PVC、坡度 1/100、半滿 的實際數字
  near('V(100mm, PVC, 1/100, 50%) = 0.8550 m/s', V0, 0.85499, 0.0001);
  near('Q(100mm, PVC, 1/100, 50%) = 3.358 L/s', Q0 * 1000, 3.35753, 0.0005);

  // ── 多重根：假設單調的二分法在此會誤判 ──
  // 取一個介於 Q_full 與 Q_max 之間的目標流量，理論上有兩個解
  const Dm = 0.3, nn = 0.013, SS = 0.01;
  const qFull = C.Q(Dm, 1, nn, SS), qMax = C.solveR(Infinity, true, Dm, nn, SS).peakV;
  const qTarget = (qFull + qMax) / 2;
  const sol = C.solveR(qTarget, true, Dm, nn, SS);
  is('Q 介於 Q_full 與 Q_max 之間時應找到 2 個解', sol.roots.length, 2);
  if (sol.roots.length === 2) {
    near('  第 1 個根重現目標 Q', C.Q(Dm, sol.roots[0], nn, SS), qTarget, qTarget * 1e-6);
    near('  第 2 個根重現目標 Q', C.Q(Dm, sol.roots[1], nn, SS), qTarget, qTarget * 1e-6);
    is('  兩根分別落在 Q_max 兩側', sol.roots[0] < 0.9381 && sol.roots[1] > 0.9381, true);
  }
  // 超過 Q_max 才是真的無解
  is('Q 超過 Q_max 時應為無解', C.solveR(qMax * 1.05, true, Dm, nn, SS).roots.length, 0);
}

/* ══════════════════════════════════════════════════════════════════════
   HYD-01 通用斷面 — 矩形明溝 / 梯形溝
   幾何來源：Chow, V.T. (1959) Open-Channel Hydraulics, Table 2-1
   實案回歸：基地周界排水暗溝 建築圖說 A7-15，B 版 450 mm → C 版 660 mm
   ══════════════════════════════════════════════════════════════════════ */
section('HYD-01 通用斷面：矩形／梯形幾何、退化交叉驗證、實案回歸');
{
  const w = load('manning-calculator');
  const C = w.CALC;
  const g = 9.81;

  // ── 矩形幾何解析解：b=450mm、H=600mm、y=400mm（r = 400/600） ──
  const RECT = { b: 450, H: 600 };
  const r23 = 400 / 600;
  const gr = C.geomOf('rect', RECT, r23);
  near('矩形 A = b·y = 0.45 × 0.40 = 0.18 m²', gr.A, 0.18, 1e-12);
  near('矩形 P = b + 2y = 0.45 + 0.80 = 1.25 m（水面不計濕周）', gr.P, 1.25, 1e-12);
  near('矩形 R = A/P = 0.144 m', gr.R, 0.144, 1e-12);
  near('矩形 T = b = 0.45 m', gr.T, 0.45, 1e-12);
  near('矩形 y = 0.40 m', gr.y, 0.40, 1e-12);

  // ── 實案回歸：n=0.015（混凝土浮平）、坡度 1/200 ──
  const nC = 0.015, sC = 1 / 200;
  const V450 = C.Vof('rect', RECT, r23, nC, sC);
  const Q450 = C.Qof('rect', RECT, r23, nC, sC) * 1000;
  near('B 版 450 mm：V = (1/0.015)·0.144^(2/3)·0.005^(1/2) = 1.29510 m/s', V450, 1.2950963, 1e-6);
  near('B 版 450 mm：Q = 233.12 L/s（與人工驗算的「約 233 L/s」一致）', Q450, 233.1173, 1e-3);

  const RECT2 = { b: 660, H: 600 };
  const Q660 = C.Qof('rect', RECT2, r23, nC, sC) * 1000;
  near('C 版 660 mm：Q = 397.95 L/s', Q660, 397.9529, 1e-3);
  near('C 版 / B 版 通水量提升 ≈ 71%', (Q660 / Q450 - 1) * 100, 70.7, 0.6);

  // ── 退化交叉驗證：梯形 z=0 必須逐點等於矩形 ──
  // 這是兩段獨立實作（(b+zy)y vs b·y、b+2y√(1+z²) vs b+2y）的相互驗證
  let maxDiff = 0;
  for (let i = 1; i <= 20; i++) {
    const rr = i / 20;
    const a = C.geomOf('rect', { b: 800, H: 500 }, rr);
    const t = C.geomOf('trap', { b: 800, H: 500, z: 0 }, rr);
    maxDiff = Math.max(maxDiff, Math.abs(a.A - t.A), Math.abs(a.P - t.P), Math.abs(a.R - t.R), Math.abs(a.T - t.T));
  }
  near('梯形 z=0 逐點退化成矩形（20 個水深，A/P/R/T 最大差異）', maxDiff, 0, 1e-12);

  // ── 梯形幾何解析解：b=1000mm、H=1000mm、z=1、y=500mm ──
  const gt = C.geomOf('trap', { b: 1000, H: 1000, z: 1 }, 0.5);
  near('梯形 A = (b+zy)y = (1.0+0.5)×0.5 = 0.75 m²', gt.A, 0.75, 1e-12);
  near('梯形 P = b + 2y√(1+z²) = 1 + 1·√2 = 2.41421 m', gt.P, 1 + Math.SQRT2, 1e-12);
  near('梯形 T = b + 2zy = 1 + 1 = 2.0 m', gt.T, 2.0, 1e-12);
  near('梯形 R = A/P = 0.310660 m', gt.R, 0.75 / (1 + Math.SQRT2), 1e-12);

  // 三角形（b=0）：A = z·y²、P = 2y√(1+z²)
  const gv = C.geomOf('trap', { b: 0, H: 1000, z: 1 }, 1.0);
  near('三角形 A = z·y² = 1.0 m²', gv.A, 1.0, 1e-12);
  near('三角形 P = 2y√2 = 2.82843 m', gv.P, 2 * Math.SQRT2, 1e-12);

  // ── 極寬矩形：R → y（水力學標準近似，寬深比 >10 時常直接以 y 代 R） ──
  const gw = C.geomOf('rect', { b: 1e7, H: 1000 }, 1.0);
  near('極寬矩形 R → y = 1.0 m（誤差 < 0.1%）', gw.R, 1.0, 1e-3);

  // ── 有頂版（箱涵）滿水時，頂版計入濕周 ──
  const open = C.geomOf('rect', { b: 500, H: 500, capped: false }, 1.0);
  const cap = C.geomOf('rect', { b: 500, H: 500, capped: true }, 1.0);
  near('明溝滿水 P = b + 2H = 1.5 m', open.P, 1.5, 1e-12);
  near('箱涵滿水 P = 2(b+H) = 2.0 m', cap.P, 2.0, 1e-12);
  is('箱涵滿水無自由水面 → T = 0', cap.T, 0);
  near('兩者 A 相同 = 0.25 m²', cap.A - open.A, 0, 1e-12);

  // ── 福祿數：矩形臨界水深 y_c = (q²/g)^(1/3) 處 Fr 必須等於 1 ──
  // 這是完全獨立於 Manning 的檢查，驗的是 Fr = V/√(gA/T) 這條式子本身
  [0.25, 0.5, 1.0, 2.0].forEach(qUnit => {
    const yc = Math.cbrt(qUnit * qUnit / g);          // 單寬流量 qUnit m³/s/m
    const bb = 1000, HH = 2000;                        // b = 1 m、H = 2 m
    const gg = C.geomOf('rect', { b: bb, H: HH }, yc / (HH / 1000));
    const Vc = (qUnit * (bb / 1000)) / gg.A;           // Q = q·b
    near(`臨界水深 q=${qUnit}：Fr(y_c) = 1`, C.froude(Vc, gg.A, gg.T), 1.0, 1e-9);
  });
  is('無自由水面時 Fr 不適用（回 NaN）', Number.isNaN(C.froude(1.0, 0.25, 0)), true);

  // ── 求解器：尺寸 ──
  // (a) 圓管用通用數值解，必須與封閉解析式 dFromQ / dFromV 完全吻合
  {
    const n2 = 0.013, S2 = 1 / 150, rr = 0.7, Qt = 0.08, Vt = 1.1;
    const anaQ = C.dFromQ(Qt, n2, S2, rr) * 1000;
    const numQ = C.solveSize('circle', { D: 100 }, rr, n2, S2, Qt, true);
    near('圓管尺寸解：數值解 vs 解析式 dFromQ', numQ.size, anaQ, 1e-6);
    const anaV = C.dFromV(Vt, n2, S2, rr) * 1000;
    const numV = C.solveSize('circle', { D: 100 }, rr, n2, S2, Vt, false);
    near('圓管尺寸解：數值解 vs 解析式 dFromV', numV.size, anaV, 1e-6);
  }
  // (b) 矩形解溝寬：解出來的 b 代回去必須重現目標 Q
  {
    const target = 0.40;                               // 400 L/s
    const sol = C.solveSize('rect', RECT, r23, nC, sC, target, true);
    is('矩形解溝寬有解', sol.ok, true);
    near('  解出的 b ≈ 664 mm（對應 C 版 660 mm 的量級）', sol.size, 664, 3);
    near('  代回去重現目標 Q = 0.40 m³/s',
         C.Qof('rect', { b: sol.size, H: RECT.H }, r23, nC, sC), target, target * 1e-9);
  }
  // (c) 矩形解溝寬（目標為流速）：R 最多趨近水深，流速有上限，超過上限應回無解
  {
    const yM = 0.4;                                    // 水深 0.4 m
    const vCeil = (1 / nC) * Math.pow(yM, 2 / 3) * Math.sqrt(sC);
    near('矩形流速上限（b→∞ 時 R→y）= (1/n)·y^(2/3)·√S = 2.55918 m/s', vCeil, 2.5591775, 1e-6);
    const bad = C.solveSize('rect', RECT, r23, nC, sC, vCeil * 1.05, false);
    is('目標流速超過上限時回報無解', bad.ok, false);
    near('  且回報的上限值正確', bad.ceiling, vCeil, 1e-3);
    const good = C.solveSize('rect', RECT, r23, nC, sC, vCeil * 0.9, false);
    is('目標流速在上限內時有解', good.ok, true);
  }

  // ── 求解器：水深 ──
  // 矩形明溝的 Q(y) 單調遞增 → 恰好一個解（圓管才會有兩個）
  {
    const sol = C.solveDepth('rect', RECT, nC, sC, 0.2331, true);
    is('矩形解水深：單調遞增 → 恰好 1 個解', sol.roots.length, 1);
    near('  解出的水深 = 400 mm', sol.roots[0] * RECT.H, 400, 0.3);
    near('  代回去重現目標 Q', C.Qof('rect', RECT, sol.roots[0], nC, sC), 0.2331, 1e-6);
    // 明溝的最大通水量必然發生在滿水（r=1），不像圓管在 r≈0.938
    near('  矩形 Q 的極大值發生在滿水 r = 1', sol.peakR, 1.0, 0.002);
    const over = C.solveDepth('rect', RECT, nC, sC, sol.peakV * 1.05, true);
    is('目標流量超過滿水容量時回報無解', over.roots.length, 0);
  }

  // ── 坡度／粗糙係數的反解與斷面形狀無關，三種斷面都要能往返 ──
  [['circle', { D: 300 }, 0.6], ['rect', { b: 600, H: 800 }, 0.5], ['trap', { b: 600, H: 800, z: 1.5 }, 0.5]]
    .forEach(([sh, dm, rr]) => {
      const nX = 0.017, sX = 1 / 250;
      const gX = C.geomOf(sh, dm, rr);
      const vX = C.Vof(sh, dm, rr, nX, sX);
      near(`${sh} S 反解一致性`, C.sFromR(vX, gX.R, nX), sX, 1e-12);
      near(`${sh} n 反解一致性`, C.nFromR(vX, gX.R, sX), nX, 1e-12);
      near(`${sh} Q = A·V 自洽`, C.Qof(sh, dm, rr, nX, sX), gX.A * vX, 1e-15);
    });

  // ── Manning 本體的單位自檢：R=1 m、S=1、n=1 → V=1 m/s ──
  // 用極寬矩形逼近 R=1：b=1e7 mm、H=1000 mm、滿水
  near('Manning 單位自檢 V(R≈1, S=1, n=1) = 1 m/s',
       C.Vof('rect', { b: 1e7, H: 1000 }, 1.0, 1, 1), 1.0, 1e-3);
}

/* ══════════════════════════════════════════════════════════════════════
   HYD-01 有頂版斷面與求解器的邊界行為
   （這一節每一項都對應一個實際發生過的缺陷，改動求解器前先看這裡）
   ══════════════════════════════════════════════════════════════════════ */
section('HYD-01 邊界行為：頂版不連續、退化尺寸解、夾限一致性');
{
  const w = load('manning-calculator');
  const C = w.CALC;
  const BOX = { b: 450, H: 600, capped: true };
  const OPEN = { b: 450, H: 600, capped: false };
  const nC = 0.015, sC = 1 / 200;

  // 有頂版時 geom 在 r=1 不連續：Q 會「掉下來」而不是繼續上升
  const qJustFull = C.Qof('rect', BOX, 1 - 1e-9, nC, sC) * 1000;
  const qPressed = C.Qof('rect', BOX, 1, nC, sC) * 1000;
  is('箱涵：頂版計入濕周後通水量反而下降（幾何不連續確實存在）', qPressed < qJustFull, true);
  near('  剛好滿水 Q 應等於同尺寸明溝的滿水 Q',
       qJustFull, C.Qof('rect', OPEN, 1, nC, sC) * 1000, 1e-6);

  // 因此水深求解的掃描上界必須收在 r=1 之前，否則會生出一個假的第二根
  const solBox = C.solveDepth('rect', BOX, nC, sC, 0.350, true);
  is('箱涵解水深：不得出現假的第二根', solBox.roots.length, 1);
  near('  唯一的根代回去重現目標 Q', C.Qof('rect', BOX, solBox.roots[0], nC, sC), 0.350, 1e-6);
  is('  掃描上界確實收在 r=1 之前', solBox.hi < 1, true);
  is('  回報的最大容量不會超過剛好滿水值', solBox.peakV * 1000 <= qJustFull + 1e-9, true);
  is('明溝的掃描上界仍是 r=1', C.solveDepth('rect', OPEN, nC, sC, 0.350, true).hi, 1);

  // 梯形 z>0 時 b=0 仍是三角形斷面、at(0) 不為零。
  // 目標若已低於 at(0)，二分法的不變式會反轉 → 必須直接回報，不能硬解
  {
    const TRAP = { b: 450, H: 600, z: 2 };
    const nT = 0.018, r400 = 400 / 600;
    const vAtZero = C.Vof('trap', { b: 0, H: 600, z: 2 }, r400, nT, sC);
    is('梯形 b=0 仍有通水能力（三角形斷面）', vAtZero > 0, true);
    const sol = C.solveSize('trap', TRAP, r400, nT, sC, vAtZero * 0.5, false);
    is('目標低於 b=0 的能力時，回報 size=0 而非亂解', sol.size, 0);
    is('  並標記此為退化解', sol.atZero, true);
    const solOK = C.solveSize('trap', TRAP, r400, nT, sC, vAtZero * 1.2, false);
    is('目標高於 b=0 的能力時正常求解', solOK.ok && !solOK.atZero, true);
    near('  代回去重現目標 V',
         C.Vof('trap', { b: solOK.size, H: 600, z: 2 }, r400, nT, sC), vAtZero * 1.2, 1e-9);
  }

  // 圓管與矩形在 D/b = 0 時通水能力為零，不受上面那條捷徑影響
  is('圓管 at(0) = 0', C.Vof('circle', { D: 0 }, 0.5, nC, sC), 0);
  is('矩形 at(0) = 0', C.Vof('rect', { b: 0, H: 600 }, 0.5, nC, sC), 0);
}

/* ══════════════════════════════════════════════════════════════════════
   HYD-01 介面行為（在 jsdom 裡真的按按鈕、真的打字）
   ══════════════════════════════════════════════════════════════════════ */
section('HYD-01 介面：欄位清空、斷面切換、異常網址、溢流判定');
{
  // ① 把數字欄位清空，不可以把 state 換成 fallback 值
  {
    const w = load('manning-calculator');
    is('起始坡度分母 = 100', w.state.S_denom, 100);
    type(w, 'inS', '200');
    is('輸入 200 後 state 更新', w.state.S_denom, 200);
    type(w, 'inS', '');                       // 使用者清空欄位準備重打
    is('清空欄位後 state 保留 200（不會變成 1）', w.state.S_denom, 200);
    blur(w, 'inS');
    is('失焦後欄位回填 200', w.document.getElementById('inS').value, '200');
  }

  // ② 切換斷面不可以偷改檢核門檻
  {
    const w = load('manning-calculator');
    const before = [w.state.vmin, w.state.vmax, w.state.rmax, w.state.use].join('|');
    w.document.querySelector('.shape-btn[data-key="rect"]').click();
    w.document.querySelector('.shape-btn[data-key="trap"]').click();
    w.document.querySelector('.shape-btn[data-key="circle"]').click();
    const after = [w.state.vmin, w.state.vmax, w.state.rmax, w.state.use].join('|');
    is('來回切換斷面後門檻不變（檢核結論才不會無故翻面）', after, before);
  }

  // ③ 異常的分享網址不可以讓整頁掛掉（原型鏈上的鍵曾能通過斷面守衛）
  ['constructor', 'toString', '__proto__'].forEach(bad => {
    const hash = '#s=' + Buffer.from(JSON.stringify({ shape: bad })).toString('base64');
    const w = load('manning-calculator', hash);
    is(`網址帶 shape="${bad}" 時退回圓形且頁面仍可用`,
       w.state.shape === 'circle' && txt(w, 'resultValue') !== '' && txt(w, 'resultValue') !== '—', true);
  });

  // ④ 水深大於溝深要判無解，不可端出夾限後的滿水值當答案
  {
    const w = load('manning-calculator');
    w.document.querySelector('.shape-btn[data-key="rect"]').click();
    type(w, 'inDepth', '900');               // 溝深預設 600 mm
    is('水深 900 > 溝深 600 → 主結果為「無解」', txt(w, 'resultValue'), '無解');
    is('  說明中要講出滿水時的通水量', /滿水.*通水量/.test(txt(w, 'resultSub')), true);
    type(w, 'inDepth', '400');
    is('改回 400 mm 後恢復正常計算', txt(w, 'resultValue') !== '無解', true);
  }

  // ⑤ 無解狀態下不可以宣稱流況是亞臨界（Fr 初值曾是 null，會通過 isFinite）
  {
    const w = load('manning-calculator');
    w.document.querySelector('.shape-btn[data-key="rect"]').click();
    w.document.querySelector('.seg-btn[data-key="size"]').click();
    w.document.getElementById('btnKnownV').click();
    type(w, 'knownValInput', '99');          // 遠超過此水深的流速上限
    is('目標流速超過上限 → 無解', txt(w, 'resultValue'), '無解');
    is('  容量面板不得出現「亞臨界」/「超臨界」字樣', /臨界/.test(txt(w, 'capsGrid')), false);
  }

  // ⑥ 標準尺寸取整後的預覽，必須是重解水深後的實際設計點
  {
    const w = load('manning-calculator');
    w.document.querySelector('.seg-btn[data-key="size"]').click();
    w.document.getElementById('btnKnownQ').click();
    type(w, 'inS', '200');
    type(w, 'knownValInput', '20');           // 目標 20 L/s
    const m = txt(w, 'checks').match(/Q = ([\d.,]+) L\/s/);
    is('取整後的預覽有列出 Q', !!m, true);
    if (m) {
      near('  預覽的 Q 應等於目標 20 L/s（重解水深，而非沿用同一充滿度）',
           parseFloat(m[1].replace(/,/g, '')), 20, 0.05);
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════
   HYD-02 雨水
   ══════════════════════════════════════════════════════════════════════ */
section('HYD-02 雨水：合理化公式、水保無因次降雨強度公式、集流時間');
{
  const w = load('rational-method');
  const C = w.CALC;

  // 單位換算自檢：1 mm/hr × 1 ha = 10 m³/hr = 1/360 m³/s
  near('Q = 1×1×1/360 → 0.0027778 m³/s', C.rationalQ(1, 1, 1), 1 / 360, 1e-12);
  near('  換算回 m³/hr 應為 10', C.rationalQ(1, 1, 1) * 3600, 10, 1e-9);

  // 加權 C
  const AC = C.areaAndC([{ area: 8000, c: 0.9 }, { area: 3000, c: 0.85 }, { area: 1500, c: 0.2 }]);
  near('總面積 12500 m² = 1.25 ha', AC.areaHa, 1.25, 1e-9);
  near('加權 C = (7200+2550+300)/12500 = 0.804', AC.cW, 0.804, 1e-9);

  // 水保 §16 無因次公式的內建自洽性：T=25、t=60 應還原 I60^25
  [1200, 1885, 2500, 3200].forEach(P => {
    const k = C.swcbCoef(P);
    const back = C.swcbI(P, 25, 60);
    near(`水保公式自洽 P=${P}：I(25年,60分) ≈ I60^25 = ${k.I60_25.toFixed(2)}`,
         back / k.I60_25, 1.0, 0.12);
  });
  // 單調性：重現期越長、延時越短 → 強度越大
  is('I 隨重現期遞增', C.swcbI(1885, 25, 60) > C.swcbI(1885, 5, 60), true);
  is('I 隨延時遞減', C.swcbI(1885, 5, 20) > C.swcbI(1885, 5, 60), true);

  // 集流時間
  near('漫地流 t₁ = 60m ÷ 0.4m/s = 2.5 分', C.tcOverland(60, 0.4), 2.5, 1e-9);
  near('管流 t₂ = 150m ÷ 1.0m/s = 2.5 分', C.tcChannel(150, 1.0), 2.5, 1e-9);
  // 芮哈：L=150m=0.15km, H=1.5m=0.0015km → W = 72(0.01)^0.6 = 72×0.0631 = 4.543 km/hr
  //       t = 0.15/4.543 hr = 0.03302 hr = 1.981 分
  near('芮哈 t₂（L=150m, H=1.5m）= 1.98 分', C.tcRziha(150, 1.5), 1.981, 0.01);
  // Kirpich: 0.0195 × 200^0.77 × 0.01^-0.385
  near('Kirpich（L=200m, S=0.01）= 6.789 分', C.tcKirpich(200, 0.01), 6.7893, 0.001);

  // 由 Q 反推管徑：對已知條件應可回推
  const D = C.pipeD(0.1, 0.013, 1 / 200, 0.8);
  is('由 Q=0.1 m³/s 反推管徑落在合理範圍 (300~600mm)', D > 300 && D < 600, true);
}

/* ══════════════════════════════════════════════════════════════════════
   HYD-04 污廢水
   ══════════════════════════════════════════════════════════════════════ */
section('HYD-04 污廢水：平衡勾稽、尖峰係數、集水坑容積、泵浦');
{
  const w = load('sewage-septic-sizing');
  const C = w.CALC;

  // 用水平衡圖：生活 7.9 + blowdown 108.5 = 納管 116.4
  const dom = C.domestic(7.96, 100);
  near('生活污水 = 7.96 × 100% = 7.96', dom, 7.96, 1e-9);
  near('污水總量 = 7.96 + 108.5 = 116.46（圖說 116.4）', dom + 108.5, 116.46, 0.06);
  near('平衡：116.46 + 335 蒸發 = 451.46（引入 451.4）', dom + 108.5 + 335, 451.4, 0.1);

  // Harmon 尖峰係數
  near('Harmon PF（75 人）= 4.276', C.harmonPF(75), 4.276, 0.002);
  near('Harmon PF（10000 人）= 2.955', C.harmonPF(10000), 2.9547, 0.001);
  is('人口越多尖峰係數越小', C.harmonPF(100) > C.harmonPF(100000), true);

  // 尖峰流量：泵浦必須承受尖峰入流，不是日平均
  const stCont = { procMode: 'cont', procHours: 24, processWaste: 108.5 };
  const stBatch = { procMode: 'batch', procHours: 1, processWaste: 108.5 };
  const pkC = C.peakFlow(stCont, 7.96, 4);
  const pkB = C.peakFlow(stBatch, 7.96, 4);
  near('連續排放：製程尖峰 = 108.5/24 = 4.52 m³/h', pkC.procPeak, 4.521, 0.005);
  near('間歇 1 小時排完：製程尖峰 = 108.5 m³/h', pkB.procPeak, 108.5, 1e-9);
  is('間歇模式的尖峰是連續模式的 24 倍', Math.round(pkB.procPeak / pkC.procPeak), 24);
  near('生活尖峰 = 7.96/24 × 4 = 1.327 m³/h', pkC.domPeak, 1.3267, 0.001);
  // 「日量 ÷ 抽水時數」得到的是平均值，保留對照確認差距
  near('（對照）日量 100 M³/日 ÷ 8h = 12.5 m³/h', 100 / 8, 12.5, 1e-9);
  is('平均值遠低於間歇排放的實際需求 108.5 m³/h', 12.5 < pkB.procPeak, true);

  // 集水坑容積：V = Q·t/4
  near('V = 100 m³/h × 6 分 ÷ 4 = 2.5 m³', C.pitVolume(100, 6), 2.5, 1e-9);
  // 驗證極值條件：入流 = Q/2 時實際週期最短，且應等於設定的最小週期
  const V = C.pitVolume(100, 6);
  near('  入流 = Q/2 = 50 m³/h 時實際週期 = 6 分（極值條件）', C.cycleTime(100, 50, V), 6, 1e-9);
  is('  入流偏離 Q/2 時週期變長', C.cycleTime(100, 20, V) > 6 && C.cycleTime(100, 80, V) > 6, true);

  // 泵浦水力
  near('100 m³/h 通過 100mm 管 → V = 3.54 m/s', C.pipeVelocity(100, 100), 3.537, 0.002);
  const Vp = C.pipeVelocity(100, 100);
  near('摩擦損失 f=0.025, L=30m, D=100mm', C.friction(30, 100, Vp, 0.025), 4.788, 0.01);
  near('P = 1000×(100/3600)×10×/(75×0.5)×1.15 = 8.52 PS', C.pumpPS(100, 10, 0.5, 1.15), 8.519, 0.01);
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n' + '═'.repeat(70));
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\n失敗項目：');
  failures.forEach(f => console.log('  ✕ ' + f));
}
console.log('═'.repeat(70));
process.exit(fail ? 1 : 0);
