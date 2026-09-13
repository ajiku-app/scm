// api/kpi.js  →  GET /api/kpi
//
// Endpoint GABUNGAN: mengambil ketiga zona (stock, logistics, fefo) sekaligus
// dalam satu request. Dipakai oleh app.js untuk refresh normal dashboard —
// lebih hemat (1 request, bukan 3) dan snapshot-nya konsisten antar-zona
// (dipakai untuk hitung skor kesehatan gabungan).
//
// Untuk refresh satu zona saja secara granular, lihat api/kpi/[zone].js.
//
// Kenapa ini perlu jadi endpoint server, bukan fetch langsung dari browser:
//   1. Menghindari masalah CORS pada endpoint yang tidak mengizinkan origin
//      dashboard ini.
//   2. Supabase anon key (dan URL endpoint) tidak lagi ikut terkirim/terlihat
//      di kode client — disimpan sebagai environment variable di server.
//   3. Satu titik untuk menambahkan caching, rate limiting, atau logging di
//      masa depan tanpa mengubah kode client.

const { ZONE_KEYS, fetchZoneLive } = require('./_lib/kpi-zones');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    const results = await Promise.all(ZONE_KEYS.map((key) => fetchZoneLive(key)));
    const zones = {};
    ZONE_KEYS.forEach((key, i) => {
      zones[key] = results[i];
    });

    // Cache sangat singkat di edge Vercel agar beberapa client yang refresh
    // hampir bersamaan tidak masing-masing memicu request baru ke Supabase.
    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=15');
    res.status(200).json({ ok: true, timestamp: Date.now(), zones });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'Internal server error' });
  }
};
