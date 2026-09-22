import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// analisis-scm-api
//
// Membaca view hasil analisis di schema public (v_*) dan mengirimkannya sebagai
// satu paket JSON untuk menu "Analisis & Prediksi" di SCM Control Tower.
//
//   GET /all      -> seluruh dataset menu Analisis (dipakai api/analisis.js)
//   GET /health   -> cek hidup
//
// Catatan keamanan:
//  - verify_jwt = true: pemanggil wajib membawa JWT Supabase (anon key sudah cukup).
//    Dipanggil server-to-server dari Vercel (api/analisis.js), bukan dari browser,
//    jadi sengaja TIDAK ada header CORS.
//  - KUNCI AKSES OPSIONAL: bila secret ANALISIS_API_KEY diisi di Supabase
//    (Edge Functions -> Secrets), semua route wajib membawa header x-api-key yang sama.
//    Isi env ANALISIS_API_KEY yang sama di Vercel. Tanpa secret ini, siapa pun yang
//    memegang anon key bisa membaca paket data ini (termasuk tren per pelanggan).
//  - Hanya READ pada view yang tercantum di VIEWS. Tidak ada input pengguna di query.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API_KEY = Deno.env.get("ANALISIS_API_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const VIEWS = {
  armada: "v_kebutuhan_armada_ringkas",
  kendaraan: "v_kebutuhan_kendaraan_hari_ini",
  prediksi: "v_prediksi_kirim",
  tren: "v_tren_bulanan",
  skuBelumMaster: "v_sku_belum_master",
  harian: "v_harian",
  stokTerbaru: "v_stok_terbaru",
  stokVsKirim: "v_stok_vs_kirim",
  shipmentsRingkas: "v_shipments_ringkas",
  shipments: "v_shipments",
  akurasi: "v_akurasi_prediksi_ringkas",
  pareto: "v_pareto",
  prioritas: "v_prioritas_tindakan",
  peringatan: "v_peringatan_data",
  hariPuncak: "v_hari_puncak_armada",
  biayaCarton: "v_biaya_per_carton_bulanan",
  durasiRingkas: "v_durasi_ringkas",
  durasiHarian: "v_durasi_harian",
  biayaHarianGudang: "v_biaya_harian_gudang",
  estimasiBudget: "v_estimasi_biaya_bulan_depan",
} as const;

// Kolom v_shipments yang dikirim (tanpa kolom yang tidak dipakai UI).
const SHIPMENT_COLS =
  "tanggal_posting,kode_sku,nama_produk,kode_batch,gudang,kota_tujuan,provinsi,pelanggan," +
  "nama_ekspedisi,qty,m3,kg,tanggal_kadaluarsa,status,keterangan_fefo";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// PostgREST membatasi 1000 baris per permintaan, jadi ambil per halaman.
// `make` harus mengembalikan query BERURUTAN (order) supaya halaman tidak tumpang tindih.
// deno-lint-ignore no-explicit-any
async function fetchAll(name: string, make: () => any, pageSize = 1000, maxPages = 30) {
  const out: unknown[] = [];
  for (let page = 0; page < maxPages; page++) {
    let res = await make().range(page * pageSize, (page + 1) * pageSize - 1);
    // Database kecil: satu query bisa kena statement timeout (8 dtk) saat beban sedang tinggi.
    // Ulangi sekali setelah jeda singkat; biasanya lolos karena cache sudah hangat.
    if (res.error && /statement timeout/i.test(res.error.message)) {
      await new Promise((r) => setTimeout(r, 500));
      res = await make().range(page * pageSize, (page + 1) * pageSize - 1);
    }
    const { data, error } = res;
    if (error) throw new Error(`${name}: ${error.message}`);
    const rows = (data ?? []) as unknown[];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

// Jalankan tugas dengan paralelisme terbatas. Menembakkan seluruh query sekaligus ke database
// kecil membuat semuanya saling melambat sampai ada yang melewati statement_timeout (8 dtk).
async function limited<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// 'YYYY-MM-DD' -> tanggal 1 pada n bulan sebelumnya
function monthsBack(ymd: string, n: number): string {
  const [y, m] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 10);
}

async function trenPelanggan() {
  const { data, error } = await supabase
    .from(VIEWS.tren).select("bulan").eq("dimensi", "TOTAL")
    .order("bulan", { ascending: false }).limit(1);
  if (error) throw new Error(`${VIEWS.tren}: ${error.message}`);
  const latest = data?.[0]?.bulan as string | undefined;
  if (!latest) return [];
  const cutoff = monthsBack(latest, 3); // 4 bulan terakhir
  return await fetchAll(`${VIEWS.tren} (pelanggan)`, () =>
    supabase.from(VIEWS.tren).select("*").eq("dimensi", "PELANGGAN").gte("bulan", cutoff)
      .order("kunci").order("bulan"));
}

async function kirimTerbaru() {
  const { data, error } = await supabase
    .from(VIEWS.shipments).select("tanggal_posting")
    .order("tanggal_posting", { ascending: false }).limit(1);
  if (error) throw new Error(`${VIEWS.shipments}: ${error.message}`);
  const tgl = data?.[0]?.tanggal_posting as string | undefined;
  if (!tgl) return [];
  const res = await supabase
    .from(VIEWS.shipments).select(SHIPMENT_COLS).eq("tanggal_posting", tgl)
    .order("m3", { ascending: false, nullsFirst: false }).limit(50);
  if (res.error) throw new Error(`${VIEWS.shipments}: ${res.error.message}`);
  return res.data ?? [];
}

async function buildBundle() {
  const [
    armada, kendaraan, prediksi, tren, tren_pelanggan, sku_belum_master,
    harian, stok_terbaru, stok_vs_kirim, shipments_ringkas, kirim_terbaru,
    akurasi, pareto, prioritas, peringatan, hari_puncak, biaya_carton,
    durasi_ringkas, durasi_harian, biaya_harian_gudang, estimasi_budget,
  ] = await limited([
    () => fetchAll(VIEWS.armada, () => supabase.from(VIEWS.armada).select("*").order("whs").order("periode")),
    () => fetchAll(VIEWS.kendaraan, () => supabase.from(VIEWS.kendaraan).select("*").order("upload_date")),
    () => fetchAll(VIEWS.prediksi, () => supabase.from(VIEWS.prediksi).select("*").order("gudang").order("kode_sku")),
    () => fetchAll(VIEWS.tren, () =>
      supabase.from(VIEWS.tren).select("*").in("dimensi", ["TOTAL", "GUDANG"])
        .order("dimensi").order("kunci").order("bulan")),
    () => trenPelanggan(),
    () => fetchAll(VIEWS.skuBelumMaster, () =>
      supabase.from(VIEWS.skuBelumMaster).select("*").order("kode_sku").order("sumber")),
    () => fetchAll(VIEWS.harian, () => supabase.from(VIEWS.harian).select("*").order("tanggal")),
    () => fetchAll(VIEWS.stokTerbaru, () => supabase.from(VIEWS.stokTerbaru).select("*").order("whs").order("item_code")),
    () => fetchAll(VIEWS.stokVsKirim, () => supabase.from(VIEWS.stokVsKirim).select("*").order("whs").order("item_code")),
    () => fetchAll(VIEWS.shipmentsRingkas, () =>
      supabase.from(VIEWS.shipmentsRingkas).select("*").order("dimensi").order("kunci").order("bulan")),
    () => kirimTerbaru(),
    () => fetchAll(VIEWS.akurasi, () =>
      supabase.from(VIEWS.akurasi).select("*").order("dimensi").order("kunci")),
    () => fetchAll(VIEWS.pareto, () =>
      supabase.from(VIEWS.pareto).select("*").order("dimensi").order("peringkat")),
    () => fetchAll(VIEWS.prioritas, () => supabase.from(VIEWS.prioritas).select("*").order("urutan")),
    () => fetchAll(VIEWS.peringatan, () => supabase.from(VIEWS.peringatan).select("*")),
    () => fetchAll(VIEWS.hariPuncak, () =>
      supabase.from(VIEWS.hariPuncak).select("*").order("armada").order("bulan", { ascending: true, nullsFirst: false })),
    () => fetchAll(VIEWS.biayaCarton, () => supabase.from(VIEWS.biayaCarton).select("*").order("bulan")),
    () => fetchAll(VIEWS.durasiRingkas, () => supabase.from(VIEWS.durasiRingkas).select("*").order("dimensi").order("jumlah_trip", { ascending: false })),
    () => fetchAll(VIEWS.durasiHarian, () => supabase.from(VIEWS.durasiHarian).select("*").order("tanggal")),
    () => fetchAll(VIEWS.biayaHarianGudang, () => supabase.from(VIEWS.biayaHarianGudang).select("*").order("tanggal", { ascending: false })),
    () => fetchAll(VIEWS.estimasiBudget, () => supabase.from(VIEWS.estimasiBudget).select("*")),
  ], 5);

  return {
    generated_at: new Date().toISOString(),
    armada, kendaraan, prediksi, tren, tren_pelanggan, sku_belum_master,
    harian, stok_terbaru, stok_vs_kirim, shipments_ringkas, kirim_terbaru,
    akurasi, pareto, prioritas, peringatan, hari_puncak, biaya_carton,
    durasi_ringkas, durasi_harian, biaya_harian_gudang, estimasi_budget,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  // Keamanan (fail-closed, temuan audit 22 Sep 2026): verify_jwt di Supabase
  // meloloskan anon key sebagai JWT yang valid — dan anon key itu MEMANG
  // publik (dipegang browser lewat assets/supabase-client.js). Jadi
  // ANALISIS_API_KEY adalah SATU-SATUNYA gerbang nyata yang membedakan
  // "server Vercel yang sudah mengecek login user" dari "siapa saja yang
  // menyalin anon key dari kode client". Sebelumnya, kalau secret ini belum
  // diisi, endpoint diam-diam TERBUKA untuk siapa saja (data SKU & pelanggan
  // bisa diambil langsung tanpa login). Sekarang endpoint menolak SEMUA
  // request selama secret belum dikonfigurasi — gagal aman, bukan gagal
  // terbuka. Isi secret `ANALISIS_API_KEY` di Supabase → Edge Functions →
  // Secrets, dan env var yang sama di Vercel, untuk mengaktifkan endpoint ini.
  if (!API_KEY) {
    return json(
      { error: "Endpoint belum dikonfigurasi: secret ANALISIS_API_KEY belum diisi di Supabase." },
      503,
    );
  }
  if (req.headers.get("x-api-key") !== API_KEY) {
    return json({ error: "Unauthorized: header x-api-key tidak ada atau salah" }, 401);
  }

  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  const route = segments[1] ?? "";

  try {
    if (route === "" || route === "health") {
      return json({
        status: "ok",
        service: "analisis-scm-api",
        time: new Date().toISOString(),
        locked: API_KEY !== "",
        endpoints: ["GET /all"],
      });
    }
    if (route === "all") return json(await buildBundle());
    return json({ error: `Endpoint tidak ditemukan: /${route}` }, 404);
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
