/**
 * HYD-05 AIDC 給水設計工作台 — 計算引擎驗證
 *
 *   node tests/verify-aidc.js
 *   （LibreOffice 存在時另做「Excel 重算 = JS」比對；不存在則略過該段）
 *
 * 驗證基準分四類：
 *   1. 實案回歸：台水內線審查計算表格式（龍慶 27MW 案 MIC-VB-WS-CAL-0001 B 版）逐格重現
 *   2. 標準表值：IPC Table E103.3(3) 表列點、JIS G3448 / ASTM B88 內徑
 *   3. 物理一致性：冷卻塔質量平衡、Hazen-Williams 與 Darcy-Weisbach 數量級、單位換算
 *   4. 敏感度：每個結果都必須隨對應輸入改變（抓「寫死」的輸出）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'assets/aidc/engine.js'));
const P = require(path.join(ROOT, 'assets/aidc/profiles.js'));
const O = require(path.join(ROOT, 'assets/aidc/ooxml.js'));

let pass = 0, fail = 0; const fails = [];
function ok(cond, name, got) { if (cond) { pass++; console.log('  PASS  ' + name + (got !== undefined ? '  →  ' + got : '')); } else { fail++; fails.push(name); console.log('  FAIL  ' + name + (got !== undefined ? '  →  ' + got : '')); } }
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol);
const sec = t => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(2, 60 - t.length)));
const clone = o => JSON.parse(JSON.stringify(o));

/* 龍慶送審重現輸入（數值取自 MIC-VB-WS-CAL-0001 B 版） */
const LQ = {
  region: 'TW', twMode: 'submit', zonedSupply: true,
  cooling: { type: 'closed_ct', basis: 'hvac', hvacDaily: 443.52, coc: 3 },
  domestic: { twRows: [{ type: 'office', area: 663.64 }] },
  over: { totMinPct: 300 }, adoptVG: 1676, adoptVT: 0, fireVolume: 0,
  pumps: [{ name: '辦公區', kind: 'domestic', share: 100, static: 10.9, length: 120 }, { name: '空調', kind: 'hvac', share: 100, static: 12, length: 200, residual: 15 }],
  twcHead: { enable: true, building: 10.9, L: 12, D: 150, V: 1.6, vt: 0 },
  wq: { ph: 7.5, tds: 337, hard: 138, alk: 105, cl: 17.7, so4: 139, turb: 0.15 },
};
const v = (r, id) => r.index[id] && r.index[id].v;

sec('1 實案回歸：台水內線審查計算表');
const r = E.run(LQ);
ok(near(v(r, 'tw_v0'), 7.96, 0.005), '辦公室 V2′ = 663.64×0.6×0.2×0.1 = 7.96', v(r, 'tw_v0'));
ok(near(v(r, 'V'), 406.34, 0.005), 'V = (7.96+443.52)×0.9 = 406.34', v(r, 'V'));
ok(v(r, 'SF') === 1.1, '安全係數 V>68.5 → 1.1', v(r, 'SF'));
ok(near(v(r, 'Vd'), 446.97, 0.005), 'Vd = 406.34×1.1 = 446.97', v(r, 'Vd'));
ok(Math.round(v(r, 'Di')) === 97, 'Di = 4.59√Vd ≈ 97 mm', v(r, 'Di'));
ok(v(r, 'Di_adopt') === 100, '採用 100 mm', v(r, 'Di_adopt'));
ok(near(v(r, 'Dp'), 140.5918905, 1e-6), 'Dp = 6.65√Vd = 140.5918905（送審表印出值）', v(r, 'Dp'));
ok(near(v(r, 'vg_min'), 89.39, 0.005), 'VG ≥ Vd×20% = 89.39', v(r, 'vg_min'));
ok(near(v(r, 'tot_min'), 1340.91, 0.005), 'VG+VT ≥ Vd×300% = 1340.91', v(r, 'tot_min'));
ok(near(v(r, 'tw_Hs'), 0.0653, 5e-5), 'Hs = 0.0653', v(r, 'tw_Hs'));
ok(near(v(r, 'tw_Ht'), 0.1306, 5e-5), 'Ht = 0.02·L/D(m)·V/2g = 0.1306（D 以公尺代入）', v(r, 'tw_Ht'));
ok(near(v(r, 'tw_Hw'), 3.7948, 5e-5), 'Hw = 3.7948', v(r, 'tw_Hw'));
ok(near(v(r, 'tw_H'), 14.9559, 2e-4), 'H = 14.9559', v(r, 'tw_H'));
ok(v(r, 'tw_PS') === 0, '無高置水塔 VT=0 → 揚水泵馬力 0（與送審表一致）', v(r, 'tw_PS'));
ok(r.checks.some(c => c.level === 'warn' && /二日/.test(c.msg)), '1676 m³ 超過 §6 二日上限 → 提出警示');
const rDeriv = E.run(Object.assign(clone(LQ), { twMode: 'eng' }));
ok(near(v(rDeriv, 'di_k'), 4.5883, 1e-4), '工程模式 Di 係數由 υ=0.7 推導 = 4.5883', v(rDeriv, 'di_k'));
ok(near(v(rDeriv, 'V'), 7.96 * 0.9 + 443.52, 0.01), '工程模式：空調用水不折減 V = 450.69', v(rDeriv, 'V'));

sec('2 標準表值');
const J = P.PIPES.sus_jis.rows, C = P.PIPES.cu_l.rows;
ok(near(J.find(x => x.name === '50Su').id, 46.2, 1e-9), 'JIS G3448 50Su ID = 48.6 − 2×1.2 = 46.2 mm');
ok(near(C.find(x => x.name === '2"').id, 1.985 * 25.4, 1e-9), 'ASTM B88 Type L 2" ID = 1.985 in');
[[1, false, 3.0], [100, false, 43.5], [100, true, 67.5], [1000, true, 208], [5000, false, 593]].forEach(([w, fv, g]) =>
  ok(near(E.U.hunter(w, fv), g, 1e-9), `Hunter ${w} WSFU ${fv ? '沖水閥' : '水箱'} = ${g} gpm`, E.U.hunter(w, fv)));
ok(near(E.U.hunter(110, true), (67.5 + 73.0) / 2, 1e-9), 'Hunter 110 WSFU 沖水閥 線性內插 = 70.25');
ok(E.U.hunter(3, true) === 15.0, '沖水閥 < 5 WSFU 取表列起點 15.0 gpm');
ok(E.U.hunter(100, false) > 12 + 0.75 * Math.pow(100, 0.72), '（對照）Jeff 版公式 12+0.75·WSFU^0.72 在 100 WSFU 低估表值', (12 + 0.75 * Math.pow(100, 0.72)).toFixed(1) + ' vs 43.5');

sec('3 物理一致性');
const ct = E.run({ region: 'US', cooling: { type: 'open_ct', basis: 'calc', heatKW: 1000, rangeC: 5, coc: 4, wetFrac: 1, loadFactor: 1 }, domestic: { occupants: 0, fixtures: {} }, pumps: [], wq: {} });
const Ekgh = v(ct, 'ct_e') * 1000 / 1000;               // m³/h per 1000 kW → kg/h per kW
ok(near(Ekgh, 1.548, 0.002), '蒸發量 ≈ 1.548 kg/h/kW（EPA 每 10°F 1% 規則）', Ekgh.toFixed(4));
ok(near(Ekgh, 3600 / 2400, 0.06), '與潛熱法 3600/2400 = 1.5 kg/h/kW 相差 < 4%', (Ekgh / 1.5).toFixed(3));
ok(near(v(ct, 'ct_m'), v(ct, 'ct_e') * 4 / 3, 1e-12), 'M = E·COC/(COC−1)');
ok(near((v(ct, 'ct_bd') + v(ct, 'ct_d')) * 4, v(ct, 'ct_m'), 1e-12), '溶解固體平衡：(BD + D)·COC = M');
ok(near(v(ct, 'ct_e') * 24 / 1000 * 1000, 37.15, 0.05), '每 MW 每日蒸發 ≈ 37 m³（頁面說明 35~40 m³ 之依據）', (v(ct, 'ct_e') * 24).toFixed(2));
const jeffEvap = (1000 / 100) * 1.44;
ok(v(ct, 'ct_e') * 24 / jeffEvap > 2.5, '（對照）Jeff 版 (kW/100)×1.44 m³/d 低估約 2.6 倍', (v(ct, 'ct_e') * 24 / jeffEvap).toFixed(2));
const hf = E.U.hw(0.01, 0.1, 100, 130);
const vel = 0.01 / (Math.PI / 4 * 0.01), Re = vel * 0.1 / 1.0e-6;
const fDW = 0.25 / Math.pow(Math.log10(0.045e-3 / (3.7 * 0.1) + 5.74 / Math.pow(Re, 0.9)), 2);
const hDW = fDW * 100 / 0.1 * vel * vel / (2 * 9.81);
ok(Math.abs(hf / hDW - 1) < 0.25, 'Hazen-Williams(C=130) 與 Darcy-Weisbach(Swamee-Jain, ε=0.045mm) 相差 < 25%', `${hf.toFixed(3)} m vs ${hDW.toFixed(3)} m`);
const dry = E.run({ region: 'TW', cooling: { type: 'dry', basis: 'hvac', hvacDaily: 2 }, domestic: { twRows: [{ type: 'office', area: 1000 }] }, pumps: [], wq: {} });
ok(!dry.evaporative && !dry.index.ct_e, '乾式冷卻器：不計蒸發量');
ok(dry.checks.some(c => /乾式冷卻器/.test(c.msg)), '乾式冷卻器：提示用水主體為生活與加濕');

sec('4 敏感度（抓寫死的輸出）');
function sens(name, base, mut, ids) {
  const a = E.run(base), b2 = clone(base); mut(b2); const b = E.run(b2);
  ids.forEach(id => ok(v(a, id) !== v(b, id), `${name} → ${id} 改變`, `${v(a, id)} → ${v(b, id)}`));
}
sens('空調補水量', LQ, x => { x.cooling.hvacDaily = 600; }, ['Vd', 'Di', 'st_cool', 'z1_q', 'z1_h']);
sens('辦公面積', LQ, x => { x.domestic.twRows[0].area = 3000; }, ['Vd', 'qp_dom', 'z0_q', 'st_dom']);
sens('泵浦靜揚程', LQ, x => { x.pumps[0].static = 30; }, ['z0_h', 'z0_kw']);
sens('泵浦管長', LQ, x => { x.pumps[1].length = 800; }, ['z1_hf', 'z1_h']);
sens('備援時數', LQ, x => { x.over.coolHours = 48; x.over.totMinPct = 40; }, ['need_cool', 'st_cool']);
sens('分格數', LQ, x => { x.over.compartments = 3; }, ['cell_dom', 'cell_cool']);
const US = { region: 'US', cooling: { type: 'open_ct', basis: 'calc', heatKW: 20000, rangeC: 5.6, coc: 4, wetFrac: 1, loadFactor: 0.8 }, domestic: { occupants: 120, fixtures: { wc_fv: 12, lav: 12 } }, pumps: [{ name: 'D', kind: 'domestic', share: 100, static: 15, length: 150 }], wq: {} };
sens('器具數', US, x => { x.domestic.fixtures.wc_fv = 30; }, ['wsfu', 'qp_dom', 'z0_q']);
sens('排熱量', US, x => { x.cooling.heatKW = 30000; }, ['ct_e', 'hvac_daily', 'Vd', 'svc_q']);

sec('5 法規區域與業主基準');
const pv = E.run(Object.assign(clone(US), { region: 'VN' }));
ok(pv.status === 'preview' && pv.checks.some(c => /預覽/.test(c.msg)), '預覽區域：結果帶「不可送審」警示');
const sg = E.run(Object.assign(clone(US), { region: 'SG', domestic: { occupants: 100, peakLpm: 200 } }));
ok(near(v(sg, 'tot_min'), sg.Vd * 1.2, 1e-9), 'SG：低位 1/5 日 + 高位 1 日 = 1.2 Vd（PUB §2.2.2/2.2.3）');
ok(sg.service.meter !== undefined, 'SG：依月用水量給 PUB 水表口徑', sg.service.meter);
const own = { name: 'test-owner', version: 'v0', params: { vgMinPct: { v: 10, note: '放寬（應被標示）' }, coolHours: 24 } };
const ro = E.run(LQ, own);
ok(ro.conflicts.some(c => c.key === 'vgMinPct' && c.legal), '業主值與法規值不同 → 記錄為衝突');
ok(ro.checks.some(c => /業主設計基準 vgMinPct/.test(c.msg)), '衝突出現在檢核清單（不靜默覆蓋）');
ok(ro.params.coolHours.src === 'owner' && v(ro, 'h_cool') === 24, '業主參數覆蓋通用基準並標示出處');
const ru = E.run(Object.assign(clone(LQ), { over: { totMinPct: 300, coolHours: 6 } }), own);
ok(ru.params.coolHours.src === 'user' && v(ru, 'h_cool') === 6, '使用者覆寫優先於業主基準');


sec('6 系統昇位與管徑（System Flow）');
const NETIN = Object.assign(clone(US), { net: { floors: 6, floorH: 4.5, basement: 5, termH: 1.2, lenMain: 60, lenHdr: 25, lenBranch: 30, lenTerm: 6, roofHvac: true },
  pumps: [{ name: 'D', kind: 'domestic', share: 100, static: null, length: 100 }, { name: 'H', kind: 'hvac', share: 100, static: null, length: 150, residual: 14 }] });
const rn = E.run(NETIN);
ok(rn.net && rn.net.segs.length > 10, '產出管段表', rn.net && rn.net.segs.length);
const sgs = id => rn.net.segs.find(x => x.id === id);
ok(near(sgs('R0').Q, rn.qpDom, 1e-9), '立管底流量 = 全棟生活尖峰（Hunter 累計 WSFU）', sgs('R0').Q.toFixed(1));
ok(sgs('R0').Q > sgs('R2').Q && sgs('R2').Q > sgs('R5').Q, '立管流量由下往上逐層遞減', [0, 2, 5].map(k => sgs('R' + k).Q.toFixed(1)).join(' > '));
const wTot = rn.wsfuTot;
ok(near(sgs('B1').Q, E.U.hunter(wTot / 6, rn.valveSys) * 3.785411784, 1e-9), '層內橫支管流量 = Hunter(單層 ΣWSFU)');
ok(rn.net.segs.filter(x => x.kind !== 'terminal' && x.v !== null).every(x => x.v <= rn.params.vMax.v + 1e-9), '所有主管、立管、支管流速 ≤ 上限');
ok(rn.net.segs.filter(x => x.kind === 'riser' || x.kind === 'main').every(x => x.dn >= sgs('B1').dn || x.Q < sgs('B1').Q), '主管管徑不小於其下游支管');
const dnOf = id => sgs(id).dn;
ok(dnOf('R0') >= dnOf('R1') && dnOf('R1') >= dnOf('R3') && dnOf('R3') >= dnOf('R5'), '立管管徑隨流量遞減不增', ['R0', 'R1', 'R3', 'R5'].map(dnOf).join('≥'));
ok(near(sgs('R1').L, 4.5, 1e-9) && near(sgs('H1').L, 6 * 4.5 + 5, 1e-9), '立管長度 = 樓高；空調補水立管 = 屋頂標高 + 泵房深度', sgs('H1').L);
const top = rn.net.profile[5], lowp = rn.net.profile[0];
ok(near(top.avail, rn.pumps[0].H - (rn.net.profile[5].z + 5) - top.hf, 1e-9), '頂層可用壓力 = 泵揚程 − 昇位 − 路徑摩擦', top.avail.toFixed(2));
ok(lowp.avail > top.avail, '低層可用壓力大於頂層');
ok(near(rn.index.z0_hs.v, 5 + 5 * 4.5 + 1.2, 1e-9) && rn.index.z0_hs.kind === 'calc', '泵浦靜揚程留空 → 由昇位自動帶入（頂層末端標高 − 泵房底）', rn.index.z0_hs.v);
ok(rn.checks.some(c => c.sec.startsWith('6c') && /可用壓力/.test(c.msg)), '產出末端壓力檢核');
const rnLow = E.run(Object.assign(clone(NETIN), { pumps: [{ name: 'D', kind: 'domestic', share: 100, static: 8, length: 100 }] }));
ok(rnLow.checks.some(c => c.level === 'fail' && /可用壓力/.test(c.msg)) && rnLow.checks.some(c => /靜揚程/.test(c.msg)), '泵浦靜揚程過低 → 判不合格並指出原因');
sens('樓層數', NETIN, x => { x.net.floors = 12; }, ['net_zrise', 'z0_hs', 'z0_h']);
const rn2 = clone(NETIN); rn2.net.floors = 12; const r12 = E.run(rn2);
ok(r12.net.segs.find(x => x.id === 'R0').dn >= 0 && r12.net.segs.filter(x => x.kind === 'branch').length === 12, '樓層數改變 → 支管數量隨之改變', r12.net.segs.filter(x => x.kind === 'branch').length);
const twn = E.run({ region: 'TW', cooling: { type: 'closed_ct', basis: 'hvac', hvacDaily: 400 }, domestic: { twRows: [{ type: 'office', area: 800 }] }, net: { floors: 4 }, pumps: [{ name: 'D', kind: 'domestic', share: 100, static: null, length: 100 }], wq: {} });
ok(near(twn.net.segs.find(x => x.id === 'R0').Q, twn.qpDom, 1e-9) && near(twn.net.segs.find(x => x.id === 'R3').Q, twn.qpDom / 4, 1e-9), '台灣：無 Hunter，立管流量依各層負荷占比', twn.net.segs.find(x => x.id === 'R3').Q.toFixed(1));
ok(twn.net.segs.find(x => x.id === 'S1').dn === twn.service.adopt, '台灣：引入管採台水 Di 級距口徑', twn.service.adopt);
// 管徑獨立驗算：Hazen-Williams 反推梯度
const sx = rn.net.segs.find(x => x.id === 'M1');
ok(near(sx.hf, E.U.hw(sx.Q / 60000, sx.ID / 1000, sx.L * 1.3, 130), 1e-9), '管段摩擦損失 = Hazen-Williams（含 30% 管件加成）');
const noNet = E.run(Object.assign(clone(NETIN), { net: { enable: false } }));
ok(!noNet.net, 'net.enable=false → 不產生管徑表');

sec('7 水質規範書：各用途比對與設備報價提醒');
const WQIN = (wq, extra) => Object.assign({ region: 'TW', cooling: { type: 'closed_ct', basis: 'hvac', hvacDaily: 400, coc: 3, humidDaily: 0 }, domestic: { twRows: [{ type: 'office', area: 800 }] }, pumps: [], wq }, extra || {});
const planOf = (r, k) => r.wq.plan.find(p => p.key === k);
const fs20 = E.run(WQIN({ ph: 7.5, tds: 337, hard: 138, alk: 105, cl: 17.7, so4: 139, turb: 0.15 }));
ok(planOf(fs20, 'tcs_fill').level === 'required', '鳳山原水 → TCS 充水必須編列 RO＋DI（原水硬度 138 ≫ ASHRAE TCS 20）');
ok(['chem', 'bleed'].every(k => planOf(fs20, k).level === 'required'), '蒸發式冷卻 COC 3 超過可達 → 加藥與導電度排放必須編列');
ok(planOf(fs20, 'softener').level === 'likely' && planOf(fs20, 'ro').level === 'likely', '硬度／硫酸鹽限制 COC → 軟化與 RO 建議編列');
ok(planOf(fs20, 'filter').level === 'none', '濁度 0.15 NTU → 不需前處理過濾');
const clean = E.run(WQIN({ ph: 8.5, ec: 5, tds: 3, hard: 2, alk: 5, cl: 0.5, so4: 0.5, turb: 0.1, sio2: 1 }));
ok(planOf(clean, 'tcs_fill').level === 'likely' && planOf(clean, 'softener').level === 'none' && planOf(clean, 'ro').level === 'none', '超純水（RO 產水等級）→ 軟化與 RO 不需要');
const dirty = E.run(WQIN({ ph: 7.5, tds: 300, hard: 120, cl: 20, so4: 30, turb: 12 }));
ok(planOf(dirty, 'filter').level === 'likely', '濁度 12 NTU 超過飲用水基準 → 建議前處理過濾');
const unk = E.run(WQIN({}));
ok(planOf(unk, 'tcs_fill').level === 'confirm' && planOf(unk, 'filter').level === 'confirm', '未提供原水數值 → 一律「請廠商確認」，不替廠商下結論');
const dryW = E.run(WQIN({ ph: 7.5, hard: 138 }, { cooling: { type: 'dry', basis: 'hvac', hvacDaily: 0, humidDaily: 10 } }));
ok(planOf(dryW, 'chem').level === 'none' && !dryW.wq.systems.find(x => x.key === 'ct') && planOf(dryW, 'humid').level === 'confirm', '乾式冷卻器：無冷卻塔補水系統，加濕補水列為廠商確認');
// 各國標準：Malaysia 硬度 500、Taiwan 硬度 300；以硬度 400 區分
const h400 = E.run(WQIN({ ph: 7.5, hard: 400, tds: 400, cl: 100, so4: 100 }));
const cmpOf = k => h400.wq.compare.find(c => c.key === k);
ok(cmpOf('tw_potable').exceed >= 1 && cmpOf('my_potable').exceed === 0, '同一份原水（硬度 400）：台灣超標、馬來西亞符合 → 各國標準獨立比對');
ok(h400.wq.compare.length === 6, '比對六個國家／區域標準', h400.wq.compare.map(c => c.region).join(','));
ok(P.WQ.eu_potable.ec === 2500 && P.WQ.eu_potable.cl === 250 && P.WQ.my_potable.hard === 500 && P.WQ.th_potable.so4 === 200, '新增飲用水標準數值與查證原文一致（歐盟 EC 2500、馬來西亞硬度 500、泰國硫酸鹽 200）');
ok(P.WQ.ashrae_tcs.hard === 20 && P.WQ.ashrae_tcs.cl === 5 && P.WQ.ashrae_fws.so4 === 100, 'ASHRAE TC 9.9 FWS／TCS 建議值與查證原文一致');
ok(P.WQ.presets.sg_pub_2023.hard === 43 && P.WQ.presets.sg_pub_2023.tds === 110, 'PUB 2023 平均水質預設與公告一致');
ok(P.REGIONS.SG.p.potable.v === 'sg_potable' && P.REGIONS.EU.p.potable.v === 'eu_potable' && P.REGIONS.VN.p.potable.v === 'vn_potable', '各區域飲用水標準指向各自的登錄值');
const ownW = { name: 'o', params: {}, wqLimits: { tcs: { hard: 5, so4: 3 } } };
const rw = E.run(WQIN({ ph: 8.5, hard: 10, so4: 5, cl: 1 }), ownW);
const tcsRows = rw.wq.systems.find(x => x.key === 'tcs').rows;
ok(tcsRows.find(x => x.k === 'hard').ok === true && tcsRows.find(x => x.k === 'hard').ownerOk === false, '業主水質基準（本機載入）比 ASHRAE 更嚴時，單獨判定並顯示');
ok(planOf(rw, 'tcs_fill').level === 'required', '只要業主基準超標就列為必須編列');
ok(!JSON.stringify(P).includes('PG25') && !JSON.stringify(P).includes('NVIDIA'), '公開 profile 不含業主機密內容（無 PG25／NVIDIA 字樣）');

sec('8 參數覆寫確實反映到結果與報表');
const baseTW = E.run(LQ);
const ovr = E.run(Object.assign(clone(LQ), { over: { totMinPct: 100, vMax: 1.2, gradMax: 3, compartments: 3, coolHours: 24, pumpEff: 0.8 } }));
ok(v(ovr, 'tot_min') !== v(baseTW, 'tot_min') && near(v(ovr, 'tot_min'), v(ovr, 'Vd'), 1e-9), '覆寫 水池合計下限 100% → tot_min 改變且 = Vd');
ok(v(ovr, 'cell_dom') !== v(baseTW, 'cell_dom') || v(ovr, 'n_cell') === 3, '覆寫 水池分格數 3 → n_cell = 3', v(ovr, 'n_cell'));
ok(v(ovr, 'z1_id') >= v(baseTW, 'z1_id') && v(ovr, 'z1_v') <= 1.2 + 1e-9, '覆寫 流速上限 1.2 → 管徑增大、流速 ≤ 1.2', v(ovr, 'z1_v'));
ok(v(ovr, 'z0_kw') < v(baseTW, 'z0_kw') || v(ovr, 'z1_kw') < v(baseTW, 'z1_kw'), '覆寫 泵浦效率 0.8 → 軸功率降低');
ok(['vMax', 'gradMax', 'compartments', 'coolHours', 'pumpEff'].every(k => ovr.params[k].src === 'user'), '被覆寫的參數出處一律標示為「使用者輸入」');
ok(['p_vmax', 'n_cell', 'h_cool', 'p_eff'].every(id => ovr.index[id].src.includes('user')), '覆寫值出現在計算書（trace）輸入列，標示使用者輸入');
const xo = O.xlsxFromResult(ovr, {}); ok(Buffer.from(xo).toString('latin1').length > 1000, 'Excel 以覆寫後的值產出');
const sw = E.run(Object.assign(clone(LQ), { region: 'US', domestic: { occupants: 80, fixtures: { wc_fv: 8, lav: 8 } }, over: { totMinPct: 300 } }));
ok(sw.region === 'US' && v(sw, 'qp_gpm') !== undefined && sw.params.totMinPct === undefined, '切換區域：同一份輸入立即以另一套法規重算（US 走 Hunter，台灣專用參數不套用）');
ok(sw.index.wsfu && !baseTW.index.wsfu && baseTW.index.qh && !sw.index.qh, '切換區域後計算方法隨之改變（TW 用 Qh、US 用 WSFU）');

sec('9 匯出檔');
const xl = O.xlsxFromResult(r, { project: 't' }), dx = O.docxFromResult(r, { project: 't' });
ok(xl[0] === 0x50 && xl[1] === 0x4b && dx[0] === 0x50, 'xlsx/docx 皆為 ZIP（PK 標頭）');
ok(O.crc32(Buffer.from('123456789')) === 0xCBF43926, 'CRC32 標準測試向量 "123456789" = CBF43926');
ok(O.xlFormula('=MINIFS(a,a,">="&{Di})') === '_xlfn.MINIFS(a,a,">="&k_Di)', 'Excel 新函數加 _xlfn 前綴、步驟代碼轉定義名稱');
let soffice = null;
try { execFileSync('soffice', ['--version'], { stdio: 'pipe', timeout: 30000 }); soffice = 'soffice'; } catch (e) { /* 沒有 LibreOffice */ }
if (soffice) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aidc-'));
  const cases = { tw: Object.assign(clone(LQ), { net: { floors: 4 } }), net: NETIN, us: Object.assign(clone(US), { pumps: [{ name: 'D', kind: 'domestic', share: 100, static: 15, length: 150 }, { name: 'H', kind: 'hvac', share: 50, static: 8, length: 300, residual: 14 }], wq: { ph: 7.5, tds: 337, hard: 138, alk: 105, cl: 17.7, so4: 139 } }) };
  const expect = {};
  Object.entries(cases).forEach(([k, inp]) => { const rr = E.run(inp); fs.writeFileSync(path.join(tmp, k + '.xlsx'), O.xlsxFromResult(rr, {})); expect[k] = {}; rr.trace.forEach(s => { if (typeof s.v === 'number' && s.kind === 'calc') expect[k][s.id] = s.v; }); });
  try {
    execFileSync(soffice, ['--headless', '--calc', '--convert-to', 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1', '--outdir', path.join(tmp, 'out'), path.join(tmp, 'tw.xlsx'), path.join(tmp, 'net.xlsx'), path.join(tmp, 'us.xlsx')], { stdio: 'pipe', timeout: 120000, env: Object.assign({}, process.env, { LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' }) });
    Object.keys(cases).forEach(k => {
      const csv = fs.readFileSync(path.join(tmp, 'out', k + '-計算書.csv'), 'utf8').split(/\r?\n/).map(l => l.split(','));
      let n = 0, bad = 0;
      csv.forEach(row => { const id = row[2], val = parseFloat(row[3]); if (id in expect[k]) { n++; if (!(Math.abs(val - expect[k][id]) <= 1e-6 * Math.max(1, Math.abs(expect[k][id])))) { bad++; console.log('     mismatch', id, val, expect[k][id]); } } });
      ok(n > 30 && bad === 0, `Excel 重算 = JS（${k}，${n} 個計算格）`, `${n - bad}/${n}`);
    });
    // 管徑表：活公式（需求內徑、採用內徑、流速、摩擦損失、梯度）逐段與 JS 比對
    const rr = E.run(NETIN), netCsv = fs.readFileSync(path.join(tmp, 'out', 'net-管徑表.csv'), 'utf8').split(/\r?\n/).map(l => l.split(','));
    let nn = 0, nb = 0;
    rr.net.segs.forEach(sg => { const row = netCsv.find(r => r[0] === sg.id); if (!row || sg.Q === null) return; nn++;
      const chk = [[5, sg.dreq], [7, sg.ID], [9, sg.v], [10, sg.hf], [11, sg.S]];
      chk.forEach(([ci, ev]) => { const got = parseFloat(row[ci]); if (!(Math.abs(got - ev) <= 1e-6 * Math.max(1, Math.abs(ev)))) { nb++; console.log('     net mismatch', sg.id, ci, got, ev); } }); });
    ok(nn > 10 && nb === 0, `Excel 管徑表重算 = JS（${nn} 管段 × 5 欄活公式）`, `${nn} segs`);
  } catch (e) { ok(false, 'LibreOffice 重算執行失敗：' + e.message.split('\n')[0]); }
} else console.log('  SKIP  未安裝 LibreOffice，略過 Excel 重算比對');

console.log('\n' + '═'.repeat(70) + `\n  ${pass} passed, ${fail} failed\n` + '═'.repeat(70));
if (fail) { console.log(fails.map(f => '  ✕ ' + f).join('\n')); process.exit(1); }
