// api/kpi/[zone].js  →  GET /api/kpi/stock | /api/kpi/logistics | /api/kpi/fefo
//
// Endpoint GRANULAR: mengambil data live untuk SATU zona saja. Berguna kalau
// ke depan dashboard butuh:
//   - refresh independen per zona (interval berbeda per kartu),
//   - retry hanya zona yang gagal tanpa mengulang yang sudah live,
//   - atau logging/monitoring per sumber data yang terpisah.
//
// app.js saat ini memakai endpoint gabungan (/api/kpi) untuk refresh normal
// dashboard — endpoint ini disediakan sebagai pelengkap, bukan pengganti.
//
// Menggunakan modul bersama yang sama dengan api/kpi.js (api/_lib/kpi-zones.js)
// agar logika fetch/timeout/header selalu konsisten di kedua endpoint.

const { ZONES, fetchZoneLive } = require('../_lib/kpi-zones');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const { zone } = req.query || {};

  if (!zone || !ZONES[zone]) {
    res.status(404).json({
      ok: false,
      error: `Zona tidak dikenal: "${zone}". Zona yang valid: ${Object.keys(ZONES).join(', ')}.`,
    });
    return;
  }

  try {
    const result = await fetchZoneLive(zone);
    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=15');
    res.status(200).json({ ok: true, timestamp: Date.now(), zone, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'Internal server error' });
  }
};
