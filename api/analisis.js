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
// Environment variable (opsional, ada default):
//   ANALISIS_API_URL   URL Edge Function, mis.
//                      https://<project>.supabase.co/functions/v1/analisis-scm-api/all
//   SUPABASE_ANON_KEY  sama dengan yang dipakai api/kpi.js
//   ANALISIS_API_KEY   (opsional) kunci akses; isi nilai yang sama dengan secret
//                      ANALISIS_API_KEY di Edge Function untuk mengunci endpoint

const { resolveAnonKey } = require('./_lib/kpi-zones');
const { requireUser } = require('./_lib/require-user');

const DEFAULT_URL =
  'https://qbougldvlmceeqceduae.supabase.co/functions/v1/analisis-scm-api/all';
const TIMEOUT_MS = 12000;

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const headers = { Accept: 'application/json' };
    if (/\.supabase\.co\/functions\//.test(url)) {
      const anonKey = resolveAnonKey();
      headers.apikey = anonKey;
      headers.Authorization = `Bearer ${anonKey}`;
    }
    // Kunci akses opsional: aktif bila ANALISIS_API_KEY diisi di Vercel DAN di secret Edge Function.
    const accessKey = (process.env.ANALISIS_API_KEY || '').trim();
    if (accessKey) headers['x-api-key'] = accessKey;

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
