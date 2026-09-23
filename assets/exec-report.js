// assets/exec-report.js — tombol "Unduh Laporan Eksekutif (PPTX)" di Control Tower
//
// Membuat file .pptx di browser (lewat pptxgenjs) berisi ringkasan KPI keempat zona
// (Stock FG, Logistics, FEFO, Warehouse Productivity) + tren bulanan + daftar prioritas —
// dari data LIVE yang sama dipakai dashboard (/api/kpi, /api/analisis).
//
// Ditulis sengaja BERDIRI SENDIRI (tidak bergantung ke variabel internal app.js/analisis.js):
// mengambil datanya sendiri dari /api/kpi & /api/analisis, format angkanya sendiri. Lebih
// banyak baris kode, tapi tidak rapuh kalau app.js/analisis.js berubah struktur internalnya.
//
// PRINSIP PENTING: laporan ini untuk dibaca pimpinan, jadi TIDAK BOLEH menampilkan angka
// simulasi seolah-olah data asli (beda dengan tampilan dashboard live, yang boleh jatuh ke
// simulasi supaya layar tidak kosong). Kalau satu zona gagal dimuat live, slide zona itu
// tegas menyatakan "data tidak tersedia" — bukan menampilkan angka palsu.

(function () {
  'use strict';

  if (typeof PptxGenJS === 'undefined') {
    console.error('exec-report.js: pptxgenjs belum termuat.');
    return;
  }

  function $(id) { return document.getElementById(id); }

  // ---------- format angka (duplikat sengaja dari app.js, lihat catatan di atas) ----------
  function fmtInt(n) { return Math.round(Number(n) || 0).toLocaleString('id-ID'); }
  function fmtPct(n, d) { d = d === undefined ? 1 : d; return (Number(n) || 0).toFixed(d).replace('.', ','); }
  function fmtHM(mins) {
    var m = Number(mins) || 0;
    var h = Math.floor(m / 60), mm = Math.round(m % 60);
    return (h > 0 ? h + 'j ' : '') + mm + 'm';
  }
  function fmtM3(liter) { return fmtInt((Number(liter) || 0) / 1000) + ' m³'; }
  function fmtRupiah(n) {
    var v = Number(n) || 0;
    if (Math.abs(v) >= 1e12) return 'Rp ' + (v / 1e12).toFixed(2).replace('.', ',') + ' T';
    if (Math.abs(v) >= 1e9) return 'Rp ' + (v / 1e9).toFixed(2).replace('.', ',') + ' M';
    if (Math.abs(v) >= 1e6) return 'Rp ' + (v / 1e6).toFixed(1).replace('.', ',') + ' jt';
    return 'Rp ' + fmtInt(v);
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  function fMonth(s) {
    var m = /^(\d{4})-(\d{2})/.exec(String(s || ''));
    return m ? MONTHS[(+m[2]) - 1] + ' ' + m[1].slice(2) : String(s || '');
  }

  // ---------- palet warna (cetak-ramah: latar terang, aksen biru khas dashboard) ----------
  var C = {
    dark: '111827', panel: '17202B', accent: '2E6BC7', accentSoft: 'DCE8FA',
    text: '1F2937', muted: '667080', good: '1D9A63', goodBg: 'E4F6ED',
    warn: 'B4780A', warnBg: 'FCEFD8', bad: 'C23B34', badBg: 'FBE4E2',
    border: 'E2E6EA', lightBg: 'F5F7F9', white: 'FFFFFF'
  };
  function statusColor(cls) { return cls === 'good' ? C.good : cls === 'warn' ? C.warn : C.bad; }
  function statusBg(cls) { return cls === 'good' ? C.goodBg : cls === 'warn' ? C.warnBg : C.badBg; }
  function classify(val, warnBelow, badBelow, invert) {
    if (invert) { if (val >= badBelow) return 'bad'; if (val >= warnBelow) return 'warn'; return 'good'; }
    if (val <= badBelow) return 'bad'; if (val <= warnBelow) return 'warn'; return 'good';
  }

  // ---------- ambil data live (mandiri, tidak bergantung ke state app.js) ----------
  async function authedFetch(url) {
    if (window.SCM_AUTH_READY) await window.SCM_AUTH_READY;
    var doFetch = (window.SCM_AUTH && window.SCM_AUTH.authFetch) || fetch;
    var res = await doFetch(url, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' });
    var json = null;
    try { json = await res.json(); } catch (_) { /* bukan JSON */ }
    if (!res.ok) throw new Error((json && json.error) || ('HTTP ' + res.status));
    return json;
  }

  async function loadKpiZones() {
    var json = await authedFetch('/api/kpi');
    if (!json || !json.ok) throw new Error((json && json.error) || 'Respons /api/kpi tidak valid.');
    return json.zones || {};
  }

  async function loadTrenBulanan() {
    try {
      var json = await authedFetch('/api/analisis');
      if (!json || !json.ok || !json.data) return [];
      var rows = json.data.tren || [];
      return rows.filter(function (r) { return r.dimensi === 'TOTAL'; })
        .sort(function (a, b) { return String(a.bulan).localeCompare(String(b.bulan)); });
    } catch (e) {
      console.warn('exec-report.js: gagal ambil tren bulanan, slide tren dilewati.', e.message);
      return [];
    }
  }

  // ---------- status / pesan UI ----------
  function showMsg(kind, html) {
    var el = $('execReportMsg');
    if (!el) return;
    el.className = 'up-msg show ' + kind;
    el.innerHTML = html;
  }
  function setBusy(busy) {
    var b = $('execReportBtn');
    if (!b) return;
    b.disabled = busy;
    b.textContent = busy ? 'Menyiapkan laporan…' : '⬇ Unduh Laporan Eksekutif (PPTX)';
  }

  // ---------- pembangun elemen slide yang berulang ----------
  function addFooter(slide, pptx, pageLabel) {
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 7.13, w: '100%', h: 0.02, fill: { color: C.border }, line: { type: 'none' } });
    slide.addText('SCM Control Tower — Laporan Eksekutif', { x: 0.4, y: 7.18, w: 8, h: 0.3, fontSize: 8, color: C.muted, fontFace: 'Arial' });
    slide.addText(pageLabel || '', { x: 10.5, y: 7.18, w: 2.4, h: 0.3, fontSize: 8, color: C.muted, align: 'right', fontFace: 'Arial' });
  }
  function addSectionHeader(slide, pptx, title, subtitle) {
    slide.background = { color: C.white };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: C.accent }, line: { type: 'none' } });
    slide.addText(title, { x: 0.55, y: 0.35, w: 12.3, h: 0.6, fontSize: 24, bold: true, color: C.dark, fontFace: 'Arial' });
    if (subtitle) slide.addText(subtitle, { x: 0.55, y: 0.88, w: 12.3, h: 0.4, fontSize: 12.5, color: C.muted, fontFace: 'Arial' });
  }
  function kpiTable(slide, pptx, rows, opts) {
    // rows: [[label, value, statusClsOrNull], ...]
    var body = rows.map(function (r) {
      var valColor = r[2] ? statusColor(r[2]) : C.text;
      return [
        { text: r[0], options: { color: C.muted, fontSize: 11, fontFace: 'Arial', valign: 'middle' } },
        { text: r[1], options: { color: valColor, fontSize: 13, bold: true, fontFace: 'Arial', valign: 'middle', align: 'right' } }
      ];
    });
    slide.addTable(body, Object.assign({
      x: 0.55, y: 1.5, w: 5.7, colW: [3.5, 2.2],
      border: { type: 'solid', color: C.border, pt: 0.75 },
      autoPage: false, rowH: 0.42
    }, opts || {}));
  }
  function insightBox(slide, text, opts) {
    slide.addShape('roundRect', Object.assign({
      x: 6.6, y: 1.5, w: 6.15, h: 3.2, fill: { color: C.lightBg }, line: { color: C.border, width: 0.75 }, rectRadius: 0.08
    }, opts && opts.box));
    slide.addText([{ text: 'Insight  ', options: { bold: true, color: C.accent } }, { text: text, options: { color: C.text } }],
      Object.assign({ x: 6.9, y: 1.72, w: 5.6, h: 2.8, fontSize: 12, fontFace: 'Arial', valign: 'top', lineSpacingMultiple: 1.3 }, opts && opts.text));
  }
  function unavailableSlide(pptx, title, errMsg) {
    var slide = pptx.addSlide();
    addSectionHeader(slide, pptx, title, 'Data tidak tersedia saat laporan dibuat');
    slide.addShape('roundRect', { x: 0.55, y: 2.2, w: 12.2, h: 1.6, fill: { color: C.badBg }, line: { color: C.bad, width: 1 }, rectRadius: 0.08 });
    slide.addText([
      { text: '⚠ Zona ini tidak bisa dimuat live saat laporan dibuat.\n', options: { bold: true, color: C.bad, fontSize: 14 } },
      { text: errMsg || 'Penyebab tidak diketahui.', options: { color: C.text, fontSize: 11.5 } }
    ], { x: 0.85, y: 2.4, w: 11.6, h: 1.2, fontFace: 'Arial', valign: 'top' });
    addFooter(slide, pptx, title);
    return slide;
  }

  // ---------- slide builders per zona ----------
  function slideRingkasan(pptx, zones, sessionEmail) {
    var slide = pptx.addSlide();
    slide.background = { color: C.white };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: C.accent }, line: { type: 'none' } });
    slide.addText('Ringkasan & Prioritas Eksekutif', { x: 0.55, y: 0.35, w: 12.3, h: 0.6, fontSize: 24, bold: true, color: C.dark, fontFace: 'Arial' });
    slide.addText('Skor kesehatan gabungan dan isu paling urgent lintas zona, per saat laporan dibuat.', { x: 0.55, y: 0.88, w: 12.3, h: 0.4, fontSize: 12.5, color: C.muted, fontFace: 'Arial' });

    var comps = [];
    if (zones.stock && zones.stock.status === 'live') comps.push(zones.stock.data.health_pct || 0);
    if (zones.logistics && zones.logistics.status === 'live') comps.push(zones.logistics.data.sla_pct || 0);
    if (zones.fefo && zones.fefo.status === 'live') comps.push(zones.fefo.data.compliance_pct || 0);
    var score = comps.length ? (comps.reduce(function (a, b) { return a + b; }, 0) / comps.length) : null;
    var scoreCls = score === null ? 'bad' : classify(score, 70, 50, false);

    slide.addShape('roundRect', { x: 0.55, y: 1.5, w: 3.6, h: 2.3, fill: { color: statusBg(scoreCls) }, line: { color: statusColor(scoreCls), width: 1 }, rectRadius: 0.1 });
    slide.addText(score === null ? '—' : Math.round(score) + '', { x: 0.55, y: 1.65, w: 3.6, h: 1.3, fontSize: 54, bold: true, align: 'center', color: statusColor(scoreCls), fontFace: 'Arial' });
    slide.addText('Skor Kesehatan Gabungan' + (comps.length < 3 ? ' (dari ' + comps.length + '/3 zona live)' : ''), { x: 0.55, y: 2.95, w: 3.6, h: 0.7, fontSize: 11, align: 'center', color: C.muted, fontFace: 'Arial' });

    var zoneLabels = { stock: 'Stock FG', logistics: 'Logistics', fefo: 'FEFO', warehouse: 'Warehouse' };
    var statusRows = Object.keys(zoneLabels).map(function (k) {
      var z = zones[k];
      var live = z && z.status === 'live';
      return [
        { text: zoneLabels[k], options: { color: C.text, fontSize: 11, bold: true, fontFace: 'Arial', valign: 'middle' } },
        { text: live ? '● LIVE' : '● TIDAK TERSEDIA', options: { color: live ? C.good : C.bad, fontSize: 10.5, fontFace: 'Arial', valign: 'middle', align: 'right' } }
      ];
    });
    slide.addTable(statusRows, { x: 4.45, y: 1.5, w: 3.4, colW: [2.1, 1.3], border: { type: 'solid', color: C.border, pt: 0.75 }, rowH: 0.42, autoPage: false });

    var items = [];
    if (zones.stock && zones.stock.status === 'live') {
      var s = zones.stock.data;
      if ((s.forecast_accuracy_pct || 0) < 40) items.push(['Stock FG', 'Akurasi forecast hanya ' + fmtPct(s.forecast_accuracy_pct) + '% (' + fmtInt(s.forecast_covered_sku) + '/' + fmtInt(s.total_sku) + ' SKU tercakup) — berisiko membuat rencana produksi/stok meleset.']);
      if ((s.capacity_util_pct || 0) >= 90) items.push(['Stock FG', 'Kapasitas gudang ' + fmtPct(s.capacity_util_pct) + '% terpakai (' + fmtInt(s.pallet_used) + '/' + fmtInt(s.pallet_total) + ' pallet) — butuh realokasi/pengiriman segera.']);
    }
    if (zones.logistics && zones.logistics.status === 'live') {
      var l = zones.logistics.data;
      if ((l.sla_pct || 0) < 70) items.push(['Logistics', 'SLA loading hanya ' + fmtPct(l.sla_pct, 0) + '% — ' + fmtInt(l.over_sla_count) + ' dari ' + fmtInt(l.total_shipment) + ' pengiriman lewat target 90 menit.']);
    }
    if (zones.fefo && zones.fefo.status === 'live') {
      var f = zones.fefo.data;
      if ((f.violation_count || 0) > 0) items.push(['FEFO', fmtInt(f.violation_count) + ' pelanggaran urutan FEFO pasti tercatat, kepatuhan keseluruhan ' + fmtPct(f.compliance_pct) + '%.']);
    }
    if (!items.length) items.push(['Sistem', 'Semua indikator berada dalam batas aman pada zona yang berhasil dimuat live.']);

    slide.addText('Prioritas Eksekutif', { x: 0.55, y: 4.15, w: 6, h: 0.35, fontSize: 13, bold: true, color: C.dark, fontFace: 'Arial' });
    var priText = items.slice(0, 5).map(function (it) {
      return [{ text: '● ' + it[0] + '  ', options: { bold: true, color: C.accent, breakLine: false, fontSize: 11.5 } },
      { text: it[1] + '\n', options: { color: C.text, fontSize: 11.5 } }];
    });
    var flat = []; priText.forEach(function (pair) { flat.push(pair[0], pair[1]); });
    slide.addText(flat, { x: 0.55, y: 4.55, w: 12.2, h: 2.3, fontFace: 'Arial', valign: 'top', lineSpacingMultiple: 1.35 });

    addFooter(slide, pptx, 'Ringkasan');
    return slide;
  }

  function slideStock(pptx, zone) {
    if (!zone || zone.status !== 'live') return unavailableSlide(pptx, 'Stock FG', zone && zone.error);
    var d = zone.data;
    var slide = pptx.addSlide();
    addSectionHeader(slide, pptx, 'Stock FG', 'Kesehatan stok, akurasi forecast, dan utilisasi kapasitas gudang');
    var health = d.health_pct || 0, fc = d.forecast_accuracy_pct || 0, cap = d.capacity_util_pct || 0;
    kpiTable(slide, pptx, [
      ['Kesehatan stok', fmtPct(health) + '%', classify(health, 60, 40, false)],
      ['SKU aman', fmtInt(d.safe_sku) + ' / ' + fmtInt(d.total_sku), null],
      ['Akurasi forecast', fmtPct(fc) + '%', classify(fc, 60, 30, false)],
      ['Kapasitas gudang terpakai', fmtPct(cap) + '%', classify(cap, 85, 95, true)],
      ['Pallet terpakai', fmtInt(d.pallet_used) + ' / ' + fmtInt(d.pallet_total), null],
      ['Total stok', fmtInt(d.total_stock_unit) + ' unit', null],
      ['Perubahan vs kemarin', (d.stock_change_pct >= 0 ? '▲' : '▼') + fmtPct(Math.abs(d.stock_change_pct || 0)) + '%', null],
      ['Volume stok', fmtM3(d.total_volume_stok_l), null]
    ]);
    var insight;
    if (cap > 100) insight = 'Stok terpakai (' + fmtInt(d.pallet_used) + ' pallet) sudah melampaui kapasitas tercatat (' + fmtInt(d.pallet_total) + ' pallet) — indikasi ada stok di luar area yang belum tercatat di data kapasitas.';
    else if (cap >= 95 && fc < 30) insight = 'Kapasitas gudang mendekati penuh (' + fmtPct(cap) + '%) dan akurasi forecast rendah (' + fmtPct(fc) + '%) — kombinasi ini berisiko memperbesar selisih stok kelas A.';
    else if (health < 50) insight = 'Hanya ' + fmtInt(d.safe_sku) + ' dari ' + fmtInt(d.total_sku) + ' SKU dalam kondisi aman — perlu peninjauan replenishment.';
    else insight = 'Kesehatan stok ' + fmtPct(health) + '% dengan utilisasi gudang ' + fmtPct(cap) + '% — kondisi terkendali, tetap pantau SKU kelas A.';
    insightBox(slide, insight);
    addFooter(slide, pptx, 'Stock FG');
    return slide;
  }

  function slideLogistics(pptx, zone) {
    if (!zone || zone.status !== 'live') return unavailableSlide(pptx, 'Logistics', zone && zone.error);
    var d = zone.data;
    var slide = pptx.addSlide();
    addSectionHeader(slide, pptx, 'Logistics', 'Kepatuhan SLA loading dan pemanfaatan armada');
    var sla = d.sla_pct || 0;
    var overPct = d.total_shipment > 0 ? (d.over_sla_count / d.total_shipment * 100) : 0;
    var volPerVeh = (d.total_vehicle_count > 0) ? (d.total_volume_muat_l / d.total_vehicle_count) : 0;
    kpiTable(slide, pptx, [
      ['SLA loading (≤90 menit)', fmtPct(sla, 0) + '%', classify(sla, 80, 60, false)],
      ['Total pengiriman', fmtInt(d.total_shipment) + ' unit', null],
      ['Rata-rata loading', fmtHM(d.avg_load_minutes), null],
      ['Loading terlama', fmtHM(d.longest_load_minutes), d.longest_load_minutes > 240 ? 'bad' : (d.longest_load_minutes > 120 ? 'warn' : 'good')],
      ['Rata-rata waktu tunggu', fmtHM(d.avg_wait_minutes || 0), classify(d.avg_wait_minutes || 0, 20, 45, true)],
      ['Ekspedisi aktif', fmtInt(d.active_ekspedisi), null],
      ['Volume per kendaraan', fmtM3(volPerVeh), null]
    ]);
    var periode = d.period ? ' (periode ' + d.period + ')' : '';
    insightBox(slide, fmtInt(d.over_sla_count) + ' dari ' + fmtInt(d.total_shipment) + ' pengiriman (' + fmtPct(overPct, 0) + '%) lewat SLA 90 menit. Loading terlama ' + fmtHM(d.longest_load_minutes) + ', rata-rata tunggu driver ' + fmtHM(d.avg_wait_minutes || 0) + ' — kandidat evaluasi rute/armada.' + periode);
    addFooter(slide, pptx, 'Logistics');
    return slide;
  }

  function slideFefo(pptx, zone) {
    if (!zone || zone.status !== 'live') return unavailableSlide(pptx, 'FEFO', zone && zone.error);
    var d = zone.data;
    var slide = pptx.addSlide();
    addSectionHeader(slide, pptx, 'FEFO (First-Expired First-Out)', 'Kepatuhan rotasi stok dan nilai pengiriman');
    var comp = d.compliance_pct || 0;
    var prevNilai = d.nilai_terkirim_periode_lalu_idr || 0;
    var nilai = d.total_nilai_terkirim_idr || 0;
    var growth = prevNilai > 0 ? ((nilai - prevNilai) / prevNilai * 100) : 0;
    kpiTable(slide, pptx, [
      ['Kepatuhan FEFO', fmtPct(comp) + '%', classify(comp, 90, 75, false)],
      ['Pelanggaran FEFO pasti', fmtInt(d.violation_count) + ' kejadian', (d.violation_count || 0) > 0 ? 'warn' : 'good'],
      ['Keterlacakan (traceability)', fmtPct(d.traceability_pct, 0) + '%', null],
      ['Dead stock', fmtPct(d.dead_stock_pct) + '%', null],
      ['Total qty terkirim', (d.total_qty_ctn / 1e6).toFixed(2).replace('.', ',') + ' jt ctn', null],
      ['Nilai terkirim', fmtRupiah(nilai), null],
      ['Pertumbuhan nilai vs periode lalu', (growth >= 0 ? '▲' : '▼') + fmtPct(Math.abs(growth)) + '%', classify(growth, 0, -10, false)],
      ['Volume terkirim', fmtM3(d.total_volume_terkirim_l || 0), null]
    ]);
    var periode = d.period ? ' (periode ' + d.period + ')' : '';
    insightBox(slide, 'Rotasi stok tertelusuri ' + fmtPct(d.traceability_pct, 0) + '% dengan kepatuhan ' + fmtPct(comp) + '%, namun tercatat ' + fmtInt(d.violation_count) + ' pelanggaran urutan FEFO pasti yang perlu dipantau. Nilai penjualan ' + (growth >= 0 ? 'tumbuh' : 'turun') + ' ' + fmtPct(Math.abs(growth)) + '% vs periode sebelumnya.' + periode);
    addFooter(slide, pptx, 'FEFO');
    return slide;
  }

  function slideWarehouse(pptx, zone) {
    if (!zone || zone.status !== 'live') return unavailableSlide(pptx, 'Warehouse Productivity', zone && zone.error);
    var d = zone.data;
    var slide = pptx.addSlide();
    addSectionHeader(slide, pptx, 'Warehouse Productivity', 'Produktivitas tenaga muat & kebutuhan armada harian');
    var match = d.token_match_pct || 0;
    kpiTable(slide, pptx, [
      ['Pengiriman / hari', fmtPct(d.avg_shipment_per_day), null],
      ['Rata-rata tenaga per pengiriman', fmtPct(d.avg_crew_size), null],
      ['Rata-rata picker / pengiriman', fmtPct(d.avg_picker_per_shipment), null],
      ['Rata-rata muat / pengiriman', fmtPct(d.avg_muat_per_shipment), null],
      ['Rata-rata stuffing / pengiriman', fmtPct(d.avg_stuffing_per_shipment), null],
      ['Cakupan pengenalan nama petugas', fmtPct(match) + '%', classify(match, 85, 60, false)],
      ['Kebutuhan kendaraan muat / hari', fmtInt(d.req_kendaraan_muat_per_hari) + ' unit', null],
      ['Karyawan terdaftar', fmtInt(d.total_karyawan_terdaftar), null]
    ]);
    insightBox(slide, 'Dengan rata-rata ' + fmtPct(d.avg_shipment_per_day) + ' pengiriman/hari dan ' + fmtPct(d.avg_crew_size) + ' tenaga per pengiriman, kebutuhan armada harian sekitar ' + fmtInt(d.req_kendaraan_muat_per_hari) + ' unit. Cakupan pengenalan nama petugas baru ' + fmtPct(match) + '% — rapikan format input nama di aplikasi Logistics Monitoring agar produktivitas per orang terhitung akurat.');
    addFooter(slide, pptx, 'Warehouse');
    return slide;
  }

  function slideTren(pptx, trenRows) {
    var slide = pptx.addSlide();
    addSectionHeader(slide, pptx, 'Tren Bulanan', 'Volume pengiriman (qty) per bulan — seluruh gudang');
    if (!trenRows || !trenRows.length) {
      slide.addText('Data tren bulanan tidak tersedia saat laporan dibuat.', { x: 0.55, y: 2.8, w: 12, h: 0.6, fontSize: 13, color: C.muted, fontFace: 'Arial' });
      addFooter(slide, pptx, 'Tren');
      return slide;
    }
    var rows = trenRows.slice(-12);
    var labels = rows.map(function (r) { return fMonth(r.bulan); });
    var qty = rows.map(function (r) { return Math.round(Number(r.qty) || 0); });
    slide.addChart(pptx.ChartType.bar, [{ name: 'Qty terkirim (ctn)', labels: labels, values: qty }], {
      x: 0.55, y: 1.55, w: 12.2, h: 4.6,
      barDir: 'col', chartColors: [C.accent],
      catAxisLabelColor: C.muted, catAxisLabelFontSize: 10,
      valAxisLabelColor: C.muted, valAxisLabelFontSize: 10,
      showLegend: false, showTitle: false,
      dataLabelColor: C.muted, showValue: false,
      catGridLine: { style: 'none' }, valGridLine: { color: C.border, style: 'solid' }
    });
    var last = rows[rows.length - 1];
    if (last && last.growth_mom_pct !== undefined && last.growth_mom_pct !== null) {
      var g = Number(last.growth_mom_pct) || 0;
      slide.addText((g >= 0 ? '▲ ' : '▼ ') + fmtPct(Math.abs(g)) + '% month-over-month pada ' + fMonth(last.bulan) + ' (bulan terakhir dengan data).',
        { x: 0.55, y: 6.35, w: 12.2, h: 0.4, fontSize: 11.5, color: g >= 0 ? C.good : C.bad, bold: true, fontFace: 'Arial' });
    }
    addFooter(slide, pptx, 'Tren');
    return slide;
  }

  function slidePenutup(pptx, sessionEmail, zones) {
    var slide = pptx.addSlide();
    slide.background = { color: C.dark };
    var liveCount = Object.keys(zones).filter(function (k) { return zones[k] && zones[k].status === 'live'; }).length;
    slide.addText('Catatan Sumber Data', { x: 0.7, y: 0.7, w: 11.9, h: 0.6, fontSize: 22, bold: true, color: C.white, fontFace: 'Arial' });
    var now = new Date();
    var ts = now.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) + ', ' + now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    var lines = [
      'Dibuat otomatis dari dashboard SCM Control Tower pada ' + ts + '.',
      liveCount + ' dari ' + Object.keys(zones).length + ' zona berhasil dimuat live saat laporan dibuat; zona yang gagal ditandai jelas di slide masing-masing (bukan diisi angka simulasi).',
      'Sumber data: view/Edge Function Supabase per zona (Stock Monitoring, Logistics, FEFO Monitoring, Warehouse Productivity).',
      sessionEmail ? ('Diunduh oleh akun: ' + sessionEmail + '.') : ''
    ].filter(Boolean);
    slide.addText(lines.map(function (t) { return { text: '•  ' + t + '\n', options: { color: '9CA3AF', fontSize: 13 } }; }),
      { x: 0.7, y: 1.6, w: 11.9, h: 3, fontFace: 'Arial', valign: 'top', lineSpacingMultiple: 1.5 });
    addFooter(slide, pptx, 'Penutup');
    return slide;
  }

  // ---------- orkestrasi utama ----------
  async function generateReport() {
    setBusy(true);
    showMsg('info', 'Mengambil data KPI live terbaru…');
    try {
      var session = window.SCM_AUTH_READY ? await window.SCM_AUTH_READY : null;
      var zones = await loadKpiZones();
      showMsg('info', 'Mengambil data tren bulanan…');
      var tren = await loadTrenBulanan();

      showMsg('info', 'Menyusun slide…');
      var pptx = new PptxGenJS();
      pptx.defineLayout({ name: 'SCM_WIDE', width: 13.33, height: 7.5 });
      pptx.layout = 'SCM_WIDE';
      pptx.author = 'SCM Control Tower';
      pptx.title = 'Laporan Eksekutif SCM';

      var cover = pptx.addSlide();
      cover.background = { color: C.dark };
      cover.addShape(pptx.ShapeType.rect, { x: 0, y: 4.35, w: 13.33, h: 0.06, fill: { color: C.accent }, line: { type: 'none' } });
      cover.addText('SCM CONTROL TOWER', { x: 0.9, y: 2.55, w: 11.5, h: 0.5, fontSize: 15, color: C.accent, bold: true, charSpacing: 2, fontFace: 'Arial' });
      cover.addText('Laporan Eksekutif', { x: 0.9, y: 3.05, w: 11.5, h: 1.1, fontSize: 40, bold: true, color: C.white, fontFace: 'Arial' });
      var todayLong = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
      cover.addText(todayLong, { x: 0.9, y: 4.55, w: 11.5, h: 0.5, fontSize: 14, color: '9CA3AF', fontFace: 'Arial' });
      cover.addText('Ringkasan kondisi Stock FG, Logistics, FEFO & Warehouse Productivity — dibuat otomatis dari data live.', { x: 0.9, y: 5.0, w: 10, h: 0.6, fontSize: 11.5, color: '6B7280', fontFace: 'Arial' });

      slideRingkasan(pptx, zones, session && session.user && session.user.email);
      slideStock(pptx, zones.stock);
      slideLogistics(pptx, zones.logistics);
      slideFefo(pptx, zones.fefo);
      slideWarehouse(pptx, zones.warehouse);
      slideTren(pptx, tren);
      slidePenutup(pptx, session && session.user && session.user.email, zones);

      showMsg('info', 'Menyimpan file…');
      var fname = 'Laporan-Eksekutif-SCM-' + new Date().toISOString().slice(0, 10) + '.pptx';
      await pptx.writeFile({ fileName: fname });
      showMsg('ok', 'Laporan berhasil dibuat — unduhan file <code>' + fname + '</code> dimulai.');
    } catch (e) {
      showMsg('err', 'Gagal membuat laporan: ' + (e && e.message ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  function init() {
    var btn = $('execReportBtn');
    if (btn) btn.addEventListener('click', generateReport);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
