// api/biaya.js  →  POST /api/biaya
//
// Input catatan biaya tenaga harian (tabel biaya_tenaga_harian) dari menu
// Analisis → Biaya. Memakai token login user (RLS: hanya role `authenticated`),
// jadi TIDAK butuh service role key di Vercel. Satu baris per (tanggal, gudang);
// mengirim ulang tanggal+gudang yang sama memperbarui baris tersebut.
//
// Body JSON: { tanggal:'YYYY-MM-DD', gudang:'FG-01'|...|'SEMUA', jumlah_pekerja:int,
//              biaya_per_pekerja:number, qty_dimuat?:number, jam_kerja?:number, catatan?:string }

const { requireUser } = require('./_lib/require-user');
const { resolveAnonKey } = require('./_lib/kpi-zones');

const SUPABASE_URL = 'https://qbougldvlmceeqceduae.supabase.co';
const GUDANG_OK = ['FG-01', 'FG-02', 'FG-03', 'FG-04', 'SEMUA'];

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }
  const auth = await requireUser(req);
  if (!auth.ok) {
    res.status(auth.status).json({ ok: false, error: auth.error });
    return;
  }

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = null; } }
  if (!b || typeof b !== 'object') {
    res.status(400).json({ ok: false, error: 'Body harus JSON.' });
    return;
  }

  const tanggal = String(b.tanggal || '');
  const gudang = String(b.gudang || '').toUpperCase();
  const pekerja = num(b.jumlah_pekerja);
  const tarif = num(b.biaya_per_pekerja);
  const qty = num(b.qty_dimuat);
  const jam = num(b.jam_kerja);
  const catatan = b.catatan ? String(b.catatan).slice(0, 300) : null;

  const errs = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal) || isNaN(Date.parse(tanggal))) errs.push('Tanggal tidak valid.');
  else if (Date.parse(tanggal) > Date.now() + 86400000) errs.push('Tanggal tidak boleh di masa depan.');
  if (!GUDANG_OK.includes(gudang)) errs.push('Gudang harus salah satu dari ' + GUDANG_OK.join(', ') + '.');
  if (!Number.isInteger(pekerja) || pekerja < 1 || pekerja > 500) errs.push('Jumlah pekerja harus bilangan bulat 1–500.');
  if (!(tarif > 0) || tarif > 5000000) errs.push('Biaya per pekerja harus lebih dari 0 (Rp per hari).');
  if (Number.isNaN(qty) || (qty !== null && qty < 0)) errs.push('Qty dimuat tidak valid.');
  if (Number.isNaN(jam) || (jam !== null && (jam < 0 || jam > 24))) errs.push('Jam kerja harus 0–24.');
  if (errs.length) {
    res.status(400).json({ ok: false, error: errs.join(' ') });
    return;
  }

  const token = String(req.headers.authorization).replace(/^Bearer\s+/i, '').trim();
  try {
    const up = await fetch(`${SUPABASE_URL}/rest/v1/biaya_tenaga_harian?on_conflict=tanggal,gudang`, {
      method: 'POST',
      headers: {
        apikey: resolveAnonKey(),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([{
        tanggal, gudang, jumlah_pekerja: pekerja, biaya_per_pekerja: tarif,
        qty_dimuat: qty, jam_kerja: jam, catatan, updated_at: new Date().toISOString(),
      }]),
    });
    if (!up.ok) {
      const msg = (await up.text()).slice(0, 200);
      res.status(502).json({ ok: false, error: `Gagal menyimpan (HTTP ${up.status}) ${msg}` });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || 'Gagal menyimpan catatan biaya.' });
  }
};
