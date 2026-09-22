// assets/enroll-page.js
//
// Logika halaman enroll.html — dipindah dari <script> inline ke file eksternal
// (temuan audit M-2) supaya CSP bisa menghapus 'unsafe-inline' dari script-src.

(function () {
  var sb = window.scmSupabase;
  var msgEl = document.getElementById('enMsg');
  var whoEl = document.getElementById('enWho');
  var btn = document.getElementById('enBtn');
  var videoEl = document.getElementById('enVideo');
  var stream = null;

  function showMsg(text, kind) {
    msgEl.className = 'en-msg ' + (kind || 'info');
    msgEl.textContent = text;
    msgEl.style.display = text ? 'block' : 'none';
  }

  document.getElementById('enBack').addEventListener('click', function () {
    SCM_FACE.stopCamera(stream);
    window.location.href = '/login.html';
  });

  async function init() {
    var sessRes = await sb.auth.getSession();
    var session = sessRes.data && sessRes.data.session;
    if (!session) { window.location.replace('/login.html'); return; }
    whoEl.textContent = 'Masuk sebagai ' + session.user.email + '. Wajah ini akan dipakai sebagai langkah kedua login Anda, menggantikan wajah yang lama bila sudah pernah didaftarkan.';
    try {
      showMsg('Memuat model pengenalan wajah…', 'info');
      await SCM_FACE.loadModels();
      stream = await SCM_FACE.startCamera(videoEl);
      showMsg('Posisikan wajah di tengah kamera lalu klik tombol di bawah.', 'info');
      btn.disabled = false;
    } catch (e) {
      showMsg('Kamera tidak bisa diakses: ' + (e.message || e), 'err');
    }
  }

  btn.addEventListener('click', async function () {
    btn.disabled = true;
    showMsg('Mengambil gambar…', 'info');
    try {
      var descriptor = await SCM_FACE.captureDescriptor(videoEl);
      var u = (await sb.auth.getUser()).data.user;
      var upsert = await sb.from('fg_face_enrollment').upsert(
        { user_id: u.id, descriptor: descriptor, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
      if (upsert.error) throw upsert.error;
      showMsg('Wajah tersimpan. Silakan login ulang untuk memverifikasinya.', 'ok');
      SCM_FACE.stopCamera(stream);
      setTimeout(function () { window.location.href = '/login.html?step=face'; }, 900);
    } catch (e) {
      showMsg('Gagal menyimpan: ' + (e.message || e), 'err');
      btn.disabled = false;
    }
  });

  init();
})();
