// assets/upload-page.js — tab "Upload Data" (#upload)
//
// Mengisi tiga tabel Supabase langsung dari browser lewat file CSV:
//   - fg_stock_items  (+ batch header di fg_stock_uploads)  — semua user login boleh insert
//   - logistics                                              — semua user login boleh insert
//   - shipments                                               — RLS: INSERT hanya role admin
//
// Header CSV yang dipakai di template SENGAJA mengikuti format data yang sudah biasa dipakai
// (mis. "Item Code", "Item Deskripsi", "in"/"out"), bukan nama kolom database mentah — supaya
// file yang sudah ada tinggal dipakai tanpa diubah. Pemetaan header->kolom database ada di
// `match` per kolom (case-insensitive, spasi disamakan jadi underscore).
//
// Ditulis terpisah dari analisis.js/app.js (IIFE sendiri) supaya tidak bentrok nama.
// Memakai window.scmSupabase (anon key + sesi login user) untuk insert langsung — pola yang
// sama seperti assets/enroll-page.js (upsert ke fg_face_enrollment). RLS di database yang
// menjaga siapa boleh menulis apa, bukan kode di sini; kode ini hanya membantu validasi &
// pesan error supaya jelas sebelum baris dikirim.

(function () {
  'use strict';

  if (typeof Papa === 'undefined') {
    console.error('upload-page.js: PapaParse belum termuat.');
    return;
  }

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function normalizeHeader(h) { return String(h || '').trim().toLowerCase().replace(/\s+/g, '_'); }
  // Rapikan no. polisi: kolaps spasi ganda/rangkap & seragamkan huruf besar, supaya
  // shipments.no_mobil bisa dicocokkan andal dengan logistics.no_mobil (kunci sinkronisasi
  // tanggal_posting + no_mobil). Lihat migration 20260923_add_no_mobil_shipments... di Supabase.
  function normPlat(s) { return s.replace(/\s+/g, ' ').trim().toUpperCase(); }

  // ---------- konfigurasi per tabel ----------
  // key         = nama kolom di database (dipakai saat insert)
  // headerLabel = teks header persis seperti di file CSV Anda (dipakai untuk template unduhan)
  // match       = daftar varian header (sudah dinormalisasi) yang dikenali sebagai kolom ini
  // inTemplate  = false berarti kolom ini opsional & TIDAK dimasukkan ke template unduhan
  //               (tetap akan terbaca kalau Anda menambahkannya sendiri di file)
  var CONFIGS = {
    stock: {
      table: 'fg_stock_items',
      needsUploadBatch: true,
      columns: [
        { key: 'whs', headerLabel: 'Whs', match: ['whs'], required: false, type: 'text', def: 'FG-01' },
        { key: 'item_code', headerLabel: 'Item Code', match: ['item_code'], required: true, type: 'text' },
        { key: 'item_desc', headerLabel: 'Item Deskripsi', match: ['item_deskripsi', 'item_desc', 'deskripsi_item', 'deskripsi'], required: false, type: 'text' },
        { key: 'stok_hari_ini', headerLabel: 'Stok Hari Ini', match: ['stok_hari_ini'], required: false, type: 'number', def: 0, min: 0 },
        { key: 'kirim_hari_ini', headerLabel: 'Kirim Hari Ini', match: ['kirim_hari_ini'], required: false, type: 'number', def: 0, min: 0 },
        { key: 'kirim_besok', headerLabel: 'Kirim Besok', match: ['kirim_besok'], required: false, type: 'number', def: 0, min: 0 },
        { key: 'product_planning', headerLabel: 'Product Planning', match: ['product_planning'], required: false, type: 'number', def: 0 },
        { key: 'stok_available', headerLabel: 'Stok Available', match: ['stok_available'], required: false, type: 'number', def: 0, min: 0 },
        { key: 'harga_satuan_idr', headerLabel: 'harga_satuan_idr', match: ['harga_satuan_idr'], required: false, type: 'number', def: 0, min: 0 }
      ],
      exampleMap: {
        whs: 'FG-01', item_code: 'SKU-00123', item_desc: 'Contoh Produk A 250ml',
        stok_hari_ini: '1200', kirim_hari_ini: '300', kirim_besok: '250',
        product_planning: '1000', stok_available: '900', harga_satuan_idr: '18500'
      }
    },
    logistics: {
      table: 'logistics',
      needsUploadBatch: false,
      columns: [
        { key: 'tgl', headerLabel: 'tgl', match: ['tgl'], required: true, type: 'date', noFuture: true },
        { key: 'driver', headerLabel: 'driver', match: ['driver'], required: true, type: 'text' },
        { key: 'no_mobil', headerLabel: 'no_mobil', match: ['no_mobil'], required: false, type: 'text', normalize: normPlat },
        { key: 'ekspedisi', headerLabel: 'ekspedisi', match: ['ekspedisi'], required: false, type: 'text' },
        { key: 'armada', headerLabel: 'armada', match: ['armada'], required: false, type: 'text' },
        { key: 'provinsi', headerLabel: 'provinsi', match: ['provinsi'], required: false, type: 'text' },
        { key: 'kota', headerLabel: 'kota', match: ['kota'], required: false, type: 'text' },
        { key: 'picker', headerLabel: 'picker', match: ['picker'], required: false, type: 'array' },
        { key: 'muat', headerLabel: 'muat', match: ['muat'], required: false, type: 'array' },
        { key: 'stuffing', headerLabel: 'stuffing', match: ['stuffing'], required: false, type: 'array' },
        { key: 'time_in', headerLabel: 'in', match: ['in', 'time_in', 'jam_masuk'], required: false, type: 'text' },
        { key: 'time_out', headerLabel: 'out', match: ['out', 'time_out', 'jam_keluar'], required: false, type: 'text' },
        { key: 'jadwal_out', headerLabel: 'jadwal_out', match: ['jadwal_out'], required: false, type: 'text', inTemplate: false }
      ],
      exampleMap: {
        tgl: '2026-09-20', driver: 'Supriatna', no_mobil: 'B 9012 XY', ekspedisi: 'JNE Trucking',
        armada: 'CDD', provinsi: 'Jawa Barat', kota: 'Bandung', picker: 'Budi|Sari', muat: 'Amir',
        stuffing: 'Doni', time_in: '08:10', time_out: '09:45', jadwal_out: ''
      }
    },
    shipments: {
      table: 'shipments',
      needsUploadBatch: false,
      adminOnly: true,
      columns: [
        { key: 'kode_sku', headerLabel: 'kode_sku', match: ['kode_sku', 'sku'], required: true, type: 'text' },
        { key: 'nama_produk', headerLabel: 'nama_produk', match: ['nama_produk'], required: false, type: 'text' },
        { key: 'kode_batch', headerLabel: 'kode_batch', match: ['kode_batch'], required: false, type: 'text' },
        { key: 'gudang', headerLabel: 'gudang', match: ['gudang'], required: false, type: 'text' },
        { key: 'kota_tujuan', headerLabel: 'kota_tujuan', match: ['kota_tujuan'], required: false, type: 'text' },
        { key: 'provinsi', headerLabel: 'provinsi', match: ['provinsi'], required: false, type: 'text' },
        { key: 'pelanggan', headerLabel: 'pelanggan', match: ['pelanggan'], required: false, type: 'text' },
        { key: 'no_mobil', headerLabel: 'no_mobil', match: ['no_mobil'], required: false, type: 'text', normalize: normPlat },
        { key: 'nama_ekspedisi', headerLabel: 'nama_ekspedisi', match: ['nama_ekspedisi'], required: false, type: 'text' },
        { key: 'tanggal_posting', headerLabel: 'tanggal_posting', match: ['tanggal_posting'], required: true, type: 'date' },
        { key: 'tanggal_kadaluarsa', headerLabel: 'tanggal_kadaluarsa', match: ['tanggal_kadaluarsa'], required: false, type: 'date' },
        { key: 'qty', headerLabel: 'qty', match: ['qty', 'quantity'], required: true, type: 'number', min: 0, exclusiveMin: true },
        { key: 'harga_satuan_idr', headerLabel: 'harga_satuan_idr', match: ['harga_satuan_idr'], required: false, type: 'number', min: 0 },
        { key: 'status', headerLabel: 'status', match: ['status'], required: false, type: 'text' },
        { key: 'keterangan_fefo', headerLabel: 'keterangan_fefo', match: ['keterangan_fefo'], required: false, type: 'text', inTemplate: false }
      ],
      exampleMap: {
        kode_sku: 'SKU-00123', nama_produk: 'Contoh Produk A 250ml', kode_batch: 'BATCH-2609',
        gudang: 'FG-01', kota_tujuan: 'Bandung', provinsi: 'Jawa Barat', pelanggan: 'PT Contoh Distribusi',
        no_mobil: 'B 9012 XY', nama_ekspedisi: 'JNE Trucking', tanggal_posting: '2026-09-20', tanggal_kadaluarsa: '2027-03-20',
        qty: '480', harga_satuan_idr: '18500', status: 'TERKIRIM', keterangan_fefo: ''
      }
    }
  };

  var state = {}; // key -> { rows, rowErrors, fileName }
  var isAdmin = false;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // ---------- pemetaan header CSV -> kolom database ----------
  function buildFieldMap(cfg, fields) {
    var map = {};
    cfg.columns.forEach(function (col) {
      var found = null;
      for (var i = 0; i < col.match.length; i++) {
        if (fields.indexOf(col.match[i]) !== -1) { found = col.match[i]; break; }
      }
      map[col.key] = found; // null = kolom ini tidak ada di file
    });
    return map;
  }

  // ---------- util validasi/parsing ----------
  function parseNum(raw) {
    var s = String(raw).trim();
    if (!s) return { ok: true, value: null };
    if (!/^-?\d+([.,]\d+)?$/.test(s)) return { ok: false };
    var n = Number(s.replace(',', '.'));
    return isFinite(n) ? { ok: true, value: n } : { ok: false };
  }

  function transformRow(cfg, raw, fieldMap) {
    var values = {};
    var errors = [];
    cfg.columns.forEach(function (col) {
      var fieldName = fieldMap[col.key];
      var cell = fieldName ? raw[fieldName] : undefined;
      var s = (cell === undefined || cell === null) ? '' : String(cell).trim();
      if (!s) {
        if (col.required) { errors.push('kolom "' + col.headerLabel + '" wajib diisi'); return; }
        values[col.key] = col.type === 'array' ? [] : (col.def !== undefined ? col.def : null);
        return;
      }
      if (col.type === 'text') {
        values[col.key] = col.normalize ? col.normalize(s) : s;
      } else if (col.type === 'array') {
        values[col.key] = s.split('|').map(function (x) { return x.trim(); }).filter(Boolean);
      } else if (col.type === 'date') {
        if (!DATE_RE.test(s)) { errors.push('kolom "' + col.headerLabel + '" harus format YYYY-MM-DD (isi: "' + s + '")'); return; }
        var dt = new Date(s + 'T00:00:00Z');
        if (isNaN(dt) || dt.toISOString().slice(0, 10) !== s) { errors.push('kolom "' + col.headerLabel + '" bukan tanggal yang valid (isi: "' + s + '")'); return; }
        if (col.noFuture && dt.getTime() > Date.now() + 2 * 86400000) {
          errors.push('kolom "' + col.headerLabel + '" berisi tanggal di masa depan ("' + s + '") — biasanya hari dan bulan tertukar (mis. 10 Jun tertulis 2026-10-06). Format sel di Excel sebagai teks YYYY-MM-DD lalu upload ulang');
          return;
        }
        values[col.key] = s;
      } else if (col.type === 'number') {
        var r = parseNum(s);
        if (!r.ok) { errors.push('kolom "' + col.headerLabel + '" bukan angka yang valid (isi: "' + s + '")'); return; }
        if (col.min !== undefined && r.value !== null) {
          var bad = col.exclusiveMin ? r.value <= col.min : r.value < col.min;
          if (bad) { errors.push('kolom "' + col.headerLabel + '" harus ' + (col.exclusiveMin ? '> ' : '>= ') + col.min); return; }
        }
        values[col.key] = r.value;
      }
    });
    return { values: values, errors: errors };
  }

  // ---------- UI helpers ----------
  function showMsg(key, kind, html) {
    var el = $('upMsg-' + key);
    if (!el) return;
    el.className = 'up-msg show ' + kind;
    el.innerHTML = html;
  }
  function clearMsg(key) {
    var el = $('upMsg-' + key);
    if (!el) return;
    el.className = 'up-msg';
    el.innerHTML = '';
  }
  function setFilename(key, name) { var el = $('upFilename-' + key); if (el) el.textContent = name || 'Belum ada file dipilih'; }
  function setSubmitEnabled(key, on) { var b = $('upSubmit-' + key); if (b) b.disabled = !on; }
  function setSubmitBusy(key, busy) {
    var b = $('upSubmit-' + key);
    if (!b) return;
    b.disabled = busy || b.disabled;
    b.innerHTML = busy ? '<span class="up-submit-spin"></span>Mengunggah…' : 'Upload ke database';
  }

  function renderPreview(key, rawRows, rows, rowErrors, cfg, fieldMap) {
    var wrap = $('upPreviewWrap-' + key);
    var table = $('upPreview-' + key);
    var countEl = $('upCount-' + key);
    if (!wrap || !table) return;
    wrap.hidden = false;

    var errByRow = {};
    rowErrors.forEach(function (e) { errByRow[e.row] = e.messages; });

    var head = '<thead><tr>' + cfg.columns.map(function (c) { return '<th>' + esc(c.headerLabel) + '</th>'; }).join('') + '</tr></thead>';
    var shown = rawRows.slice(0, 10);
    var body = '<tbody>' + shown.map(function (r, i) {
      var rowNum = i + 2;
      var hasErr = !!errByRow[rowNum];
      return '<tr class="' + (hasErr ? 'up-row-err' : '') + '">' +
        cfg.columns.map(function (c) {
          var fn = fieldMap[c.key];
          var v = fn ? r[fn] : '';
          return '<td>' + esc(v === undefined ? '' : v) + '</td>';
        }).join('') +
        '</tr>';
    }).join('') + '</tbody>';
    table.innerHTML = head + body;

    var extra = rawRows.length > 10 ? (' (menampilkan 10 dari ' + rawRows.length + ' baris)') : '';
    if (countEl) countEl.textContent = rawRows.length + ' baris terbaca' + extra;

    if (rowErrors.length) {
      var list = rowErrors.slice(0, 20).map(function (e) {
        return '<li>Baris ' + e.row + ': ' + e.messages.map(esc).join('; ') + '</li>';
      }).join('');
      var more = rowErrors.length > 20 ? ('<li>… dan ' + (rowErrors.length - 20) + ' baris lain bermasalah.</li>') : '';
      showMsg(key, 'err', '<b>' + rowErrors.length + ' dari ' + rawRows.length + ' baris punya masalah.</b> Perbaiki lalu unggah ulang file.<ul>' + list + more + '</ul>');
    } else {
      showMsg(key, 'ok', rows.length + ' baris valid dan siap diupload.');
    }
  }

  function resetCard(key) {
    state[key] = null;
    var wrap = $('upPreviewWrap-' + key);
    if (wrap) wrap.hidden = true;
    setSubmitEnabled(key, false);
    var input = $('upFile-' + key);
    if (input) input.value = '';
    setFilename(key, null);
  }

  // ---------- file handling ----------
  function handleFile(key, file) {
    var cfg = CONFIGS[key];
    clearMsg(key);
    if (!file) return;
    setFilename(key, file.name);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: normalizeHeader,
      complete: function (res) {
        var rawRows = res.data || [];
        var fields = (res.meta && res.meta.fields) || [];
        if (!rawRows.length) {
          showMsg(key, 'err', 'File CSV kosong atau tidak terbaca.');
          $('upPreviewWrap-' + key).hidden = true;
          setSubmitEnabled(key, false);
          return;
        }
        var fieldMap = buildFieldMap(cfg, fields);
        var missing = cfg.columns.filter(function (c) { return c.required && !fieldMap[c.key]; });
        if (missing.length) {
          showMsg(key, 'err', 'Kolom wajib tidak ditemukan di header CSV: <b>' + missing.map(function (c) { return esc(c.headerLabel); }).join(', ') + '</b>. Pastikan pakai template yang disediakan.');
          $('upPreviewWrap-' + key).hidden = true;
          setSubmitEnabled(key, false);
          return;
        }
        var rows = [];
        var rowErrors = [];
        rawRows.forEach(function (r, i) {
          var out = transformRow(cfg, r, fieldMap);
          rows.push(out.values);
          if (out.errors.length) rowErrors.push({ row: i + 2, messages: out.errors });
        });
        state[key] = { rows: rows, rowErrors: rowErrors, fileName: file.name };
        renderPreview(key, rawRows, rows, rowErrors, cfg, fieldMap);
        var canSubmit = rowErrors.length === 0 && rows.length > 0 && !(cfg.adminOnly && !isAdmin);
        setSubmitEnabled(key, canSubmit);
      },
      error: function (err) {
        showMsg(key, 'err', 'Gagal membaca file CSV: ' + esc(err.message || String(err)));
      }
    });
  }

  // ---------- upload ke Supabase ----------
  function describeError(e) {
    var msg = (e && (e.message || e.error_description)) || String(e);
    if (e && (e.code === '42501' || /row-level security/i.test(msg))) {
      return 'Ditolak oleh kebijakan akses database (RLS) — akun Anda tidak punya izin menulis ke tabel ini.';
    }
    return esc(msg);
  }

  async function submitUpload(key) {
    var cfg = CONFIGS[key];
    var st = state[key];
    if (!st || !st.rows.length || st.rowErrors.length) return;
    if (cfg.adminOnly && !isAdmin) { showMsg(key, 'err', 'Hanya akun admin yang bisa mengunggah data ini.'); return; }

    setSubmitBusy(key, true);
    try {
      var session = await window.SCM_AUTH_READY;
      if (!session) throw new Error('Sesi login berakhir, silakan masuk ulang.');

      var uploadId = null;
      if (cfg.needsUploadBatch) {
        var todayStr = new Date().toISOString().slice(0, 10);
        var batchRes = await window.scmSupabase.from('fg_stock_uploads')
          .insert({ file_name: st.fileName, upload_date: todayStr, row_count: st.rows.length, uploaded_by: session.user.id })
          .select('id').single();
        if (batchRes.error) throw batchRes.error;
        uploadId = batchRes.data.id;
      }

      var rowsToInsert = st.rows.map(function (r) {
        if (uploadId === null) return r;
        var copy = Object.assign({}, r);
        copy.upload_id = uploadId;
        return copy;
      });

      var CHUNK = 500;
      var done = 0;
      for (var i = 0; i < rowsToInsert.length; i += CHUNK) {
        var chunk = rowsToInsert.slice(i, i + CHUNK);
        var insRes = await window.scmSupabase.from(cfg.table).insert(chunk);
        if (insRes.error) {
          var errWithProgress = insRes.error;
          errWithProgress._done = done;
          throw errWithProgress;
        }
        done += chunk.length;
        if (rowsToInsert.length > CHUNK) showMsg(key, 'info', 'Mengunggah… ' + done + ' / ' + rowsToInsert.length + ' baris.');
      }

      showMsg(key, 'ok', '<b>Berhasil.</b> ' + done + ' baris ditambahkan ke <code>' + esc(cfg.table) + '</code>' +
        (cfg.needsUploadBatch ? ' (batch #' + uploadId + ' di fg_stock_uploads).' : '.'));
      resetCard(key);
      // "Periode data" di masthead mengikuti data terbaru (v_harian /
      // v_stok_terbaru) — minta analisis.js menyegarkannya langsung supaya
      // tanggalnya ikut berubah begitu upload ini selesai, tanpa perlu
      // pindah tab dulu.
      if (window.SCM_REFRESH_PERIOD) window.SCM_REFRESH_PERIOD();
    } catch (e) {
      var progressNote = (e && typeof e._done === 'number' && e._done > 0) ? (' (' + e._done + ' baris sempat berhasil sebelum error ini.)') : '';
      showMsg(key, 'err', 'Gagal upload: ' + describeError(e) + progressNote);
    } finally {
      setSubmitBusy(key, false);
    }
  }

  // ---------- template CSV ----------
  function csvEscape(v) {
    var s = String(v === undefined || v === null ? '' : v);
    return /[",\n]/.test(s) ? ('"' + s.replace(/"/g, '""') + '"') : s;
  }
  function downloadTemplate(key) {
    var cfg = CONFIGS[key];
    var cols = cfg.columns.filter(function (c) { return c.inTemplate !== false; });
    var header = cols.map(function (c) { return c.headerLabel; }).join(',');
    var example = cols.map(function (c) { return csvEscape(cfg.exampleMap[c.key]); }).join(',');
    var csv = header + '\n' + example + '\n';
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'template_' + cfg.table + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------- gate shipments: hanya admin ----------
  async function initAccessGate() {
    var session = await window.SCM_AUTH_READY;
    if (!session) return;
    try {
      var res = await window.scmSupabase.from('profiles').select('role').eq('id', session.user.id).single();
      isAdmin = !res.error && res.data && res.data.role === 'admin';
    } catch (e) { isAdmin = false; }

    if (!isAdmin) {
      var tag = $('upScope-shipments');
      if (tag) tag.textContent = 'nonaktif untuk akun Anda';
      var input = $('upFile-shipments');
      var label = input ? input.closest('.up-filebtn') : null;
      if (input) input.disabled = true;
      if (label) label.classList.add('disabled');
      showMsg('shipments', 'warn', 'Akun ' + esc(session.user.email || '') + ' bukan role admin, jadi tidak bisa mengunggah data shipments (dijaga lewat Row Level Security). Hubungi admin, atau login dengan akun admin.');
    }
  }

  // ---------- wiring ----------
  function init() {
    Object.keys(CONFIGS).forEach(function (key) {
      var input = $('upFile-' + key);
      if (input) input.addEventListener('change', function (e) { handleFile(key, e.target.files && e.target.files[0]); });
      var submitBtn = $('upSubmit-' + key);
      if (submitBtn) submitBtn.addEventListener('click', function () { submitUpload(key); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.up-template'), function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        downloadTemplate(a.getAttribute('data-template'));
      });
    });
    initAccessGate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
