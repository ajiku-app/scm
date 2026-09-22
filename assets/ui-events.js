// assets/ui-events.js
//
// Menggantikan seluruh atribut onclick="..." inline di index.html (temuan
// audit M-2) dengan event listener yang dipasang dari file eksternal ini.
// Tujuannya supaya CSP (lihat vercel.json) bisa menghapus 'unsafe-inline'
// dari script-src: dengan itu, kalaupun suatu saat ada celah lain yang
// berhasil menyuntik HTML ke halaman, browser tidak akan menjalankan
// atribut/blok skrip yang disuntikkan (baik <script> inline maupun
// onclick="..."), karena keduanya sama-sama diblokir CSP tanpa 'unsafe-inline'.
//
// Elemen yang tadinya punya onclick="fn()" sekarang punya:
//   data-action="nama-aksi"        -> aksi tanpa argumen (lihat ACTIONS di bawah)
//   data-kpi-modal="key"           -> openKpiModal('key')
//
// Fungsi yang dipanggil (manualRefresh, toggleSettings, saveAndApply,
// openCombinedScoreModal, openKpiModal, closeKpiModal) tetap didefinisikan
// sebagai fungsi global di app.js, jadi file ini harus dimuat SETELAH app.js.

(function () {
  'use strict';

  var ACTIONS = {
    'manual-refresh': function () { manualRefresh(); },
    'toggle-settings': function () { toggleSettings(); },
    'save-apply': function () { saveAndApply(); },
    'open-combined-score': function () { openCombinedScoreModal(); },
    'close-kpi-modal': function () { closeKpiModal(); },
    // Overlay modal: hanya tutup kalau yang diklik overlay itu sendiri,
    // bukan salah satu anak elemennya (sama seperti perilaku onclick lama:
    // if(event.target===this) closeKpiModal()).
    'close-kpi-modal-if-self': function (ev, el) {
      if (ev.target === el) closeKpiModal();
    },
  };

  document.querySelectorAll('[data-action]').forEach(function (el) {
    var action = ACTIONS[el.getAttribute('data-action')];
    if (!action) return;
    el.addEventListener('click', function (ev) { action(ev, el); });
  });

  document.querySelectorAll('[data-kpi-modal]').forEach(function (el) {
    var key = el.getAttribute('data-kpi-modal');
    el.addEventListener('click', function () { openKpiModal(key); });
  });
})();
