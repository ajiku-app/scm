// Sudah login dan lolos verifikasi wajah di tab ini -> langsung ke aplikasi.
(async function () {
  try {
    var s = await window.scmSupabase.auth.getSession();
    var u = s.data.session && s.data.session.user;
    if (u && sessionStorage.getItem('scm_face_ok') === u.id) location.replace('/m.html');
  } catch (e) {}
})();
