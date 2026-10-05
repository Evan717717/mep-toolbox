/**
 * 零依賴 Office Open XML 產生器（.xlsx / .docx）
 * ------------------------------------------------------------------
 * .xlsx 與 .docx 本質上是 ZIP 包著 XML。這裡用「不壓縮（STORE）」的 ZIP
 * 加上 CRC32 自己打包，不需要任何外部函式庫，離線也能匯出。
 *
 *   OOXML.xlsxFromResult(result, meta) → Uint8Array
 *   OOXML.docxFromResult(result, meta) → Uint8Array
 *
 * Excel 檔的每個計算值都是「活的公式」，並以定義名稱（k_<步驟代碼>）互相引用：
 * 使用者在 Excel 改輸入值（淡黃底格），整份計算書會跟著重算。
 */
(function (root) {
  'use strict';
  const PR = (typeof module !== 'undefined' && module.exports) ? require('./profiles.js') : root.AIDC_PROFILES;
  const { SOURCES } = PR;

  /* ───────── CRC32 + ZIP(STORE) ───────── */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  const enc = s => new TextEncoder().encode(s);

  function zip(files) {            // files: [{name, data(string|Uint8Array)}]
    const parts = [], central = []; let offset = 0;
    const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
    files.forEach(f => {
      const name = enc(f.name), data = typeof f.data === 'string' ? enc(f.data) : f.data;
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    });
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
    let p = 0; all.forEach(a => { out.set(a, p); p += a.length; });
    return out;
  }

  const esc = s => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const srcText = arr => [].concat(arr || []).map(k => (SOURCES[k] ? SOURCES[k].short : (k === 'user' ? '使用者輸入' : k))).join('；');
  const colName = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

  /* ═════════════════════════ XLSX ═════════════════════════ */
  const NEW_FUNCS = ['MINIFS', 'MAXIFS'];
  function xlFormula(xl) {
    let f = xl.replace(/^=/, '').replace(/\{([A-Za-z0-9_]+)\}/g, (m, id) => 'k_' + id);
    NEW_FUNCS.forEach(fn => { f = f.replace(new RegExp('(?<![_.A-Za-z])' + fn + '\\(', 'g'), '_xlfn.' + fn + '('); });
    return f;
  }
  const HUNTER_XL = 'MAX(IFERROR(INDEX(hunter_y,MATCH(k_wsfu,hunter_x,1))+(k_wsfu-INDEX(hunter_x,MATCH(k_wsfu,hunter_x,1)))*(INDEX(hunter_y,MATCH(k_wsfu,hunter_x,1)+1)-INDEX(hunter_y,MATCH(k_wsfu,hunter_x,1)))/(INDEX(hunter_x,MATCH(k_wsfu,hunter_x,1)+1)-INDEX(hunter_x,MATCH(k_wsfu,hunter_x,1))),IF(k_wsfu>=MAX(hunter_x),INDEX(hunter_y,COUNT(hunter_x)),0)),IF(k_wsfu>0,_xlfn.MINIFS(hunter_y,hunter_y,">0"),0))';

  function cell(ref, v, style, formula) {
    const s = style ? ` s="${style}"` : '';
    if (formula) return `<c r="${ref}"${s}><f>${esc(formula)}</f></c>`;
    if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
    if (v === null || v === undefined || v === '') return `<c r="${ref}"${s}/>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  }
  function sheetXml(rows, cols, merges) {
    const colXml = cols ? '<cols>' + cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>' : '';
    const body = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((c, ci) => c ? cell(colName(ci) + (ri + 1), c.v, c.s, c.f) : '').join('') + '</row>').join('');
    const mg = merges && merges.length ? `<mergeCells count="${merges.length}">` + merges.map(m => `<mergeCell ref="${m}"/>`).join('') + '</mergeCells>' : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="5" topLeftCell="A6" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${colXml}<sheetData>${body}</sheetData>${mg}<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  }
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.000"/></numFmts>
<fonts count="4"><font><sz val="10"/><name val="Microsoft JhengHei"/></font><font><b/><sz val="10"/><name val="Microsoft JhengHei"/></font><font><b/><sz val="14"/><name val="Microsoft JhengHei"/></font><font><b/><sz val="10"/><color rgb="FFB91C1C"/><name val="Microsoft JhengHei"/></font></fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF7D6"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/></patternFill></fill></fills>
<borders count="2"><border/><border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom></border></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="9">
<xf/>
<xf fontId="1" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf fontId="2" applyFont="1"/>
<xf numFmtId="164" fillId="2" borderId="1" applyNumberFormat="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fillId="4" borderId="1" applyNumberFormat="1" applyFill="1" applyBorder="1"/>
<xf borderId="1" applyBorder="1"><alignment wrapText="1" vertical="top"/></xf>
<xf fontId="1" applyFont="1"/>
<xf fontId="3" applyFont="1"/>
<xf fontId="1" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/>
</cellXfs></styleSheet>`;

  function xlsxFromResult(R, meta) {
    meta = meta || {};
    const names = [];                 // [name, ref]
    const SH = "'計算書'";
    const rows = [];
    rows.push([{ v: meta.title || 'AIDC 給水水理計算書', s: 2 }]);
    rows.push([{ v: `專案：${meta.project || ''}　文件編號：${meta.docNo || ''}　版次：${meta.rev || ''}`, s: 6 }]);
    rows.push([{ v: `法規區域：${R.regionLabel}（${R.profileVersion}）　引擎 v${R.version}　${R.ownerName ? '業主基準：' + R.ownerName + ' ' + (R.ownerVersion || '') : '未載入業主基準'}　產出：${meta.stamp || ''}`, s: 0 }]);
    rows.push([{ v: meta.status || '初篩版 — 未經工程師覆核，不得作為送審文件', s: 7 }]);
    rows.push(['章節', '項目', '代號', '計算值', '單位', '公式', '代入', '出處', '備註'].map(v => ({ v, s: 1 })));
    let sec = null;
    R.trace.forEach(st => {
      if (st.sec !== sec) { sec = st.sec; rows.push([{ v: sec, s: 6 }]); }
      const r = rows.length + 1, ref = `$D$${r}`;
      let c;
      if (st.kind === 'in') { c = { v: typeof st.v === 'number' ? st.v : String(st.v), s: 3 }; }
      else if (st.kind === 'text') { c = { v: String(st.v), s: 5 }; }
      else if (st.xl === 'HUNTER') { c = { f: HUNTER_XL, s: 4 }; }
      else if (st.xl) { c = { f: xlFormula(st.xl), s: 4 }; }
      else { c = { v: st.v, s: 4 }; }
      if (st.kind !== 'text') names.push(['k_' + st.id, `${SH}!${ref}`]);
      rows.push([{ v: '', s: 5 }, { v: st.label, s: 5 }, { v: st.id, s: 5 }, c, { v: st.unit || '', s: 5 },
        { v: st.kind === 'in' ? '（輸入值，可修改）' : (st.f || ''), s: 5 }, { v: st.sub || '', s: 5 }, { v: srcText(st.src), s: 5 }, { v: st.note || '', s: 5 }]);
    });
    const seen = new Set();
    names.forEach(([n]) => { const k = n.toLowerCase(); if (seen.has(k)) throw new Error('Excel 定義名稱重複（不分大小寫）：' + n); seen.add(k); });
    const sheet1 = sheetXml(rows, [6, 34, 12, 14, 9, 48, 34, 26, 30]);

    /* 查表 */
    const t2 = [[{ v: '查表資料（計算書公式引用）', s: 2 }], [{ v: '' }], [{ v: '' }], [{ v: '' }], []];
    const tnames = Object.keys(R.tables);
    t2[4] = tnames.map(n => ({ v: n, s: 1 }));
    const maxLen = Math.max(0, ...tnames.map(n => R.tables[n].length));
    for (let i = 0; i < maxLen; i++) t2.push(tnames.map(n => (i < R.tables[n].length ? { v: R.tables[n][i], s: 5 } : null)));
    tnames.forEach((n, ci) => names.push([n, `'查表'!$${colName(ci)}$6:$${colName(ci)}$${5 + R.tables[n].length}`]));
    const sheet2 = sheetXml(t2, tnames.map(() => 14));

    /* 檢核與出處 */
    const t3 = [[{ v: '檢核結果與出處', s: 2 }], [{ v: '' }], [{ v: '' }], [{ v: '' }], ['等級', '訊息', '出處'].map(v => ({ v, s: 1 }))];
    const lv = { pass: '通過', fail: '不合格', warn: '注意', info: '說明' };
    R.checks.forEach(c => t3.push([{ v: lv[c.level] || c.level, s: 5 }, { v: c.msg, s: 5 }, { v: srcText(c.src), s: 5 }]));
    t3.push([]); t3.push([{ v: '出處清單', s: 6 }]);
    const usedSrc = new Set(); R.trace.forEach(s => s.src.forEach(k => usedSrc.add(k))); R.checks.forEach(c => c.src.forEach(k => usedSrc.add(k)));
    [...usedSrc].filter(k => SOURCES[k]).forEach(k => t3.push([{ v: SOURCES[k].short, s: 5 }, { v: SOURCES[k].full, s: 5 }, { v: SOURCES[k].url || '', s: 5 }]));
    const sheet3 = sheetXml(t3, [10, 100, 50]);

    const extra = [];
    const ns = netSheet(R, names); if (ns) extra.push(['管徑表', ns]);
    extra.push(['水質與設備報價', wqSheet(R)]);
    return pack([['計算書', sheet1]].concat(extra, [['查表', sheet2], ['檢核與出處', sheet3]]), names);
  }

  function pack(sheets, names) {
    const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s[0])}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${names.length ? `<definedNames>${names.map(([n, ref]) => `<definedName name="${n}">${esc(ref)}</definedName>`).join('')}</definedNames>` : ''}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
    const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
    const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
    return zip([
      { name: '[Content_Types].xml', data: ct }, { name: '_rels/.rels', data: rels },
      { name: 'xl/workbook.xml', data: wb }, { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
      { name: 'xl/styles.xml', data: STYLES },
      ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s[1] })),
    ]);
  }


  const LVT = { required: '必須編列', likely: '建議編列', confirm: '請廠商確認', none: '不需要' };
  const stT = ok => ok === null || ok === undefined ? '未提供' : ok ? '符合' : '超過';
  const fmtN = x => (typeof x === 'number' && isFinite(x)) ? x : '';
  /* 系統昇位管徑表：流量與管長為輸入格，需求內徑、採用內徑、流速、摩擦損失皆為活公式 */
  function netSheet(R, names) {
    const n = R.net; if (!n) return null;
    const rows = [];
    rows.push([{ v: '給水管徑表（系統昇位）', s: 2 }]);
    rows.push([{ v: `管材：${n.cat}；流速上限、摩擦梯度上限、C 值、管件加成引用「計算書」頁的 p_vmax／p_grad／p_c／p_fit（改那些輸入格，本表自動重算）`, s: 0 }]);
    rows.push([{ v: '流量與管長為淡黃色輸入格；立管與橫支管流量為 Hunter／負荷占比的計算結果（以值貼入）；器具末端接管採最小口徑規則（採用內徑為固定值）。', s: 0 }]);
    rows.push([]);
    rows.push(['編號', '管段', '類別', '流量 Q（L/min）', '管長 L（m）', '需求內徑（mm）', '採用管', '採用內徑 ID（mm）', 'DN', '流速 v（m/s）', '摩擦損失 hf（m）', '梯度（m/100m）', '流量依據'].map(v => ({ v, s: 1 })));
    const kindT = { service: '引入', main: '幹管', riser: '立管', branch: '橫支管', terminal: '末端' };
    n.segs.forEach(sg => {
      const r = rows.length + 1, has = sg.Q !== null && sg.Q !== undefined;
      const row = [{ v: sg.id, s: 5 }, { v: sg.name, s: 5 }, { v: kindT[sg.kind] || sg.kind, s: 5 }, has ? { v: sg.Q, s: 3 } : { v: '—', s: 5 }, { v: sg.L, s: 3 }];
      if (has) {
        row.push({ f: `IF(D${r}>0,MAX(1000*SQRT(4*D${r}/60000/(PI()*k_p_vmax)),IF(k_p_grad>0,1000*(10.67*(D${r}/60000)^1.852/(k_p_c^1.852*k_p_grad/100))^(1/4.87),0)),0)`, s: 4 });
        row.push({ v: sg.pipe, s: 5 });
        if (sg.rule === 'size') row.push({ f: `MAX(_xlfn.MINIFS(pipe_ids,pipe_ids,">="&F${r}),${sg.minID || 0})`, s: 4 });
        else row.push({ v: sg.ID, s: 3 });
        row.push({ v: sg.dn, s: 5 });
        row.push({ f: `IF(AND(D${r}>0,H${r}>0),D${r}/60000/(PI()/4*(H${r}/1000)^2),0)`, s: 4 });
        row.push({ f: `IF(AND(D${r}>0,H${r}>0,E${r}>0),10.67*E${r}*(1+k_p_fit/100)*(D${r}/60000)^1.852/(k_p_c^1.852*(H${r}/1000)^4.87),0)`, s: 4 });
        row.push({ f: `IF(E${r}>0,K${r}/(E${r}*(1+k_p_fit/100))*100,0)`, s: 4 });
      } else { row.push({ v: '—', s: 5 }, { v: sg.pipe, s: 5 }, { v: sg.ID, s: 3 }, { v: sg.dn, s: 5 }, { v: '—', s: 5 }, { v: '—', s: 5 }, { v: '—', s: 5 }); }
      row.push({ v: sg.basis, s: 5 });
      rows.push(row);
    });
    if (n.profile.length) {
      rows.push([]); rows.push([{ v: '各層末端可用壓力（以值列出）', s: 6 }]);
      rows.push(['樓層', '末端標高（m）', '路徑摩擦損失（m）', '可用壓力（m）', '所需壓力（m）', '判定'].map(v => ({ v, s: 1 })));
      n.profile.forEach(p => rows.push([{ v: p.floor + 'F', s: 5 }, { v: p.z, s: 4 }, { v: p.hf, s: 4 }, { v: p.avail, s: 4 }, { v: n.check.need, s: 4 }, { v: p.avail + 1e-9 >= n.check.need ? '足夠' : '不足', s: 5 }]));
    }
    return sheetXml(rows, [8, 34, 9, 14, 11, 14, 12, 14, 7, 12, 14, 14, 50]);
  }
  /* 水質與設備報價（靜態文字）：可直接附在詢價文件 */
  function wqSheet(R) {
    const w = R.wq, rows = [];
    rows.push([{ v: '水處理設備報價提醒', s: 2 }]);
    rows.push([{ v: '「必須編列」不得以選項報價；「請廠商確認」項目由廠商依原水報告判定並書面回覆。', s: 0 }]);
    rows.push([]); rows.push([]);
    rows.push(['設備／系統', '建議', '原因（原水對基準）', '依據', '廠商回覆：是否編列／規格／數量'].map(v => ({ v, s: 1 })));
    w.plan.forEach(p => rows.push([{ v: p.name, s: 5 }, { v: LVT[p.level], s: 5 }, { v: p.reason, s: 5 }, { v: srcText(p.src), s: 5 }, { v: '', s: 3 }]));
    rows.push([]); rows.push([{ v: '各用途水質比對', s: 6 }]);
    w.systems.forEach(sy => {
      rows.push([{ v: `${sy.label}　${sy.basis}`, s: 6 }]);
      if (sy.rows.length) {
        const ho = sy.rows.some(r => r.ownerLimit);
        rows.push(['項目', '原水', '基準', '判定'].concat(ho ? ['業主基準', '判定'] : []).map(v => ({ v, s: 1 })));
        sy.rows.forEach(r => rows.push([{ v: r.label + (r.unit ? `（${r.unit}）` : ''), s: 5 }, r.v === null ? { v: '—', s: 5 } : { v: r.v, s: 4 }, { v: r.limit, s: 5 }, { v: stT(r.ok), s: 5 }].concat(ho ? [{ v: r.ownerLimit || '—', s: 5 }, { v: r.ownerLimit ? stT(r.ownerOk) : '—', s: 5 }] : [])));
      }
    });
    rows.push([]); rows.push([{ v: '各國飲用水標準比對', s: 6 }]);
    const cmp = w.compare;
    rows.push(['項目'].concat(cmp.map(c => c.label)).map(v => ({ v, s: 1 })));
    const keys = []; cmp.forEach(c => c.rows.forEach(r => { if (!keys.find(k => k[0] === r.k)) keys.push([r.k, r.label]); }));
    keys.forEach(([k, lb]) => rows.push([{ v: lb, s: 5 }].concat(cmp.map(c => { const r = c.rows.find(x => x.k === k); return { v: r ? `${r.limit} ${r.ok === null ? '' : r.ok ? '✓' : '✕'}` : '—', s: 5 }; }))));
    rows.push([]); rows.push([{ v: '出處', s: 6 }]);
    cmp.forEach(c => rows.push([{ v: c.label, s: 5 }, { v: srcText(c.src), s: 5 }]));
    return sheetXml(rows, [40, 14, 70, 34, 34, 20, 20]);
  }
  function xlsxWQ(R, meta) {
    meta = meta || {};
    return pack([['水質與設備報價', wqSheet(R)]], []);
  }

  /* ═════════════════════════ DOCX ═════════════════════════ */
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const run = (t, o) => { o = o || {}; return `<w:r><w:rPr>${o.b ? '<w:b/>' : ''}${o.color ? `<w:color w:val="${o.color}"/>` : ''}${o.sz ? `<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>` : ''}${o.mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : ''}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`; };
  const para = (t, o) => { o = o || {}; return `<w:p><w:pPr>${o.style ? `<w:pStyle w:val="${o.style}"/>` : ''}${o.align ? `<w:jc w:val="${o.align}"/>` : ''}<w:spacing w:after="${o.after === undefined ? 80 : o.after}"/></w:pPr>${Array.isArray(t) ? t.join('') : run(t, o)}</w:p>`; };
  /* 圖片（PNG）：寬度縮放到 9600 dxa（約 16.9 cm）以內；media 收集在 media 陣列，由 docxPackage 一併封裝 */
  function imagePara(im, media) {
    const idx = media.length + 1, rid = 'rIdImg' + idx;
    media.push({ name: `word/media/image${idx}.png`, data: im.png, rid, target: `media/image${idx}.png` });
    const maxEmu = 9600 / 1440 * 914400;
    const cx = Math.round(Math.min(maxEmu, im.w * 9525)), cy = Math.round(cx * im.h / im.w);
    const cap = im.title ? para(im.title, { b: true, sz: 18, after: 40 }) : '';
    return cap + `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${idx}" name="圖 ${idx}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${idx}" name="image${idx}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  }
  function table(rows, widths, header) {
    const grid = widths.map(w => `<w:gridCol w:w="${w}"/>`).join('');
    const tr = (cells, isHead) => `<w:tr>${isHead ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.map((c, i) => `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/>${isHead ? '<w:shd w:val="clear" w:color="auto" w:fill="E2E8F0"/>' : (c && c.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${c.fill}"/>` : '')}</w:tcPr>${para(typeof c === 'object' && c !== null ? c.t : c, { b: isHead || (c && c.b), sz: 17, after: 0, mono: c && c.mono, color: c && c.color })}</w:tc>`).join('')}</w:tr>`;
    return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${header ? tr(header, true) : ''}${rows.map(r => tr(r, false)).join('')}</w:tbl>`;
  }
  const fmtV = (v, st) => typeof v === 'number' ? (isFinite(v) ? (Math.abs(v) >= 1000 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(st && st.fmt !== undefined ? st.fmt : 3) : v.toPrecision(4)) : '—') : String(v);

  function docxFromResult(R, meta) {
    meta = meta || {};
    const b = [];
    if (meta.status) b.push(para(meta.status, { color: 'B91C1C', b: true, align: 'center' }));
    b.push(para(meta.title || 'AIDC 給水水理計算書', { style: 'Title' }));
    b.push(table([
      ['專案名稱', meta.project || '', '文件編號', meta.docNo || ''],
      ['版次', meta.rev || '', '產出時間', meta.stamp || ''],
      ['法規區域', `${R.regionLabel}（${R.profileVersion}）`, '計算引擎', `v${R.version}`],
      ['業主設計基準', R.ownerName ? `${R.ownerName} ${R.ownerVersion || ''}` : '未載入（僅法規與公開基準）', '重算連結', meta.link ? '見文末' : '—'],
    ], [1600, 3200, 1600, 3200]));
    b.push(para('', { after: 120 }));
    b.push(para('結果摘要', { style: 'Heading1' }));
    (meta.summary || []).forEach(s => b.push(para([run(s[0] + '：', { b: true }), run(s[1])])));
    (meta.schedules || []).forEach(t => {
      b.push(para(t.title, { style: 'Heading1' }));
      const n = t.rows[0].length, w = Array(n).fill(Math.floor(9600 / n));
      b.push(table(t.rows.slice(1), w, t.rows[0]));
    });
    const media = [];
    (meta.images || []).forEach(im => { if (im && im.png) b.push(imagePara(im, media)); });
    let sec = null, buf = [];
    const flush = () => { if (buf.length) { b.push(table(buf, [2300, 2700, 2200, 1200, 700, 1300], ['項目', '公式', '代入', '結果', '單位', '出處'])); buf = []; } };
    R.trace.forEach(st => {
      if (st.sec !== sec) { flush(); sec = st.sec; b.push(para(sec, { style: 'Heading1' })); }
      const isIn = st.kind === 'in';
      buf.push([{ t: st.label, b: !isIn }, isIn ? { t: '輸入', color: '64748B' } : { t: st.f || '', mono: false }, { t: st.sub || '', mono: true },
        { t: fmtV(st.v, st), b: true, fill: isIn ? 'FFF7D6' : 'DCFCE7' }, st.unit || '', srcText(st.src)]);
    });
    flush();
    b.push(para('檢核結果', { style: 'Heading1' }));
    const lv = { pass: ['✓ 通過', '15803D'], fail: ['✕ 不合格', 'B91C1C'], warn: ['! 注意', 'B45309'], info: ['i 說明', '1D4ED8'] };
    b.push(table(R.checks.map(c => [{ t: (lv[c.level] || [c.level])[0], color: (lv[c.level] || [])[1], b: true }, c.msg, srcText(c.src)]), [1200, 6400, 2000], ['等級', '內容', '出處']));
    b.push(para('出處清單', { style: 'Heading1' }));
    const usedSrc = new Set(); R.trace.forEach(s => s.src.forEach(k => usedSrc.add(k))); R.checks.forEach(c => c.src.forEach(k => usedSrc.add(k)));
    const tierLabel = { law: '法規', std: '標準／技術規範', gov: '主管機關文件', guide: '產業指引', phys: '物理推導', assume: '工程假設', owner: '業主基準' };
    [...usedSrc].filter(k => SOURCES[k]).forEach(k => b.push(para([run(`［${tierLabel[SOURCES[k].tier]}］`, { b: true }), run(SOURCES[k].full + (SOURCES[k].url ? '　' + SOURCES[k].url : ''))])));
    if (meta.link) { b.push(para('重算連結', { style: 'Heading1' })); b.push(para(meta.link, { mono: true, sz: 14 })); }
    b.push(para('', { after: 200 }));
    b.push(table([['核算 Designed', '審核 Checked', '核定 Approved'], ['\n\n', '\n\n', '\n\n']], [3200, 3200, 3200]));
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${b.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="900" w:bottom="1000" w:left="900" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    return docxPackage(doc, media);
  }

  function docxPackage(doc, media) {
    media = media || [];
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft JhengHei"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US" w:eastAsia="zh-TW"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="200"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="0F766E"/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CBD5E1"/><w:left w:val="single" w:sz="4" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:color="CBD5E1"/><w:insideV w:val="single" w:sz="4" w:color="CBD5E1"/></w:tblBorders><w:tblCellMar><w:left w:w="70" w:type="dxa"/><w:right w:w="70" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;
    const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${media.length ? '<Default Extension="png" ContentType="image/png"/>' : ''}</Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
    const drels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${media.map(m => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${m.target}"/>`).join('')}</Relationships>`;
    return zip([
      { name: '[Content_Types].xml', data: ct }, { name: '_rels/.rels', data: rels },
      { name: 'word/document.xml', data: doc }, { name: 'word/_rels/document.xml.rels', data: drels },
      { name: 'word/styles.xml', data: styles },
    ].concat(media.map(m => ({ name: m.name, data: m.data }))));
  }

  /* 通用區塊 → Word（水質基準書、規範書用） */
  function docxFromBlocks(blocks) {
    const b = [], media = [];
    blocks.forEach(k => {
      if (k.image) b.push(imagePara(k.image, media));
      else if (k.title) b.push(para(k.title, { style: 'Title' }));
      else if (k.h) b.push(para(k.h, { style: 'Heading1' }));
      else if (k.warn) b.push(para(k.warn, { color: 'B91C1C', b: true, align: 'center' }));
      else if (k.list) k.list.forEach((t, i) => b.push(para(`${i + 1}. ${t}`)));
      else if (k.table && k.table.length) {
        const n = Math.max(...k.table.map(r => r.length));
        const w = Array(n).fill(Math.floor(9600 / n));
        const rows = k.table.map(r => { const c = r.slice(); while (c.length < n) c.push(''); return c; });
        b.push(table(rows.slice(1), w, rows[0]));
        b.push(para('', { after: 60 }));
      } else if (k.p !== undefined) b.push(para(k.p));
    });
    return wrapDocx(b, media);
  }
  function wrapDocx(b, media) {
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${b.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="900" w:bottom="1000" w:left="900" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    return docxPackage(doc, media);
  }

  const API = { zip, crc32, xlsxFromResult, xlsxWQ, docxFromResult, docxFromBlocks, xlFormula };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.AIDC_OOXML = API;
})(typeof window !== 'undefined' ? window : globalThis);
