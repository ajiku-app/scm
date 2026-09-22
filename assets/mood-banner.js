// assets/mood-banner.js
//
// Logika banner mood di index.html — dipindah dari <script> inline ke file
// eksternal (temuan audit M-2) supaya CSP bisa menghapus 'unsafe-inline' dari script-src.

(function () {
  // Menampilkan hasil deteksi ekspresi wajah dari halaman login (kalau ada),
  // maksimal 30 detik lalu hilang sendiri. Data ini cuma sekali pakai (dihapus
  // dari sessionStorage begitu ditampilkan) dan tidak pernah dikirim ke server.
  var MAX_MS = 30000;
  try {
    var raw = sessionStorage.getItem('scm_mood_result');
    if (!raw) return;
    sessionStorage.removeItem('scm_mood_result');
    var data = JSON.parse(raw);
    var age = Date.now() - (data.ts || 0);
    if (age > MAX_MS) return; // sudah kedaluwarsa (mis. dari sesi lama), jangan tampilkan

    var box = document.getElementById('moodBanner');
    if (!box) return;
    // Pertahanan berlapis: nilai ini berasal dari lookup table tetap di
    // login.html (bukan input bebas), tapi tetap di-escape sebelum masuk
    // innerHTML — kalau suatu saat ada celah lain yang bisa menulis ke
    // sessionStorage, banner ini tidak jadi jalan eksekusi skrip.
    function esc(s) {
      return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    var el = document.createElement('div');
    el.className = 'mood-banner' + (data.indikasiStres ? ' stres' : '');
    el.innerHTML =
      '<span class="mood-emoji">' + esc(data.emoji) + '</span>' +
      '<span class="mood-text">Ekspresi terdeteksi saat login: <b>' + esc(data.label) + '</b> (' + esc(data.percent) + '%)' +
      '<span class="mood-note">' + (data.indikasiStres
        ? 'Indikasi tingkat stres cukup tinggi — bukan diagnosis, hanya perkiraan dari ekspresi wajah.'
        : 'Perkiraan dari ekspresi wajah saat ini, bukan pengukuran medis.') + '</span></span>' +
      '<button type="button" class="mood-close" aria-label="Tutup">×</button>';
    box.appendChild(el);

    var remaining = MAX_MS - age;
    var timer = setTimeout(function () { el.remove(); }, remaining);
    el.querySelector('.mood-close').addEventListener('click', function () {
      clearTimeout(timer);
      el.remove();
    });
  } catch (e) { /* abaikan bila sessionStorage/JSON bermasalah */ }
})();
