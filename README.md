# Serena Control Tower — SCM KPI Dashboard

Lapisan agregasi KPI strategis di atas tiga aplikasi sumber: **Stock Monitoring FG**,
**Logistics Monitoring**, dan **FEFO Monitoring**. Menampilkan skor kesehatan
operasional gabungan, KPI per zona, insight otomatis, dan peringatan lintas aplikasi.

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
├── index.html            # Client: struktur halaman
├── style.css              # Client: seluruh styling
├── app.js                 # Client: rendering KPI, modal, alert, simulasi fallback
├── package.json
├── vercel.json
├── .env.example
└── .gitignore
```

**Alur data (refresh normal dashboard):** browser memanggil `/api/kpi`
(same-origin, tanpa masalah CORS) → `api/kpi.js` memanggil ketiga endpoint
Supabase Edge Function secara paralel & server-to-server (dengan
`apikey`/`Authorization` dari environment variable) → hasilnya digabung dalam
satu snapshot lalu dikirim balik ke browser sebagai satu response JSON. Dipilih
sebagai default karena dashboard ini selalu merender & menghitung skor
gabungan dari ketiga zona sekaligus tiap siklus refresh, jadi 1 request lebih
hemat dan snapshot-nya konsisten antar-zona.

**Endpoint granular (`/api/kpi/<zone>`)** disediakan sebagai pelengkap untuk
kebutuhan di masa depan — mis. tombol "refresh zona ini saja", interval
berbeda per kartu, atau retry hanya zona yang gagal. Contoh: `GET
/api/kpi/stock`, `GET /api/kpi/logistics`, `GET /api/kpi/fefo`. Zona yang
tidak dikenal akan mengembalikan HTTP 404 dengan pesan error yang jelas. Kedua
endpoint memakai fungsi fetch/timeout/header yang sama persis dari
`api/_lib/kpi-zones.js`, jadi perilakunya selalu konsisten.

Jika sebuah zona gagal diambil live (endpoint down, env var belum diisi, dst),
`app.js` otomatis jatuh ke **mode simulasi** (data historis yang "berjalan" sedikit
demi sedikit) sehingga dashboard tetap enak dilihat dan didemokan. Status
live/simulasi per zona selalu ditampilkan apa adanya di UI.

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

Tiap endpoint (`STOCK_API_URL`, `LOGISTICS_API_URL`, `FEFO_API_URL`) diharapkan
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
