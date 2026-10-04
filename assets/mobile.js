// assets/mobile.js
// Lapisan mobile untuk index.html. Hanya menambah UI (bottom nav, sheet Profil, Beranda) di layar
// <= 820px. Logika data tetap di app.js / analisis.js / upload-page.js; desktop tidak berubah.
(function () {
  'use strict';
  var mq = window.matchMedia('(max-width: 820px)');
  var $ = function (id) { return document.getElementById(id); };
  var ICON = {
    tower: '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
    analisis: '<path d="M3 20h18M6 16V9M11 16V5M16 16v-5M21 16V8"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
    profil: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-5 15-5 16 0"/>'
  };
  var NAV = [['tower', 'Tower', '#tower'], ['analisis', 'Analisis', '#analisis'], ['upload', 'Upload', '#upload'], ['profil', 'Profil', '#profil']];
  var state = { session: null };

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ---------- bottom nav ----------
  function buildNav() {
    if ($('mNav')) return;
    var nav = document.createElement('nav');
    nav.id = 'mNav'; nav.className = 'm-nav'; nav.setAttribute('aria-label', 'Menu utama');
    nav.innerHTML = NAV.map(function (n) {
      return '<a href="' + n[2] + '" data-k="' + n[0] + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[n[0]] + '</svg>' + n[1] + '</a>';
    }).join('');
    document.body.appendChild(nav);
    nav.querySelector('[data-k="profil"]').addEventListener('click', function (e) { e.preventDefault(); toggleSheet(true); });
    var brand = document.querySelector('.brand-mark');            // ketuk "SUPER APP" -> Beranda
    if (brand) { brand.setAttribute('role', 'link'); brand.tabIndex = 0; brand.style.cursor = 'pointer';
      brand.addEventListener('click', function () { location.hash = '#beranda'; }); }
  }
  function markNav() {
    var key = (location.hash || '#tower').replace('#', '');
    document.querySelectorAll('#mNav a').forEach(function (a) {
      if (a.getAttribute('data-k') === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  // ---------- sheet Profil ----------
  function buildSheet() {
    if ($('mSheet')) return;
    var bg = document.createElement('div');
    bg.id = 'mSheet'; bg.className = 'm-sheet-bg';
    bg.innerHTML = '<div class="m-sheet" role="dialog" aria-modal="true" aria-label="Profil"><div class="who">Masuk sebagai</div><div class="email" id="mEmail">—</div>' +
      '<button type="button" data-a="cfg">Konfigurasi sumber data</button><button type="button" data-a="ref">Segarkan data</button>' +
      '<button type="button" data-a="out" class="out">Keluar</button></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function (e) {
      if (e.target === bg) return toggleSheet(false);
      var a = e.target.getAttribute && e.target.getAttribute('data-a');
      if (!a) return;
      toggleSheet(false);
      if (a === 'cfg') { location.hash = '#tower'; setTimeout(function () { var b = document.querySelector('[data-action="toggle-settings"]'); if (b) b.click(); }, 80); }
      if (a === 'ref') { var r = $('refreshBtn'); if (r) r.click(); }
      if (a === 'out') {
        sessionStorage.removeItem('scm_face_ok');
        Promise.resolve(window.scmSupabase && window.scmSupabase.auth.signOut()).catch(function () {}).then(function () { location.replace('/login.html'); });
      }
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') toggleSheet(false); });
  }
  function toggleSheet(open) {
    var s = $('mSheet'); if (!s) return;
    s.classList.toggle('open', !!open);
    if (open) { var e = $('mEmail'); if (e) e.textContent = (state.session && state.session.user.email) || '—'; }
  }

  // ---------- Beranda ----------
  var CHECKS = [
    { label: 'Upload stok FG', table: 'fg_stock_uploads', cols: ['created_at', 'uploaded_at'], tbl: 'fg_stock_items' },
    { label: 'Upload data Logistics', table: 'logistics', cols: ['tgl_date'], tbl: 'logistics' },
    { label: 'Upload data Shipments', table: 'shipments', cols: ['tanggal_posting'], tbl: 'shipments' }
  ];
  function latestDate(c) {
    var sb = window.scmSupabase;
    if (!sb) return Promise.resolve(null);
    function pick(rows) {
      if (!rows || !rows.length) return null;
      for (var i = 0; i < c.cols.length; i++) { var v = rows[0][c.cols[i]]; if (v) return String(v).slice(0, 10); }
      return null;
    }
    return sb.from(c.table).select('*').order(c.cols[0], { ascending: false }).limit(1)
      .then(function (r) { return r.error ? null : pick(r.data); }, function () { return null; });
  }
  function fmtShort(s) { var p = s.split('-'); return p[2] + '/' + p[1] + '/' + p[0].slice(2); }

  function buildBeranda() {
    var host = $('page-beranda'); if (!host || host.getAttribute('data-built')) return;
    host.setAttribute('data-built', '1');
    var now = new Date(), days = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'], wk = '';
    for (var i = -2; i <= 2; i++) { var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      wk += '<div class="bh-day' + (i === 0 ? ' today' : '') + '"><span>' + days[d.getDay()] + '</span><b>' + d.getDate() + '</b></div>'; }
    host.innerHTML =
      '<div class="bh-top"><div><div class="bh-date">' + esc(now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })) + '</div>' +
      '<h1 id="bhHello">Halo</h1></div><span class="bh-avatar" id="bhAvatar" aria-hidden="true">S</span></div>' +
      '<div class="bh-week">' + wk + '</div>' +
      '<div class="bh-h">Check-in harian <span id="bhCount">0/4</span></div>' +
      '<div class="bh-cards"><div class="bh-card"><div class="t">Upload</div><div class="n" id="bhUp">–/3</div><a href="#upload">Upload data</a></div>' +
      '<div class="bh-card"><div class="t">SLA Loading</div><div class="n" id="bhSla">--%</div><a href="#tower">Lihat detail</a></div></div>' +
      '<div class="bh-h">Hari ini <span id="bhCount2">0/4</span></div><div id="bhList"></div>';
  }
  function paintBeranda() {
    var email = (state.session && state.session.user.email) || '';
    var name = email ? email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, function (m) { return m.toUpperCase(); }) : '';
    if ($('bhHello')) $('bhHello').textContent = 'Halo' + (name ? ', ' + name : '');
    if ($('bhAvatar')) $('bhAvatar').textContent = (name || 'S').charAt(0);
    var today = ymd(new Date()), key = 'scm_bh_review_' + today;
    Promise.all(CHECKS.map(latestDate)).then(function (dates) {
      var done = 0, html = '';
      CHECKS.forEach(function (c, i) {
        var ok = dates[i] === today; if (ok) done++;
        html += '<a class="bh-item" href="#upload"><div><div class="a">' + c.label + '</div><div class="b">tabel ' + c.tbl + ' · ' + (dates[i] ? 'data terbaru ' + fmtShort(dates[i]) : 'belum ada data') + '</div></div>' +
          '<span class="bh-dot' + (ok ? ' done' : '') + '" role="img" aria-label="' + (ok ? 'Selesai' : 'Belum') + '">' + (ok ? '✓' : '') + '</span></a>';
      });
      var rev = localStorage.getItem(key) === '1'; if (rev) done++;
      html += '<button type="button" class="bh-item" id="bhReview"><div><div class="a">Tinjau SKU prioritas kritis</div><div class="b">menu Prioritas</div></div>' +
        '<span class="bh-dot' + (rev ? ' done' : '') + '" role="img" aria-label="' + (rev ? 'Selesai' : 'Belum') + '">' + (rev ? '✓' : '') + '</span></button>';
      $('bhList').innerHTML = html;
      $('bhCount').textContent = $('bhCount2').textContent = done + '/4';
      $('bhUp').textContent = (done - (rev ? 1 : 0)) + '/3';
      $('bhReview').addEventListener('click', function () {
        try { localStorage.setItem(key, '1'); } catch (e) {}
        location.hash = '#analisis';
        var tries = 0, t = setInterval(function () {      // tunggu data analisis tampil, lalu buka sub-tab Prioritas
          var b = document.querySelector('#anSubSeg [data-sub="prioritas"]'), body = $('anBody');
          if ((b && body && !body.hidden) || ++tries > 40) { clearInterval(t); if (b) b.click(); }
        }, 250);
      });
    });
  }
  function syncSla() { var v = $('val-sla'), t = $('bhSla'); if (v && t) t.textContent = v.textContent; }

  // ---------- init ----------
  function init() {
    if (!mq.matches) { if (location.hash === '#beranda') location.hash = '#tower'; return; }
    buildNav(); buildSheet(); buildBeranda(); markNav();
    if (!location.hash || location.hash === '#') {           // pendaratan pertama di mobile = Beranda
      history.replaceState(null, '', '#beranda'); window.dispatchEvent(new Event('hashchange'));
    }
    paintBeranda(); setInterval(syncSla, 2000);
  }
  window.addEventListener('hashchange', function () { if (mq.matches) { markNav(); if (location.hash === '#beranda') paintBeranda(); } });
  mq.addEventListener && mq.addEventListener('change', function () { location.reload(); });
  (window.SCM_AUTH_READY || Promise.resolve(null)).then(function (s) { state.session = s; }, function () {}).then(function () {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  });
})();
