# Serena Control Tower — SCM KPI Dashboard

Lapisan agregasi KPI strategis di atas empat sumber: **Stock Monitoring FG**,
**Logistics Monitoring**, **FEFO Monitoring**, dan **Produktivitas Tim Gudang**
(dihitung server-side dari tabel `logistics` + `data_karyawan` lewat Edge Function
`warehouse-productivity-api`). Menampilkan skor kesehatan operasional gabungan,
KPI per zona, insight otomatis, dan peringatan lintas aplikasi.

## Arsitektur

Proyek ini dipecah menjadi **server** dan **client**, siap di-deploy sebagai satu
project Vercel (statis + serverless function), tanpa build step:

```
scm-control-tower/
├── api/
│   ├── _lib/
│   │   └── kpi-zones.js  # Logika bersama: config zona + fetchZoneLive()
│   │                     #   (diawali "_" → bukan endpoint, cuma modul internal)
│   ├── kpi.js            # Server: GET /api/kpi          — endpoint GABUNGAN
│   │                     #   (3 zona sekaligus, 1 request; dipakai app.js)
│   └── kpi/
│       └── [zone].js     # Server: GET /api/kpi/<zone>   — endpoint GRANULAR
│                          #   (1 zona saja: stock | logistics | fefo)
│   └── analisis.js       # Server: GET /api/analisis     — data menu "Analisis & Prediksi"
├── supabase/functions/
│   └── analisis-scm-api/ # Edge Function: membaca view hasil analisis (v_*) di Supabase
├── index.html            # Client: struktur halaman (menu Control Tower + Analisis & Prediksi)
├── style.css              # Client: seluruh styling
├── app.js                 # Client: rendering KPI, modal, alert, simulasi fallback
├── analisis.js            # Client: menu "Analisis & Prediksi" + navigasi tab
├── package.json
├── vercel.json
├── .env.example
└── .gitignore
```

**Alur data (refresh normal dashboard):** browser memanggil `/api/kpi`
(same-origin, tanpa masalah CORS) → `api/kpi.js` memanggil keempat endpoint
Supabase Edge Function secara paralel & server-to-server (dengan
`apikey`/`Authorization` dari environment variable) → hasilnya digabung dalam
satu snapshot lalu dikirim balik ke browser sebagai satu response JSON. Dipilih
sebagai default karena dashboard ini selalu merender & menghitung skor
gabungan dari zona-zona ini sekaligus tiap siklus refresh, jadi 1 request lebih
hemat dan snapshot-nya konsisten antar-zona.

**Tentang zona "Produktivitas Tim Gudang":** berbeda dari 3 zona lain, ini bukan
aplikasi terpisah — Edge Function `warehouse-productivity-api` menghitungnya
langsung dari baris mentah tabel `logistics` (kolom `picker`/`muat`/`stuffing`)
yang dicocokkan ke tabel `data_karyawan`. Karena nama petugas di kolom tersebut
kadang tergabung tanpa spasi (mis. "CAHYOADAMFERIKHAALFIAN" = 4 nama sekaligus),
function ini melakukan pencocokan heuristik (longest-match) — nilai
`token_match_pct` yang ditampilkan dashboard mencerminkan kualitas pencocokan
ini, bukan performa kerja. Kalau field ini pernah perlu diubah lagi, source
lengkapnya ada di Supabase Dashboard → Edge Functions → `warehouse-productivity-api`.

**Endpoint granular (`/api/kpi/<zone>`)** disediakan sebagai pelengkap untuk
kebutuhan di masa depan — mis. tombol "refresh zona ini saja", interval
berbeda per kartu, atau retry hanya zona yang gagal. Contoh: `GET
/api/kpi/stock`, `GET /api/kpi/logistics`, `GET /api/kpi/fefo`, `GET /api/kpi/warehouse`. Zona yang
tidak dikenal akan mengembalikan HTTP 404 dengan pesan error yang jelas. Kedua
endpoint memakai fungsi fetch/timeout/header yang sama persis dari
`api/_lib/kpi-zones.js`, jadi perilakunya selalu konsisten.

Jika sebuah zona gagal diambil live (endpoint down, env var belum diisi, dst),
`app.js` otomatis jatuh ke **mode simulasi** (data historis yang "berjalan" sedikit
demi sedikit) sehingga dashboard tetap enak dilihat dan didemokan. Status
live/simulasi per zona selalu ditampilkan apa adanya di UI.

## Menu "Analisis & Prediksi"

Menu kedua (tab di bawah judul, alamat `#analisis`) menampilkan hasil analisis dari
**view Supabase**, bukan dari tabel mentah. Isinya dibagi enam bagian:

| Bagian | Isi | View sumber |
|---|---|---|
| Armada | Kebutuhan armada hari ini dan besok per gudang, kebutuhan trip historis, hari puncak vs kapasitas armada | `v_kebutuhan_armada_ringkas`, `v_kebutuhan_kendaraan_hari_ini`, `v_hari_puncak_armada` |
| Stok | Stok vs prediksi kirim, akurasi prediksi (uji mundur), perbandingan dengan rata-rata datar 90 hari, stok saat ini per SKU | `v_prediksi_kirim`, `v_akurasi_prediksi_ringkas`, `v_stok_vs_kirim`, `v_stok_terbaru` |
| Prioritas | Peringatan data otomatis, prioritas tindakan per SKU, Pareto SKU dan pelanggan | `v_peringatan_data`, `v_prioritas_tindakan`, `v_pareto` |
| Tren | Tren bulanan (grafik, per gudang), tren per pelanggan, rekap harian volume vs trip | `v_tren_bulanan`, `v_harian` |
| Durasi truk | Durasi truk di lokasi (jam masuk sampai keluar), trip berkategori Lama (di atas persentil ke-90), per ekspedisi dan per armada | `v_durasi_harian`, `v_durasi_ringkas` (turunan `v_durasi_bongkar_muat`) |
| Pengiriman | Ringkasan per bulan (status, ekspedisi, provinsi, kasus FEFO) dan 50 baris terbesar pada tanggal terakhir | `v_shipments_ringkas` (turunan `v_shipments`), `v_shipments` |
| Biaya (lanjutan) | Biaya tenaga per gudang dan per hari dari catatan harian, proyeksi budget bulan depan dalam skenario rendah/rata-rata/tinggi/target | `v_biaya_harian_gudang`, `v_estimasi_biaya_bulan_depan` |
| Evaluasi target biaya | Menilai target di `target_biaya_karton` terhadap level historis (median, rata-rata berbobot, model biaya tetap/variabel) dan mengusulkan target realistis/tantangan | dihitung di sisi klien dari `v_biaya_per_carton_bulanan`, tanpa view baru |
| Data master | SKU yang belum punya volume atau berat | `v_sku_belum_master` |

View pendukung: `v_akurasi_prediksi` (detail uji mundur per SKU per tanggal acuan) dan
`v_shipments_ringkas` (ringkasan `v_shipments` per bulan, supaya browser tidak perlu memuat
puluhan ribu baris).

**Alur data:** browser -> `/api/analisis` (Vercel) -> Edge Function `analisis-scm-api`
(Supabase, membaca view dengan service role, hanya baca) -> JSON. Pola ini sama dengan
`/api/kpi`: URL dan anon key hanya ada di server.

**Deploy Edge Function** (sekali saja, kalau belum ada di project Supabase Anda):

```bash
supabase functions deploy analisis-scm-api --project-ref <project-ref>
```

Function ini memakai `verify_jwt` (default), jadi pemanggilnya wajib membawa JWT/anon key,
yang sudah disisipkan `api/analisis.js`. Endpoint bisa diganti lewat env `ANALISIS_API_URL`.

**Kunci akses (sangat disarankan).** Paket data ini memuat tren per pelanggan dan baris
pengiriman. Tanpa kunci, siapa pun yang memegang anon key bisa memanggil Edge Function
dan membacanya. Untuk mengunci:

1. Supabase -> Edge Functions -> Secrets: tambahkan `ANALISIS_API_KEY` (string acak panjang).
2. Vercel -> Environment Variables: isi `ANALISIS_API_KEY` dengan nilai yang sama, lalu redeploy.

Setelah keduanya terisi, panggilan tanpa header `x-api-key` ditolak dengan HTTP 401.

Angka "hari ini" dan "besok" mengikuti tanggal **upload stok terbaru**, bukan tanggal
hari ini. Menu menampilkan peringatan jika upload sudah berumur 2 hari atau lebih.

### Catatan data untuk Durasi truk dan Biaya (lanjutan)

- **Durasi truk** memakai `logistics.time_in` dan `time_out`. Tabel itu tidak mencatat jam mulai muat, jadwal keluar (`jadwal_out` kosong),
  maupun gudang, jadi waktu tunggu, keterlambatan terhadap jadwal, dan rincian per gudang tidak tersedia. Kartu menampilkan peringatan
  bila data trip terakhir sudah lebih dari 14 hari.
- **Biaya per gudang dan per hari** membaca `biaya_tenaga_harian` (catatan manual: jumlah pekerja x biaya per pekerja, qty dimuat), diisi lewat
  Edge Function `biaya-tenaga-api` (butuh secret `BIAYA_API_KEY` dan endpoint `api/biaya.js` di Vercel, yang belum ada di repo ini). Selama tabel
  kosong, kartu menampilkan petunjuk. Bila sebuah tanggal punya catatan gudang `SEMUA`, itu dipakai sebagai total hari tersebut.
- **Proyeksi budget** adalah proyeksi lurus (volume 22 hari kirim x biaya per karton bulan acuan), tanpa musim, promosi, atau perubahan tarif.
- **Keamanan view:** jalankan `supabase/migrations/20260921_security_invoker_views.sql`. Tanpanya lima view di atas bisa dibaca siapa pun yang
  memegang anon key dan melewati RLS tabel dasarnya.

### Evaluasi target biaya per karton

Kartu ini dihitung sepenuhnya di `analisis.js` dari data `v_biaya_per_carton_bulanan` yang sudah dikirim edge function,
jadi tidak menambah view atau memerlukan deploy ulang. Cost labour bulanan hampir tetap sedangkan volume berubah-ubah,
sehingga biaya per karton terutama ditentukan oleh volume; karena itu setiap skenario target disertai volume minimum
per bulan (dari model biaya tetap + variabel, regresi linear sederhana). Minimal perlu 3 bulan dengan cost labour terisi.

### Login + verifikasi wajah (baru)

Dashboard ini sekarang WAJIB login sebelum bisa dibuka: email/password Supabase Auth, lalu
verifikasi wajah (memakai infrastruktur `verify-face` + tabel `fg_face_enrollment` yang sudah
ada di project Supabase ini, dibangun untuk aplikasi presensi/verifikasi gudang).

**Alur:**
1. `login.html` — masuk dengan email & password akun di tabel `profiles` / Supabase Auth.
2. Setelah password benar, kamera aktif dan meminta verifikasi wajah. Descriptor wajah dikirim
   ke Edge Function `verify-face`, yang membandingkannya dengan `fg_face_enrollment.descriptor`
   milik akun itu (perbandingan terjadi di server, bukan di browser, supaya hasilnya tidak bisa
   dipalsukan lewat DevTools).
3. Kalau cocok, `index.html` (dashboard) baru bisa dibuka. Status "sudah verifikasi wajah"
   disimpan di `sessionStorage`, jadi hilang saat tab ditutup — tab/sesi browser baru wajib
   verifikasi wajah lagi walau akunnya masih login.
4. Akun yang belum punya wajah terdaftar (`fg_face_enrollment` kosong untuknya) diarahkan ke
   `enroll.html` untuk mendaftarkan wajahnya sendiri (butuh login dulu; RLS `fg_face_enrollment`
   hanya mengizinkan menulis baris miliknya sendiri).

**Perlindungan di server, bukan cuma di tampilan.** `api/kpi.js`, `api/kpi/[zone].js`, dan
`api/analisis.js` sekarang menolak permintaan tanpa header `Authorization: Bearer <token>` yang
valid (dicek lewat `api/_lib/require-user.js`, memanggil Supabase Auth). Sebelum perubahan ini,
siapa pun yang tahu URL Vercel bisa membaca seluruh data KPI dan analisis tanpa login sama
sekali — endpoint selalu memakai anon key milik SERVER, bukan identitas pengunjung. Penting:
pengecekan wajah TIDAK dicek ulang di server tiap request API (itu di luar cakupan token JWT
Supabase standar) — wajah adalah gerbang untuk MEMBUKA dashboard di browser, sedangkan yang
menjaga API adalah login email/password yang valid.

**Yang perlu Anda siapkan:**
- Provider Email/Password aktif di Supabase → Authentication → Providers.
- Akun untuk tiap pengguna dashboard di Supabase → Authentication → Users (dan baris terkait di
  `profiles`). Dua akun contoh yang sudah ada: `aji.septaku@gmail.com` (wajah sudah terdaftar)
  dan `manager@fglogistics.local` (belum, perlu buka `enroll.html` setelah login pertama).
- Kamera aktif dan browser mengizinkan akses kamera. `getUserMedia` hanya jalan di **HTTPS atau
  localhost** — tidak akan berfungsi kalau dashboard diakses lewat `http://` biasa di jaringan
  lain (deploy Vercel otomatis HTTPS, jadi ini hanya masalah saat uji coba manual di luar
  localhost).
- Model pengenalan wajah (`face-api.js`) dimuat dari CDN publik saat halaman dibuka, jadi
  butuh koneksi internet dan asumsi model itu SAMA (`faceRecognitionNet`, 128 dimensi) dengan
  yang dipakai saat wajah pertama kali didaftarkan di sistem presensi. Kalau ternyata beda,
  `enroll.html` akan menulis ulang dengan model yang konsisten dengan alur baru ini.

**Bukan proteksi mutlak.** Ini second factor untuk MEMBUKA aplikasi, bukan enkripsi data.
Siapa pun yang tahu email+password tetap bisa memanggil `/api/kpi` dan `/api/analisis` langsung
(tanpa lewat UI) asal menyertakan token login yang valid — itu memang levelnya "harus login",
bukan "harus juga difoto tiap request". Untuk keamanan lebih tinggi lagi (mis. audit log tiap
akses, rate limiting, atau mewajibkan wajah tervalidasi per-request), perlu perubahan tambahan.

## Menjalankan secara lokal

Butuh [Node.js 18+](https://nodejs.org) dan [Vercel CLI](https://vercel.com/docs/cli):

```bash
npm install
npx vercel dev
```

Buka `http://localhost:3000`. Secara default dashboard memakai endpoint Supabase
contoh (lihat `.env.example`) — untuk memakai sumber data sendiri, salin
`.env.example` menjadi `.env.local` dan isi sesuai project Anda.

## Push ke GitHub

```bash
git init
git add .
git commit -m "Initial commit: SCM Control Tower (server + client)"
git branch -M main
git remote add origin https://github.com/<username>/<nama-repo>.git
git push -u origin main
```

## Deploy ke Vercel

**Opsi A — lewat dashboard (paling mudah):**
1. Buka [vercel.com/new](https://vercel.com/new) dan import repo GitHub di atas.
2. Vercel otomatis mendeteksi ini sebagai project statis + serverless function
   (framework preset: *Other*) — tidak perlu build command khusus.
3. Di tab **Environment Variables**, tambahkan (opsional tapi disarankan untuk
   produksi):
   - `STOCK_API_URL`
   - `LOGISTICS_API_URL`
   - `FEFO_API_URL`
   - `WAREHOUSE_API_URL`
   - `SUPABASE_ANON_KEY`
4. Klik **Deploy**.

**Opsi B — lewat CLI:**
```bash
npm install -g vercel
vercel        # deploy preview
vercel --prod # deploy ke production
```

## Mengatur ulang sumber data setelah deploy

Endpoint & API key tidak lagi diedit di browser (beda dari versi awal file HTML
tunggal) — semuanya lewat **Environment Variables** di Vercel (Project → Settings →
Environment Variables), lalu redeploy. Ini lebih aman karena kunci tidak pernah
terkirim ke client.

Di dalam dashboard, tombol **Konfigurasi** hanya mengatur:
- zona mana yang boleh mencoba mengambil data live (toggle "Coba Live"),
- interval auto-refresh.

Pengaturan ini disimpan di `localStorage` browser masing-masing pengguna.

## Kontrak data JSON

Tiap endpoint (`STOCK_API_URL`, `LOGISTICS_API_URL`, `FEFO_API_URL`, `WAREHOUSE_API_URL`) diharapkan
mengembalikan JSON datar (bukan array, bukan nested) sesuai bentuk yang bisa
dilihat di dashboard lewat panel Konfigurasi → "Lihat kontrak data JSON yang
diharapkan per zona", atau di konstanta `DATA_CONTRACT` pada `app.js`.

## Keamanan / perubahan dari versi sebelumnya

Dibanding file HTML tunggal sebelumnya, versi ini:
- **Menghapus** panggilan langsung dari browser ke `api.anthropic.com` dengan
  MCP connector (hanya berfungsi di dalam sandbox artifact Claude.ai, tidak akan
  jalan di deployment nyata, dan berisiko keamanan bila dibiarkan).
- **Memindahkan** Supabase anon key dari kode client ke environment variable
  server (`api/kpi.js`).
- **Mengganti** `window.storage` (API khusus artifact Claude.ai) dengan
  `localStorage` standar browser agar berjalan di hosting mana pun.
