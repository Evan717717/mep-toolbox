/**
 * 工具箱清單 — 單一資料來源 (Single Source of Truth)
 *
 * 新增一支工具時，只需要做兩件事：
 *   1. 在 tools/ 底下建一個資料夾，裡面放 index.html
 *   2. 在下面的陣列加一筆記錄
 * 首頁會自動渲染，不需要改任何 HTML。
 *
 * 欄位說明：
 *   id       工具編號，格式 <領域碼>-<兩位數>，例如 HYD-01。顯示在卡片左上角。
 *   name     工具名稱（中文）
 *   path     相對路徑，指向工具資料夾
 *   summary  一句話說明這支工具解什麼問題
 *   formula  代表性算式，用等寬字顯示。工程師靠算式認工具，比 icon 好認。
 *   tags     分類標籤，用於篩選。沿用既有標籤可讓篩選列不會爆炸。
 *   status   'live' 可用 ｜ 'beta' 測試中 ｜ 'wip' 開發中（wip 不可點擊）
 *   updated  最後更新日期 YYYY-MM-DD
 *
 * 領域碼建議：
 *   HYD 水力／排水    HVA 空調      ELE 電氣
 *   FIR 消防          STR 結構      GEN 通用換算
 */

window.TOOLS = [
  {
    id: 'HYD-01',
    name: 'Manning 逕流計算機',
    path: 'tools/manning-calculator/',
    summary: '圓管部分充滿流的流速、流量、坡度、管徑、粗糙係數、充滿度六者互解，附自淨流速與法規最低坡度檢核。',
    formula: 'V = (1/n) · R^(2/3) · S^(1/2)',
    tags: ['水力', '排水', '管徑計算'],
    status: 'live',
    updated: '2026-08-17',
  },

  {
    id: 'HYD-02',
    name: '雨水排水設計流量計算機',
    path: 'tools/rational-method/',
    summary: '合理化公式估算基地雨水逕流設計流量，內建逕流係數加權平均表與 IDF 降雨強度公式試算，強調雨污分流、不與污水系統合流。',
    formula: 'Q = C · I · A / 360',
    tags: ['水力', '排水', '雨水'],
    status: 'live',
    updated: '2026-08-18',
  },
  {
    id: 'HYD-03',
    name: '給水設計流量與泵浦計算機',
    path: 'tools/water-supply-demand/',
    summary: '人口法(V1)＋樓地板面積法(V2)＋特殊製程用水(含冷卻水塔補水子模組)逐步算出一日設計用水量、進水口徑、蓄水池/水塔容量、揚水管徑與泵浦馬力，預設值取自資料中心案例。',
    formula: 'Vd = (V1+V2+V制程) × 安全係數',
    tags: ['水力', '給水', '資料中心'],
    status: 'live',
    updated: '2026-08-18',
  },
  {
    id: 'HYD-04',
    name: '污水/廢水量與化糞池・抽水泵浦選型',
    path: 'tools/sewage-septic-sizing/',
    summary: '生活污水(給水量×回收率)＋製程廢水加總為污水總排放量，附用水/排水平衡勾稽檢查、化糞池/處理設施人份選型、集水坑抽水泵浦概估與器具排水單位(DFU)參考表。',
    formula: '污水量 = 給水量 × 回收率',
    tags: ['水力', '排水', '污水'],
    status: 'live',
    updated: '2026-08-18',
  },
];
