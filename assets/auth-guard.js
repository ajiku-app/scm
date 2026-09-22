// assets/auth-guard.js
//
// Dipasang di index.html (SATU-SATUNYA halaman dashboard). Menjamin:
//   1. Harus sudah login (email/password Supabase Auth) di tab ini.
//   2. Harus sudah lolos verifikasi wajah DI TAB/SESI BROWSER INI (ditandai
//      sessionStorage, jadi hilang saat tab ditutup — tab baru wajib
//      verifikasi wajah lagi walau akunnya masih login).
// Kalau salah satu belum terpenuhi, langsung diarahkan ke login.html.
//
// window.SCM_AUTH.authFetch() dipakai app.js & analisis.js sebagai pengganti
// fetch() biasa ke /api/kpi dan /api/analisis, supaya token login user ikut
// terkirim (server memvalidasinya lewat api/_lib/require-user.js). Kalau
// server menjawab 401 (sesi kadaluwarsa/dicabut), otomatis dilempar ke login.

(function () {
  var sb = window.scmSupabase;

  function toLogin(step) {
    var here = encodeURIComponent(window.location.pathname.split('/').pop() || 'index.html');
    var q = step ? ('step=' + step + '&next=' + here) : ('next=' + here);
    window.location.replace('login.html?' + q);
  }

  async function guard() {
    var sessRes = await sb.auth.getSession();
    var session = sessRes.data && sessRes.data.session;
    if (!session) { toLogin(); return null; }
    if (sessionStorage.getItem('scm_face_ok') !== session.user.id) { toLogin('face'); return null; }
    return session;
  }

  sb.auth.onAuthStateChange(function (event) {
    if (event === 'SIGNED_OUT') toLogin();
  });

  async function authFetch(url, opts) {
    opts = opts || {};
    var sessRes = await sb.auth.getSession();
    var session = sessRes.data && sessRes.data.session;
    if (!session) { toLogin(); throw new Error('Sesi login berakhir.'); }
    var headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + session.access_token });
    var res = await fetch(url, Object.assign({}, opts, { headers: headers }));
    if (res.status === 401) {
      sessionStorage.removeItem('scm_face_ok');
      toLogin();
      throw new Error('Sesi login berakhir, silakan masuk ulang.');
    }
    return res;
  }

  function mountUserBadge(session) {
    var box = document.querySelector('.sync-box');
    if (!box || document.getElementById('scmUserBadge')) return;
    var wrap = document.createElement('div');
    wrap.id = 'scmUserBadge';
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin-top:8px;';
    var email = document.createElement('span');
    email.textContent = session.user.email || 'Masuk';
    var out = document.createElement('a');
    out.href = '#';
    out.textContent = 'Keluar';
    out.style.cssText = 'color:var(--steel);text-decoration:none;font-weight:600;';
    out.addEventListener('click', async function (ev) {
      ev.preventDefault();
      sessionStorage.removeItem('scm_face_ok');
      await sb.auth.signOut();
      window.location.replace('login.html');
    });
    wrap.appendChild(email);
    wrap.appendChild(document.createTextNode('·'));
    wrap.appendChild(out);
    box.appendChild(wrap);
  }

  window.SCM_AUTH = { authFetch: authFetch };

  // Jalankan sesegera mungkin; app.js/analisis.js menunggu event ini sebelum
  // memanggil authFetch pertama kalinya (lihat perubahan di app.js/analisis.js).
  window.SCM_AUTH_READY = guard().then(function (session) {
    if (session) mountUserBadge(session);
    return session;
  });
})();
