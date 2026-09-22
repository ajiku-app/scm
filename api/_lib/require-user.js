// api/_lib/require-user.js
//
// Menjaga endpoint /api/* supaya hanya bisa dipanggil oleh browser yang sudah
// login (bukan siapa saja yang tahu URL dashboard). Sebelum perubahan ini,
// api/kpi.js dan api/analisis.js selalu memanggil Supabase pakai anon key
// milik SERVER sendiri, terlepas dari siapa yang membuka dashboard, jadi
// datanya bisa dibaca siapa saja yang tahu URL Vercel-nya.
//
// Browser (assets/auth-guard.js) mengirim access token Supabase user yang
// sedang login lewat header "Authorization: Bearer <token>". Fungsi ini
// memvalidasi token itu ke Supabase Auth (GET /auth/v1/user) — bukan sekadar
// mem-parsing isi JWT, supaya token yang sudah dicabut/expired ikut ditolak.
// Sesi anonim Supabase (kalau pernah dipakai fitur lain) juga ditolak.
//
// TIDAK mengecek status verifikasi wajah: itu murni gerbang di sisi klien
// (lihat assets/auth-guard.js) yang menentukan boleh tidaknya membuka
// index.html/menu Analisis. Endpoint ini hanya menjamin "yang meminta data
// adalah akun yang sudah login dengan email/password yang valid".

const SUPABASE_URL = 'https://qbougldvlmceeqceduae.supabase.co';
const { resolveAnonKey } = require('./kpi-zones');

async function requireUser(req) {
  const auth = req.headers && req.headers.authorization;
  if (!auth || !/^Bearer\s+.+/i.test(auth)) {
    return { ok: false, status: 401, error: 'Belum login. Silakan masuk terlebih dahulu.' };
  }
  const token = auth.replace(/^Bearer\s+/i, '').trim();

  try {
    const anonKey = resolveAnonKey();
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return { ok: false, status: 401, error: 'Sesi tidak valid atau sudah berakhir. Silakan login ulang.' };
    }
    const user = await res.json();
    if (!user || !user.id || user.is_anonymous) {
      return { ok: false, status: 403, error: 'Akun ini tidak diizinkan mengakses data.' };
    }
    return { ok: true, user };
  } catch (e) {
    return { ok: false, status: 502, error: 'Gagal memverifikasi sesi login: ' + (e.message || e) };
  }
}

module.exports = { requireUser };
