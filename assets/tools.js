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
    name: '圓管重力流水理計算機（Manning）',
    path: 'tools/manning-calculator/',
    summary: '圓管部分充滿流的流速、流量、坡度、管徑、粗糙係數、充滿度六者互解。內建自淨流速、流速上限、最大充滿度、法規最低坡度檢核，並正確處理「同一流量可能有兩個充滿度解」的多重根情形。',
    formula: 'V = (1/n) · R^(2/3) · S^(1/2)',
    tags: ['水力', '排水', '管徑計算'],
    status: 'live',
    updated: '2026-08-18',
  },

  {
    id: 'HYD-02',
    name: '雨水排水設計流量計算機',
    path: 'tools/rational-method/',
    summary: '合理化公式估算基地雨水逕流設計流量。降雨強度綁定集流時間（合理化公式的前提），內建水土保持技術規範 §16 官方降雨強度公式、§19 集流時間，以及出流管制/滯洪量初篩。',
    formula: 'Q = C · I · A / 360',
    tags: ['水力', '排水', '雨水'],
    status: 'live',
    updated: '2026-08-18',
  },

  {
    id: 'HYD-03',
    name: '給水設計流量與泵浦計算機',
    path: 'tools/water-supply-demand/',
    summary: '人口法 V1 ＋ 樓地板面積法 V2 ＋ 特殊製程用水（含冷卻水塔補水子模組），算出一日設計用水量、進水口徑、蓄水池/水塔容量、揚水管徑、總揚程與泵浦馬力。提供「送審重現」與「工程保守」雙模式，預設值可逐格重現台水內線審查計算表。',
    formula: 'Vd = V × 安全係數 ・ Di = k√Vd',
    tags: ['水力', '給水', '資料中心'],
    status: 'live',
    updated: '2026-08-18',
  },

  {
    id: 'HYD-04',
    name: '污廢水量、化糞池與集水坑泵浦',
    path: 'tools/sewage-septic-sizing/',
    summary: '生活污水（給水量×回收率）＋製程廢水的日量與尖峰量、用水/排水平衡勾稽、化糞池與處理設施規模、依尖峰入流與最小啟閉週期選集水坑泵浦與坑體容積、DFU 管徑對照。',
    formula: 'Q尖峰 = 生活/24×PF + 製程尖峰',
    tags: ['水力', '排水', '污水'],
    status: 'live',
    updated: '2026-08-18',
  },
];
