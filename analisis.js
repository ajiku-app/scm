// analisis.js — menu "Analisis & Prediksi"
//
// Menampilkan hasil analisis dari view Supabase (lewat /api/analisis):
//   - Kebutuhan armada hari ini & besok      (v_kebutuhan_armada_ringkas, v_kebutuhan_kendaraan_hari_ini)
//   - Stok vs prediksi kirim per SKU/gudang   (v_prediksi_kirim)
//   - Tren penjualan bulanan                  (v_tren_bulanan)
//   - Kelengkapan data master produk          (v_sku_belum_master)
//
// Dibungkus IIFE supaya nama fungsi/variabelnya tidak bentrok dengan app.js
// (yang mendefinisikan fmtInt, fmtPct, dst. di scope global).
(function () {
  'use strict';

  var ENDPOINT = '/api/analisis';
  var STALE_MS = 5 * 60 * 1000;
  var PAGE_SIZE = 10;

  // ---------- Peta sebaran pelanggan (CARTO basemap + Leaflet) ----------
  // Basemaps API key CARTO — publik seperti token peta lain (Mapbox dsb.),
  // aman dipakai di client. Docs: https://carto.com/basemaps/apikey/
  var CARTO_API_KEY = 'cb1_30gl_1_2f654137b45a97f4e5b76e6d';
  var CARTO_TILE_URL = 'https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png?key=' + CARTO_API_KEY;
  var CARTO_ATTRIBUTION = '&copy; <a href="https://carto.com/attribution">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  var petaMap = null, petaLayer = null, petaMaxQty = 0;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  // ---------- helper ----------
  function $(id) { return document.getElementById(id); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  var nf0 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
  var nf1 = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function fInt(v) { return isNum(v) ? nf0.format(v) : '—'; }
  function fDec(v) { return isNum(v) ? nf1.format(v) : '—'; }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  function fDate(s) { var p = parseYmd(s); return p ? p.d + ' ' + MONTHS[p.m - 1] + ' ' + p.y : '—'; }
  function fMonth(s) { var p = parseYmd(s); return p ? MONTHS[p.m - 1] + ' ' + String(p.y).slice(2) : '—'; }
  function fMonthLong(s) { var p = parseYmd(s); return p ? MONTHS[p.m - 1] + ' ' + p.y : '—'; }
  function daysAgo(s) {
    var p = parseYmd(s);
    if (!p) return null;
    var now = new Date();
    var today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((today - Date.UTC(p.y, p.m - 1, p.d)) / 86400000);
  }
  function uniq(arr) { return Array.from(new Set(arr)); }
  function pctText(p, digits) {
    if (!isNum(p)) return '';
    var sign = p > 0 ? '+' : p < 0 ? '−' : '';
    return sign + (digits ? nf1.format(Math.abs(p)) : nf0.format(Math.abs(p))) + '%';
  }

  // ---------- state ----------
  var state = {
    data: null, loading: false, loadedAt: 0,
    gudang: 'SEMUA',
    pf: { gudang: '', status: '', tren: '', q: '' },
    sort: { key: 'prioritas', dir: 'desc' },
    page: 1,
    metric: 'qty',
    sub: 'armada',
    pri: { aksi: '' },
    par: 'SKU',
    puncak: 'BWB',
    dr: { dim: 'EKSPEDISI' },
    bcg: { bulan: '', gudang: '' },
    pet: { tipe: 'semua' }
  };

  var STATUS = [
    { key: 'KRITIS (<7 hari)', label: 'Kritis', tone: 'bad', hint: 'Stok cukup kurang dari 7 hari kirim' },
    { key: 'HABIS / TERALOKASI', label: 'Habis / teralokasi', tone: 'bad', hint: 'Stok tersedia 0 setelah kirim hari ini dan besok' },
    { key: 'TIDAK ADA DI STOK', label: 'Tidak ada di stok', tone: 'warn', hint: 'Masih dikirim, tetapi tidak ada di upload stok' },
    { key: 'MENUMPUK (>60 hari)', label: 'Menumpuk', tone: 'steel', hint: 'Stok cukup lebih dari 60 hari kirim' },
    { key: 'AMAN', label: 'Aman', tone: 'good', hint: 'Stok cukup 7 sampai 60 hari kirim' },
    { key: 'TANPA PERGERAKAN', label: 'Tanpa pergerakan', tone: 'muted', hint: 'Tidak ada kirim dalam 90 hari' }
  ];
  var STATUS_ORDER = STATUS.map(function (s) { return s.key; });
  function statusMeta(key) {
    for (var i = 0; i < STATUS.length; i++) if (STATUS[i].key === key) return STATUS[i];
    return { key: key, label: key, tone: 'muted', hint: '' };
  }
  function rankStatus(k) { var i = STATUS_ORDER.indexOf(k); return i < 0 ? 99 : i; }

  var COLS = [
    { key: 'gudang', label: 'Gudang', left: true, str: true },
    { key: 'produk', label: 'Produk', left: true, str: true },
    { key: 'stok_available', label: 'Stok tersedia' },
    { key: 'prediksi_kirim_per_hari', label: 'Prediksi kirim/hari' },
    { key: 'hari_cukup_prediksi', label: 'Cukup (hari)' },
    { key: 'tren_pct', label: 'Tren 30 hari' },
    { key: 'status_prediksi', label: 'Status', left: true, status: true },
    { key: 'kekurangan_22hari', label: 'Kurang untuk 22 hari' }
  ];

  var SORTS = {
    prioritas: { key: 'prioritas', dir: 'desc' },
    kurang: { key: 'kekurangan_22hari', dir: 'desc' },
    cukup: { key: 'hari_cukup_prediksi', dir: 'asc' },
    kirim: { key: 'prediksi_kirim_per_hari', dir: 'desc' },
    stok: { key: 'stok_available', dir: 'desc' }
  };

  // ---------- normalisasi data ----------
  var NUM = {
    armada: ['total_karton', 'total_m3', 'total_ton', 'ctn_40ft', 'bwb', 'ctn_20ft'],
    kendaraan: ['qty_karton', 'm3_plan', 'kg_plan', 'm3_per_trip_historis', 'kg_per_trip_historis', 'kebutuhan_kendaraan', 'rata2_trip_per_hari', 'rata2_m3_per_hari', 'hari_dipakai', 'sku_tanpa_volume'],
    prediksi: ['laju_30h_terakhir', 'laju_31_60h', 'laju_61_90h', 'prediksi_kirim_per_hari', 'tren_pct', 'proyeksi_qty_5hari', 'proyeksi_qty_22hari', 'prediksi_m3_per_hari', 'proyeksi_m3_22hari', 'stok_hari_ini', 'stok_available', 'hari_cukup_prediksi', 'kekurangan_22hari'],
    tren: ['hari_kirim', 'qty', 'm3', 'qty_per_hari', 'm3_per_hari', 'qty_per_hari_bulan_lalu', 'growth_mom_pct'],
    sku: ['jumlah_baris'],
    harian: ['trip', 'kendaraan_unik', 'qty', 'm3', 'kg', 'baris_tanpa_volume', 'm3_per_trip', 'kg_per_trip'],
    stok: ['upload_id', 'stok_hari_ini', 'kirim_hari_ini', 'kirim_besok', 'product_planning', 'stok_available', 'qty_per_pallet', 'volume_produk', 'berat_produk', 'm3_per_karton', 'm3_stok', 'm3_kirim_hari_ini', 'm3_kirim_besok', 'kg_kirim_hari_ini', 'kg_kirim_besok'],
    svk: ['stok_hari_ini', 'kirim_hari_ini', 'kirim_besok', 'stok_available', 'qty_kirim_90h', 'hari_kirim_90h', 'rata2_kirim_per_hari', 'm3_stok', 'hari_cukup'],
    ship: ['baris', 'qty', 'm3', 'kg', 'baris_tanpa_volume', 'trip', 'kendaraan_unik'],
    kt: ['qty', 'm3', 'kg'],
    akurasi: ['jumlah_baris', 'aktual_per_hari', 'prediksi_berbobot_per_hari', 'prediksi_datar_per_hari', 'wape_berbobot_pct', 'wape_datar_pct', 'bias_berbobot_pct', 'bias_datar_pct', 'error_total_berbobot_pct', 'error_total_datar_pct'],
    pareto: ['peringkat', 'qty', 'm3', 'porsi_pct', 'kumulatif_pct'],
    prioritas: ['urutan', 'peringkat_sku', 'tren_pct', 'stok_available', 'prediksi_kirim_per_hari', 'hari_cukup_prediksi', 'kekurangan_22hari', 'kelebihan_22hari', 'dampak_m3'],
    peringatan: ['urutan', 'nilai'],
    puncak: ['hari_kirim', 'rata2_m3', 'p90_m3', 'puncak_m3', 'kapasitas_m3', 'faktor_isi', 'unit_rata2', 'unit_p90', 'unit_puncak', 'rasio_puncak_rata2'],
    biaya: ['total_delivery', 'cost_labour', 'total_labour', 'biaya_per_carton', 'target_rp', 'pct_dari_target'],
    durHarian: ['jumlah_trip', 'rata2_durasi_menit', 'jumlah_lama'],
    durRingkas: ['jumlah_trip', 'rata2_durasi_menit', 'p90_durasi_menit', 'jumlah_lama', 'pct_lama'],
    biayaGd: ['jumlah_pekerja', 'biaya_per_pekerja', 'qty_dimuat', 'jam_kerja', 'total_biaya', 'biaya_per_karton'],
    estimasi: ['proyeksi_qty_22hari', 'rata2_biaya_per_carton', 'min_biaya_per_carton', 'max_biaya_per_carton', 'jumlah_bulan_acuan',
      'proyeksi_biaya_rp', 'proyeksi_biaya_rp_terendah', 'proyeksi_biaya_rp_tertinggi', 'target_biaya_per_carton_saat_ini', 'budget_ideal_rp'],
    peta: ['lat', 'lng', 'jml_pelanggan', 'jml_kota', 'total_qty', 'total_m3', 'total_kg', 'hari_sejak_kirim']
  };
  function conv(rows, keys) {
    return (Array.isArray(rows) ? rows : []).map(function (r) {
      var o = Object.assign({}, r);
      keys.forEach(function (k) { o[k] = num(o[k]); });
      return o;
    });
  }
  // Validasi baris: view Supabase bisa mengembalikan baris "yatim" pasca
  // upload — mis. SKU di shipments yang belum ada di stok terbaru, atau
  // baris logistics yang belum ketemu pasangannya — hasilnya kolom kunci
  // (kode SKU, gudang, tanggal, dst.) kosong walau baris numeriknya sendiri
  // ada. Baris begini bukan "0" yang valid, tapi baris tidak lengkap yang
  // membingungkan kalau ikut ditampilkan di tabel. clean() membuang baris
  // yang kolom kuncinya kosong SEBELUM dirender di mana pun (tabel, filter
  // dropdown, kartu ringkasan), dan mencatat berapa banyak yang dibuang
  // supaya bisa ditampilkan sebagai peringatan (lihat normalize() di bawah).
  function nonEmpty(v) { return v !== null && v !== undefined && String(v).trim() !== ''; }
  function clean(rows, keys, label, report) {
    var arr = Array.isArray(rows) ? rows : [];
    var kept = arr.filter(function (r) { return keys.every(function (k) { return nonEmpty(r[k]); }); });
    var dropped = arr.length - kept.length;
    if (dropped > 0 && report) report.push({ label: label, dropped: dropped, total: arr.length, keys: keys });
    return kept;
  }
  function normalize(d) {
    d = d || {};
    var report = [];
    var out = {
      generated_at: d.generated_at || null,
      armada: clean(conv(d.armada, NUM.armada), ['whs', 'periode'], 'Kebutuhan armada', report),
      kendaraan: conv(d.kendaraan, NUM.kendaraan),
      prediksi: clean(conv(d.prediksi, NUM.prediksi), ['kode_sku', 'gudang'], 'Stok vs prediksi kirim', report),
      tren: clean(conv(d.tren, NUM.tren), ['bulan', 'dimensi'], 'Tren bulanan', report),
      sku: clean(conv(d.sku_belum_master, NUM.sku), ['kode_sku'], 'SKU belum lengkap di master', report),
      harian: clean(conv(d.harian, NUM.harian), ['tanggal'], 'Rekap harian', report),
      stok: clean(conv(d.stok_terbaru, NUM.stok), ['item_code', 'whs'], 'Stok saat ini', report),
      svk: clean(conv(d.stok_vs_kirim, NUM.svk), ['item_code', 'whs'], 'Stok vs rata-rata kirim', report),
      trenPel: clean(conv(d.tren_pelanggan, NUM.tren), ['bulan', 'kunci'], 'Tren per pelanggan', report),
      ship: clean(conv(d.shipments_ringkas, NUM.ship), ['dimensi', 'bulan', 'kunci'], 'Ringkasan pengiriman', report),
      kt: clean(conv(d.kirim_terbaru, NUM.kt), ['kode_sku'], 'Baris pengiriman terbesar', report),
      akurasi: clean(conv(d.akurasi, NUM.akurasi), ['dimensi'], 'Akurasi prediksi', report),
      pareto: clean(conv(d.pareto, NUM.pareto), ['dimensi', 'kunci'], 'Pareto', report),
      prioritas: clean(conv(d.prioritas, NUM.prioritas), ['kode_sku', 'gudang'], 'Prioritas tindakan', report),
      peringatan: clean(conv(d.peringatan, NUM.peringatan), ['judul', 'tingkat'], 'Peringatan data', report),
      puncak: clean(conv(d.hari_puncak, NUM.puncak), ['armada'], 'Hari puncak armada', report),
      biaya: clean(conv(d.biaya_carton, NUM.biaya), ['bulan'], 'Biaya per karton bulanan', report),
      durHarian: clean(conv(d.durasi_harian, NUM.durHarian), ['tanggal'], 'Durasi truk harian', report),
      durRingkas: clean(conv(d.durasi_ringkas, NUM.durRingkas), ['kunci', 'dimensi'], 'Durasi truk ringkas', report),
      kpiLogistics: d.kpi_logistics || null,
      biayaGd: clean(conv(d.biaya_harian_gudang, NUM.biayaGd), ['tanggal', 'gudang'], 'Biaya tenaga per gudang harian', report),
      estimasi: conv(Array.isArray(d.estimasi_budget) ? d.estimasi_budget : (d.estimasi_budget ? [d.estimasi_budget] : []), NUM.estimasi)[0] || null,
      peta: clean(conv(d.peta_pelanggan, NUM.peta), ['wilayah_key', 'lat', 'lng'], 'Sebaran pelanggan', report)
    };
    // Baris yang dibuang tidak hilang diam-diam — muncul sebagai peringatan
    // INFO di panel "Peringatan data" yang sudah ada, supaya kelihatan kalau
    // ada data tidak konsisten pasca upload dan bisa ditelusuri sumbernya.
    if (report.length) {
      console.warn('[Analisis & Prediksi] Baris tidak lengkap disembunyikan dari tampilan (datanya sendiri tetap ada di Supabase, cuma tidak dirender karena kolom kuncinya kosong):', report);
      out.peringatan = out.peringatan.concat(report.map(function (x) {
        return {
          tingkat: 'INFO', urutan: 900,
          judul: 'Ditemukan ' + x.dropped + ' dari ' + x.total + ' baris tidak lengkap di "' + x.label + '"',
          detail: 'Baris ini disembunyikan dari tabel karena kolom kunci (' + x.keys.join(', ') + ') kosong pada hasil query — biasanya karena salah satu dari tiga tabel upload (stok, logistics, shipments) belum sinkron saat view dihitung, mis. SKU/gudang di satu tabel belum ada pasangannya di tabel lain. Cek upload terakhir bila jumlahnya besar; baris akan otomatis muncul lagi begitu datanya lengkap.'
        };
      }));
    }
    return out;
  }

  // ---------- 1. kebutuhan armada ----------
  function renderArmada() {
    var rows = state.data.armada;
    var host = $('anArmadaTable');
    if (!rows.length) {
      $('anGudangSeg').innerHTML = '';
      $('anAcuan').textContent = '';
      host.innerHTML = '<p class="an-updated">Belum ada rencana kirim di upload stok terbaru.</p>';
      $('anArmadaNotes').innerHTML = '';
      renderKendaraan();
      return;
    }
    var whs = ['SEMUA'].concat(uniq(rows.filter(function (r) { return r.whs !== 'SEMUA'; }).map(function (r) { return r.whs; })).sort());
    if (whs.indexOf(state.gudang) < 0) state.gudang = 'SEMUA';

    $('anGudangSeg').innerHTML = whs.map(function (w) {
      return '<button type="button" data-gudang="' + esc(w) + '" aria-pressed="' + (w === state.gudang) + '">' +
        (w === 'SEMUA' ? 'Semua gudang' : esc(w)) + '</button>';
    }).join('');

    var upload = rows[0].upload_date;
    $('anAcuan').textContent = 'Acuan: upload stok ' + fDate(upload);

    function pick(p) { return rows.filter(function (r) { return r.whs === state.gudang && r.periode === p; })[0]; }
    function big(v, label) { return '<td class="big" data-label="' + label + '">' + fInt(v) + '<small>unit</small></td>'; }
    function line(label, p) {
      var r = pick(p);
      if (!r) return '<tr><th scope="row">' + label + '</th><td class="none" colspan="6">Tidak ada rencana kirim</td></tr>';
      return '<tr><th scope="row">' + label + '</th><td data-label="Karton">' + fInt(r.total_karton) + '</td><td data-label="Volume (m³)">' + fDec(r.total_m3) +
        '</td><td data-label="Berat (ton)">' + fDec(r.total_ton) + '</td>' + big(r.ctn_40ft, 'Container 40 ft') + big(r.bwb, 'BWB') + big(r.ctn_20ft, 'Container 20 ft') + '</tr>';
    }
    host.innerHTML = '<table class="an-table an-fleet an-cards"><thead><tr>' +
      '<th scope="col">Delivery</th><th scope="col">Karton</th><th scope="col">Volume (m³)</th><th scope="col">Berat (ton)</th>' +
      '<th scope="col">Container 40 ft</th><th scope="col">BWB</th><th scope="col">Container 20 ft</th></tr></thead><tbody>' +
      line('Hari ini', 'HARI_INI') + line('Besok', 'BESOK') + '</tbody></table>';

    // catatan yang dihitung dari data (bukan teks tetap)
    var notes = [];
    var age = daysAgo(upload);
    if (age !== null && age >= 2) {
      notes.push('<b>Data stok berumur ' + age + ' hari.</b> "Hari ini" dan "besok" di atas mengikuti tanggal upload ' + fDate(upload) +
        ', bukan tanggal hari ini. Angka akan diperbarui otomatis setelah ada upload stok baru.');
    }
    var besok = rows.filter(function (r) { return r.whs === 'SEMUA' && r.periode === 'BESOK'; })[0];
    var normal = state.data.prediksi.reduce(function (a, r) { return a + (r.prediksi_kirim_per_hari || 0); }, 0);
    if (besok && normal > 0 && besok.total_karton / normal >= 3) {
      notes.push('<b>Rencana kirim besok ' + fInt(besok.total_karton) + ' karton, sekitar ' + fDec(besok.total_karton / normal) +
        ' kali laju harian normal (' + fInt(normal) + ' karton/hari).</b> Pastikan angka besok di file stok memang untuk satu hari kirim, karena kebutuhan armada besok mengikuti angka itu.');
    }
    $('anArmadaNotes').innerHTML = notes.map(function (n) { return '<li>' + n + '</li>'; }).join('');
    renderKendaraan();
  }

  function renderKendaraan() {
    var k = state.data.kendaraan[0];
    var host = $('anKendaraan');
    if (!k) { host.innerHTML = ''; return; }
    function stat(v, l, s) { return '<div class="an-stat"><div class="v">' + v + '</div><div class="l">' + l + '</div><div class="s">' + s + '</div></div>'; }
    host.innerHTML =
      stat(fInt(k.kebutuhan_kendaraan) + ' trip', 'Kebutuhan trip hari ini (pola historis)',
        fDec(k.m3_plan) + ' m³ dibagi ' + fDec(k.m3_per_trip_historis) + ' m³ rata-rata per trip') +
      stat(fDec(k.rata2_trip_per_hari) + ' trip', 'Rata-rata trip per hari',
        'dari ' + fInt(k.hari_dipakai) + ' hari yang datanya ada di logistics dan shipments') +
      stat(fDec(k.m3_per_trip_historis) + ' m³', 'Rata-rata muatan per trip',
        fInt(k.kg_per_trip_historis) + ' kg per trip') +
      stat(fInt(k.sku_tanpa_volume) + ' SKU', 'Rencana kirim tanpa data volume',
        k.sku_tanpa_volume > 0 ? 'tidak ikut terhitung di kebutuhan armada' : 'semua SKU rencana kirim terhitung');
  }

  // ---------- 2. stok vs prediksi ----------
  function predFiltered(ignoreStatus) {
    var f = state.pf, q = f.q.trim().toLowerCase();
    return state.data.prediksi.filter(function (r) {
      if (f.gudang && r.gudang !== f.gudang) return false;
      if (f.tren && r.tren !== f.tren) return false;
      if (q && (String(r.kode_sku || '').toLowerCase().indexOf(q) < 0 && String(r.produk || '').toLowerCase().indexOf(q) < 0)) return false;
      if (!ignoreStatus && f.status && r.status_prediksi !== f.status) return false;
      return true;
    });
  }
  function cmp(a, b) {
    var key = state.sort.key, m = state.sort.dir === 'asc' ? 1 : -1;
    if (key === 'prioritas') {
      var d = rankStatus(a.status_prediksi) - rankStatus(b.status_prediksi);
      if (d) return d;
      return ((b.kekurangan_22hari || 0) - (a.kekurangan_22hari || 0)) || ((b.proyeksi_m3_22hari || 0) - (a.proyeksi_m3_22hari || 0));
    }
    var x = a[key], y = b[key];
    if (key === 'status_prediksi') return (rankStatus(x) - rankStatus(y)) * m;
    if (typeof x === 'string' || typeof y === 'string') return String(x || '').localeCompare(String(y || ''), 'id') * m;
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * m;
  }
  function trenCell(r) {
    if (r.tren === 'BARU') return '<span class="an-chip steel">Baru</span>';
    if (r.tren === 'TIDAK AKTIF' || !isNum(r.tren_pct)) return '<span class="dim">—</span>';
    var cls = r.tren === 'NAIK' ? 'up' : r.tren === 'TURUN' ? 'down' : 'flat';
    var arrow = r.tren === 'NAIK' ? '▲' : r.tren === 'TURUN' ? '▼' : '●';
    var p = r.tren_pct;
    var t = Math.abs(p) >= 500 ? (p > 0 ? '>+500%' : '<−500%') : pctText(p, false) || '0%';
    return '<span class="' + cls + '">' + arrow + ' ' + t + '</span>';
  }

  function renderPrediksiControls() {
    var g = uniq(state.data.prediksi.map(function (r) { return r.gudang; })).sort();
    var sel = $('anFGudang');
    sel.innerHTML = '<option value="">Semua</option>' + g.map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + '</option>'; }).join('');
    if (g.indexOf(state.pf.gudang) < 0) state.pf.gudang = '';
    sel.value = state.pf.gudang;
    $('anFTren').value = state.pf.tren;
    $('anFQ').value = state.pf.q;
    var keyOf = Object.keys(SORTS).filter(function (k) { return SORTS[k].key === state.sort.key && SORTS[k].dir === state.sort.dir; })[0];
    $('anFSort').value = keyOf || 'prioritas';
  }

  function updatePrediksi() {
    var all = state.data.prediksi;
    if (!all.length) {
      $('anTiles').innerHTML = '';
      $('anPredTable').innerHTML = '<p class="an-updated">Belum ada data prediksi kirim.</p>';
      $('anPredCount').textContent = '';
      $('anPredPager').innerHTML = '';
      return;
    }
    // kotak status (dihitung dari filter selain status)
    var base = predFiltered(true);
    var present = uniq(all.map(function (r) { return r.status_prediksi; }));
    var keys = STATUS_ORDER.filter(function (k) { return present.indexOf(k) >= 0; })
      .concat(present.filter(function (k) { return STATUS_ORDER.indexOf(k) < 0; }));
    $('anTiles').innerHTML = keys.map(function (k) {
      var m = statusMeta(k);
      var rows = base.filter(function (r) { return r.status_prediksi === k; });
      var m3 = rows.reduce(function (a, r) { return a + (r.proyeksi_m3_22hari || 0); }, 0);
      return '<button type="button" class="an-tile ' + m.tone + '" data-status="' + esc(k) + '" aria-pressed="' + (state.pf.status === k) +
        '" title="' + esc(m.hint) + '"><span class="n">' + fInt(rows.length) + '</span><span class="t">' + esc(m.label) +
        '</span><span class="h">' + fInt(m3) + ' m³ kirim 22 hari</span></button>';
    }).join('');

    // tabel
    var rows = predFiltered(false).sort(cmp);
    var pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * PAGE_SIZE;
    var shown = rows.slice(start, start + PAGE_SIZE);
    var head = COLS.map(function (c) {
      var active = state.sort.key === c.key;
      var arrow = active ? (state.sort.dir === 'asc' ? '▲' : '▼') : '';
      return '<th scope="col" class="' + (c.left ? 'l' : '') + '" aria-sort="' + (active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') + '">' +
        '<button type="button" class="an-th" data-sort="' + c.key + '">' + c.label + '<span class="arr">' + arrow + '</span></button></th>';
    }).join('');
    var body = shown.map(function (r) {
      var m = statusMeta(r.status_prediksi);
      return '<tr><td class="l c-gud" data-label="Gudang">' + esc(r.gudang) + '</td>' +
        '<td class="prod">' + esc(r.produk) + '<span class="sku">' + esc(r.kode_sku) + '</span></td>' +
        '<td class="c-stok" data-label="Stok tersedia">' + fInt(r.stok_available) +
        (r.stok_beda_gudang ? '<span class="an-stok-note" title="Stok SKU ini tercatat di gudang lain pada upload stok, sedangkan kirimnya dari gudang ini.">stok tercatat di ' + esc(r.gudang_stok) + '</span>' : '') + '</td>' +
        '<td class="c-pred" data-label="Prediksi kirim/hari">' + fInt(r.prediksi_kirim_per_hari) + '</td>' +
        '<td class="c-cukup" data-label="Cukup (hari)">' + fDec(r.hari_cukup_prediksi) + '</td>' +
        '<td class="c-tren" data-label="Tren 30 hari">' + trenCell(r) + '</td>' +
        '<td class="l c-status" data-label="Status"><span class="an-chip ' + m.tone + '">' + esc(m.label) + '</span></td>' +
        '<td class="c-kur" data-label="Kurang untuk 22 hari">' + fInt(r.kekurangan_22hari) + '</td></tr>';
    }).join('');
    $('anPredTable').innerHTML = rows.length
      ? '<table class="an-table an-cards"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>'
      : '<p class="an-updated">Tidak ada baris yang cocok dengan filter.</p>';
    $('anPredCount').textContent = rows.length
      ? 'Menampilkan ' + fInt(start + 1) + '–' + fInt(start + shown.length) + ' dari ' + fInt(rows.length) + ' baris (SKU per gudang)'
      : '';
    renderPager('anPredPager', state.page, rows.length, PAGE_SIZE, function (p) { state.page = p; updatePrediksi(); });
  }

  // ---------- 3. tren bulanan ----------
  function growthOf(cur, prev) {
    return isNum(cur) && isNum(prev) && prev > 0 ? (cur / prev - 1) * 100 : null;
  }
  function chartSvg(rows, key, unit) {
    // lebar viewBox = lebar kontainer, supaya teks tampil 1:1 (tidak mengecil di layar sempit)
    var W = Math.max(300, Math.round($('anChart').clientWidth || 720)), H = 260, padL = 8, padR = 8, padT = 30, padB = 46;
    var n = rows.length;
    var vals = rows.map(function (r) { return r[key] || 0; });
    var max = Math.max.apply(null, vals.concat([1]));
    var plotH = H - padT - padB, slot = (W - padL - padR) / n, bw = Math.min(54, slot * 0.62);
    var compact = slot < 58; // layar sempit: angka diringkas supaya label tidak bertabrakan
    // layar sempit: karton ditampilkan dalam ribuan (keterangan satuan ada di pojok grafik)
    var inThousands = compact && key === 'qty_per_hari';
    function lab(v) {
      if (!isNum(v)) return '—';
      return inThousands ? nf0.format(Math.round(v / 1000)) : fInt(v);
    }
    function mlab(r) {
      var p = parseYmd(r.bulan);
      return (compact && p ? MONTHS[p.m - 1] : fMonth(r.bulan)) + (r.bulan_berjalan ? '*' : '');
    }
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="' + (compact ? 'sm' : '') + '" role="img" aria-label="Grafik ' + esc(unit) + ' per bulan">';
    if (inThousands) out += '<text class="cap" x="' + padL + '" y="12">ribu ' + esc(unit) + '</text>';
    out += '<line class="axis" x1="' + padL + '" y1="' + (H - padB) + '" x2="' + (W - padR) + '" y2="' + (H - padB) + '"/>';
    rows.forEach(function (r, i) {
      var v = r[key];
      var h = isNum(v) && v > 0 ? Math.max(2, (v / max) * plotH) : 0;
      var x = padL + slot * i + (slot - bw) / 2, y = H - padB - h, cx = x + bw / 2;
      var g = i > 0 ? growthOf(v, rows[i - 1][key]) : null;
      var gcls = g === null ? 'flat' : g > 0.05 ? 'up' : g < -0.05 ? 'down' : 'flat';
      out += '<rect class="bar' + (r.bulan_berjalan ? ' partial' : '') + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2"><title>' + esc(fMonthLong(r.bulan) + ': ' + fInt(v) + ' ' + unit + ', ' + fInt(r.hari_kirim) + ' hari kirim') + '</title></rect>';
      out += '<text class="val" x="' + cx.toFixed(1) + '" y="' + (y - 6).toFixed(1) + '">' + lab(v) + '</text>';
      out += '<text class="mon" x="' + cx.toFixed(1) + '" y="' + (H - padB + 16) + '">' + esc(mlab(r)) + '</text>';
      out += '<text class="gr ' + gcls + '" x="' + cx.toFixed(1) + '" y="' + (H - padB + 32) + '">' + (g === null ? '' : pctText(g, !compact)) + '</text>';
    });
    return out + '</svg>';
  }

  function renderTren() {
    var key = state.metric === 'm3' ? 'm3_per_hari' : 'qty_per_hari';
    var unit = state.metric === 'm3' ? 'm³/hari' : 'karton/hari';
    Array.prototype.forEach.call($('anMetricSeg').querySelectorAll('[data-metric]'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.metric === state.metric));
    });

    var total = state.data.tren.filter(function (r) { return r.dimensi === 'TOTAL'; })
      .sort(function (a, b) { return String(a.bulan).localeCompare(String(b.bulan)); });
    if (!total.length) {
      $('anChart').innerHTML = '<p class="an-updated">Belum ada data tren bulanan.</p>';
      $('anTrenInsight').innerHTML = '';
      $('anTrenGudang').innerHTML = '';
      return;
    }
    $('anChart').innerHTML = chartSvg(total, key, unit);

    var last = total[total.length - 1], prev = total.length > 1 ? total[total.length - 2] : null;
    var withVal = total.filter(function (r) { return isNum(r[key]); });
    var hi = withVal.reduce(function (a, r) { return r[key] > a[key] ? r : a; }, withVal[0]);
    var lo = withVal.reduce(function (a, r) { return r[key] < a[key] ? r : a; }, withVal[0]);
    var g = prev ? growthOf(last[key], prev[key]) : null;
    var txt = '<b>' + esc(fMonthLong(last.bulan)) + '</b>: ' + fInt(last[key]) + ' ' + unit;
    if (last.bulan_berjalan) txt += ' (baru ' + fInt(last.hari_kirim) + ' hari kirim, bulan berjalan)';
    if (g !== null) txt += ', ' + (g >= 0 ? 'naik ' : 'turun ') + nf1.format(Math.abs(g)) + '% dibanding ' + esc(fMonthLong(prev.bulan));
    txt += '. Tertinggi <b>' + esc(fMonthLong(hi.bulan)) + '</b> (' + fInt(hi[key]) + '), terendah <b>' + esc(fMonthLong(lo.bulan)) + '</b> (' + fInt(lo[key]) + '). ' +
      'Tanda * dan batang putus-putus menandai bulan berjalan.';
    $('anTrenInsight').innerHTML = txt;

    // tabel per gudang: 4 bulan terakhir
    var months = total.slice(-4).map(function (r) { return r.bulan; });
    var monthRows = {};
    total.forEach(function (r) { monthRows[r.bulan] = r; });
    var gud = uniq(state.data.tren.filter(function (r) { return r.dimensi === 'GUDANG'; }).map(function (r) { return r.kunci; })).sort();
    if (!gud.length) { $('anTrenGudang').innerHTML = ''; return; }
    var head = '<th scope="col" class="l">Gudang (' + unit + ')</th>' + months.map(function (m) {
      return '<th scope="col">' + esc(fMonth(m)) + (monthRows[m].bulan_berjalan ? '*' : '') + '</th>';
    }).join('') + '<th scope="col">Perubahan bulan terakhir</th>';
    var body = gud.map(function (k) {
      var byMonth = {};
      state.data.tren.forEach(function (r) { if (r.dimensi === 'GUDANG' && r.kunci === k) byMonth[r.bulan] = r; });
      var cells = months.map(function (m) { return '<td>' + (byMonth[m] ? fInt(byMonth[m][key]) : '—') + '</td>'; }).join('');
      var cur = byMonth[months[months.length - 1]], pre = byMonth[months[months.length - 2]];
      var gg = cur && pre ? growthOf(cur[key], pre[key]) : null;
      var cls = gg === null ? 'flat' : gg > 0.05 ? 'up' : gg < -0.05 ? 'down' : 'flat';
      return '<tr><td class="l">' + esc(k) + '</td>' + cells + '<td class="' + cls + '">' + (gg === null ? '—' : pctText(gg, true)) + '</td></tr>';
    }).join('');
    $('anTrenGudang').innerHTML = '<table class="an-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  // ---------- 3b. biaya per carton ----------
  var EFISIENSI = {
    'Efisien': { tone: 'good', hint: 'Biaya ≤ 90% target' },
    'Efektif': { tone: 'steel', hint: 'Biaya dalam rentang ±10% target' },
    'Boros': { tone: 'bad', hint: 'Biaya > 110% target' }
  };
  function efisiensiChip(status) {
    if (!status) return '<span class="an-chip muted">—</span>';
    var m = EFISIENSI[status] || { tone: 'muted' };
    return '<span class="an-chip ' + m.tone + '">' + esc(status) + '</span>';
  }
  function biayaChartSvg(rows) {
    var host = $('bcChart');
    var W = Math.max(300, Math.round(host.clientWidth || 720)), H = 270, padL = 8, padR = 8, padT = 30, padB = 56;
    var n = rows.length;
    var vals = rows.map(function (r) { return isNum(r.biaya_per_carton) ? r.biaya_per_carton : 0; });
    var max = Math.max.apply(null, vals.concat([1]));
    var plotH = H - padT - padB, slot = (W - padL - padR) / n, bw = Math.min(54, slot * 0.62);
    var compact = slot < 58;
    function mlab(r) { var p = parseYmd(r.bulan); return p ? MONTHS[p.m - 1] + (compact ? '' : ' ' + String(p.y).slice(2)) : '—'; }
    function gcls(status) { return status === 'Efisien' ? 'up' : status === 'Boros' ? 'down' : 'flat'; }
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="' + (compact ? 'sm' : '') + '" role="img" aria-label="Grafik biaya per karton per bulan">';
    out += '<line class="axis" x1="' + padL + '" y1="' + (H - padB + 24) + '" x2="' + (W - padR) + '" y2="' + (H - padB + 24) + '"/>';
    rows.forEach(function (r, i) {
      var v = r.biaya_per_carton;
      var h = isNum(v) && v > 0 ? Math.max(2, (v / max) * plotH) : 0;
      var x = padL + slot * i + (slot - bw) / 2, y = H - padB + 24 - h, cx = x + bw / 2;
      var missing = !isNum(v);
      out += '<rect class="bar' + (missing ? ' partial' : '') + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2"><title>' + esc(fMonthLong(r.bulan) + ': ' + (missing ? 'belum ada data' : 'Rp ' + fInt(v) + '/karton (' + (r.status_efisiensi || '—') + ')')) + '</title></rect>';
      out += '<text class="val" x="' + cx.toFixed(1) + '" y="' + (y - 6).toFixed(1) + '">' + (missing ? '—' : fInt(v)) + '</text>';
      out += '<text class="mon" x="' + cx.toFixed(1) + '" y="' + (H - padB + 40) + '">' + esc(mlab(r)) + '</text>';
      out += '<text class="gr ' + gcls(r.status_efisiensi) + '" x="' + cx.toFixed(1) + '" y="' + (H - padB + 56) + '">' + esc(r.status_efisiensi || '') + '</text>';
    });
    return out + '</svg>';
  }
  function renderBiaya() {
    var rows = (state.data.biaya || []).slice().sort(function (a, b) { return String(a.bulan).localeCompare(String(b.bulan)); });
    if (!rows.length) {
      $('bcStats').innerHTML = '';
      $('bcChart').innerHTML = '<p class="an-updated">Belum ada data biaya tenaga kerja.</p>';
      $('bcTable').innerHTML = '';
      return;
    }
    $('bcChart').innerHTML = biayaChartSvg(rows);

    var withVal = rows.filter(function (r) { return isNum(r.biaya_per_carton); });
    if (withVal.length) {
      var last = withVal[withVal.length - 1];
      var avg = withVal.reduce(function (s, r) { return s + r.biaya_per_carton; }, 0) / withVal.length;
      var hi = withVal.reduce(function (a, r) { return r.biaya_per_carton > a.biaya_per_carton ? r : a; }, withVal[0]);
      var lo = withVal.reduce(function (a, r) { return r.biaya_per_carton < a.biaya_per_carton ? r : a; }, withVal[0]);
      $('bcStats').innerHTML =
        statHtml('Rp ' + fInt(last.biaya_per_carton), esc(fMonthLong(last.bulan)), (last.status_efisiensi || '—') + ' · target Rp ' + fInt(last.target_rp)) +
        statHtml('Rp ' + fInt(avg), 'Rata-rata', withVal.length + ' bulan dengan data cost labour') +
        statHtml('Rp ' + fInt(hi.biaya_per_carton), 'Tertinggi', esc(fMonthLong(hi.bulan)) + ' · ' + (hi.status_efisiensi || '—')) +
        statHtml('Rp ' + fInt(lo.biaya_per_carton), 'Terendah', esc(fMonthLong(lo.bulan)) + ' · ' + (lo.status_efisiensi || '—'));
    } else {
      $('bcStats').innerHTML = '';
    }

    var head = '<th scope="col" class="l">Bulan</th><th scope="col">Total kirim (karton)</th><th scope="col">Cost labour</th>' +
      '<th scope="col">Rata² karyawan/bulan</th><th scope="col">Biaya/karton</th><th scope="col">Target</th><th scope="col">% target</th><th scope="col" class="l">Status</th>';
    var body = rows.map(function (r) {
      var has = isNum(r.biaya_per_carton);
      return '<tr><td class="l">' + esc(fMonthLong(r.bulan)) + '</td>' +
        '<td data-label="Total kirim">' + fInt(r.total_delivery) + '</td>' +
        '<td data-label="Cost labour">' + (isNum(r.cost_labour) ? 'Rp ' + fInt(r.cost_labour) : '—') + '</td>' +
        '<td data-label="Rata² karyawan">' + (isNum(r.total_labour) ? fInt(r.total_labour) : '—') + '</td>' +
        '<td data-label="Biaya/karton"><b>' + (has ? 'Rp ' + fInt(r.biaya_per_carton) : '—') + '</b></td>' +
        '<td data-label="Target">' + (isNum(r.target_rp) ? 'Rp ' + fInt(r.target_rp) : '—') + '</td>' +
        '<td data-label="% target">' + (isNum(r.pct_dari_target) ? fDec(r.pct_dari_target) + '%' : '—') + '</td>' +
        '<td class="l" data-label="Status">' + efisiensiChip(r.status_efisiensi) + '</td></tr>';
    }).join('');
    $('bcTable').innerHTML = '<table class="an-table an-cards"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>' +
      '<p class="an-updated" style="margin-top:8px">Total kirim mengikuti data <code>shipments</code> terbaru (otomatis). Cost labour dan rata-rata karyawan diinput manual per bulan; strip (—) berarti bulan belum ditutup / datanya belum diisi. Status: <b>Efisien</b> jika biaya ≤ 90% target, <b>Efektif</b> jika dalam rentang ±10% target, <b>Boros</b> jika &gt; 110% target — target diambil dari tabel <code>target_biaya_karton</code>.</p>';
  }

  // ---------- 3c. durasi truk di lokasi (v_durasi_harian, v_durasi_ringkas) ----------
  function ymd10(s) { return String(s || '').slice(0, 10); }
  function sum(rows, fn) { return rows.reduce(function (a, r) { var v = fn(r); return a + (isNum(v) ? v : 0); }, 0); }
  function fRpS(v) {
    if (!isNum(v)) return '—';
    var a = Math.abs(v), s = v < 0 ? '-' : '';
    if (a >= 1e9) return s + 'Rp ' + nf1.format(a / 1e9) + ' M';
    if (a >= 1e6) return s + 'Rp ' + nf1.format(a / 1e6) + ' jt';
    return s + 'Rp ' + nf0.format(a);
  }
  function fMenit(v) {
    if (!isNum(v)) return '—';
    var m = Math.round(v);
    return m >= 60 ? Math.floor(m / 60) + ' j ' + (m % 60) + ' mnt' : m + ' mnt';
  }
  function showNote(id, html) {
    var el = $(id);
    el.hidden = !html;
    el.innerHTML = html;
  }
  function durChartSvg(days, avg) {
    var host = $('drChart');
    var W = Math.max(300, Math.round(host.clientWidth || 720)), H = 220, padL = 8, padR = 8, padT = 26, padB = 26;
    var n = days.length;
    var max = Math.max.apply(null, days.map(function (d) { return d.rata2_durasi_menit || 0; }).concat([isNum(avg) ? avg * 1.15 : 1]));
    var plotH = H - padT - padB, slot = (W - padL - padR) / n, bw = Math.max(3, Math.min(30, slot * 0.68)), base = H - padB;
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Grafik rata-rata durasi truk di lokasi per hari">';
    out += '<line class="axis" x1="' + padL + '" y1="' + base + '" x2="' + (W - padR) + '" y2="' + base + '"/>';
    if (isNum(avg)) {
      var ay = base - (avg / max) * plotH;
      out += '<line class="sla" x1="' + padL + '" y1="' + ay.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + ay.toFixed(1) + '"/>';
      out += '<text class="cap" x="' + padL + '" y="12">Garis putus-putus: rata-rata seluruh data ' + fInt(avg) + ' menit</text>';
    }
    days.forEach(function (d, i) {
      var v = d.rata2_durasi_menit || 0;
      var h = Math.max(1.5, (v / max) * plotH);
      var x = padL + slot * i + (slot - bw) / 2;
      out += '<rect class="bar' + (isNum(avg) && v > avg * 1.25 ? ' late' : '') + '" x="' + x.toFixed(1) + '" y="' + (base - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2"><title>' +
        esc(fDate(d.tanggal) + ': rata-rata ' + fInt(v) + ' menit, ' + fInt(d.jumlah_trip) + ' trip, ' + fInt(d.jumlah_lama) + ' berkategori Lama') + '</title></rect>';
    });
    [0, Math.floor((n - 1) / 2), n - 1].forEach(function (i, k) {
      if (k > 0 && n < 3) return;
      var anchor = k === 0 ? 'start' : k === 2 ? 'end' : 'middle';
      var x = k === 0 ? padL : k === 2 ? W - padR : padL + slot * i + slot / 2;
      out += '<text class="mon" style="text-anchor:' + anchor + '" x="' + x.toFixed(1) + '" y="' + (H - 7) + '">' + esc(fDate(days[i].tanggal)) + '</text>';
    });
    return out + '</svg>';
  }
  function renderDurasi() {
    var days = state.data.durHarian.slice().sort(function (a, b) { return ymd10(a.tanggal).localeCompare(ymd10(b.tanggal)); });
    if (!days.length) {
      showNote('drWarn', '');
      $('drStats').innerHTML = '';
      $('drChart').innerHTML = '<p class="an-updated">Belum ada data durasi trip (v_durasi_harian kosong atau belum dikirim edge function).</p>';
      drTable.render();
      return;
    }
    var trips = sum(days, function (r) { return r.jumlah_trip; });
    var lama = sum(days, function (r) { return r.jumlah_lama; });
    var avg = trips ? sum(days, function (r) { return (r.rata2_durasi_menit || 0) * (r.jumlah_trip || 0); }) / trips : null;
    var first = ymd10(days[0].tanggal), last = ymd10(days[days.length - 1].tanggal);
    var ago = daysAgo(last);
    showNote('drWarn', isNum(ago) && ago > 14
      ? '<b>Data trip terakhir tercatat ' + esc(fDate(last)) + ' (' + fInt(ago) + ' hari lalu).</b> Analisis ini belum mencakup periode sesudahnya; pastikan data <code>logistics</code> terbaru sudah diunggah.'
      : '');
    $('drStats').innerHTML =
      statHtml(fInt(trips), 'Total trip', esc(fDate(first)) + ' sampai ' + esc(fDate(last))) +
      statHtml(fMenit(avg), 'Rata-rata durasi di lokasi', 'jam masuk sampai jam keluar') +
      statHtml(trips ? fDec(lama / trips * 100) + '%' : '—', 'Trip berkategori Lama', fInt(lama) + ' dari ' + fInt(trips) + ' trip · di atas persentil ke-90') +
      statHtml(fInt(days.length), 'Hari yang punya data', 'grafik menampilkan ' + Math.min(60, days.length) + ' hari terakhir');
    var recent = days.slice(-60);
    $('drChart').innerHTML = durChartSvg(recent, avg) +
      '<p class="an-updated" style="margin-top:4px">Batang: rata-rata durasi truk per hari (merah bila lebih dari 25% di atas rata-rata seluruh data).</p>';
    drTable.reset(); drTable.render();
    renderKpiLogistics();
  }

  // ---------- 3c-bis. SLA & KPI server-side (RPC get_logistics_kpi, baru) ----------
  // Dihitung langsung di database (bukan diagregasi di browser dari v_durasi_harian/
  // v_durasi_ringkas seperti di atas), jadi tidak kena limit 1000 baris PostgREST dan
  // sekalian menambah metrik yang belum ada: SLA %, median/p90 keseluruhan, jumlah trip
  // dianggap anomali (format jam salah / jam keluar < jam masuk), dan breakdown per armada.
  function renderKpiLogistics() {
    var host = $('drKpiCard');
    if (!host) return; // index.html belum di-update, jangan error
    var k = state.data.kpiLogistics;
    if (!k || !isNum(k.total_trip) || k.total_trip === 0) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    $('drKpiStats').innerHTML =
      statHtml(isNum(k.sla_pct) ? fDec(k.sla_pct) + '%' : '—', 'SLA tepat waktu', 'target ≤ ' + fInt(k.sla_target_menit) + ' menit di lokasi') +
      statHtml(fMenit(k.median_menit), 'Median durasi', 'p90: ' + fMenit(k.p90_menit)) +
      statHtml(fInt(k.trip_anomali), 'Trip anomali', 'dari ' + fInt(k.total_trip) + ' total trip · jam masuk/keluar tidak valid') +
      statHtml(isNum(k.kendaraan_bervolume) ? fInt(k.kendaraan_bervolume) : '—', 'Kendaraan bervolume', isNum(k.volume_per_kendaraan_m3) ? 'rata-rata ' + fDec(k.volume_per_kendaraan_m3) + ' m³/kendaraan' : 'volume per kendaraan belum ada');
    var terlama = k.loading_terlama;
    showNote('drKpiNote', terlama
      ? 'Trip loading terlama tercatat: <b>' + esc(fMenit(terlama.durasi_menit)) + '</b> — ' + esc(terlama.driver || '-') + ', ' + esc(terlama.ekspedisi || '-') +
        (terlama.provinsi ? ' (' + esc(terlama.provinsi) + (terlama.kota ? ', ' + esc(terlama.kota) : '') + ')' : '') + ', ' + esc(fDate(terlama.tgl)) + '.'
      : '');
    var perArmada = Array.isArray(k.per_armada) ? k.per_armada : [];
    if (!perArmada.length) {
      $('drKpiArmada').innerHTML = '<p class="an-updated">Belum ada breakdown per armada.</p>';
      return;
    }
    var rows = perArmada.slice().sort(function (a, b) { return (b.trip || 0) - (a.trip || 0); }).map(function (r) {
      return '<tr><td class="l" data-label="Armada">' + esc(r.armada) + '</td>' +
        '<td data-label="Trip">' + fInt(r.trip) + '</td>' +
        '<td data-label="SLA %">' + (isNum(r.sla_pct) ? fDec(r.sla_pct) + '%' : '—') + '</td>' +
        '<td data-label="Rata-rata">' + fMenit(r.avg_menit) + '</td>' +
        '<td data-label="Median">' + fMenit(r.median_menit) + '</td></tr>';
    }).join('');
    $('drKpiArmada').innerHTML = '<table class="an-table an-cards"><thead><tr>' +
      '<th class="l">Armada</th><th>Trip</th><th>SLA %</th><th>Rata-rata</th><th>Median</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
  }
  var drTable = makeTable({
    host: 'drTable', count: 'drCount', pager: 'drPager', sortM: 'drSortM', sort: { key: 'jumlah_lama', dir: 'desc' },
    empty: 'Belum ada data ringkasan durasi.',
    rows: function () {
      if (!state.data) return [];
      return state.data.durRingkas.filter(function (r) { return r.dimensi === state.dr.dim; });
    },
    cols: [
      { key: 'kunci', label: 'Nama', left: true },
      { key: 'jumlah_trip', label: 'Trip', fmt: 'int' },
      { key: 'rata2_durasi_menit', label: 'Rata-rata', html: function (r) { return fMenit(r.rata2_durasi_menit); } },
      { key: 'p90_durasi_menit', label: 'Persentil ke-90', html: function (r) { return fMenit(r.p90_durasi_menit); } },
      { key: 'jumlah_lama', label: 'Trip Lama', fmt: 'int' },
      { key: 'pct_lama', label: '% Lama', html: function (r) { return fDec(r.pct_lama) + '%'; } }
    ]
  });

  // ---------- 3d. biaya tenaga per gudang & harian (v_biaya_harian_gudang) ----------
  // Data ini catatan HARIAN yang diinput manual (jumlah pekerja x biaya per pekerja, qty dimuat).
  function efisiensiOf(pct) {
    if (!isNum(pct)) return null;
    return pct <= 90 ? 'Efisien' : pct <= 110 ? 'Efektif' : 'Boros';
  }
  function targetFor(bulan) {
    var t = null, rows = state.data.biaya || [];
    rows.forEach(function (r) { if (ymd10(r.bulan) === ymd10(bulan).slice(0, 7) + '-01' && isNum(r.target_rp)) t = r.target_rp; });
    if (t === null) {
      rows.forEach(function (r) { if (isNum(r.target_rp)) t = r.target_rp; });
      var e = state.data.estimasi;
      if (e && isNum(e.target_biaya_per_carton_saat_ini)) t = e.target_biaya_per_carton_saat_ini;
    }
    return t;
  }
  function bcgMonthRows() {
    return state.data.biayaGd.filter(function (r) { return ymd10(r.tanggal).slice(0, 7) === state.bcg.bulan.slice(0, 7); });
  }
  // Total per hari: bila ada catatan gudang 'SEMUA' pada tanggal itu, itulah totalnya; bila tidak, jumlah semua catatan.
  function bcgDayTotals(rows, onlyGudang) {
    var by = {};
    rows.forEach(function (r) { var k = ymd10(r.tanggal); (by[k] = by[k] || []).push(r); });
    return Object.keys(by).sort().map(function (k) {
      var list = by[k];
      if (!onlyGudang) {
        var semua = list.filter(function (r) { return r.gudang === 'SEMUA'; });
        if (semua.length) list = semua;
      }
      var biaya = sum(list, function (r) { return r.total_biaya; });
      var qty = sum(list, function (r) { return r.qty_dimuat; });
      var per = qty > 0 ? biaya / qty : null;
      var t = targetFor(k);
      var pct = isNum(per) && isNum(t) && t > 0 ? per / t * 100 : null;
      return { tanggal: k, biaya: biaya, qty: qty, per: per, target: t, pct: pct, status: efisiensiOf(pct) };
    });
  }
  function bcgGudangAgg(rows) {
    var biaya = sum(rows, function (r) { return r.total_biaya; });
    var qty = sum(rows, function (r) { return r.qty_dimuat; });
    var pekerja = sum(rows, function (r) { return r.jumlah_pekerja; });
    var per = qty > 0 ? biaya / qty : null;
    var t = rows.length ? targetFor(rows[rows.length - 1].tanggal) : null;
    var pct = isNum(per) && isNum(t) && t > 0 ? per / t * 100 : null;
    return { hari: uniq(rows.map(function (r) { return ymd10(r.tanggal); })).length, biaya: biaya, qty: qty,
      kpp: pekerja > 0 ? qty / pekerja : null, per: per, pct: pct, status: efisiensiOf(pct) };
  }
  function bcgChartSvg(days) {
    var host = $('bcgChart');
    var W = Math.max(300, Math.round(host.clientWidth || 720)), H = 220, padL = 8, padR = 8, padT = 26, padB = 26;
    var n = days.length;
    var target = null;
    days.forEach(function (d) { if (isNum(d.target)) target = d.target; });
    var vals = days.map(function (d) { return isNum(d.per) ? d.per : 0; });
    var max = Math.max.apply(null, vals.concat([isNum(target) ? target * 1.15 : 1]));
    var plotH = H - padT - padB, slot = (W - padL - padR) / n, bw = Math.max(3, Math.min(30, slot * 0.68)), base = H - padB;
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Grafik biaya per karton per hari">';
    out += '<line class="axis" x1="' + padL + '" y1="' + base + '" x2="' + (W - padR) + '" y2="' + base + '"/>';
    if (isNum(target)) {
      var ty = base - (target / max) * plotH;
      out += '<line class="sla" x1="' + padL + '" y1="' + ty.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + ty.toFixed(1) + '"/>';
      out += '<text class="cap" x="' + padL + '" y="12">Garis putus-putus: target Rp ' + fInt(target) + ' per karton</text>';
    }
    var peak = -1;
    days.forEach(function (d, i) { if (isNum(d.per) && (peak < 0 || d.per > days[peak].per)) peak = i; });
    days.forEach(function (d, i) {
      var has = isNum(d.per);
      var h = has ? Math.max(1.5, (d.per / max) * plotH) : 0;
      var x = padL + slot * i + (slot - bw) / 2;
      out += '<rect class="bar' + (!has ? ' partial' : d.status === 'Boros' ? ' late' : '') + '" x="' + x.toFixed(1) + '" y="' + (base - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2"><title>' +
        esc(fDate(d.tanggal) + ': ' + (has ? 'Rp ' + fInt(d.per) + '/karton (' + (d.status || '—') + '), ' + fInt(d.qty) + ' karton' : 'biaya belum bisa dihitung')) + '</title></rect>';
      if (i === peak) out += '<text class="val" x="' + Math.min(W - 26, Math.max(26, x + bw / 2)).toFixed(1) + '" y="' + (base - h - 5).toFixed(1) + '">' + fInt(d.per) + '</text>';
    });
    [0, Math.floor((n - 1) / 2), n - 1].forEach(function (i, k) {
      if (k > 0 && n < 3) return;
      var anchor = k === 0 ? 'start' : k === 2 ? 'end' : 'middle';
      var x = k === 0 ? padL : k === 2 ? W - padR : padL + slot * i + slot / 2;
      out += '<text class="mon" style="text-anchor:' + anchor + '" x="' + x.toFixed(1) + '" y="' + (H - 7) + '">' + esc(fDate(days[i].tanggal)) + '</text>';
    });
    return out + '</svg>';
  }
  function renderBiayaGudang() {
    var all = state.data.biayaGd;
    if (!all.length) {
      showNote('bcgWarn', '<b>Belum ada catatan biaya tenaga harian.</b> Tabel <code>biaya_tenaga_harian</code> masih kosong. Isi lewat kotak <b>Input catatan biaya tenaga harian</b> di bawah; analisis per gudang dan per hari muncul otomatis setelah ada catatan.');
      $('bcgStats').innerHTML = ''; $('bcgChart').innerHTML = ''; $('bcgGdTable').innerHTML = '';
      fillSelect('bcgBulan', [], 'Belum ada bulan'); fillSelect('bcgGudang', [], 'Semua gudang');
      bcgTable.render();
      return;
    }
    showNote('bcgWarn', '');
    var months = uniq(all.map(function (r) { return ymd10(r.tanggal).slice(0, 7) + '-01'; })).sort().reverse();
    $('bcgBulan').innerHTML = months.map(function (m) { return '<option value="' + esc(m) + '">' + esc(fMonthLong(m)) + '</option>'; }).join('');
    if (!state.bcg.bulan || months.indexOf(state.bcg.bulan) < 0) state.bcg.bulan = months[0];
    $('bcgBulan').value = state.bcg.bulan;

    var mrows = bcgMonthRows();
    var gs = uniq(mrows.map(function (r) { return r.gudang; })).sort();
    fillSelect('bcgGudang', gs, 'Semua gudang');
    state.bcg.gudang = $('bcgGudang').value;

    var srows = mrows.filter(function (r) { return !state.bcg.gudang || r.gudang === state.bcg.gudang; });
    var days = bcgDayTotals(srows, !!state.bcg.gudang);
    var biaya = sum(days, function (d) { return d.biaya; }), qty = sum(days, function (d) { return d.qty; });
    var per = qty > 0 ? biaya / qty : null;
    var target = targetFor(state.bcg.bulan);
    var pct = isNum(per) && isNum(target) && target > 0 ? per / target * 100 : null;
    var boros = days.filter(function (d) { return d.status === 'Boros'; }).length;
    $('bcgStats').innerHTML =
      statHtml(fRpS(biaya), 'Total biaya tenaga', esc(fMonthLong(state.bcg.bulan)) + ' · ' + (state.bcg.gudang ? esc(state.bcg.gudang) : 'semua gudang')) +
      statHtml(fInt(qty) + ' karton', 'Qty dimuat', fInt(days.length) + ' hari tercatat') +
      statHtml(isNum(per) ? 'Rp ' + fInt(per) : '—', 'Biaya per karton', (efisiensiOf(pct) || '—') + (isNum(target) ? ' · target Rp ' + fInt(target) : '')) +
      statHtml(fInt(boros) + ' dari ' + fInt(days.length), 'Hari berstatus Boros', 'biaya per karton di atas 110% target');

    var head = '<th scope="col" class="l">Gudang</th><th scope="col">Hari tercatat</th><th scope="col">Qty dimuat</th><th scope="col">Total biaya</th>' +
      '<th scope="col">Karton/pekerja</th><th scope="col">Biaya/karton</th><th scope="col">% target</th><th scope="col" class="l">Status</th>';
    var body = gs.map(function (g) {
      var a = bcgGudangAgg(mrows.filter(function (r) { return r.gudang === g; }));
      return '<tr><td class="l">' + esc(g === 'SEMUA' ? 'SEMUA (catatan total)' : g) + '</td>' +
        '<td data-label="Hari tercatat">' + fInt(a.hari) + '</td>' +
        '<td data-label="Qty dimuat">' + fInt(a.qty) + '</td>' +
        '<td data-label="Total biaya">Rp ' + fInt(a.biaya) + '</td>' +
        '<td data-label="Karton/pekerja">' + fDec(a.kpp) + '</td>' +
        '<td data-label="Biaya/karton"><b>' + (isNum(a.per) ? 'Rp ' + fInt(a.per) : '—') + '</b></td>' +
        '<td data-label="% target">' + (isNum(a.pct) ? fDec(a.pct) + '%' : '—') + '</td>' +
        '<td class="l" data-label="Status">' + efisiensiChip(a.status) + '</td></tr>';
    }).join('');
    $('bcgGdTable').innerHTML = '<table class="an-table an-cards"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
    $('bcgChart').innerHTML = days.length ? bcgChartSvg(days) : '<p class="an-updated">Tidak ada data pada pilihan ini.</p>';
    bcgTable.reset(); bcgTable.render();
  }
  function rowStatus(r) {
    var t = targetFor(r.tanggal);
    return efisiensiOf(isNum(r.biaya_per_karton) && isNum(t) && t > 0 ? r.biaya_per_karton / t * 100 : null);
  }
  var bcgTable = makeTable({
    host: 'bcgTable', count: 'bcgCount', pager: 'bcgPager', sortM: 'bcgSortM', sort: { key: 'tanggal', dir: 'desc' },
    empty: 'Tidak ada catatan yang cocok dengan filter.',
    rows: function () {
      if (!state.data || !state.bcg.bulan) return [];
      var only = $('bcgBoros').checked;
      return bcgMonthRows().filter(function (r) {
        return (!state.bcg.gudang || r.gudang === state.bcg.gudang) && (!only || rowStatus(r) === 'Boros');
      });
    },
    cols: [
      { key: 'tanggal', label: 'Tanggal', left: true, html: function (r) { return fDate(r.tanggal); } },
      { key: 'gudang', label: 'Gudang', left: true },
      { key: 'jumlah_pekerja', label: 'Pekerja', fmt: 'int' },
      { key: 'biaya_per_pekerja', label: 'Biaya/pekerja', html: function (r) { return isNum(r.biaya_per_pekerja) ? 'Rp ' + fInt(r.biaya_per_pekerja) : '—'; } },
      { key: 'total_biaya', label: 'Total biaya', html: function (r) { return isNum(r.total_biaya) ? 'Rp ' + fInt(r.total_biaya) : '—'; } },
      { key: 'qty_dimuat', label: 'Qty dimuat', fmt: 'int' },
      { key: 'biaya_per_karton', label: 'Biaya/karton', html: function (r) { return isNum(r.biaya_per_karton) ? '<b>Rp ' + fInt(r.biaya_per_karton) + '</b>' : '—'; } },
      { key: 'jam_kerja', label: 'Jam kerja', fmt: 'dec' },
      { key: 'status', label: 'Status', left: true, val: function (r) { return rowStatus(r); }, html: function (r) { return efisiensiChip(rowStatus(r)); } }
    ]
  });

  // ---------- 3e. proyeksi budget tenaga kerja (v_estimasi_biaya_bulan_depan) ----------
  function renderProyeksi() {
    var e = state.data.estimasi;
    if (!e || !isNum(e.proyeksi_qty_22hari)) {
      $('pjStats').innerHTML = '';
      $('pjTable').innerHTML = '<p class="an-updated">Belum ada proyeksi (v_estimasi_biaya_bulan_depan kosong atau belum dikirim edge function).</p>';
      $('pjNote').textContent = '';
      return;
    }
    var has = isNum(e.proyeksi_biaya_rp);
    var tgt = e.target_biaya_per_carton_saat_ini;
    var selisih = has && isNum(e.budget_ideal_rp) ? e.proyeksi_biaya_rp - e.budget_ideal_rp : null;
    $('pjStats').innerHTML =
      statHtml(fInt(e.proyeksi_qty_22hari) + ' karton', 'Proyeksi volume', '22 hari kirim ke depan, jumlah proyeksi semua SKU') +
      (has ? statHtml(fRpS(e.proyeksi_biaya_rp), 'Budget tenaga kerja (rata-rata)', 'Rp ' + fInt(e.rata2_biaya_per_carton) + '/karton · rentang ' + fRpS(e.proyeksi_biaya_rp_terendah) + ' – ' + fRpS(e.proyeksi_biaya_rp_tertinggi)) : '') +
      (isNum(e.budget_ideal_rp) ? statHtml(fRpS(e.budget_ideal_rp), 'Budget di target', 'target Rp ' + fInt(tgt) + '/karton') : '') +
      (isNum(selisih) ? statHtml(fRpS(Math.abs(selisih)), 'Selisih proyeksi vs target', selisih > 0 ? 'di atas budget target' : selisih < 0 ? 'di bawah budget target' : 'sama dengan target') : '');
    if (!has) {
      $('pjTable').innerHTML = '<p class="an-updated">Biaya per karton belum bisa dijadikan dasar karena belum ada bulan dengan cost labour terisi.</p>';
      $('pjNote').textContent = '';
      return;
    }
    var rows = [
      { nama: 'Rendah', hint: 'biaya per karton terendah dari bulan acuan', per: e.min_biaya_per_carton, budget: e.proyeksi_biaya_rp_terendah },
      { nama: 'Rata-rata', hint: 'rata-rata biaya per karton bulan acuan', per: e.rata2_biaya_per_carton, budget: e.proyeksi_biaya_rp },
      { nama: 'Tinggi', hint: 'biaya per karton tertinggi dari bulan acuan', per: e.max_biaya_per_carton, budget: e.proyeksi_biaya_rp_tertinggi },
      { nama: 'Sesuai target', hint: 'biaya per karton = target', per: tgt, budget: e.budget_ideal_rp }
    ];
    var head = '<th scope="col" class="l">Skenario</th><th scope="col">Biaya/karton</th><th scope="col">% target</th><th scope="col">Budget</th><th scope="col">Selisih vs target</th><th scope="col" class="l">Dasar</th>';
    var body = rows.map(function (s) {
      var d = isNum(s.budget) && isNum(e.budget_ideal_rp) ? s.budget - e.budget_ideal_rp : null;
      return '<tr><td class="l"><b>' + esc(s.nama) + '</b></td>' +
        '<td data-label="Biaya/karton">' + (isNum(s.per) ? 'Rp ' + fInt(s.per) : '—') + '</td>' +
        '<td data-label="% target">' + (isNum(s.per) && isNum(tgt) && tgt > 0 ? fDec(s.per / tgt * 100) + '%' : '—') + '</td>' +
        '<td data-label="Budget"><b>' + (isNum(s.budget) ? 'Rp ' + fInt(s.budget) : '—') + '</b></td>' +
        '<td data-label="Selisih vs target">' + (isNum(d) ? (d > 0 ? '+' : d < 0 ? '-' : '') + 'Rp ' + fInt(Math.abs(d)) : '—') + '</td>' +
        '<td class="l" data-label="Dasar">' + esc(s.hint) + '</td></tr>';
    }).join('');
    $('pjTable').innerHTML = '<table class="an-table an-cards"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
    $('pjNote').textContent = 'Bulan acuan biaya: ' + fMonthLong(e.bulan_acuan_awal) + (ymd10(e.bulan_acuan_awal) === ymd10(e.bulan_acuan_akhir) ? '' : ' sampai ' + fMonthLong(e.bulan_acuan_akhir)) +
      ' (' + fInt(e.jumlah_bulan_acuan) + ' bulan yang cost labour-nya sudah diisi).';
  }

  // ---------- 3f. evaluasi target biaya per karton ----------
  // Dihitung dari data bulanan yang sudah ada (biaya_carton), sama dengan logika view SQL v_evaluasi_target_biaya.
  function pctile(sortedAsc, p) {
    var n = sortedAsc.length;
    if (!n) return null;
    var r = p * (n - 1), lo = Math.floor(r), hi = Math.ceil(r);
    return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (r - lo);
  }
  function evaluasiTarget() {
    var all = state.data.biaya || [];
    var rows = all.filter(function (r) { return isNum(r.biaya_per_carton) && isNum(r.cost_labour) && isNum(r.total_delivery) && r.total_delivery > 0; })
      .sort(function (a, b) { return ymd10(a.bulan).localeCompare(ymd10(b.bulan)); });
    var n = rows.length;
    if (n < 3) return { n: n };
    var target = null;
    all.forEach(function (r) { if (isNum(r.target_rp)) target = r.target_rp; });
    if (!isNum(target)) return { n: n, noTarget: true };

    var pers = rows.map(function (r) { return r.biaya_per_carton; }).sort(function (a, b) { return a - b; });
    var med = pctile(pers, 0.5), p25 = pctile(pers, 0.25);
    var berbobotAll = sum(rows, function (r) { return r.cost_labour; }) / sum(rows, function (r) { return r.total_delivery; });
    var last3 = rows.slice(-3);
    var berbobot3 = sum(last3, function (r) { return r.cost_labour; }) / sum(last3, function (r) { return r.total_delivery; });
    var qty3 = sum(last3, function (r) { return r.total_delivery; }) / last3.length;

    // regresi linear: cost_labour = tetap + variabel x karton
    var mx = sum(rows, function (r) { return r.total_delivery; }) / n, my = sum(rows, function (r) { return r.cost_labour; }) / n;
    var sxy = 0, sxx = 0, syy = 0;
    rows.forEach(function (r) { var dx = r.total_delivery - mx, dy = r.cost_labour - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; });
    var model = sxx > 0 ? { variabel: sxy / sxx, tetap: my - (sxy / sxx) * mx, r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : null } : null;
    var struktur = model ? model.tetap / qty3 + model.variabel : null;

    var tip = [berbobot3, med].concat(isNum(struktur) ? [struktur] : []).sort(function (a, b) { return a - b; });
    var tipikal = pctile(tip, 0.5);
    var realistis = Math.round(tipikal / 5) * 5, tantangan = Math.round(p25 / 5) * 5;

    function volMin(t) { return model && t > model.variabel && model.tetap > 0 ? model.tetap / (t - model.variabel) : null; }
    function skenario(kelompok, nama, t, dasar) {
      return { kelompok: kelompok, nama: nama, target: t, dasar: dasar, selisih: (t / target - 1) * 100,
        tercapai: rows.filter(function (r) { return r.biaya_per_carton <= t; }).length, volMin: volMin(t) };
    }
    var list = [
      skenario('SAAT_INI', 'Target saat ini', target, 'Nilai di tabel target_biaya_karton'),
      skenario('KANDIDAT', 'Rata-rata berbobot 3 bulan terakhir', berbobot3, 'Total cost labour dibagi total karton, 3 bulan terakhir'),
      skenario('KANDIDAT', 'Median seluruh bulan', med, 'Separuh bulan lebih murah, separuh lebih mahal')
    ];
    if (isNum(struktur)) list.push(skenario('KANDIDAT', 'Model struktur biaya di volume 3 bulan terakhir', struktur, 'Biaya tetap dibagi volume ditambah biaya variabel per karton (indikatif)'));
    list.push(skenario('KANDIDAT', 'Rata-rata berbobot seluruh bulan', berbobotAll, 'Total cost labour dibagi total karton, semua bulan'));
    list.push(skenario('KANDIDAT', 'Kuartil terbaik (P25)', p25, 'Hanya tercapai pada bulan-bulan terbaik, biasanya volume tinggi'));
    list.push(skenario('REKOMENDASI', 'Realistis', realistis, 'Median tiga estimasi tipikal, dibulatkan ke 5'));
    list.push(skenario('REKOMENDASI', 'Tantangan', tantangan, 'Kuartil terbaik dibulatkan ke 5; butuh volume tinggi yang konsisten'));
    return { n: n, target: target, model: model, tipikal: tipikal, realistis: realistis, tantangan: tantangan, list: list, rows: rows,
      cur: list[0], volMinTarget: volMin(target), volReal: volMin(realistis), volTant: volMin(tantangan) };
  }
  function renderEvaluasiTarget() {
    var e = evaluasiTarget();
    if (!e.list) {
      $('etStats').innerHTML = ''; $('etTable').innerHTML = '';
      $('etVerdict').innerHTML = e.noTarget ? 'Target belum diisi di <code>target_biaya_karton</code>.'
        : 'Belum cukup data: perlu minimal 3 bulan dengan cost labour terisi (saat ini ' + fInt(e.n) + ').';
      $('etNote').textContent = '';
      return;
    }
    var cur = e.cur, pctOk = Math.round(cur.tercapai / e.n * 100);
    var r2 = e.model && isNum(e.model.r2) ? (Math.round(e.model.r2 * 100) / 100).toString().replace('.', ',') : '—';
    $('etStats').innerHTML =
      statHtml('Rp ' + fInt(e.target), 'Target saat ini', fInt(cur.tercapai) + ' dari ' + fInt(e.n) + ' bulan tercapai (' + pctOk + '%)') +
      statHtml('Rp ' + fInt(e.tipikal), 'Level tipikal biaya', 'median dari tiga estimasi: berbobot 3 bulan, median, model struktur') +
      statHtml('Rp ' + fInt(e.realistis), 'Usulan target realistis', isNum(e.volReal) ? 'butuh ≥ ' + fInt(e.volReal) + ' karton per bulan' : '') +
      statHtml('Rp ' + fInt(e.tantangan), 'Usulan target tantangan', isNum(e.volTant) ? 'butuh ≥ ' + fInt(e.volTant) + ' karton per bulan' : '') +
      (e.model ? statHtml(fRpS(e.model.tetap), 'Biaya tetap per bulan (perkiraan)', '+ Rp ' + fInt(e.model.variabel) + ' per karton · R² ' + r2) : '');

    var diff = (e.target / e.tipikal - 1) * 100;
    var posisi = diff > 3 ? 'lebih longgar ' + fDec(diff) + '% dari' : diff < -3 ? 'lebih ketat ' + fDec(-diff) + '% dari' : 'kurang lebih sejalan dengan';
    var miss = e.rows.filter(function (r) { return r.biaya_per_carton > e.target; });
    var verdict = 'Target <b>Rp ' + fInt(e.target) + '</b> ' + posisi + ' level tipikal (Rp ' + fInt(e.tipikal) + ') dan tercapai <b>' + fInt(cur.tercapai) + ' dari ' + fInt(e.n) + ' bulan</b>.';
    if (miss.length) {
      verdict += ' Bulan di atas target: ' + miss.map(function (r) { return fMonthLong(r.bulan) + ' (Rp ' + fInt(r.biaya_per_carton) + ', ' + fInt(r.total_delivery) + ' karton)'; }).join(', ') + '.';
      if (isNum(e.volMinTarget)) {
        var low = miss.filter(function (r) { return r.total_delivery < e.volMinTarget; }).length;
        verdict += ' ' + (low === miss.length ? 'Semuanya' : fInt(low) + ' dari ' + fInt(miss.length)) + ' volumenya di bawah volume minimum sekitar ' + fInt(e.volMinTarget) + ' karton per bulan, jadi penyebab utamanya volume, bukan efisiensi kerja.';
      }
    }
    $('etVerdict').innerHTML = verdict;

    var head = '<th scope="col" class="l">Skenario</th><th scope="col">Target (Rp/karton)</th><th scope="col">Selisih vs saat ini</th><th scope="col">Bulan tercapai</th><th scope="col">Volume minimum/bulan</th><th scope="col" class="l">Dasar</th>';
    var body = e.list.map(function (s) {
      var strong = s.kelompok !== 'KANDIDAT';
      var nm = (s.kelompok === 'REKOMENDASI' ? 'Usulan: ' : '') + s.nama;
      return '<tr><td class="l">' + (strong ? '<b>' + esc(nm) + '</b>' : esc(nm)) + '</td>' +
        '<td data-label="Target (Rp/karton)">' + (strong ? '<b>' : '') + 'Rp ' + fInt(s.target) + (strong ? '</b>' : '') + '</td>' +
        '<td data-label="Selisih vs saat ini">' + (s.kelompok === 'SAAT_INI' ? '—' : (s.selisih > 0 ? '+' : '') + fDec(s.selisih) + '%') + '</td>' +
        '<td data-label="Bulan tercapai">' + fInt(s.tercapai) + ' dari ' + fInt(e.n) + '</td>' +
        '<td data-label="Volume minimum/bulan">' + (isNum(s.volMin) ? fInt(s.volMin) + ' karton' : '—') + '</td>' +
        '<td class="l" data-label="Dasar">' + esc(s.dasar) + '</td></tr>';
    }).join('');
    $('etTable').innerHTML = '<table class="an-table an-cards"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
    $('etNote').textContent = 'Dasar: ' + fInt(e.n) + ' bulan dengan cost labour terisi (' + fMonthLong(e.rows[0].bulan) + ' sampai ' + fMonthLong(e.rows[e.rows.length - 1].bulan) +
      '). Model biaya tetap dan variabel dihitung dari sedikit bulan sehingga volume minimum hanya indikatif. Target ini per karton pada level bulanan, bukan per hari: biaya tenaga per hari relatif tetap sehingga biaya per karton harian naik-turun mengikuti volume hari itu.';
  }

  // ---------- 4. kelengkapan master ----------
  function renderKualitas() {
    var map = {};
    state.data.sku.forEach(function (r) {
      var e = map[r.kode_sku] || (map[r.kode_sku] = { kode: r.kode_sku, nama: r.nama || '', baris: 0, ada: true });
      e.baris += r.jumlah_baris || 0;
      e.ada = e.ada && r.ada_di_master !== false;
      if (!e.nama && r.nama) e.nama = r.nama;
    });
    var list = Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.baris - a.baris; });
    var belum = list.filter(function (e) { return !e.ada; }).length;
    function stat(v, l, s) { return '<div class="an-stat"><div class="v">' + v + '</div><div class="l">' + l + '</div><div class="s">' + s + '</div></div>'; }
    if (!list.length) {
      $('anKualStats').innerHTML = stat('0 SKU', 'SKU belum lengkap', 'semua SKU sudah punya volume dan berat');
      $('anKualTable').innerHTML = '';
      return;
    }
    $('anKualStats').innerHTML =
      stat(fInt(list.length) + ' SKU', 'SKU belum lengkap di master produk', 'belum punya volume atau berat') +
      stat(fInt(belum) + ' SKU', 'Belum terdaftar di master', 'perlu ditambahkan ke tabel master_produk') +
      stat(fInt(list.length - belum) + ' SKU', 'Terdaftar, volume atau berat kosong', 'perlu dilengkapi di master_produk');
    $('anKualTable').innerHTML = '<table class="an-table an-cards"><thead><tr><th scope="col" class="l">SKU</th><th scope="col" class="l">Kondisi</th><th scope="col">Baris terdampak</th></tr></thead><tbody>' +
      list.slice(0, 8).map(function (e) {
        return '<tr><td class="prod">' + esc(e.nama || e.kode) + '<span class="sku">' + esc(e.kode) + '</span></td>' +
          '<td class="l" data-label="Kondisi"><span class="an-chip ' + (e.ada ? 'warn' : 'bad') + '">' + (e.ada ? 'Volume/berat kosong' : 'Belum ada di master') + '</span></td>' +
          '<td data-label="Baris terdampak">' + fInt(e.baris) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      (list.length > 8 ? '<p class="an-updated" style="margin-top:8px">Menampilkan 8 SKU dengan baris terdampak terbanyak dari ' + fInt(list.length) + ' SKU.</p>' : '');
  }


  // ---------- komponen umum ----------
  function statHtml(v, l, s2) {
    return '<div class="an-stat"><div class="v">' + v + '</div><div class="l">' + l + '</div><div class="s">' + s2 + '</div></div>';
  }
  function fillSelect(id, options, allLabel) {
    var el = $(id), cur = el.value;
    el.innerHTML = '<option value="">' + esc(allLabel) + '</option>' + options.map(function (o) {
      var v = typeof o === 'string' ? o : o.value, t = typeof o === 'string' ? o : o.label;
      return '<option value="' + esc(v) + '">' + esc(t) + '</option>';
    }).join('');
    var ok = options.some(function (o) { return (typeof o === 'string' ? o : o.value) === cur; });
    el.value = ok ? cur : '';
  }
  function statusChip(key) {
    var m = statusMeta(key);
    return '<span class="an-chip ' + m.tone + '">' + esc(m.label) + '</span>';
  }
  function matches(q, parts) {
    if (!q) return true;
    return parts.some(function (p) { return String(p || '').toLowerCase().indexOf(q) >= 0; });
  }

  // Pagination bernomor: render 1 … 4 [5] 6 … N ke dalam <div class="an-pager">.
  // page: halaman aktif (1-based), total: total baris, size: baris/halaman, onGo(p): pindah halaman.
  function renderPager(host, page, total, size, onGo) {
    var el = typeof host === 'string' ? $(host) : host;
    if (!el) return;
    var pages = Math.max(1, Math.ceil(total / size));
    page = Math.min(Math.max(1, page), pages);
    if (pages <= 1) { el.innerHTML = ''; return; }
    function btn(p, label, disabled, on) {
      return '<button type="button" data-pg="' + p + '"' + (disabled ? ' disabled' : '') + (on ? ' class="on"' : '') + '>' + label + '</button>';
    }
    var nums = [];
    var win = 1; // halaman di sekitar current yang ditampilkan penuh
    for (var p = 1; p <= pages; p++) {
      if (p === 1 || p === pages || Math.abs(p - page) <= win) nums.push(p);
    }
    var out = btn(page - 1, '‹', page <= 1, false);
    var prev = null;
    nums.forEach(function (p) {
      if (prev !== null && p - prev > 1) out += '<span class="dots">…</span>';
      out += btn(p, String(p), false, p === page);
      prev = p;
    });
    out += btn(page + 1, '›', page >= pages, false);
    el.innerHTML = out;
    el.onclick = function (e) {
      var b = e.target.closest('[data-pg]');
      if (!b || b.disabled) return;
      onGo(Number(b.dataset.pg));
    };
  }

  // Tabel generik: urutan klik header, paginasi, pilihan urutan untuk layar sempit.
  // Kolom: { key, label, left, cls, fmt:'int'|'dec', html(r), val(r), rank(v), dir:'asc'|'desc' }
  function makeTable(o) {
    var size = o.pageSize || PAGE_SIZE;
    var st = { sort: Object.assign({}, o.sort), page: 1 };
    var cols = o.cols;
    function colOf(k) { return cols.filter(function (c) { return c.key === k; })[0]; }
    function val(c, r) { return c.val ? c.val(r) : r[c.key]; }
    function isNil(x) { return x === null || x === undefined || x === '' || (typeof x === 'number' && !isFinite(x)); }
    function cmp(a, b) {
      var c = colOf(st.sort.key);
      if (!c) return 0;
      var m = st.sort.dir === 'asc' ? 1 : -1;
      var x = val(c, a), y = val(c, b);
      if (c.rank) { x = c.rank(x); y = c.rank(y); }
      if (isNil(x) && isNil(y)) return 0;
      if (isNil(x)) return 1;
      if (isNil(y)) return -1;
      if (typeof x === 'string' || typeof y === 'string') return String(x).localeCompare(String(y), 'id') * m;
      return (x - y) * m;
    }
    function cell(c, r) {
      var inner = c.html ? c.html(r) : c.fmt === 'int' ? fInt(val(c, r)) : c.fmt === 'dec' ? fDec(val(c, r)) : esc(val(c, r));
      return '<td class="' + (c.left ? 'l ' : '') + (c.cls || '') + '" data-label="' + esc(c.label) + '">' + inner + '</td>';
    }
    function buildSortSelect() {
      var host = o.sortM && $(o.sortM);
      if (!host) return;
      host.innerHTML = '<label>Urutkan <select>' + cols.map(function (c) {
        return '<option value="' + esc(c.key) + '">' + esc(c.label) + '</option>';
      }).join('') + '</select></label>';
      host.querySelector('select').addEventListener('change', function (e) {
        var c = colOf(e.target.value);
        st.sort = { key: c.key, dir: c.dir || (c.left ? 'asc' : 'desc') };
        render();
      });
    }
    function render() {
      var rows = o.rows().slice().sort(cmp);
      var pages = Math.max(1, Math.ceil(rows.length / size));
      if (st.page > pages) st.page = pages;
      var start = (st.page - 1) * size;
      var shown = rows.slice(start, start + size);
      var head = cols.map(function (c) {
        var active = st.sort.key === c.key;
        return '<th scope="col" class="' + (c.left ? 'l' : '') + '" aria-sort="' + (active ? (st.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') + '">' +
          '<button type="button" class="an-th" data-sort="' + esc(c.key) + '">' + esc(c.label) + '<span class="arr">' + (active ? (st.sort.dir === 'asc' ? '▲' : '▼') : '') + '</span></button></th>';
      }).join('');
      var body = shown.map(function (r) { return '<tr>' + cols.map(function (c) { return cell(c, r); }).join('') + '</tr>'; }).join('');
      $(o.host).innerHTML = rows.length
        ? '<table class="an-table an-cards"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>'
        : '<p class="an-updated">' + esc(o.empty || 'Tidak ada baris yang cocok dengan filter.') + '</p>';
      $(o.count).textContent = rows.length
        ? 'Menampilkan ' + fInt(start + 1) + '–' + fInt(start + shown.length) + ' dari ' + fInt(rows.length) + ' baris'
        : '';
      renderPager(o.pager, st.page, rows.length, size, function (p) { st.page = p; render(); });
      var sel = o.sortM && $(o.sortM) && $(o.sortM).querySelector('select');
      if (sel) sel.value = st.sort.key;
    }
    $(o.host).addEventListener('click', function (e) {
      var b = e.target.closest('[data-sort]');
      if (!b) return;
      var c = colOf(b.dataset.sort);
      if (!c) return;
      st.sort = st.sort.key === c.key
        ? { key: c.key, dir: st.sort.dir === 'asc' ? 'desc' : 'asc' }
        : { key: c.key, dir: c.dir || (c.left ? 'asc' : 'desc') };
      st.page = 1;
      render();
    });
    buildSortSelect();
    return {
      render: render,
      reset: function () { st.page = 1; },
      setCols: function (newCols, sort) { cols = newCols; if (sort) st.sort = Object.assign({}, sort); buildSortSelect(); }
    };
  }
  function bindFilters(ids, table) {
    ids.forEach(function (id) {
      var el = $(id);
      el.addEventListener(el.tagName === 'INPUT' && el.type !== 'checkbox' ? 'input' : 'change', function () { table.reset(); table.render(); });
    });
  }
  function prodCell(name, sub) { return esc(name) + '<span class="sku">' + esc(sub) + '</span>'; }

  // ---------- stok saat ini (v_stok_terbaru) ----------
  var stokTable = makeTable({
    host: 'stTable', count: 'stCount', pager: 'stPager', sortM: 'stSortM', sort: { key: 'stok_available', dir: 'desc' },
    rows: function () {
      var g = $('stG').value, q = $('stQ').value.trim().toLowerCase();
      return state.data.stok.filter(function (r) { return (!g || r.whs === g) && matches(q, [r.item_code, r.produk]); });
    },
    cols: [
      { key: 'whs', label: 'Gudang', left: true },
      { key: 'produk', label: 'Produk', left: true, cls: 'prod', html: function (r) { return prodCell(r.produk, r.item_code); } },
      { key: 'stok_hari_ini', label: 'Stok', fmt: 'int' },
      { key: 'kirim_hari_ini', label: 'Kirim hari ini', fmt: 'int' },
      { key: 'kirim_besok', label: 'Kirim besok', fmt: 'int' },
      { key: 'stok_available', label: 'Stok tersedia', fmt: 'int' },
      { key: 'pallet', label: 'Estimasi pallet', fmt: 'int', val: function (r) { return r.qty_per_pallet > 0 && isNum(r.stok_hari_ini) ? r.stok_hari_ini / r.qty_per_pallet : null; } },
      { key: 'm3_stok', label: 'Volume stok (m³)', fmt: 'int' }
    ]
  });
  function renderStok() {
    var rows = state.data.stok;
    if (!rows.length) {
      $('stStats').innerHTML = '';
      $('stTable').innerHTML = '<p class="an-updated">Belum ada data stok.</p>';
      $('stCount').textContent = ''; $('stPager').innerHTML = '';
      return;
    }
    fillSelect('stG', uniq(rows.map(function (r) { return r.whs; })).sort(), 'Semua');
    function sum(k) { return rows.reduce(function (a, r) { return a + (r[k] || 0); }, 0); }
    var pallet = rows.reduce(function (a, r) { return a + (r.qty_per_pallet > 0 && isNum(r.stok_hari_ini) ? r.stok_hari_ini / r.qty_per_pallet : 0); }, 0);
    var tanpa = rows.filter(function (r) { return r.tanpa_volume; }).length;
    $('stStats').innerHTML =
      statHtml(fInt(sum('stok_hari_ini')) + ' karton', 'Total stok', fInt(rows.length) + ' baris SKU per gudang, upload ' + fDate(rows[0].upload_date)) +
      statHtml(fInt(sum('m3_stok')) + ' m³', 'Volume stok', tanpa ? fInt(tanpa) + ' SKU tanpa data volume tidak terhitung' : 'semua SKU punya data volume') +
      statHtml(fInt(pallet) + ' pallet', 'Perkiraan pallet terpakai', 'stok dibagi isi per pallet di master produk') +
      statHtml(fInt(sum('kirim_hari_ini')) + ' karton', 'Rencana kirim hari ini', 'besok ' + fInt(sum('kirim_besok')) + ' karton');
    stokTable.render();
  }

  // ---------- stok vs rata-rata kirim (v_stok_vs_kirim) ----------
  function predStatusOf(r) {
    var hit = state.data.prediksi.filter(function (p) { return p.gudang === r.whs && p.kode_sku === r.item_code; })[0];
    return hit ? hit.status_prediksi : null;
  }
  var svkTable = makeTable({
    host: 'svkTable', count: 'svkCount', pager: 'svkPager', sortM: 'svkSortM', sort: { key: 'status', dir: 'asc' },
    rows: function () {
      var g = $('svkG').value, s2 = $('svkS').value, q = $('svkQ').value.trim().toLowerCase();
      return state.data.svk.filter(function (r) {
        return (!g || r.whs === g) && (!s2 || r.status === s2) && matches(q, [r.item_code, r.produk]);
      });
    },
    cols: [
      { key: 'whs', label: 'Gudang', left: true },
      { key: 'produk', label: 'Produk', left: true, cls: 'prod', html: function (r) { return prodCell(r.produk, r.item_code); } },
      { key: 'stok_available', label: 'Stok tersedia', fmt: 'int' },
      { key: 'rata2_kirim_per_hari', label: 'Rata-rata kirim/hari', fmt: 'int' },
      { key: 'hari_cukup', label: 'Cukup (hari)', fmt: 'dec' },
      { key: 'status', label: 'Status (rata-rata)', left: true, rank: rankStatus, dir: 'asc', html: function (r) { return statusChip(r.status); } },
      {
        key: 'status_pred', label: 'Status (prediksi)', left: true, rank: rankStatus, dir: 'asc',
        val: function (r) { return predStatusOf(r); },
        html: function (r) {
          var p = predStatusOf(r);
          if (!p) return '<span class="dim">—</span>';
          return statusChip(p) + (p !== r.status ? ' <span class="an-diff" title="Berbeda dengan status rata-rata datar">berbeda</span>' : '');
        }
      },
      { key: 'kirim_terakhir', label: 'Kirim terakhir', html: function (r) { return fDate(r.kirim_terakhir); } }
    ]
  });
  function renderSvk() {
    var rows = state.data.svk;
    if (!rows.length) {
      $('svkTable').innerHTML = '<p class="an-updated">Belum ada data.</p>';
      $('anSvkInsight').innerHTML = ''; $('svkCount').textContent = ''; $('svkPager').innerHTML = '';
      return;
    }
    fillSelect('svkG', uniq(rows.map(function (r) { return r.whs; })).sort(), 'Semua');
    fillSelect('svkS', STATUS_ORDER.filter(function (k) { return rows.some(function (r) { return r.status === k; }); }).map(function (k) {
      return { value: k, label: statusMeta(k).label };
    }), 'Semua');
    var comparable = rows.filter(function (r) { return predStatusOf(r); });
    var diff = comparable.filter(function (r) { return predStatusOf(r) !== r.status; }).length;
    $('anSvkInsight').innerHTML = comparable.length
      ? '<b>' + fInt(diff) + ' dari ' + fInt(comparable.length) + ' baris</b> berstatus berbeda antara rata-rata datar dan prediksi berbobot. ' +
        'Selisih biasanya muncul pada SKU yang lajunya baru naik atau turun, karena rata-rata datar lambat mengikuti tren.'
      : '';
    svkTable.render();
  }

  // ---------- tren per pelanggan (v_tren_bulanan, dimensi PELANGGAN) ----------
  function monthInfo() {
    var total = state.data.tren.filter(function (r) { return r.dimensi === 'TOTAL'; })
      .sort(function (a, b) { return String(a.bulan).localeCompare(String(b.bulan)); });
    return total;
  }
  var pelTable = makeTable({
    host: 'plTable', count: 'plCount', pager: 'plPager', sortM: 'plSortM', sort: { key: 'kunci', dir: 'asc' },
    rows: function () {
      var q = $('plQ').value.trim().toLowerCase();
      return statePel.filter(function (r) { return matches(q, [r.kunci]); });
    },
    cols: [{ key: 'kunci', label: 'Pelanggan', left: true, cls: 'prod' }]
  });
  var statePel = [];
  function renderPelanggan() {
    var months = monthInfo().slice(-4);
    if (!state.data.trenPel.length || !months.length) {
      statePel = [];
      $('plTable').innerHTML = '<p class="an-updated">Belum ada data tren pelanggan.</p>';
      $('plCount').textContent = ''; $('plPager').innerHTML = '';
      return;
    }
    var by = {};
    state.data.trenPel.forEach(function (r) {
      var e = by[r.kunci] || (by[r.kunci] = { kunci: r.kunci, v: {} });
      e.v[r.bulan] = r.qty_per_hari;
    });
    statePel = Object.keys(by).map(function (k) { return by[k]; });
    var full = months.filter(function (m) { return !m.bulan_berjalan; });
    var cur = full[full.length - 1], prev = full[full.length - 2];
    var cols = [{ key: 'kunci', label: 'Pelanggan', left: true, cls: 'prod' }];
    months.forEach(function (m) {
      cols.push({ key: 'm' + m.bulan, label: fMonth(m.bulan) + (m.bulan_berjalan ? '*' : ''), fmt: 'int', val: function (r) { return isNum(r.v[m.bulan]) ? r.v[m.bulan] : null; } });
    });
    cols.push({
      key: 'growth', label: cur && prev ? 'Perubahan ' + fMonth(cur.bulan) : 'Perubahan',
      val: function (r) { return cur && prev ? growthOf(r.v[cur.bulan], r.v[prev.bulan]) : null; },
      html: function (r) {
        var g = cur && prev ? growthOf(r.v[cur.bulan], r.v[prev.bulan]) : null;
        if (g === null) return '<span class="dim">—</span>';
        return '<span class="' + (g > 0.05 ? 'up' : g < -0.05 ? 'down' : 'flat') + '">' + pctText(g, true) + '</span>';
      }
    });
    pelTable.setCols(cols, { key: cur ? 'm' + cur.bulan : 'kunci', dir: cur ? 'desc' : 'asc' });
    $('anPelSub').textContent = 'Laju kirim (karton per hari kirim) tiap pelanggan pada ' + months.length + ' bulan terakhir' +
      (cur && prev ? '. Kolom perubahan membandingkan ' + fMonthLong(cur.bulan) + ' dengan ' + fMonthLong(prev.bulan) + '.' : '.') +
      (months.some(function (m) { return m.bulan_berjalan; }) ? ' Tanda * menandai bulan berjalan yang belum lengkap.' : '');
    pelTable.reset();
    pelTable.render();
  }

  // ---------- peta sebaran pelanggan ----------
  var PET_BUCKETS = [
    { min: 100000, color: '#e05252', ring: '#ffb3b3', label: 'Volume besar' },
    { min: 20000, color: '#e0a33e', ring: '#ffe1a6', label: 'Volume menengah' },
    { min: 0, color: '#3fc38a', ring: '#b8f0d6', label: 'Volume kecil' }
  ];
  function petBucket(qty) {
    for (var i = 0; i < PET_BUCKETS.length; i++) if (qty >= PET_BUCKETS[i].min) return PET_BUCKETS[i];
    return PET_BUCKETS[PET_BUCKETS.length - 1];
  }
  function petRows() {
    var all = state.data.peta, t = state.pet.tipe;
    return t === 'semua' ? all : all.filter(function (r) { return r.tipe === t; });
  }
  function petCompact(n) {
    if (!isNum(n)) return '-';
    if (n >= 1000000) return nf1.format(n / 1000000) + 'jt';
    if (n >= 1000) return nf1.format(n / 1000) + 'rb';
    return fInt(n);
  }
  function petBadgeIcon(row, maxQty) {
    var qty = row.total_qty || 0;
    var b = petBucket(qty);
    var min = 30, max = 58;
    var size = maxQty ? Math.round(min + (Math.sqrt(qty) / Math.sqrt(maxQty)) * (max - min)) : min;
    var fontSize = Math.max(10, Math.round(size * 0.32));
    var html = '<div class="ppb-badge" style="width:' + size + 'px;height:' + size + 'px;background:' + b.color +
      ';box-shadow:0 0 0 4px ' + b.ring + '55, 0 2px 6px rgba(0,0,0,.45);">' +
      '<span style="font-size:' + fontSize + 'px;">' + esc(petCompact(row.jml_pelanggan)) + '</span>' +
      (row.tipe === 'negara' ? '<i class="ppb-flag" title="Luar negeri"></i>' : '') + '</div>';
    return L.divIcon({ html: html, className: 'ppb-icon-wrap', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }
  // Icon untuk cluster (gabungan beberapa wilayah yang berdekatan pada zoom
  // level tertentu). Warna & ukuran dihitung dari total qty gabungan semua
  // wilayah di dalam cluster itu, angka di badge = total pelanggan unik
  // gabungan. petaMaxQty di-refresh tiap renderPetaMap() dan dibaca di sini
  // lewat closure supaya skala ukuran tetap konsisten dengan marker tunggal.
  function petClusterIcon(cluster) {
    var markers = cluster.getAllChildMarkers();
    var totalQty = 0, totalPelanggan = 0, hasNegara = false;
    markers.forEach(function (m) {
      var r = m.options.petRow || {};
      totalQty += r.total_qty || 0;
      totalPelanggan += r.jml_pelanggan || 0;
      if (r.tipe === 'negara') hasNegara = true;
    });
    var b = petBucket(totalQty);
    var min = 34, max = 64;
    var ref = Math.max(petaMaxQty, totalQty);
    var size = ref ? Math.round(min + (Math.sqrt(totalQty) / Math.sqrt(ref)) * (max - min)) : min;
    var fontSize = Math.max(11, Math.round(size * 0.3));
    var html = '<div class="ppb-badge ppb-cluster" style="width:' + size + 'px;height:' + size + 'px;background:' + b.color +
      ';box-shadow:0 0 0 4px ' + b.ring + '66, 0 2px 8px rgba(0,0,0,.5);">' +
      '<span style="font-size:' + fontSize + 'px;">' + esc(petCompact(totalPelanggan)) + '</span>' +
      (hasNegara ? '<i class="ppb-flag" title="Termasuk luar negeri"></i>' : '') + '</div>';
    return L.divIcon({ html: html, className: 'ppb-icon-wrap', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }
  function petPopupHtml(r) {
    return '<div style="min-width:190px;font-family:inherit;">' +
      '<strong>' + esc(r.label) + '</strong>' +
      '<div style="font-size:12px;color:#666;margin-bottom:6px;">' + (r.tipe === 'negara' ? 'Luar negeri' : 'Domestik') + '</div>' +
      '<table style="font-size:13px;width:100%;">' +
      '<tr><td>Pelanggan</td><td style="text-align:right;">' + fInt(r.jml_pelanggan) + '</td></tr>' +
      '<tr><td>Kota tujuan</td><td style="text-align:right;">' + fInt(r.jml_kota) + '</td></tr>' +
      '<tr><td>Total karton</td><td style="text-align:right;">' + fInt(r.total_qty) + '</td></tr>' +
      '<tr><td>Total m³</td><td style="text-align:right;">' + fDec(r.total_m3) + '</td></tr>' +
      '<tr><td>Total kg</td><td style="text-align:right;">' + fInt(r.total_kg) + '</td></tr>' +
      '<tr><td>Kirim terakhir</td><td style="text-align:right;">' + fDate(r.kirim_terakhir) + '</td></tr>' +
      '</table></div>';
  }
  // Stats + legend + filter-button state: aman dipanggil kapan pun (tidak
  // menyentuh Leaflet), jadi ikut dipanggil dari render() seperti tab lain.
  function renderPeta() {
    Array.prototype.forEach.call($('petSeg').querySelectorAll('[data-tipe]'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.tipe === state.pet.tipe));
    });
    var rows = petRows();
    var pelanggan = 0, qty = 0;
    rows.forEach(function (r) { pelanggan += r.jml_pelanggan || 0; qty += r.total_qty || 0; });
    function stat(v, l) { return '<div class="an-stat"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>'; }
    $('anPetaStats').innerHTML = !state.data.peta.length ? '' :
      stat(fInt(rows.length), 'wilayah aktif') + stat(fInt(pelanggan), 'pelanggan (unik per wilayah)') + stat(fInt(qty), 'total karton terkirim');
    $('anPetaLegend').innerHTML = !state.data.peta.length ? '' :
      PET_BUCKETS.slice().reverse().map(function (b) { return '<span><i class="dot" style="background:' + b.color + '"></i>' + b.label + '</span>'; }).join('') +
      '<span><i class="dot" style="background:#1b2436;border:2px solid #fff"></i>Penanda luar negeri</span>' +
      '<span style="margin-left:auto;font-style:italic;">Angka pada badge = jumlah pelanggan unik</span>';
  }
  // Leaflet butuh container yang sudah terlihat (ukuran > 0) saat dibuat,
  // jadi map di-init secara lazy pas panel "peta" pertama kali dibuka
  // (dipanggil dari showSub), bukan dari render() yang bisa terjadi saat
  // panel masih hidden. Panggilan berikutnya tinggal update marker +
  // invalidateSize (perlu tiap kali panel disembunyikan lalu ditampilkan
  // lagi, karena ukuran container bisa berubah).
  function renderPetaMap() {
    if (!state.data || !state.data.peta.length) return;
    var host = $('anPetaMap');
    if (!petaMap) {
      petaMap = L.map(host, { center: [-2.5, 118], zoom: 5, scrollWheelZoom: true });
      L.tileLayer(CARTO_TILE_URL, { attribution: CARTO_ATTRIBUTION, maxZoom: 20 }).addTo(petaMap);
      // markerClusterGroup: badge yang berdekatan (mis. Jabodetabek–Bandung)
      // otomatis digabung jadi satu cluster bulat saat zoom out, lalu pecah
      // sendiri (atau spiderfy) begitu di-zoom in / diklik, jadi tidak lagi
      // saling tumpuk seperti pakai layerGroup biasa.
      petaLayer = L.markerClusterGroup({
        maxClusterRadius: 55,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        zoomToBoundsOnClick: true,
        iconCreateFunction: petClusterIcon
      });
      petaLayer.addTo(petaMap);
    }
    petaLayer.clearLayers();
    var rows = petRows();
    petaMaxQty = rows.reduce(function (m, r) { return Math.max(m, r.total_qty || 0); }, 0);
    var markers = rows.map(function (r) {
      return L.marker([r.lat, r.lng], { icon: petBadgeIcon(r, petaMaxQty), petRow: r }).bindPopup(petPopupHtml(r));
    });
    petaLayer.addLayers(markers);
    setTimeout(function () { petaMap.invalidateSize(); }, 0);
  }

  // ---------- rekap harian (v_harian) ----------
  var harianTable = makeTable({
    host: 'hrTable', count: 'hrCount', pager: 'hrPager', sortM: 'hrSortM', sort: { key: 'tanggal', dir: 'desc' },
    rows: function () {
      var onlyTrip = $('hrTrip').checked;
      return state.data.harian.filter(function (r) { return !onlyTrip || isNum(r.trip); });
    },
    cols: [
      { key: 'tanggal', label: 'Tanggal', left: true, cls: 'prod', html: function (r) { return fDate(r.tanggal); } },
      { key: 'trip', label: 'Trip', fmt: 'int' },
      { key: 'kendaraan_unik', label: 'Kendaraan unik', fmt: 'int' },
      { key: 'qty', label: 'Karton', fmt: 'int' },
      { key: 'm3', label: 'Volume (m³)', fmt: 'dec' },
      { key: 'ton', label: 'Berat (ton)', fmt: 'dec', val: function (r) { return isNum(r.kg) ? r.kg / 1000 : null; } },
      { key: 'm3_per_trip', label: 'm³ per trip', fmt: 'dec' }
    ]
  });
  function dailyChartSvg(rows) {
    var W = Math.max(300, Math.round($('hrChart').clientWidth || 720)), H = 190, padL = 8, padR = 8, padT = 22, padB = 24;
    var n = rows.length;
    var max = Math.max.apply(null, rows.map(function (r) { return r.m3 || 0; }).concat([1]));
    var plotH = H - padT - padB, slot = (W - padL - padR) / n, bw = Math.max(2, slot * 0.72);
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Grafik volume harian">';
    out += '<line class="axis" x1="' + padL + '" y1="' + (H - padB) + '" x2="' + (W - padR) + '" y2="' + (H - padB) + '"/>';
    var peak = -1;
    rows.forEach(function (r, i) { if (isNum(r.m3) && (peak < 0 || r.m3 > rows[peak].m3)) peak = i; });
    rows.forEach(function (r, i) {
      var h = isNum(r.m3) && r.m3 > 0 ? Math.max(1.5, (r.m3 / max) * plotH) : 0;
      var x = padL + slot * i + (slot - bw) / 2, y = H - padB - h;
      out += '<rect class="bar' + (isNum(r.trip) ? '' : ' dim') + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '"><title>' +
        esc(fDate(r.tanggal) + ': ' + fDec(r.m3) + ' m³' + (isNum(r.trip) ? ', ' + fInt(r.trip) + ' trip' : ', tanpa data trip')) + '</title></rect>';
      if (i === peak) out += '<text class="val" x="' + Math.min(W - 24, Math.max(24, x + bw / 2)).toFixed(1) + '" y="' + (y - 5).toFixed(1) + '">' + fInt(r.m3) + ' m³</text>';
    });
    [0, Math.floor((n - 1) / 2), n - 1].forEach(function (i, k) {
      var anchor = k === 0 ? 'start' : k === 2 ? 'end' : 'middle';
      var x = k === 0 ? padL : k === 2 ? W - padR : padL + slot * i + slot / 2;
      out += '<text class="mon" style="text-anchor:' + anchor + '" x="' + x.toFixed(1) + '" y="' + (H - 6) + '">' + esc(fDate(rows[i].tanggal)) + '</text>';
    });
    return out + '</svg>';
  }
  function renderHarianChart() {
    var rows = state.data.harian.filter(function (r) { return isNum(r.m3); }).slice(-60);
    $('hrChart').innerHTML = rows.length ? dailyChartSvg(rows) : '<p class="an-updated">Belum ada data harian.</p>';
  }
  function renderHarian() {
    var all = state.data.harian;
    if (!all.length) {
      $('hrStats').innerHTML = ''; $('hrChart').innerHTML = '';
      $('hrTable').innerHTML = '<p class="an-updated">Belum ada data harian.</p>';
      $('hrCount').textContent = ''; $('hrPager').innerHTML = '';
      return;
    }
    var withM3 = all.filter(function (r) { return isNum(r.m3); });
    var last30 = withM3.slice(-30);
    var avgM3 = last30.reduce(function (a, r) { return a + r.m3; }, 0) / (last30.length || 1);
    var avgQty = last30.reduce(function (a, r) { return a + (r.qty || 0); }, 0) / (last30.length || 1);
    var trips = all.filter(function (r) { return isNum(r.trip); });
    var sumTrip = trips.reduce(function (a, r) { return a + r.trip; }, 0);
    var sumM3T = trips.reduce(function (a, r) { return a + (r.m3 || 0); }, 0);
    var sumKgT = trips.reduce(function (a, r) { return a + (r.kg || 0); }, 0);
    var lastTrip = trips.length ? trips[trips.length - 1].tanggal : null;
    $('hrStats').innerHTML =
      statHtml(fInt(avgM3) + ' m³', 'Volume kirim per hari', 'rata-rata ' + last30.length + ' hari kirim terakhir, ' + fInt(avgQty) + ' karton') +
      statHtml(fInt(trips.length) + ' dari ' + fInt(all.length) + ' hari', 'Hari yang punya data trip', lastTrip ? 'data trip terakhir ' + fDate(lastTrip) : 'belum ada data trip') +
      statHtml(trips.length ? fDec(sumTrip / trips.length) + ' trip' : '—', 'Rata-rata trip per hari', 'pada hari yang punya data trip') +
      statHtml(sumTrip ? fDec(sumM3T / sumTrip) + ' m³' : '—', 'Rata-rata muatan per trip', sumTrip ? fInt(sumKgT / sumTrip) + ' kg per trip' : '');
    renderHarianChart();
    harianTable.reset();
    harianTable.render();
  }

  // ---------- ringkasan pengiriman (v_shipments_ringkas) ----------
  function shipMonths() {
    var ms = uniq(state.data.ship.filter(function (r) { return r.dimensi === 'STATUS'; }).map(function (r) { return r.bulan; })).sort();
    var partial = monthInfo().filter(function (m) { return m.bulan_berjalan; }).map(function (m) { return m.bulan; });
    return { list: ms, partial: partial };
  }
  function shipAgg(dim, month) {
    var by = {};
    state.data.ship.forEach(function (r) {
      if (r.dimensi !== dim || (month && r.bulan !== month)) return;
      var e = by[r.kunci] || (by[r.kunci] = { kunci: r.kunci, baris: 0, qty: 0, m3: 0, kg: 0, tv: 0 });
      e.baris += r.baris || 0; e.qty += r.qty || 0; e.m3 += r.m3 || 0; e.kg += r.kg || 0; e.tv += r.baris_tanpa_volume || 0;
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.qty - a.qty; });
  }
  function miniTable(rows, first, total) {
    if (!rows.length) return '<p class="an-updated">Tidak ada data.</p>';
    return '<table class="an-table an-cards"><thead><tr><th scope="col" class="l">' + first + '</th><th scope="col">Karton</th><th scope="col">Volume (m³)</th><th scope="col">Porsi karton</th></tr></thead><tbody>' +
      rows.map(function (e) {
        return '<tr><td class="l prod">' + esc(e.kunci) + '</td><td data-label="Karton">' + fInt(e.qty) + '</td><td data-label="Volume (m³)">' + fInt(e.m3) +
          '</td><td data-label="Porsi karton">' + (total > 0 ? nf1.format(e.qty / total * 100) + '%' : '—') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  // Armada keluar per ekspedisi (dimensi ARMADA_EKSPEDISI, dari logistics): trip dan kendaraan unik.
  function armadaAgg(month) {
    var by = {};
    state.data.ship.forEach(function (r) {
      if (r.dimensi !== 'ARMADA_EKSPEDISI' || (month && r.bulan !== month)) return;
      var e = by[r.kunci] || (by[r.kunci] = { kunci: r.kunci, trip: 0, kend: 0 });
      e.trip += r.trip || 0; e.kend += r.kendaraan_unik || 0;
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.trip - a.trip; });
  }
  function armadaTable(rows, showKend) {
    if (!rows.length) return '<p class="an-updated">Belum ada data trip pada periode ini.</p>';
    var total = rows.reduce(function (a, e) { return a + e.trip; }, 0);
    return '<table class="an-table an-cards"><thead><tr><th scope="col" class="l">Ekspedisi</th><th scope="col">Armada keluar (trip)</th><th scope="col">Kendaraan unik</th><th scope="col">Porsi trip</th></tr></thead><tbody>' +
      rows.map(function (e) {
        return '<tr><td class="l prod">' + esc(e.kunci) + '</td><td data-label="Armada keluar (trip)">' + fInt(e.trip) + '</td><td data-label="Kendaraan unik">' + (showKend ? fInt(e.kend) : '—') +
          '</td><td data-label="Porsi trip">' + (total > 0 ? nf1.format(e.trip / total * 100) + '%' : '—') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  function renderShip() {
    var ms = shipMonths();
    if (!ms.list.length) {
      $('shStats').innerHTML = ''; $('shEks').innerHTML = ''; $('shPel').innerHTML = ''; $('shProv').innerHTML = '';
      $('shFefoBox').hidden = true;
      $('shStats').innerHTML = '<p class="an-updated">Belum ada data pengiriman.</p>';
      return;
    }
    var opts = ms.list.slice().reverse().map(function (m) {
      return { value: m, label: fMonthLong(m) + (ms.partial.indexOf(m) >= 0 ? ' (berjalan)' : '') };
    });
    var el = $('shBulan');
    var prevVal = el.value;
    el.innerHTML = '<option value="ALL">Semua bulan</option>' + opts.map(function (o) { return '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>'; }).join('');
    var lastFull = ms.list.filter(function (m) { return ms.partial.indexOf(m) < 0; }).pop() || ms.list[ms.list.length - 1];
    el.value = prevVal && (prevVal === 'ALL' || ms.list.indexOf(prevVal) >= 0) ? prevVal : lastFull;
    drawShip();
  }
  function drawShip() {
    var month = $('shBulan').value === 'ALL' ? '' : $('shBulan').value;
    var status = shipAgg('STATUS', month);
    var tot = status.reduce(function (a, e) { return { baris: a.baris + e.baris, qty: a.qty + e.qty, m3: a.m3 + e.m3, kg: a.kg + e.kg, tv: a.tv + e.tv }; }, { baris: 0, qty: 0, m3: 0, kg: 0, tv: 0 });
    var exp = status.filter(function (e) { return e.kunci === 'EXPORT'; })[0];
    $('shStats').innerHTML =
      statHtml(fInt(tot.qty) + ' karton', 'Total kirim', fInt(tot.baris) + ' baris pengiriman') +
      statHtml(fInt(tot.m3) + ' m³', 'Volume kirim', tot.baris ? nf1.format(tot.tv / tot.baris * 100) + '% baris tanpa data volume, jadi angka ini lebih kecil dari kenyataan' : '') +
      statHtml(fInt(tot.kg / 1000) + ' ton', 'Berat kirim', 'dari baris yang punya data berat') +
      statHtml(tot.qty ? nf1.format((exp ? exp.qty : 0) / tot.qty * 100) + '%' : '—', 'Porsi ekspor', 'dari total karton; sisanya lokal');
    $('shPel').innerHTML = miniTable(shipAgg('PELANGGAN', month).slice(0, 10), 'Pelanggan', tot.qty);
    $('shEks').innerHTML = armadaTable(armadaAgg(month).slice(0, 15), !!month);
    $('shProv').innerHTML = miniTable(shipAgg('PROVINSI', month).slice(0, 10), 'Provinsi', tot.qty);
    var fefo = shipAgg('FEFO', month);
    $('shFefoBox').hidden = !fefo.length;
    $('shFefo').innerHTML = fefo.length
      ? '<table class="an-table an-cards"><thead><tr><th scope="col" class="l">Kasus</th><th scope="col">Baris</th><th scope="col">Karton</th></tr></thead><tbody>' +
        fefo.map(function (e) { return '<tr><td class="l prod">' + esc(e.kunci) + '</td><td data-label="Baris">' + fInt(e.baris) + '</td><td data-label="Karton">' + fInt(e.qty) + '</td></tr>'; }).join('') + '</tbody></table>'
      : '';
  }

  // ---------- baris pengiriman terbesar (v_shipments) ----------
  var ktTable = makeTable({
    host: 'ktTable', count: 'ktCount', pager: 'ktPager', sortM: 'ktSortM', sort: { key: 'm3', dir: 'desc' },
    rows: function () {
      var q = $('ktQ').value.trim().toLowerCase();
      return state.data.kt.filter(function (r) { return matches(q, [r.nama_produk, r.kode_sku, r.pelanggan, r.kota_tujuan, r.provinsi, r.nama_ekspedisi]); });
    },
    cols: [
      { key: 'nama_produk', label: 'Produk', left: true, cls: 'prod', html: function (r) { return prodCell(r.nama_produk, r.kode_sku + ' · ' + (r.kode_batch || '')); } },
      { key: 'gudang', label: 'Gudang', left: true },
      { key: 'pelanggan', label: 'Pelanggan', left: true, cls: 'txt' },
      { key: 'kota_tujuan', label: 'Tujuan', left: true, cls: 'txt', html: function (r) { return esc(r.kota_tujuan || '') + '<span class="sku">' + esc(r.provinsi || '') + '</span>'; } },
      { key: 'nama_ekspedisi', label: 'Ekspedisi', left: true, cls: 'txt' },
      { key: 'qty', label: 'Karton', fmt: 'int' },
      { key: 'm3', label: 'Volume (m³)', fmt: 'dec' },
      { key: 'kg', label: 'Berat (kg)', fmt: 'int' },
      { key: 'tanggal_kadaluarsa', label: 'Kedaluwarsa', html: function (r) { return fDate(r.tanggal_kadaluarsa); } },
      {
        key: 'status', label: 'Status', left: true,
        html: function (r) {
          return '<span class="an-chip ' + (r.status === 'EXPORT' ? 'steel' : 'muted') + '">' + esc(r.status || '—') + '</span>' +
            (r.keterangan_fefo ? ' <span class="an-chip warn" title="' + esc(r.keterangan_fefo) + '">Kasus FEFO</span>' : '');
        }
      }
    ]
  });
  function renderKt() {
    var rows = state.data.kt;
    $('ktTanggal').textContent = rows.length ? fDate(rows[0].tanggal_posting) : '—';
    ktTable.reset();
    ktTable.render();
  }


  // ---------- hari puncak vs kapasitas armada (v_hari_puncak_armada) ----------
  function renderPuncak() {
    var rows = state.data.puncak;
    if (!rows.length) {
      $('pkSeg').innerHTML = ''; $('pkStats').innerHTML = '';
      $('pkTable').innerHTML = '<p class="an-updated">Belum ada data volume harian.</p>';
      return;
    }
    var arm = uniq(rows.map(function (r) { return r.armada; })).sort();
    if (arm.indexOf(state.puncak) < 0) state.puncak = arm[0];
    $('pkSeg').innerHTML = arm.map(function (a) {
      return '<button type="button" data-armada="' + esc(a) + '" aria-pressed="' + (a === state.puncak) + '">' + esc(a) + '</button>';
    }).join('');
    var mine = rows.filter(function (r) { return r.armada === state.puncak; });
    var all = mine.filter(function (r) { return r.bulan === null; })[0];
    var months = mine.filter(function (r) { return r.bulan !== null; }).sort(function (a, b) { return String(a.bulan).localeCompare(String(b.bulan)); });
    if (all) {
      $('pkStats').innerHTML =
        statHtml(fInt(all.unit_rata2) + ' unit', 'Hari rata-rata', fDec(all.rata2_m3) + ' m³ per hari kirim, dari ' + fInt(all.hari_kirim) + ' hari') +
        statHtml(fInt(all.unit_p90) + ' unit', 'Hari padat (10% hari terpadat)', fDec(all.p90_m3) + ' m³ per hari') +
        statHtml(fInt(all.unit_puncak) + ' unit', 'Hari puncak', fDate(all.tanggal_puncak) + ', ' + fInt(all.puncak_m3) + ' m³') +
        statHtml(fDec(all.rasio_puncak_rata2) + ' kali', 'Puncak dibanding rata-rata', 'menyiapkan armada sebanyak hari padat menutup sekitar 90% hari');
    } else {
      $('pkStats').innerHTML = '';
    }
    $('pkTable').innerHTML = months.length
      ? '<table class="an-table an-cards"><thead><tr><th scope="col" class="l">Bulan</th><th scope="col">Hari kirim</th><th scope="col">m³ rata-rata</th><th scope="col">m³ hari padat</th><th scope="col">m³ puncak</th><th scope="col">Tanggal puncak</th>' +
        '<th scope="col">Unit rata-rata</th><th scope="col">Unit hari padat</th><th scope="col">Unit puncak</th></tr></thead><tbody>' +
        months.map(function (m) {
          return '<tr><td class="l prod">' + esc(fMonthLong(m.bulan)) + '</td><td data-label="Hari kirim">' + fInt(m.hari_kirim) + '</td><td data-label="m³ rata-rata">' + fInt(m.rata2_m3) +
            '</td><td data-label="m³ hari padat">' + fInt(m.p90_m3) + '</td><td data-label="m³ puncak">' + fInt(m.puncak_m3) + '</td><td data-label="Tanggal puncak">' + esc(fDate(m.tanggal_puncak)) +
            '</td><td data-label="Unit rata-rata">' + fInt(m.unit_rata2) + '</td><td data-label="Unit hari padat">' + fInt(m.unit_p90) + '</td><td data-label="Unit puncak">' + fInt(m.unit_puncak) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '';
  }

  // ---------- akurasi prediksi (v_akurasi_prediksi_ringkas) ----------
  function biasHtml(v) {
    if (!isNum(v)) return '<span class="dim">—</span>';
    return '<span class="' + (v > 5 ? 'up' : v < -5 ? 'down' : 'flat') + '">' + pctText(v, true) + '</span>';
  }
  var akSkuTable = makeTable({
    host: 'akSkuTable', count: 'akSkuCount', pager: 'akSkuPager', sortM: 'akSkuSortM', sort: { key: 'aktual_per_hari', dir: 'desc' },
    rows: function () { return state.data.akurasi.filter(function (r) { return r.dimensi === 'SKU'; }); },
    cols: [
      { key: 'gudang', label: 'Gudang', left: true },
      { key: 'produk', label: 'Produk', left: true, cls: 'prod', html: function (r) { return prodCell(r.produk, String(r.kunci).split('|')[1] || r.kunci); } },
      { key: 'aktual_per_hari', label: 'Realisasi/hari', fmt: 'int' },
      { key: 'prediksi_berbobot_per_hari', label: 'Prediksi/hari', fmt: 'int' },
      { key: 'wape_berbobot_pct', label: 'Galat (WAPE)', html: function (r) { return isNum(r.wape_berbobot_pct) ? fDec(r.wape_berbobot_pct) + '%' : '—'; } },
      { key: 'wape_datar_pct', label: 'WAPE rata-rata datar', html: function (r) { return isNum(r.wape_datar_pct) ? fDec(r.wape_datar_pct) + '%' : '—'; } },
      { key: 'bias_berbobot_pct', label: 'Bias', html: function (r) { return biasHtml(r.bias_berbobot_pct); } },
      {
        key: 'nilai', label: 'Penilaian', left: true, val: function (r) { return r.wape_berbobot_pct; },
        html: function (r) {
          var w = r.wape_berbobot_pct;
          if (!isNum(w)) return '<span class="dim">—</span>';
          return w < 25 ? '<span class="an-chip good">Baik</span>' : w < 50 ? '<span class="an-chip warn">Cukup</span>' : '<span class="an-chip bad">Rendah</span>';
        }
      }
    ]
  });
  function renderAkurasi() {
    var rows = state.data.akurasi;
    var tot = rows.filter(function (r) { return r.dimensi === 'TOTAL'; })[0];
    var anc = rows.filter(function (r) { return r.dimensi === 'ANCHOR'; }).sort(function (a, b) { return String(a.tanggal_acuan).localeCompare(String(b.tanggal_acuan)); });
    if (!tot || !anc.length) {
      $('akStats').innerHTML = ''; $('anAkInsight').innerHTML = '';
      $('akTable').innerHTML = '<p class="an-updated">Belum cukup riwayat untuk uji mundur.</p>';
      $('akSkuTable').innerHTML = ''; $('akSkuCount').textContent = ''; $('akSkuPager').innerHTML = '';
      return;
    }
    var last3 = anc.slice(-3);
    var bias3 = last3.reduce(function (a, r) { return a + (r.bias_berbobot_pct || 0); }, 0) / last3.length;
    var better = anc.filter(function (a) { return a.error_total_berbobot_pct < a.error_total_datar_pct; }).length;
    $('akStats').innerHTML =
      statHtml(fDec(tot.error_total_berbobot_pct) + '%', 'Galat total volume', 'prediksi berbobot, rata-rata ' + anc.length + ' uji; rata-rata datar ' + fDec(tot.error_total_datar_pct) + '%') +
      statHtml(fDec(tot.wape_berbobot_pct) + '%', 'Galat per SKU (WAPE)', 'prediksi berbobot; rata-rata datar ' + fDec(tot.wape_datar_pct) + '%') +
      statHtml(pctText(bias3, true), 'Bias ' + last3.length + ' uji terakhir', bias3 < -5 ? 'prediksi cenderung terlalu rendah' : bias3 > 5 ? 'prediksi cenderung terlalu tinggi' : 'prediksi cukup seimbang') +
      statHtml(fInt(better) + ' dari ' + fInt(anc.length), 'Uji yang lebih baik dengan bobot terbaru', 'dibanding rata-rata datar, pada galat total volume');
    $('anAkInsight').innerHTML = 'Pada total volume, prediksi meleset rata-rata <b>' + fDec(tot.error_total_berbobot_pct) + '%</b>. ' +
      (bias3 < -5
        ? 'Tiga uji terakhir meleset ke bawah (rata-rata ' + pctText(bias3, true) + '), yaitu saat permintaan sedang naik, jadi kebutuhan sebenarnya cenderung lebih tinggi dari angka prediksi.'
        : bias3 > 5
          ? 'Tiga uji terakhir meleset ke atas (rata-rata ' + pctText(bias3, true) + '), jadi prediksi cenderung berlebih.'
          : 'Arah kesalahan pada tiga uji terakhir seimbang.') +
      ' Per SKU galatnya jauh lebih besar (' + fDec(tot.wape_berbobot_pct) + '%), jadi angka per SKU sebaiknya dipakai sebagai arah, bukan angka pasti.';
    $('akTable').innerHTML = '<table class="an-table an-cards"><thead><tr><th scope="col" class="l">Tanggal acuan</th><th scope="col">Realisasi/hari</th><th scope="col">Prediksi berbobot</th><th scope="col">Galat total</th>' +
      '<th scope="col">Prediksi rata-rata datar</th><th scope="col">Galat total (datar)</th><th scope="col">Bias berbobot</th><th scope="col">WAPE SKU</th></tr></thead><tbody>' +
      anc.map(function (a) {
        return '<tr><td class="l prod">' + esc(fDate(a.tanggal_acuan)) + '</td><td data-label="Realisasi/hari">' + fInt(a.aktual_per_hari) + '</td><td data-label="Prediksi berbobot">' + fInt(a.prediksi_berbobot_per_hari) +
          '</td><td data-label="Galat total">' + fDec(a.error_total_berbobot_pct) + '%</td><td data-label="Prediksi rata-rata datar">' + fInt(a.prediksi_datar_per_hari) +
          '</td><td data-label="Galat total (datar)">' + fDec(a.error_total_datar_pct) + '%</td><td data-label="Bias berbobot">' + biasHtml(a.bias_berbobot_pct) +
          '</td><td data-label="WAPE SKU">' + fDec(a.wape_berbobot_pct) + '%</td></tr>';
      }).join('') + '</tbody></table>';
    akSkuTable.reset();
    akSkuTable.render();
  }

  // ---------- peringatan data (v_peringatan_data) ----------
  var TINGKAT = { TINGGI: { label: 'Tinggi', tone: 'bad', rank: 0 }, SEDANG: { label: 'Sedang', tone: 'warn', rank: 1 }, INFO: { label: 'Info', tone: 'steel', rank: 2 } };
  function renderPeringatan() {
    var rows = state.data.peringatan.slice().sort(function (a, b) {
      var ra = (TINGKAT[a.tingkat] || { rank: 3 }).rank, rb = (TINGKAT[b.tingkat] || { rank: 3 }).rank;
      return ra - rb || (a.urutan || 0) - (b.urutan || 0);
    });
    var high = rows.filter(function (r) { return r.tingkat === 'TINGGI'; }).length;
    var badge = $('anBadge');
    badge.hidden = !high;
    badge.textContent = high ? String(high) : '';
    $('warnList').innerHTML = rows.length
      ? rows.map(function (r) {
        var t = TINGKAT[r.tingkat] || { label: r.tingkat, tone: 'muted' };
        return '<li class="' + t.tone + '"><span class="an-chip ' + t.tone + '">' + esc(t.label) + '</span><div><b>' + esc(r.judul) + '</b><p>' + esc(r.detail) + '</p></div></li>';
      }).join('')
      : '<li class="ok"><span class="an-chip good">Aman</span><div><b>Tidak ada peringatan</b><p>Semua pemeriksaan data lolos.</p></div></li>';
  }

  // ---------- prioritas tindakan (v_prioritas_tindakan) ----------
  var AKSI = [
    { key: 'ISI STOK SEGERA', label: 'Isi stok segera', tone: 'bad', hint: 'SKU kelas A yang kritis atau habis' },
    { key: 'ISI STOK', label: 'Isi stok', tone: 'warn', hint: 'SKU kelas B atau C yang kritis atau habis' },
    { key: 'CEK DATA STOK', label: 'Cek data stok', tone: 'steel', hint: 'SKU kelas A atau B yang masih dikirim tetapi tidak ada di upload stok' },
    { key: 'TAHAN PRODUKSI', label: 'Tahan produksi', tone: 'steel', hint: 'Stok cukup lebih dari 60 hari kirim' },
    { key: 'PANTAU', label: 'Pantau', tone: 'muted', hint: 'Tidak perlu tindakan khusus' }
  ];
  function aksiMeta(k) {
    for (var i = 0; i < AKSI.length; i++) if (AKSI[i].key === k) return AKSI[i];
    return { key: k, label: k, tone: 'muted', hint: '' };
  }
  function kelasChip(k) { return '<span class="an-chip ' + (k === 'A' ? 'steel' : 'muted') + '">' + esc(k || '—') + '</span>'; }
  function priFiltered(ignoreAksi) {
    var g = $('priG').value, k = $('priK').value, q = $('priQ').value.trim().toLowerCase();
    return state.data.prioritas.filter(function (r) {
      if (g && r.gudang !== g) return false;
      if (k && r.kelas !== k) return false;
      if (!matches(q, [r.kode_sku, r.produk])) return false;
      if (!ignoreAksi && state.pri.aksi && r.aksi !== state.pri.aksi) return false;
      return true;
    });
  }
  var priTable = makeTable({
    host: 'priTable', count: 'priCount', pager: 'priPager', sortM: 'priSortM', sort: { key: 'urutan', dir: 'asc' },
    rows: function () { return priFiltered(false); },
    cols: [
      { key: 'urutan', label: '#', fmt: 'int', dir: 'asc' },
      { key: 'produk', label: 'Produk', left: true, cls: 'prod', html: function (r) { return prodCell(r.produk, r.kode_sku); } },
      { key: 'gudang', label: 'Gudang', left: true },
      { key: 'kelas', label: 'Kelas', left: true, html: function (r) { return kelasChip(r.kelas); } },
      { key: 'aksi', label: 'Tindakan', left: true, rank: function (v) { return STATUS_ORDER.length + AKSI.map(function (a) { return a.key; }).indexOf(v); }, dir: 'asc', html: function (r) { var m = aksiMeta(r.aksi); return '<span class="an-chip ' + m.tone + '">' + esc(m.label) + '</span>'; } },
      { key: 'stok_available', label: 'Stok tersedia', fmt: 'int' },
      { key: 'hari_cukup_prediksi', label: 'Cukup (hari)', fmt: 'dec' },
      { key: 'kekurangan_22hari', label: 'Kurang 22 hari', fmt: 'int' },
      { key: 'dampak_m3', label: 'Dampak (m³)', fmt: 'int' },
      { key: 'alasan', label: 'Catatan', left: true, cls: 'txt', html: function (r) { return r.alasan ? esc(r.alasan) : '<span class="dim">—</span>'; } }
    ]
  });
  function updatePri() {
    var base = priFiltered(true);
    $('priTiles').innerHTML = AKSI.map(function (a) {
      var rows = base.filter(function (r) { return r.aksi === a.key; });
      var m3 = rows.reduce(function (acc, r) { return acc + (r.dampak_m3 || 0); }, 0);
      return '<button type="button" class="an-tile ' + a.tone + '" data-aksi="' + esc(a.key) + '" aria-pressed="' + (state.pri.aksi === a.key) + '" title="' + esc(a.hint) + '">' +
        '<span class="n">' + fInt(rows.length) + '</span><span class="t">' + esc(a.label) + '</span><span class="h">' +
        (a.key === 'PANTAU' ? 'tanpa tindakan khusus' : fInt(m3) + ' m³ terdampak') + '</span></button>';
    }).join('');
    priTable.render();
  }
  function renderPrioritas() {
    var rows = state.data.prioritas;
    if (!rows.length) {
      $('priTiles').innerHTML = '';
      $('priTable').innerHTML = '<p class="an-updated">Belum ada data prioritas.</p>';
      $('priCount').textContent = ''; $('priPager').innerHTML = '';
      return;
    }
    fillSelect('priG', uniq(rows.map(function (r) { return r.gudang; })).sort(), 'Semua');
    priTable.reset();
    updatePri();
  }

  // ---------- Pareto (v_pareto) ----------
  var parTable = makeTable({
    host: 'parTable', count: 'parCount', pager: 'parPager', sortM: 'parSortM', sort: { key: 'peringkat', dir: 'asc' },
    rows: function () { return state.data.pareto.filter(function (r) { return r.dimensi === state.par; }); },
    cols: [
      { key: 'peringkat', label: '#', fmt: 'int', dir: 'asc' },
      { key: 'kunci', label: 'Nama', left: true, cls: 'prod', html: function (r) { return r.dimensi === 'SKU' ? prodCell(r.nama || r.kunci, r.kunci) : esc(r.kunci); } },
      { key: 'qty', label: 'Karton', fmt: 'int' },
      { key: 'm3', label: 'Volume (m³)', fmt: 'int' },
      { key: 'porsi_pct', label: 'Porsi', html: function (r) { return fDec(r.porsi_pct) + '%'; } },
      { key: 'kumulatif_pct', label: 'Kumulatif', html: function (r) { return fDec(r.kumulatif_pct) + '%'; } },
      { key: 'kelas', label: 'Kelas', left: true, html: function (r) { return kelasChip(r.kelas); } }
    ]
  });
  function renderPareto() {
    Array.prototype.forEach.call($('parSeg').querySelectorAll('[data-par]'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.par === state.par));
    });
    var rows = state.data.pareto.filter(function (r) { return r.dimensi === state.par; });
    if (!rows.length) {
      $('parStats').innerHTML = '';
      $('parTable').innerHTML = '<p class="an-updated">Belum ada data Pareto.</p>';
      $('parCount').textContent = ''; $('parPager').innerHTML = '';
      return;
    }
    var unit = state.par === 'SKU' ? 'SKU' : 'pelanggan';
    function grp(k) {
      var g = rows.filter(function (r) { return r.kelas === k; });
      return { n: g.length, share: g.reduce(function (a, r) { return a + (r.porsi_pct || 0); }, 0) };
    }
    var a = grp('A'), b = grp('B'), c = grp('C');
    $('parStats').innerHTML =
      statHtml(fInt(a.n) + ' ' + unit, 'Kelas A', 'menyumbang ' + fDec(a.share) + '% karton, dari total ' + fInt(rows.length) + ' ' + unit) +
      statHtml(fInt(b.n) + ' ' + unit, 'Kelas B', 'menyumbang ' + fDec(b.share) + '% karton') +
      statHtml(fInt(c.n) + ' ' + unit, 'Kelas C', 'menyumbang ' + fDec(c.share) + '% karton') +
      statHtml(fDec(rows[0].porsi_pct) + '%', 'Terbesar: ' + esc(state.par === 'SKU' ? (rows[0].nama || rows[0].kunci) : rows[0].kunci), 'porsi karton satu ' + unit + ' teratas');
    parTable.reset();
    parTable.render();
  }

  // ---------- sub-menu ----------
  function showSub(key) {
    state.sub = key;
    Array.prototype.forEach.call($('anSubSeg').querySelectorAll('[data-sub]'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.sub === key));
    });
    Array.prototype.forEach.call(document.querySelectorAll('#anBody [data-panel]'), function (p) {
      p.hidden = p.dataset.panel !== key;
    });
    if (state.data && key === 'tren') { renderTren(); renderHarianChart(); }
    if (state.data && key === 'biaya') { renderBiaya(); renderEvaluasiTarget(); renderBiayaGudang(); renderProyeksi(); }
    if (state.data && key === 'durasi') { renderDurasi(); }
    if (state.data && key === 'peta') { renderPeta(); renderPetaMap(); }
  }

  // ---------- render & muat data ----------
  function render() {
    renderArmada();
    renderPrediksiControls();
    updatePrediksi();
    renderStok();
    renderSvk();
    renderTren();
    renderPelanggan();
    renderHarian();
    renderShip();
    renderKt();
    renderKualitas();
    renderPuncak();
    renderAkurasi();
    renderPeringatan();
    renderPrioritas();
    renderPareto();
    renderBiaya();
    renderDurasi();
    renderEvaluasiTarget();
    renderBiayaGudang();
    renderProyeksi();
    renderPeta();
    showSub(state.sub);
  }
  function setPill(kind) {
    var el = $('anPill');
    el.className = 'sync-pill' + (kind === 'live' ? '' : kind === 'error' ? ' err' : ' sim');
    el.textContent = kind === 'live' ? '● LIVE' : kind === 'error' ? '● GAGAL' : '● MEMUAT…';
  }
  function showError(msg) {
    var box = $('anError');
    box.hidden = false;
    box.innerHTML = '<b>Data analisis belum bisa dimuat.</b> Periksa apakah Edge Function <code>analisis-scm-api</code> aktif di Supabase, ' +
      'lalu cek <code>ANALISIS_API_URL</code> dan <code>SUPABASE_ANON_KEY</code> di Vercel. Klik Segarkan untuk mencoba lagi.<br><code>' + esc(msg) + '</code>';
  }

  // "Periode data" di masthead (dipakai di semua tab, bukan cuma #analisis) —
  // dulu teks statis yang ditulis tangan di index.html dan tidak pernah
  // berubah. Sekarang dihitung dari data asli: tanggal paling awal & paling
  // akhir di v_harian (rekap harian, mencakup seluruh histori), dengan
  // fallback ke upload_date dari v_stok_terbaru (dipakai README sebagai
  // acuan "tanggal upload stok terbaru") kalau v_harian kosong. Dipanggil
  // tiap kali load() berhasil, jadi otomatis mengikuti upload terbaru tanpa
  // perlu diedit manual lagi.
  function updateHeaderPeriod() {
    var el = $('periodText');
    if (!el) return;
    var harian = (state.data && state.data.harian) || [];
    var stok = (state.data && state.data.stok) || [];
    var start = harian.length ? harian[0].tanggal : null;
    var end = harian.length ? harian[harian.length - 1].tanggal : (stok.length ? stok[0].upload_date : null);
    if (!start && !end) {
      el.textContent = 'Periode data: tidak tersedia';
      return;
    }
    el.textContent = 'Periode data: ' + (start ? fDate(start) : '—') + ' – ' + (end ? fDate(end) : '—');
  }
  // Dipanggil dari app.js (tombol "Segarkan" di masthead) dan upload-page.js
  // (setelah upload CSV berhasil) supaya "Periode data" ikut ter-refresh
  // tanpa harus pindah ke tab Analisis & Prediksi dulu.
  window.SCM_REFRESH_PERIOD = function () { load(); };

  async function load() {
    if (state.loading) return;
    state.loading = true;
    setPill('loading');
    $('anRefreshIcon').classList.add('spin');
    $('anLoading').hidden = !!state.data;
    try {
      if (window.SCM_AUTH_READY) await window.SCM_AUTH_READY;
      var doFetch = (window.SCM_AUTH && window.SCM_AUTH.authFetch) || fetch;
      var res = await doFetch(ENDPOINT, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' });
      var json = null;
      try { json = await res.json(); } catch (_) { /* bukan JSON */ }
      if (!res.ok || !json || !json.ok) throw new Error((json && json.error) || ('HTTP ' + res.status));
      state.data = normalize(json.data);
      state.loadedAt = Date.now();
      $('anError').hidden = true;
      $('anBody').hidden = false;
      render();
      updateHeaderPeriod();
      setPill('live');
      $('anUpdated').textContent = 'Diperbarui ' + new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      showError(e && e.message ? e.message : String(e));
      setPill('error');
    } finally {
      state.loading = false;
      $('anLoading').hidden = true;
      $('anRefreshIcon').classList.remove('spin');
    }
  }

  // ---------- input biaya tenaga harian (POST /api/biaya) ----------
  function bcgPrefillQty() {
    var tgl = $('bcgInTgl').value, q = $('bcgInQty');
    if (!tgl || !state.data || q.dataset.touched) return;
    var row = state.data.harian.filter(function (r) { return ymd10(r.tanggal) === tgl; })[0];
    q.value = row && isNum(row.qty) ? Math.round(row.qty) : '';
  }
  $('bcgInTgl').addEventListener('change', function () { $('bcgInQty').dataset.touched = ''; bcgPrefillQty(); });
  $('bcgInQty').addEventListener('input', function () { this.dataset.touched = '1'; });
  $('bcgForm').addEventListener('toggle', function () {
    if (this.open && !$('bcgInTgl').value) {
      var last = state.data && state.data.harian.length ? ymd10(state.data.harian[state.data.harian.length - 1].tanggal) : '';
      $('bcgInTgl').value = last; bcgPrefillQty();
    }
  });
  $('bcgInSave').addEventListener('click', async function () {
    var msg = $('bcgInMsg'), btn = this;
    var body = {
      tanggal: $('bcgInTgl').value, gudang: $('bcgInGudang').value,
      jumlah_pekerja: $('bcgInPekerja').value, biaya_per_pekerja: $('bcgInTarif').value,
      qty_dimuat: $('bcgInQty').value, jam_kerja: $('bcgInJam').value, catatan: $('bcgInCatatan').value.trim()
    };
    btn.disabled = true; msg.textContent = 'Menyimpan…';
    try {
      if (window.SCM_AUTH_READY) await window.SCM_AUTH_READY;
      var doFetch = (window.SCM_AUTH && window.SCM_AUTH.authFetch) || fetch;
      var res = await doFetch('/api/biaya', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      var json = null; try { json = await res.json(); } catch (_) { /* bukan JSON */ }
      if (!res.ok || !json || !json.ok) throw new Error((json && json.error) || ('HTTP ' + res.status));
      msg.textContent = 'Tersimpan: ' + fDate(body.tanggal) + ' · ' + body.gudang + '. Memuat ulang analisis…';
      $('bcgInPekerja').value = ''; $('bcgInCatatan').value = '';
      await load();
      msg.textContent = 'Tersimpan: ' + fDate(body.tanggal) + ' · ' + body.gudang + '.';
    } catch (e) {
      msg.textContent = 'Gagal menyimpan: ' + (e && e.message ? e.message : e);
    } finally { btn.disabled = false; }
  });

  // ---------- interaksi ----------
  $('anRefresh').addEventListener('click', function () { load(); });
  $('anGudangSeg').addEventListener('click', function (e) {
    var b = e.target.closest('[data-gudang]');
    if (!b) return;
    state.gudang = b.dataset.gudang;
    renderArmada();
  });
  $('anTiles').addEventListener('click', function (e) {
    var b = e.target.closest('[data-status]');
    if (!b) return;
    state.pf.status = state.pf.status === b.dataset.status ? '' : b.dataset.status;
    state.page = 1;
    updatePrediksi();
  });
  $('anFGudang').addEventListener('change', function (e) { state.pf.gudang = e.target.value; state.page = 1; updatePrediksi(); });
  $('anFTren').addEventListener('change', function (e) { state.pf.tren = e.target.value; state.page = 1; updatePrediksi(); });
  $('anFQ').addEventListener('input', function (e) { state.pf.q = e.target.value; state.page = 1; updatePrediksi(); });
  $('anPredTable').addEventListener('click', function (e) {
    var b = e.target.closest('[data-sort]');
    if (!b) return;
    var key = b.dataset.sort;
    if (state.sort.key === key) {
      state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      var col = COLS.filter(function (c) { return c.key === key; })[0] || {};
      state.sort = { key: key, dir: col.str || col.status ? 'asc' : 'desc' };
    }
    state.page = 1;
    updatePrediksi();
  });
  $('anFSort').addEventListener('change', function (e) {
    state.sort = Object.assign({}, SORTS[e.target.value] || SORTS.prioritas);
    state.page = 1;
    updatePrediksi();
  });
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (state.data && !$('page-analisis').hidden && state.sub === 'tren') { renderTren(); renderHarianChart(); }
      if (state.data && !$('page-analisis').hidden && state.sub === 'biaya') { renderBiaya(); renderBiayaGudang(); }
      if (state.data && !$('page-analisis').hidden && state.sub === 'durasi') { renderDurasi(); }
    }, 150);
  });
  $('anMetricSeg').addEventListener('click', function (e) {
    var b = e.target.closest('[data-metric]');
    if (!b) return;
    state.metric = b.dataset.metric;
    renderTren();
  });

  $('anSubSeg').addEventListener('click', function (e) {
    var b = e.target.closest('[data-sub]');
    if (b) showSub(b.dataset.sub);
  });
  $('petSeg').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tipe]');
    if (!b) return;
    state.pet.tipe = b.dataset.tipe;
    renderPeta();
    renderPetaMap();
  });
  bindFilters(['stG', 'stQ'], stokTable);
  bindFilters(['svkG', 'svkS', 'svkQ'], svkTable);
  bindFilters(['plQ'], pelTable);
  bindFilters(['hrTrip'], harianTable);
  bindFilters(['ktQ'], ktTable);
  $('priG').addEventListener('change', function () { priTable.reset(); updatePri(); });
  $('priK').addEventListener('change', function () { priTable.reset(); updatePri(); });
  $('priQ').addEventListener('input', function () { priTable.reset(); updatePri(); });
  $('priTiles').addEventListener('click', function (e) {
    var b = e.target.closest('[data-aksi]');
    if (!b) return;
    state.pri.aksi = state.pri.aksi === b.dataset.aksi ? '' : b.dataset.aksi;
    priTable.reset();
    updatePri();
  });
  $('parSeg').addEventListener('click', function (e) {
    var b = e.target.closest('[data-par]');
    if (!b) return;
    state.par = b.dataset.par;
    renderPareto();
  });
  $('pkSeg').addEventListener('click', function (e) {
    var b = e.target.closest('[data-armada]');
    if (!b) return;
    state.puncak = b.dataset.armada;
    renderPuncak();
  });
  $('shBulan').addEventListener('change', drawShip);
  $('drDimSeg').addEventListener('click', function (e) {
    var b = e.target.closest('[data-dim]');
    if (!b) return;
    state.dr.dim = b.dataset.dim;
    Array.prototype.forEach.call($('drDimSeg').querySelectorAll('[data-dim]'), function (x) { x.setAttribute('aria-pressed', String(x.dataset.dim === state.dr.dim)); });
    drTable.reset(); drTable.render();
  });
  $('bcgBulan').addEventListener('change', function (e) { state.bcg.bulan = e.target.value; renderBiayaGudang(); });
  $('bcgGudang').addEventListener('change', function (e) { state.bcg.gudang = e.target.value; renderBiayaGudang(); });
  $('bcgBoros').addEventListener('change', function () { bcgTable.reset(); bcgTable.render(); });

  // ---------- menu (tab) ----------
  var PAGES = { tower: 'page-tower', analisis: 'page-analisis', upload: 'page-upload' };
  function route() {
    var h = (location.hash || '#tower').replace('#', '');
    var key = PAGES[h] ? h : 'tower';
    Object.keys(PAGES).forEach(function (k) {
      $(PAGES[k]).hidden = k !== key;
      // 'upload' sekarang tidak punya tab sendiri di nav (diakses lewat
      // tombol Konfigurasi -> link "Upload Data via CSV"), jadi elemen
      // tab-upload tidak ada lagi di DOM.
      var tab = $('tab-' + k);
      if (!tab) return;
      if (k === key) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
    });
    document.body.setAttribute('data-page', key);
    document.title = key === 'analisis' ? 'Analisis & Prediksi · SCM Control Tower' : 'SCM Control Tower';
    if (key === 'analisis' && !state.loading && (!state.data || Date.now() - state.loadedAt > STALE_MS)) load();
  }
  window.addEventListener('hashchange', route);
  route();
  // "Periode data" di masthead tampil di semua tab (bukan cuma #analisis),
  // jadi datanya perlu dimuat sejak awal walau user mendarat di Control
  // Tower — bukan cuma saat tab Analisis & Prediksi dibuka. load() sudah
  // dijaga terhadap pemanggilan ganda lewat state.loading, jadi aman kalau
  // route() di atas kebetulan sudah memicu load() juga (mis. saat buka
  // langsung ke #analisis).
  if (!state.data) load();
})();
