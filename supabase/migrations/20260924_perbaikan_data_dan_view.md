# 24 Sep 2026 — sudah diterapkan langsung ke database (lewat Supabase MCP)

1. `fix_logistics_tgl_swapped_day_month` — memperbaiki 341 baris `logistics.tgl` yang hari/bulannya tertukar
   (111 di antaranya jatuh di masa depan, mis. 5 Jun 2027). Cadangan: tabel `logistics_tgl_backup_20260924`.
   View `v_durasi_bongkar_muat` kini memakai `parse_tgl_fleksibel(tgl)` (sebelumnya hanya menerima DD/MM/YY sehingga kosong).
2. `stok_fallback_beda_gudang` / `stok_vs_kirim_fallback_beda_gudang` — `v_prediksi_kirim` dan `v_stok_vs_kirim`
   memakai stok dari gudang lain bila SKU dikirim dari gudang yang tidak punya baris stok; kolom baru
   `stok_beda_gudang` + `gudang_stok` (prediksi) dan `kirim_beda_gudang` + `gudang_kirim` (stok vs kirim).
3. `biaya_tenaga_harian_rls_authenticated` — policy RLS agar akun login bisa input lewat `/api/biaya`.
4. `koreksi_gudang_stok_lemonia` — tabel `stok_koreksi_gudang` (pemetaan label gudang stok → gudang aktual) dipakai `v_stok_terbaru`.
5. `shipments_ringkas_pelanggan_dan_armada_ekspedisi` — `v_shipments_ringkas` mendapat dimensi `PELANGGAN` dan
   `ARMADA_EKSPEDISI` (kolom baru `trip`, `kendaraan_unik` dari logistics). Edge function tidak perlu diubah (select `*`).
6. `ekspedisi_lokal_dan_muatan_per_trip` — tabel `ekspedisi_lokal` (Serena Indopangan = pengiriman lokal, tidak ada di logistics);
   `v_harian.m3_per_trip` / `kg_per_trip` kini memakai volume via ekspedisi saja (37,2 m³ & 9.005 kg per trip, sebelumnya 45,5 m³ & 11.066 kg).
   Kolom baru: `qty_ekspedisi`, `m3_ekspedisi`, `kg_ekspedisi`. `v_kebutuhan_kendaraan_hari_ini` belum diubah.
7. `rls_dedupe_policies_and_initplan` — hapus policy RLS duplikat (logistics, profiles, fg_face_enrollment) dan
   bungkus `auth.uid()`/`auth.jwt()` dengan `(select ...)` di semua policy publik agar dievaluasi sekali per query
   (perf advisor: initplan), bukan per baris.
8. `harden_functions_and_add_fk_index` — cabut `execute` publik dari fungsi trigger
   (`prevent_role_self_escalation`, `reject_anonymous_signup`), kunci `search_path` beberapa fungsi,
   tambah index FK `fg_stock_uploads.uploaded_by`, cabut akses tabel backup `logistics_tgl_backup_20260924` dari anon/authenticated.
9. `grant_read_biaya_karton_views` — beri akses `select` ke `authenticated` untuk `target_biaya_karton` dan view
   `v_biaya_per_karton`, `v_biaya_per_karton_harian`, `v_biaya_per_karton_ringkas` (semua `security_invoker`).
10. `drop_logistics_tgl_backup_20260924` — hapus tabel cadangan setelah perbaikan tanggal di #1 diverifikasi aman.
11. `fg_stock_replace_same_day_upload` — trigger baru: upload stok FG baru pada tanggal yang sama otomatis
    menggantikan (hapus) upload sebelumnya di tanggal tersebut, supaya tidak dobel.
12. **`logistics_kpi_server_side`** — view `v_logistics_trip` (durasi loading per trip dari `time_in`/`time_out`,
    dengan flag `durasi_valid` untuk membuang anomali) dan fungsi RPC `get_logistics_kpi(p_from, p_to, p_sla_menit)`
    yang menghitung KPI (SLA %, rata-rata/median/p90 durasi, breakdown per armada, volume per kendaraan, dll)
    langsung di server — menghindari limit 1000 baris PostgREST. **Frontend belum memakai RPC ini** — perlu
    ditambahkan hook baru (mis. `hooks/fetch/useLogisticsKpi.ts`) yang memanggil
    `supabase.rpc('get_logistics_kpi', { p_from, p_to, p_sla_menit })`.
