/**
 * AIDC 給水設計工作台 — 法規區域 Profile 與出處登錄
 * ------------------------------------------------------------------
 * 這支檔案只放「資料」：每個法規區域用哪一套方法、哪些參數、參數出處是什麼。
 * 計算邏輯在 engine.js。新增一個國家 = 在 REGIONS 加一筆，不必改引擎。
 *
 * 參數一律寫成 { v: 值, src: '出處代碼', note: '說明' }。
 * 出處代碼對應下方 SOURCES；tier 決定畫面上的標籤顏色：
 *   law     法規（強制）
 *   std     標準 / 主管機關技術規範
 *   gov     政府機關技術文件、主管機關公告資料
 *   guide   產業指引 / 學會 / 廠商手冊（非強制）
 *   phys    物理定律 / 解析解（不需出處的推導）
 *   assume  工程假設（無法規值，需設計者確認）
 *   owner   業主設計基準（由本機設定檔載入，非法規要求）
 *
 * 區域狀態：
 *   ready    參數已逐項查證，可產出計算書
 *   partial  部分參數已查證，未查證者以工程假設代入並明確標示
 *   preview  只建立法規對照，計算不可用於設計（匯出強制加「初篩」浮水印）
 */
(function (root) {
  'use strict';

  const SOURCES = {
    /* ── 台灣 ── */
    tw_std: { tier: 'law', short: '自來水用戶用水設備標準',
      full: '經濟部《自來水用戶用水設備標準》（民國105年6月6日修正）',
      url: 'https://law.moea.gov.tw/LawContent.aspx?id=FL025862' },
    tw_tech: { tier: 'std', short: '建築物給水排水設備設計技術規範',
      full: '內政部《建築物給水排水設備設計技術規範》（含附錄 設備容量及計算方法）',
      url: 'https://glrs.moi.gov.tw/LawContent.aspx?id=GL000602' },
    twc_form: { tier: 'gov', short: '台水內線審查計算表',
      full: '台灣自來水公司 內線審查計算表（第七區管理處 Y001 格式）— 一日用水量、安全係數級距、Di／Dp 係數、揚程與馬力算式',
      url: '' },
    tw_dw: { tier: 'law', short: '飲用水水質標準',
      full: '環境部《飲用水水質標準》最大限值（引自台水淨水場水質公告之「最大限值」欄）',
      url: 'https://www.water.gov.tw/' },
    twc_wq_fs: { tier: 'gov', short: '台水 鳳山淨水場 平均水質',
      full: '台灣自來水公司 鳳山淨水場平均水質公告（發布日期 2026/08/10）',
      url: 'https://www.water.gov.tw/' },
    jis_g3448: { tier: 'std', short: 'JIS G3448',
      full: 'JIS G3448 一般配管用ステンレス鋼鋼管 標準寸法（外徑／厚度）',
      url: 'https://www.nipponsteel.com/product/construction/handbook/pdf/4-29.pdf' },

    /* ── 美國 ── */
    ipc_e: { tier: 'law', short: 'IPC 2024 App. E',
      full: 'ICC 2024 International Plumbing Code, Appendix E — Table E103.3(2) WSFU、Table E103.3(3) Table for Estimating Demand（Hunter）',
      url: 'https://codes.iccsafe.org/content/IPC2024P1' },
    ipc_604: { tier: 'law', short: 'IPC 2024 §604',
      full: 'ICC 2024 IPC §604.3 / Table 604.3（器具最低流動壓力）、§604.8（靜壓 > 80 psi 需設減壓閥）',
      url: 'https://codes.iccsafe.org/content/IPC2024P1/chapter-6-water-supply-and-distribution' },
    ipc_608: { tier: 'law', short: 'IPC 2024 §608',
      full: 'ICC 2024 IPC §608 Protection of Potable Water Supply、Table 608.1（高危害交叉連接須 RPZ 或空氣間隙）',
      url: 'https://codes.iccsafe.org/content/IPC2024P1/chapter-6-water-supply-and-distribution' },
    astm_b88: { tier: 'std', short: 'ASTM B88 Type L',
      full: 'ASTM B88 Seamless Copper Water Tube — Type L 外徑／壁厚',
      url: 'https://engineeringtoolbox.com/astm-copper-tubes-d_779.html' },
    cda: { tier: 'guide', short: 'CDA 流速建議',
      full: 'Copper Development Association：冷水銅管建議流速 ≤ 8 ft/s（約 2.4 m/s）',
      url: 'https://www.pmmag.com/articles/105715-james-dipping-a-deep-dive-into-water-pipe-sizing' },
    epa_143: { tier: 'law', short: '40 CFR 143.3',
      full: 'US EPA 40 CFR §143.3 Secondary Maximum Contaminant Levels',
      url: 'https://www.ecfr.gov/current/title-40/chapter-I/subchapter-D/part-143/subpart-A/section-143.3' },

    /* ── 新加坡 ── */
    pub_hb: { tier: 'gov', short: 'PUB Handbook 2022',
      full: 'PUB Singapore, Handbook on Application for Water Supply (2022) §2.2.2 高位水箱 1 日、§2.2.3 低位水箱 1/5 或 1/3 日且泵浦需備用、§6.3 水表口徑',
      url: 'https://www.pub.gov.sg/-/media/PUB/PDF/Handbook_on_Application_for_Water_Supply_2022.pdf' },
    ss636: { tier: 'std', short: 'SS 636',
      full: 'Singapore Standard SS 636 Code of Practice for Water Services（全文需購買，未逐條查證）',
      url: '' },

    /* ── 歐洲／東南亞 飲用水水質 ── */
    eu_dwd: { tier: 'law', short: 'EU 飲用水指令 指標參數',
      full: 'Council Directive 98/83/EC Annex I Part C 指標參數（氯鹽 250、硫酸鹽 250 mg/L、導電度 2,500 µS/cm@20°C、pH 6.5–9.5；無硬度與 TDS 數值）。Directive (EU) 2020/2184 為其修訂版，本表數值取自 98/83/EC 英國保留版全文，2020/2184 全文未逐字核對',
      url: 'https://legislation.gov.uk/eudr/1998/83/annex/I/part/C/2020-12-31/data.xht' },
    sg_pub: { tier: 'gov', short: 'PUB 飲用水水質 2023',
      full: 'PUB Singapore, "SG Drinking Water Quality"（2023 年資料）：EPH Regulations 標準以 WHO 飲用水水質指引為基礎，表列 pH 6.5–9.5、濁度 ≤ 5 NTU；硬度、TDS、氯鹽、硫酸鹽等僅列監測值、無限值',
      url: 'https://www.pub.gov.sg/-/media/PUB/PDF/SG-Drinking-Water-Quality.pdf' },
    my_moh: { tier: 'gov', short: '馬來西亞 MOH 飲用水標準',
      full: 'Ministry of Health Malaysia, Engineering Services Division《Piawaian Kualiti Air Minum》Table 2（淨水廠出水）：pH 6.5–9.0、濁度 5 NTU、TDS 1,000、總硬度 500、氯鹽 250、硫酸鹽 250 mg/L',
      url: 'https://hq.moh.gov.my/engineering/images/perkhidmatan/kas/muat-turun/piawaian_kualiti_air_minum.pdf' },
    th_moi: { tier: 'gov', short: '泰國 MOI 飲用水標準（舊）',
      full: 'Thailand Ministry of Industry Notification No. 322 B.E. 2521 (1978)，經 WEPA 資料庫轉載：pH 6.5–8.5、濁度 5（SSU）、總固體 500、硬度 < 300、氯鹽 250、硫酸鹽 200。為 1978 年公告，是否為現行供水（MWA／PWA）規定未查證，只作參考',
      url: 'https://wepa-db.net/archive/policies/law/thailand/std_drinking.htm' },
    ashrae_td99: { tier: 'guide', short: 'ASHRAE TC 9.9 水冷伺服器白皮書',
      full: 'ASHRAE TC 9.9 White Paper "Water-Cooled Servers" Table 1：設施水系統 FWS（pH 7–9、氯鹽 < 50、硫酸鹽 < 100、總硬度 < 200 mg/L、細菌 < 1,000 CFU/mL、濾網 400–500 µm）；二次側 TCS（pH 8.0–9.5、氯鹽 < 5、硫酸鹽 < 10、總硬度 < 20 mg/L、導電度 0.2–20 µS/cm、細菌 < 100 CFU/mL、絕對過濾）。版本年份未標示',
      url: 'https://www.ashrae.org/File%20Library/Technical%20Resources/Bookstore/WhitePaper_TC099-WaterCooledServers.pdf' },

    /* ── 通用 / 資料中心 ── */
    epa_ct: { tier: 'gov', short: 'EPA WaterSense §6.3',
      full: 'US EPA, WaterSense at Work §6.3 Cooling Towers (2012)：蒸發量約為循環水量每 10°F 溫差 1%；Makeup = 蒸發 + 飛濺 + 排放；COC = Makeup ÷ Blowdown；現代除霧器飛濺 < 0.005%',
      url: 'https://www.epa.gov/system/files/documents/2023-05/ws-commercial-watersense-at-work_Section_6.3_Cooling_Towers.pdf' },
    uptime_mw: { tier: 'guide', short: 'Uptime Institute',
      full: 'Uptime Institute Journal, "Implications of economizers in Tier Certified data centers"：Tier III 須 12 小時可同時維修之補給水',
      url: 'https://journal.uptimeinstitute.com/implications-of-economizers-in-tier-certified-data-centers/' },
    jra_gl02: { tier: 'guide', short: 'JRA-GL02:1994',
      full: '日本冷凍空調工業會 JRA-GL02:1994 冷凍空調機器用水質ガイドライン（冷却水系 循環式：補給水／循環水基準，不使用水處理劑時）',
      url: 'https://www.env.go.jp/earth/ondanka/gel/ghg-guideline/search/pdf/01_140.pdf' },
    hw: { tier: 'phys', short: 'Hazen-Williams',
      full: 'Hazen-Williams 公式（SI）：hf = 10.67·L·Q^1.852 / (C^1.852·D^4.87)',
      url: '' },
    phys: { tier: 'phys', short: '物理推導',
      full: '質量守恆／單位換算等物理推導，不需外部出處',
      url: '' },
    cont: { tier: 'phys', short: '連續方程式',
      full: '連續方程式 Q = A·v；泵浦軸功率 P = ρ·g·Q·H / η',
      url: '' },
    assume: { tier: 'assume', short: '工程假設',
      full: '無對應法規數值，為工程慣用假設；送審前須由設計者確認或改填業主／當地主管機關要求',
      url: '' },
    owner: { tier: 'owner', short: '業主設計基準',
      full: '業主設計基準（由本機設定檔載入；內部設計要求，非法規）',
      url: '' },
    hvac: { tier: 'assume', short: '空調組提供',
      full: '由空調組（冷卻系統）提供之設計值；本工具不重算，只做合理性檢核',
      url: '' },
    fire: { tier: 'assume', short: '消防組提供',
      full: '消防水源容量由消防組依當地消防法規計算；本工具只納入總量、不重算',
      url: '' },
  };

  /* ── 管材內徑表（ID = OD − 2t，單位 mm）── */
  const PIPES = {
    sus_jis: {
      label: '不鏽鋼管 JIS G3448（SUS304）', src: 'jis_g3448',
      rows: [
        ['13Su', 13, 15.88, 0.8], ['20Su', 20, 22.22, 1.0], ['25Su', 25, 28.58, 1.0],
        ['30Su', 30, 34.0, 1.2], ['40Su', 40, 42.7, 1.2], ['50Su', 50, 48.6, 1.2],
        ['60Su', 60, 60.5, 1.5], ['75Su', 75, 76.3, 1.5], ['80Su', 80, 89.1, 2.0],
        ['100Su', 100, 114.3, 2.0], ['125Su', 125, 139.8, 2.0], ['150Su', 150, 165.2, 3.0],
        ['200Su', 200, 216.3, 3.0], ['250Su', 250, 267.4, 3.0], ['300Su', 300, 318.5, 3.0],
      ].map(([name, dn, od, t]) => ({ name, dn, od, t, id: od - 2 * t })),
    },
    cu_l: {
      label: '銅管 ASTM B88 Type L', src: 'astm_b88',
      rows: [
        ['1/2"', 15, 0.625, 0.040], ['3/4"', 20, 0.875, 0.045], ['1"', 25, 1.125, 0.050],
        ['1-1/4"', 32, 1.375, 0.055], ['1-1/2"', 40, 1.625, 0.060], ['2"', 50, 2.125, 0.070],
        ['2-1/2"', 65, 2.625, 0.080], ['3"', 80, 3.125, 0.090], ['3-1/2"', 90, 3.625, 0.100],
        ['4"', 100, 4.125, 0.114], ['5"', 125, 5.125, 0.125], ['6"', 150, 6.125, 0.140],
      ].map(([name, dn, odIn, tIn]) => ({ name, dn, od: odIn * 25.4, t: tIn * 25.4, id: (odIn - 2 * tIn) * 25.4 })),
    },
  };

  /* ── IPC 2024 Table E103.3(3)（gpm）── null = 表中無此列 */
  const HUNTER = {
    wsfu: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,20,25,30,35,40,45,50,60,70,80,90,100,120,140,160,180,200,225,250,275,300,400,500,750,1000,1250,1500,1750,2000,2500,3000,4000,5000],
    tank: [3.0,5.0,6.5,8.0,9.4,10.7,11.8,12.8,13.7,14.6,15.4,16.0,16.5,17.0,17.5,18.0,18.4,18.8,19.6,21.5,23.3,24.9,26.3,27.7,29.1,32.0,35.0,38.0,41.0,43.5,48.0,52.5,57.0,61.0,65.0,70.0,75.0,80.0,85.0,105.0,124.0,170.0,208.0,239.0,269.0,297.0,325.0,380.0,433.0,525.0,593.0],
    valve:[null,null,null,null,15.0,17.4,19.8,22.2,24.6,27.0,27.8,28.6,29.4,30.2,31.0,31.8,32.6,33.4,35.0,38.0,42.0,44.0,46.0,48.0,50.0,54.0,58.0,61.2,64.3,67.5,73.0,77.0,81.0,85.5,90.0,95.5,101.0,104.5,108.0,127.0,143.0,177.0,208.0,239.0,269.0,297.0,325.0,380.0,433.0,525.0,593.0],
  };

  /* ── IPC 2024 Table E103.3(2) WSFU（總量欄）── */
  const FIXTURES_IPC = [
    { key: 'wc_fv',  label: '大便器（公用，沖水閥）',     wsfu: 10.0, valve: true },
    { key: 'wc_ft',  label: '大便器（公用，水箱式）',     wsfu: 5.0 },
    { key: 'ur_fv1', label: '小便器（公用，1" 沖水閥）',  wsfu: 10.0, valve: true },
    { key: 'ur_fv3', label: '小便器（公用，3/4" 沖水閥）',wsfu: 5.0,  valve: true },
    { key: 'lav',    label: '洗面盆（公用）',              wsfu: 2.0 },
    { key: 'ss',     label: '拖布盆／清潔水槽',            wsfu: 3.0 },
    { key: 'sh',     label: '淋浴（公用，混合閥）',        wsfu: 4.0 },
    { key: 'df',     label: '飲水機',                      wsfu: 0.25 },
    { key: 'ks',     label: '廚房水槽（商用）',            wsfu: 4.0 },
  ];

  /* ── 台水樓地板面積推算用途表（內線審查計算表）── */
  const TW_ZONES = {
    office:   { label: '辦公室',     eff: 0.6,   density: 0.2,  unit: 0.1 },
    general:  { label: '一般事務所', eff: 0.56,  density: 0.2,  unit: 0.1 },
    factory:  { label: '工廠(座式)', eff: 0.59,  density: 0.2,  unit: 0.06 },
    factory2: { label: '工廠(立式)', eff: 0.59,  density: 0.1,  unit: 0.06 },
    shop:     { label: '店舖',       eff: 0.575, density: 0.16, unit: 0.04 },
  };

  /* ── 標準馬達容量 ── */
  const MOTORS_KW = [0.37,0.55,0.75,1.1,1.5,2.2,3,4,5.5,7.5,11,15,18.5,22,30,37,45,55,75,90,110,132,160];
  const MOTORS_HP = [0.5,0.75,1,1.5,2,3,5,7.5,10,15,20,25,30,40,50,60,75,100,125,150,200];

  /* ── 水質門檻 ── */
  const WQ = {
    jra_makeup:  { ph: [6.0, 8.0], ec: 300, hard: 70, alk: 50, cl: 50, so4: 50, sio2: 30, src: 'jra_gl02' },
    jra_circ:    { ph: [6.5, 8.2], ec: 800, hard: 200, alk: 100, cl: 200, so4: 200, sio2: 50, src: 'jra_gl02' },
    tw_potable:  { ph: [6.0, 8.5], hard: 300, tds: 500, cl: 250, so4: 250, turb: 2, src: 'tw_dw' },
    us_potable:  { ph: [6.5, 8.5], tds: 500, cl: 250, so4: 250, src: 'epa_143' },
    eu_potable:  { ph: [6.5, 9.5], ec: 2500, cl: 250, so4: 250, src: 'eu_dwd' },
    sg_potable:  { ph: [6.5, 9.5], turb: 5, src: 'sg_pub' },
    my_potable:  { ph: [6.5, 9.0], turb: 5, tds: 1000, hard: 500, cl: 250, so4: 250, src: 'my_moh' },
    th_potable:  { ph: [6.5, 8.5], turb: 5, tds: 500, hard: 300, cl: 250, so4: 200, src: 'th_moi' },
    vn_potable:  { src: 'assume' },
    ashrae_fws:  { ph: [7, 9], hard: 200, cl: 50, so4: 100, src: 'ashrae_td99' },
    ashrae_tcs:  { ph: [8.0, 9.5], hard: 20, cl: 5, so4: 10, ec: [0.2, 20], src: 'ashrae_td99' },
    params: [['ph', 'pH', ''], ['ec', '導電度 EC', 'µS/cm'], ['tds', 'TDS', 'mg/L'], ['hard', '總硬度 (as CaCO₃)', 'mg/L'], ['alk', '總鹼度', 'mg/L'],
      ['cl', '氯鹽 Cl⁻', 'mg/L'], ['so4', '硫酸鹽 SO₄²⁻', 'mg/L'], ['sio2', '二氧化矽 SiO₂', 'mg/L'], ['turb', '濁度', 'NTU']],
    /* 預設水質基準一覽（水質規範書「各用途水質基準」表用）：group 分組、key 對應上方限值物件 */
    uses: [
      { group: '飲用水（生活回路）', key: 'tw_potable', label: '台灣 飲用水水質標準', region: 'TW' },
      { group: '飲用水（生活回路）', key: 'us_potable', label: '美國 EPA 次級標準（非強制）', region: 'US' },
      { group: '飲用水（生活回路）', key: 'eu_potable', label: '歐盟 飲用水指令 指標參數', region: 'EU' },
      { group: '飲用水（生活回路）', key: 'sg_potable', label: '新加坡 EPH／WHO', region: 'SG' },
      { group: '飲用水（生活回路）', key: 'my_potable', label: '馬來西亞 MOH', region: 'MY' },
      { group: '飲用水（生活回路）', key: 'th_potable', label: '泰國 MOI（1978，參考）', region: 'TH' },
      { group: '冷卻塔（蒸發式）', key: 'jra_makeup', label: 'JRA-GL02 補給水（不加藥）' },
      { group: '冷卻塔（蒸發式）', key: 'jra_circ', label: 'JRA-GL02 循環水（不加藥）' },
      { group: '液冷／冷卻水迴路', key: 'ashrae_fws', label: 'ASHRAE TC 9.9 設施水 FWS 建議' },
      { group: '液冷／冷卻水迴路', key: 'ashrae_tcs', label: 'ASHRAE TC 9.9 二次側 TCS 建議' },
    ],
    presets: {
      fongshan_20260810: {
        label: '高雄 鳳山淨水場（2026/08/10 公告平均值）', src: 'twc_wq_fs',
        ph: 7.5, tds: 337, hard: 138, alk: 105, cl: 17.7, so4: 139, turb: 0.15, sio2: null, ec: null,
        note: '公告未列導電度與二氧化矽；導電度依 TDS 估算（EC ≈ TDS ÷ 0.65），屬估計值。',
      },
      sg_pub_2023: {
        label: '新加坡 PUB 自來水（2023 年平均值）', src: 'sg_pub',
        ph: 8.2, ec: 222, tds: 110, hard: 43, alk: null, cl: 28, so4: 7.5, sio2: null, turb: 0.14,
        note: 'PUB 公布全島 2023 年平均值（範圍：硬度 19–203、氯鹽 <5–154、TDS 72–354 mg/L）；未列鹼度與二氧化矽。',
      },
    },
  };

  /* ═════════════════════════ 法規區域 ═════════════════════════ */
  const REGIONS = {
    TW: {
      id: 'TW', flag: '🇹🇼', label: '台灣', status: 'ready', version: 'TW-2026.10',
      units: 'SI', pipe: 'sus_jis', codes: '自來水用戶用水設備標準(105) · 建築物給水排水設備設計技術規範 · 台水內線審查',
      method: { demand: 'twc_area', peak: 'tw_qp', service: 'twc_di', storage: 'tw_std6', meter: 'twc_di' },
      p: {
        twAdj:        { v: 0.9,  src: 'twc_form', note: '考慮使用水量變化，V2 可取 ±10%' },
        diVel:        { v: 0.7,  src: 'twc_form', note: 'Di = 4.59√Vd 反推：24 小時均勻進水、流速 0.7 m/s' },
        dpVel:        { v: 1.6,  src: 'twc_form', note: 'Dp = 6.65√Vd：30 分鐘送 0.1Vd、流速 1.6 m/s' },
        dpMin:        { v: 30,   src: 'twc_form' },
        meterList:    { v: [13,20,25,32,40,50,65,75,100,125,150,200,250,300], src: 'twc_form' },
        vgMinPct:     { v: 20,   src: 'tw_std', note: '§6 蓄水池容量 ≥ 設計用水量 2/10' },
        totMinPct:    { v: 40,   src: 'tw_std', note: '§6 蓄水池＋水塔合計 ≥ 4/10' },
        totMaxDays:   { v: 2,    src: 'tw_std', note: '§6 合計 ≤ 二日用水量' },
        peakK:        { v: 4,    src: 'tw_tech', note: '附錄 1.1：Qp = (3~4)·Qh/60，取上限 4' },
        useHours:     { v: 8,    src: 'tw_tech', note: '附錄 表 A-1：辦公室使用時間 8 小時' },
        resGeneral:   { v: 3.0,  src: 'tw_std', note: '§13／技術規範 3.4.4：一般水栓 ≥ 0.3 kg/cm²（≈3 m）' },
        resFlushValve:{ v: 10.0, src: 'tw_std', note: '§13／技術規範 3.4.4：沖水閥 ≥ 1.0 kg/cm²（≈10 m）' },
        vMax:         { v: 2.0,  src: 'assume', note: '台灣法規未訂給水管流速上限；2.0 m/s 為工程慣用值' },
        hwC:          { v: 130,  src: 'assume', note: '不鏽鋼管舊管保守值' },
        fittingPct:   { v: 30,   src: 'assume', note: '管件當量長度以直管長 30% 估計' },
        pumpEff:      { v: 0.6,  src: 'twc_form' },
        pumpMargin:   { v: 1.1,  src: 'twc_form' },
        hammer:       { v: 0.34, src: 'twc_form', note: '台水表：水錘加重水頭 = (Hs+Hd+Ht)×0.34（僅送審表格式使用）' },
        pressMaxM:    { v: null, src: 'assume' },
        motorList:    { v: 'kW', src: 'assume' },
        potable:      { v: 'tw_potable', src: 'tw_dw' },
      },
    },

    US: {
      id: 'US', flag: '🇺🇸', label: '美國 IPC', status: 'partial', version: 'US-IPC2024-2026.10',
      units: 'US', pipe: 'cu_l', codes: 'IPC 2024（多數州採用；以 AHJ 採用版本與州修正為準）',
      method: { demand: 'per_capita', peak: 'hunter', service: 'velocity', storage: 'autonomy', meter: 'utility' },
      p: {
        perCapLpd:    { v: 75.7, src: 'assume', note: 'IPC 未訂每人日用水量；以 20 gpd/人（75.7 L）為工程假設，請以業主／utility 資料覆寫' },
        designMargin: { v: 1.1,  src: 'assume' },
        vMax:         { v: 2.44, src: 'cda', note: '8 ft/s' },
        resGeneral:   { v: 5.6,  src: 'ipc_604', note: 'Table 604.3 一般器具 8 psi（請以最不利器具查表）' },
        resFlushValve:{ v: 17.6, src: 'ipc_604', note: '沖水閥系統以 25 psi 估計；正式設計請依 Table 604.3 最不利器具' },
        pressMaxM:    { v: 56.2, src: 'ipc_604', note: '§604.8：靜壓 > 80 psi 須設減壓閥' },
        hwC:          { v: 130,  src: 'assume', note: '銅管新管 C≈140~150，取 130 保守' },
        fittingPct:   { v: 30,   src: 'assume' },
        pumpEff:      { v: 0.65, src: 'assume' },
        pumpMargin:   { v: 1.15, src: 'assume' },
        motorList:    { v: 'HP', src: 'assume' },
        potable:      { v: 'us_potable', src: 'epa_143' },
      },
    },

    SG: {
      id: 'SG', flag: '🇸🇬', label: '新加坡', status: 'partial', version: 'SG-PUB2022-2026.10',
      units: 'SI', pipe: 'sus_jis', codes: 'Public Utilities (Water Supply) Regulations · SS 636 · PUB Handbook 2022',
      method: { demand: 'per_capita', peak: 'manual', service: 'velocity', storage: 'pub', meter: 'pub' },
      p: {
        perCapLpd:    { v: 75.7, src: 'assume', note: 'PUB 未於 Handbook 列每人日用水量；以工程假設代入，請以業主資料覆寫' },
        designMargin: { v: 1.1,  src: 'assume' },
        pubHighDays:  { v: 1.0,  src: 'pub_hb', note: '§2.2.2 高位水箱 = 1 日用水量' },
        pubLowFrac:   { v: 0.2,  src: 'pub_hb', note: '§2.2.3 低位水箱 ≥ 1/5 日（進水口 25–30 m AMSL）；> 30 m AMSL 為 1/3' },
        vMax:         { v: 2.0,  src: 'assume' },
        resGeneral:   { v: 3.0,  src: 'assume' },
        resFlushValve:{ v: 10.0, src: 'assume' },
        hwC:          { v: 130,  src: 'assume' },
        fittingPct:   { v: 30,   src: 'assume' },
        pumpEff:      { v: 0.6,  src: 'assume' },
        pumpMargin:   { v: 1.1,  src: 'assume' },
        motorList:    { v: 'kW', src: 'assume' },
        potable:      { v: 'sg_potable', src: 'sg_pub' },
        pubMeter:     { v: [[15,130],[25,700],[50,5000],[100,20000],[150,45000]], src: 'pub_hb', note: '§6.3 建議最大月用水量（m³/月）' },
      },
    },

    EU: {
      id: 'EU', flag: '🇪🇺', label: '歐洲 EN', status: 'preview', version: 'EU-preview',
      units: 'SI', pipe: 'sus_jis', codes: 'EN 806-1~5 給水 · EN 1717 防逆流 · EN 12056 建築排水 · EN 752 場區排水（各國國家附錄另訂）',
      method: { demand: 'per_capita', peak: 'manual', service: 'velocity', storage: 'autonomy', meter: 'utility' },
      p: {
        perCapLpd: { v: 75.7, src: 'assume' }, designMargin: { v: 1.1, src: 'assume' },
        vMax: { v: 2.0, src: 'assume' }, resGeneral: { v: 10, src: 'assume' }, resFlushValve: { v: 10, src: 'assume' },
        hwC: { v: 130, src: 'assume' }, fittingPct: { v: 30, src: 'assume' },
        pumpEff: { v: 0.6, src: 'assume' }, pumpMargin: { v: 1.1, src: 'assume' }, motorList: { v: 'kW', src: 'assume' },
        potable: { v: 'eu_potable', src: 'eu_dwd' },
      },
    },

    MY: { id: 'MY', flag: '🇲🇾', label: '馬來西亞', status: 'preview', version: 'MY-preview', units: 'SI', pipe: 'sus_jis',
      codes: 'SPAN Uniform Technical Guidelines（給水管網與配管）· MS 1525 · 各州水務公司規定',
      method: { demand: 'per_capita', peak: 'manual', service: 'velocity', storage: 'autonomy', meter: 'utility' }, p: null },
    TH: { id: 'TH', flag: '🇹🇭', label: '泰國', status: 'preview', version: 'TH-preview', units: 'SI', pipe: 'sus_jis',
      codes: '建築管制法部令 · EIT（泰國工程學會 วสท.）衛生設備標準 · MWA/PWA 供水規定',
      method: { demand: 'per_capita', peak: 'manual', service: 'velocity', storage: 'autonomy', meter: 'utility' }, p: null },
    VN: { id: 'VN', flag: '🇻🇳', label: '越南', status: 'preview', version: 'VN-preview', units: 'SI', pipe: 'sus_jis',
      codes: 'TCVN 13606:2023 給水管網與構造物 · TCVN 4513 建築內部給水 · QCVN 07:2023/BXD 技術基礎設施',
      method: { demand: 'per_capita', peak: 'manual', service: 'velocity', storage: 'autonomy', meter: 'utility' }, p: null },
  };
  /* 預覽區域沿用 EU 的通用假設參數 */
  const POT = { MY: ['my_potable', 'my_moh'], TH: ['th_potable', 'th_moi'], VN: ['vn_potable', 'assume'] };
['MY', 'TH', 'VN'].forEach(k => { REGIONS[k].p = Object.assign({}, REGIONS.EU.p, { potable: { v: POT[k][0], src: POT[k][1] } }); });

  /* ── 公開版的「AIDC 通用設計基準」：只放公開出處的值 ── */
  const AIDC_BASE = {
    coolHours:   { v: 12, src: 'uptime_mw', note: 'Tier III 12 小時補給水（蒸發式散熱才需要）' },
    domHours:    { v: 24, src: 'assume', note: '生活用水備援時數，工程假設' },
    compartments:{ v: 2,  src: 'assume', note: '水池分 2 格，單格清洗時不斷水（可同時維修）' },
    pumpDuty:    { v: 1,  src: 'assume' },
    pumpStandby: { v: 1,  src: 'assume', note: '1 用 1 備' },
    driftPct:    { v: 0.005, src: 'epa_ct', note: '現代除霧器 < 0.005%' },
    evapRule:    { v: 0.0018, src: 'epa_ct', note: '每 °C 溫差蒸發 0.18% 循環水量（= 每 10°F 1%）' },
    hvacPeak:    { v: 1.25, src: 'assume', note: '空調補水最大時 = 日平均時 × 1.25（無空調組資料時）' },
    minBranchDN: { v: 15, src: 'assume', note: '器具末端接管最小口徑 DN15（常見做法；IPC Table 604.5 對各器具有最小口徑，請依該表覆核）' },
    minFlushDN:  { v: 25, src: 'assume', note: '沖水閥末端接管最小口徑 DN25（1 吋；常見做法，請依閥體廠商與 IPC Table 604.5 覆核）' },
    gradMax:     { v: 5, src: 'assume', note: '摩擦損失梯度 ≤ 5 m/100m（工程慣用值；避免長管路只受流速控制而壓損過大）' },
  };

  const API = { SOURCES, PIPES, HUNTER, FIXTURES_IPC, TW_ZONES, MOTORS_KW, MOTORS_HP, WQ, REGIONS, AIDC_BASE };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.AIDC_PROFILES = API;
})(typeof window !== 'undefined' ? window : globalThis);
