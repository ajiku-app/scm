// api/analisis.js  →  GET /api/analisis
//
// Endpoint untuk menu "Analisis & Prediksi". Memanggil Supabase Edge Function
// `analisis-scm-api` (yang membaca view hasil analisis: v_kebutuhan_armada_ringkas,
// v_prediksi_kirim, v_tren_bulanan, dst.) secara server-to-server, lalu
// meneruskan hasilnya ke browser dalam satu response JSON.
//
// Pola dan alasannya sama dengan api/kpi.js: URL & anon key dipegang server
// (environment variable), bukan browser, dan tidak ada masalah CORS.
//
// Environment variable:
//   ANALISIS_API_URL   URL Edge Function, mis.
//                      https://<project>.supabase.co/functions/v1/analisis-scm-api/all
//                      (opsional, ada default)
//   SUPABASE_ANON_KEY  sama dengan yang dipakai api/kpi.js (opsional, ada default)
//   ANALISIS_API_KEY   WAJIB diisi (temuan audit 22 Sep 2026, C-1): Edge Function
//                      `analisis-scm-api` sekarang menolak semua request bila secret
//                      ini kosong (fail-closed) — sebelumnya endpoint itu diam-diam
//                      terbuka untuk siapa saja yang memegang anon key (yang memang
//                      publik di client). Isi nilai yang sama persis dengan secret
//                      ANALISIS_API_KEY di Supabase → Edge Functions → Secrets.

const { resolveAnonKey } = require('./_lib/kpi-zones');
const { requireUser } = require('./_lib/require-user');

const DEFAULT_URL =
  'https://qbougldvlmceeqceduae.supabase.co/functions/v1/analisis-scm-api/all';
const TIMEOUT_MS = 25000;
let warnedUrl = false;
let warnedNoAccessKey = false;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const auth = await requireUser(req);
  if (!auth.ok) {
    res.status(auth.status).json({ ok: false, error: auth.error });
    return;
  }

  const url = (process.env.ANALISIS_API_URL || '').trim() || DEFAULT_URL;
  if (url === DEFAULT_URL && !warnedUrl) {
    warnedUrl = true;
    console.warn(
      '[api/analisis] Env var "ANALISIS_API_URL" belum diisi — memakai URL project Supabase ' +
      'contoh sebagai fallback. Isi di Vercel Environment Variables jika ini deployment Anda sendiri.'
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const headers = { Accept: 'application/json' };
    if (/\.supabase\.co\/functions\//.test(url)) {
      const anonKey = resolveAnonKey();
      headers.apikey = anonKey;
      headers.Authorization = `Bearer ${anonKey}`;
    }
    // WAJIB diisi di Vercel DAN sama persis dengan secret di Edge Function
    // (lihat catatan di atas berkas ini). Tanpa ini, panggilan ke Edge
    // Function akan ditolak 503 oleh perbaikan fail-closed yang baru.
    const accessKey = (process.env.ANALISIS_API_KEY || '').trim();
    if (accessKey) {
      headers['x-api-key'] = accessKey;
    } else if (!warnedNoAccessKey) {
      warnedNoAccessKey = true;
      console.warn(
        '[api/analisis] Env var "ANALISIS_API_KEY" belum diisi di Vercel. Edge Function ' +
        'analisis-scm-api akan menolak (503) sampai ini diisi — lihat laporan audit C-1.'
      );
    }

    const upstream = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (!upstream.ok) {
      let bodyMsg = '';
      try {
        bodyMsg = (await upstream.text()).trim().slice(0, 220);
      } catch (_) {
        /* abaikan */
      }
      res.status(502).json({
        ok: false,
        error: `Endpoint analisis merespons HTTP ${upstream.status}${bodyMsg ? ` — ${bodyMsg}` : ''}`,
      });
      return;
    }

    const data = await upstream.json();
    // Cache singkat di edge Vercel: data berasal dari view yang berubah per upload/shipment,
    // bukan per detik, jadi 30 detik sudah cukup segar.
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json({ ok: true, timestamp: Date.now(), data });
  } catch (e) {
    const message =
      e.name === 'AbortError'
        ? `Timeout — endpoint analisis tidak merespons dalam ${TIMEOUT_MS / 1000} detik.`
        : e.message || 'Gagal mengambil data analisis (alasan tidak diketahui).';
    res.status(502).json({ ok: false, error: message });
  } finally {
    clearTimeout(timer);
  }
};
