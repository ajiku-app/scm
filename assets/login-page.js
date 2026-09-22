// assets/login-page.js
//
// Logika halaman login.html — dipindah dari <script> inline ke file eksternal
// (temuan audit M-2) supaya CSP bisa menghapus 'unsafe-inline' dari script-src.

(function () {
  var sb = window.scmSupabase;
  var msgEl = document.getElementById('lfMsg');
  var passStep = document.getElementById('lfPassStep');
  var faceStep = document.getElementById('lfFaceStep');
  var passBtn = document.getElementById('lfPassBtn');
  var faceBtn = document.getElementById('lfFaceBtn');
  var enrollLink = document.getElementById('lfEnrollLink');
  var videoEl = document.getElementById('lfVideo');
  var videoWrap = document.getElementById('lfVideoWrap');
  var whoEl = document.getElementById('lfWhoAmI');
  var moodEl = document.getElementById('lfMood');
  var moodEmojiEl = document.getElementById('lfMoodEmoji');
  var moodLabelEl = document.getElementById('lfMoodLabel');
  var moodNoteEl = document.getElementById('lfMoodNote');
  var stream = null;
  var attempts = 0;

  var EXPR_EMOJI = { neutral: '😐', happy: '😄', sad: '😔', angry: '😠', fearful: '😟', disgusted: '😖', surprised: '😲' };

  function showMood(expressions) {
    var sum = SCM_FACE.summarizeExpression(expressions);
    if (!sum) { moodEl.className = 'lf-mood'; return; } // ekspresi tidak terbaca, sembunyikan saja
    moodEmojiEl.textContent = EXPR_EMOJI[sum.key] || '🙂';
    moodLabelEl.textContent = 'Ekspresi terdeteksi: ' + sum.label + ' (' + sum.percent + '%)';
    moodNoteEl.textContent = sum.indikasiStres
      ? 'Indikasi tingkat stres cukup tinggi — bukan diagnosis, hanya perkiraan dari ekspresi wajah.'
      : 'Perkiraan dari ekspresi wajah saat ini, bukan pengukuran medis.';
    moodEl.className = 'lf-mood show' + (sum.indikasiStres ? ' stres' : '');
    try {
      sessionStorage.setItem('scm_mood_result', JSON.stringify({
        emoji: EXPR_EMOJI[sum.key] || '🙂',
        label: sum.label,
        percent: sum.percent,
        indikasiStres: sum.indikasiStres,
        ts: Date.now(),
      }));
    } catch (e) { /* sessionStorage tidak tersedia, abaikan */ }
  }

  function showMsg(text, kind) {
    msgEl.className = 'lf-msg ' + (kind || 'info');
    msgEl.textContent = text;
    msgEl.style.display = text ? 'block' : 'none';
  }
  // Keamanan: "next" datang dari query string URL, jadi tidak boleh dipercaya
  // begitu saja untuk redirect (celah "open redirect" — orang lain bisa
  // membuat link login.html?next=https://situs-luar.com/... dan setelah
  // korban berhasil login+verifikasi wajah di halaman asli ini, dia malah
  // dilempar ke situs luar). Redirect tujuan HARUS berupa salah satu halaman
  // yang memang ada di aplikasi ini, bukan URL bebas dari input pengguna.
  var ALLOWED_NEXT_PAGES = ['/index.html', '/enroll.html'];
  function safeNext(next) {
    return ALLOWED_NEXT_PAGES.indexOf(next) !== -1 ? next : '/index.html';
  }
  function goTo(next) { window.location.replace(safeNext(next)); }

  function paramStep() {
    var p = new URLSearchParams(window.location.search);
    return p.get('step');
  }

  async function enterFaceStep(session) {
    passStep.classList.remove('active');
    faceStep.classList.add('active');
    moodEl.className = 'lf-mood';
    whoEl.textContent = (session.user.email || 'Akun') + ' — sesi terverifikasi, sekarang cek wajah';
    showMsg('Memuat model pengenalan wajah…', 'info');
    try {
      await SCM_FACE.loadModels();
      showMsg('Arahkan wajah ke kamera, lalu klik Verifikasi wajah.', 'info');
      videoWrap.classList.remove('busy');
      stream = await SCM_FACE.startCamera(videoEl);
    } catch (e) {
      showMsg('Kamera tidak bisa diakses: ' + (e.message || e) + '. Pastikan izin kamera diaktifkan dan halaman dibuka lewat HTTPS atau localhost.', 'err');
    }
  }

  async function doPasswordLogin(ev) {
    ev.preventDefault();
    showMsg('', '');
    passBtn.disabled = true;
    passBtn.textContent = 'Memeriksa…';
    try {
      var email = document.getElementById('lfEmail').value.trim();
      var password = document.getElementById('lfPass').value;
      var res = await sb.auth.signInWithPassword({ email: email, password: password });
      if (res.error) throw res.error;
      if (!res.data || !res.data.session) throw new Error('Login gagal, coba lagi.');
      sessionStorage.removeItem('scm_face_ok');
      await enterFaceStep(res.data.session);
    } catch (e) {
      showMsg('Gagal masuk: ' + (e.message || 'email atau kata sandi salah.'), 'err');
    } finally {
      passBtn.disabled = false;
      passBtn.textContent = 'Masuk';
    }
  }

  async function doFaceVerify() {
    showMsg('Mengambil gambar…', 'info');
    faceBtn.disabled = true;
    videoWrap.classList.add('busy');
    try {
      var capture = await SCM_FACE.captureDescriptorAndExpressions(videoEl);
      var descriptor = capture.descriptor;
      try { showMood(capture.expressions); } catch (e) { console.warn('Gagal menampilkan mood (diabaikan):', e); }
      var sessRes = await sb.auth.getSession();
      var token = sessRes.data && sessRes.data.session && sessRes.data.session.access_token;
      if (!token) throw new Error('Sesi login sudah berakhir, silakan masuk ulang.');

      var resp = await fetch(window.SCM_SUPABASE_URL + '/functions/v1/verify-face', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: window.SCM_SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
        body: JSON.stringify({ descriptor: descriptor }),
      });
      var body = await resp.json().catch(function () { return {}; });

      if (resp.ok && body.verified === true) {
        SCM_FACE.stopCamera(stream);
        var u = (await sb.auth.getUser()).data.user;
        sessionStorage.setItem('scm_face_ok', u.id);
        showMsg('Wajah cocok. Membuka dashboard…', 'ok');
        var dest = (new URLSearchParams(window.location.search)).get('next') || '/index.html';
        setTimeout(function () { goTo(dest); }, 900);
        return;
      }

      if (resp.ok && body.reason === 'not_enrolled') {
        showMsg('Wajah Anda belum terdaftar di sistem ini. Daftarkan dulu wajah Anda.', 'err');
        enrollLink.style.display = 'block';
      } else {
        attempts++;
        showMsg('Wajah tidak cocok dengan data terdaftar (percobaan ke-' + attempts + '). Coba lagi dengan pencahayaan lebih baik.', 'err');
        if (attempts >= 5) showMsg('Sudah 5 kali gagal. Untuk keamanan, silakan hubungi admin bila ini akun Anda.', 'err');
      }
    } catch (e) {
      showMsg(e.message || 'Verifikasi wajah gagal, coba lagi.', 'err');
    } finally {
      faceBtn.disabled = false;
      videoWrap.classList.remove('busy');
    }
  }

  document.getElementById('lfSignOut').addEventListener('click', async function (ev) {
    ev.preventDefault();
    SCM_FACE.stopCamera(stream);
    sessionStorage.removeItem('scm_face_ok');
    await sb.auth.signOut();
    window.location.reload();
  });
  enrollLink.addEventListener('click', function () { window.location.href = '/enroll.html'; });
  passStep.addEventListener('submit', doPasswordLogin);
  faceBtn.addEventListener('click', doFaceVerify);

  // Kalau sesi login sudah ada (mis. diarahkan ke sini oleh auth-guard.js karena
  // wajah belum diverifikasi di tab ini), langsung lompat ke langkah wajah.
  (async function init() {
    if ((new URLSearchParams(window.location.search)).get('reason') === 'idle') {
      showMsg('Anda otomatis keluar karena 5 menit tidak ada aktivitas. Silakan masuk lagi.', 'info');
    }
    var sessRes = await sb.auth.getSession();
    var session = sessRes.data && sessRes.data.session;
    if (session && paramStep() === 'face') {
      await enterFaceStep(session);
    } else if (session && sessionStorage.getItem('scm_face_ok') === session.user.id) {
      goTo('index.html');
    }
  })();
})();
