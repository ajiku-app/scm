// api/_lib/kpi-zones.js
//
// Logika bersama untuk mengambil data KPI live per zona, dipakai oleh:
//   - api/kpi.js         (endpoint gabungan: /api/kpi, ambil 3 zona sekaligus)
//   - api/kpi/[zone].js   (endpoint granular: /api/kpi/<zone>, ambil 1 zona)
//
// Folder ini diawali underscore ("_lib") sehingga TIDAK dijadikan endpoint
// oleh Vercel — murni modul yang di-import oleh file lain di dalam /api.

const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFib3VnbGR2bG1jZWVxY2VkdWFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1NDQ3NzgsImV4cCI6MjEwNDEyMDc3OH0.10PDqnr2ShDbWwqNbt76EsMmeGgL5aOwETdYIov4g3s';

const ZONES = {
  stock: {
    envUrl: 'STOCK_API_URL',
    defaultUrl:
      'https://qbougldvlmceeqceduae.supabase.co/functions/v1/stock-monitoring-api/kpi',
  },
  logistics: {
    envUrl: 'LOGISTICS_API_URL',
    defaultUrl:
      'https://qbougldvlmceeqceduae.supabase.co/functions/v1/logistics-api/kpi',
  },
  fefo: {
    envUrl: 'FEFO_API_URL',
    defaultUrl:
      'https://qbougldvlmceeqceduae.supabase.co/functions/v1/fefo-monitoring-api/kpi',
  },
  warehouse: {
    envUrl: 'WAREHOUSE_API_URL',
    defaultUrl:
      'https://qbougldvlmceeqceduae.supabase.co/functions/v1/warehouse-productivity-api/kpi',
  },
};

const ZONE_KEYS = Object.keys(ZONES);
const FETCH_TIMEOUT_MS = 8000;

let warnedUrlZones = new Set();
let warnedAnonKey = false;

function resolveUrl(zoneKey) {
  const zone = ZONES[zoneKey];
  if (!zone) return null;
  const fromEnv = process.env[zone.envUrl];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  // Keamanan/konfigurasi (temuan audit M-1): env var belum diisi, jatuh ke
  // project Supabase contoh. Ini disengaja untuk kenyamanan demo, tapi kalau
  // ini deployment produksi Anda sendiri, ini kemungkinan besar KESALAHAN
  // KONFIGURASI (env var belum diisi di Vercel) — beri peringatan sekali per
  // proses supaya terlihat di log server, bukan diam-diam terpakai.
  if (!warnedUrlZones.has(zoneKey)) {
    warnedUrlZones.add(zoneKey);
    console.warn(
      `[kpi-zones] Env var "${zone.envUrl}" belum diisi — memakai URL project Supabase ` +
      `contoh sebagai fallback. Isi "${zone.envUrl}" di Vercel Environment Variables jika ini deployment Anda sendiri.`
    );
  }
  return zone.defaultUrl;
}

function resolveAnonKey() {
  const fromEnv = process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_ANON_KEY.trim();
  if (fromEnv) return fromEnv;

  if (!warnedAnonKey) {
    warnedAnonKey = true;
    console.warn(
      '[kpi-zones] Env var "SUPABASE_ANON_KEY" belum diisi — memakai anon key project Supabase ' +
      'contoh sebagai fallback. Isi "SUPABASE_ANON_KEY" di Vercel Environment Variables jika ini deployment Anda sendiri.'
    );
  }
  return DEFAULT_SUPABASE_ANON_KEY;
}

async function fetchZoneLive(zoneKey) {
  if (!Object.prototype.hasOwnProperty.call(ZONES, zoneKey)) {
    return { status: 'error', data: null, error: `Zona tidak dikenal: "${zoneKey}".` };
  }

  const url = resolveUrl(zoneKey);
  if (!url) {
    return { status: 'error', data: null, error: 'URL endpoint belum dikonfigurasi.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers = { Accept: 'application/json' };
    if (/\.supabase\.co\/functions\//.test(url)) {
      const anonKey = resolveAnonKey();
      headers.apikey = anonKey;
      headers.Authorization = `Bearer ${anonKey}`;
    }

    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) {
      let bodyMsg = '';
      try {
        bodyMsg = (await res.text()).trim().slice(0, 220);
      } catch (_) {
        /* ignore */
      }
      return {
        status: 'error',
        data: null,
        error: `Endpoint merespons HTTP ${res.status}${bodyMsg ? ` — ${bodyMsg}` : ''}`,
      };
    }

    const json = await res.json();
    return { status: 'live', data: json, error: null };
  } catch (e) {
    const message =
      e.name === 'AbortError'
        ? `Timeout — endpoint tidak merespons dalam ${FETCH_TIMEOUT_MS / 1000} detik.`
        : e.message || 'Gagal mengambil data (alasan tidak diketahui).';
    return { status: 'error', data: null, error: message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { ZONES, ZONE_KEYS, resolveUrl, resolveAnonKey, fetchZoneLive, FETCH_TIMEOUT_MS };
