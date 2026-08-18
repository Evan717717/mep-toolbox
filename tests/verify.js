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

function load(tool) {
  const file = path.join(ROOT, 'tools', tool, 'index.html');
  const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
    runScripts: 'dangerously',
    url: 'https://example.test/tools/' + tool + '/',
    pretendToBeVisual: true,
  });
  return dom.window;
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

  // ── 揚程：這是原版最大的錯誤所在 ──
  const hp = { building: 10.9, L: 12, Dmm: 150, V: 1.6, f: 0.02, hammer: 0.34, minorK: 0, htMode: 'official' };
  const H = C.head(hp);
  near('Hs = 0.5·V²/2g = 0.0653', H.Hs, 0.0653, 0.0002);
  near('Hd = 10.9 + Hs = 10.9653', H.Hd, 10.9653, 0.0002);
  near('Ht = 0.02·(L/D_公尺)·V/2g = 0.1305  ← 原版用 mm 代入得 0.00013，少 1000 倍',
       H.Ht, 0.1305, 0.0005);
  near('Hw = (Hs+Hd+Ht)×0.34 = 3.7948', H.Hw, 3.7948, 0.001);
  near('H 總揚程 = 14.9559', H.H, 14.9559, 0.002);

  // 原版的錯誤值，確認我們知道自己修掉了什麼
  const wrongHt = 0.02 * (12 / 150) * 1.6 / (2 * 9.8);
  near('（對照）原版 Ht 錯誤值 ≈ 0.000131', wrongHt, 0.000131, 1e-6);
  is('修正後/錯誤值 比值 ≈ 1000', Math.round(H.Ht / wrongHt), 1000);

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

  // ── 多重根：原版二分法在此會誤判 ──
  // 取一個介於 Q_full 與 Q_max 之間的目標流量，理論上有兩個解
  const Dm = 0.3, nn = 0.013, SS = 0.01;
  const qFull = C.Q(Dm, 1, nn, SS), qMax = C.solveR(Infinity, true, Dm, nn, SS).peakV;
  const qTarget = (qFull + qMax) / 2;
  const sol = C.solveR(qTarget, true, Dm, nn, SS);
  is('Q 介於 Q_full 與 Q_max 之間時應找到 2 個解（原版回報「無解」）', sol.roots.length, 2);
  if (sol.roots.length === 2) {
    near('  第 1 個根重現目標 Q', C.Q(Dm, sol.roots[0], nn, SS), qTarget, qTarget * 1e-6);
    near('  第 2 個根重現目標 Q', C.Q(Dm, sol.roots[1], nn, SS), qTarget, qTarget * 1e-6);
    is('  兩根分別落在 Q_max 兩側', sol.roots[0] < 0.9381 && sol.roots[1] > 0.9381, true);
  }
  // 超過 Q_max 才是真的無解
  is('Q 超過 Q_max 時應為無解', C.solveR(qMax * 1.05, true, Dm, nn, SS).roots.length, 0);
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

  // 尖峰流量：這是原版最大的觀念錯誤
  const stCont = { procMode: 'cont', procHours: 24, processWaste: 108.5 };
  const stBatch = { procMode: 'batch', procHours: 1, processWaste: 108.5 };
  const pkC = C.peakFlow(stCont, 7.96, 4);
  const pkB = C.peakFlow(stBatch, 7.96, 4);
  near('連續排放：製程尖峰 = 108.5/24 = 4.52 m³/h', pkC.procPeak, 4.521, 0.005);
  near('間歇 1 小時排完：製程尖峰 = 108.5 m³/h', pkB.procPeak, 108.5, 1e-9);
  is('間歇模式的尖峰是連續模式的 24 倍', Math.round(pkB.procPeak / pkC.procPeak), 24);
  near('生活尖峰 = 7.96/24 × 4 = 1.327 m³/h', pkC.domPeak, 1.3267, 0.001);
  // 原版的做法（日量 ÷ 8 小時）
  near('（對照）原版做法 100 M³/日 ÷ 8h = 12.5 m³/h', 100 / 8, 12.5, 1e-9);
  is('原版做法遠低於間歇排放實際需求 108.5 m³/h', 12.5 < pkB.procPeak, true);

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
