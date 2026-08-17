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
    name: 'Manning 徑流計算機',
    path: 'tools/manning-calculator/',
    summary: '圓管部分充滿流的流速、流量、坡度、管徑、粗糙係數、充滿度六者互解，附自淨流速與法規最低坡度檢核。',
    formula: 'V = (1/n) · R^(2/3) · S^(1/2)',
    tags: ['水力', '排水', '管徑計算'],
    status: 'live',
    updated: '2026-08-17',
  },

  // ── 以下為佔位範例，實作後把 status 改成 'live'、補上 path 即可 ──
  // {
  //   id: 'HYD-02',
  //   name: '雨水排水量估算',
  //   path: 'tools/rational-method/',
  //   summary: '合理化公式估算集水區徑流量，內建各地降雨強度公式與徑流係數表。',
  //   formula: 'Q = C · I · A / 360',
  //   tags: ['水力', '排水'],
  //   status: 'wip',
  //   updated: '',
  // },
];
