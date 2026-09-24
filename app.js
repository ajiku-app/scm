const DATA_CONTRACT = {
  stock: { health_pct:46.1, safe_sku:47, total_sku:102, forecast_accuracy_pct:11.5, forecast_covered_sku:73, capacity_util_pct:96.8, pallet_used:6729, pallet_total:6948, total_stock_unit:443856, stock_change_pct:-2.6, total_nilai_stok_idr:145899078729, sku_dengan_harga:446, total_volume_stok_l:36740384, sku_dengan_volume:537 },
  logistics: { sla_pct:48, avg_load_minutes:102, total_shipment:98, over_sla_count:51, active_ekspedisi:18, longest_load_minutes:335, avg_wait_minutes:27, total_vehicle_count:22, total_volume_muat_l:84700 },
  fefo: { compliance_pct:93.07, dead_stock_pct:0, traceability_pct:100, total_qty_ctn:3550000, violation_count:4887, total_nilai_terkirim_idr:20764627255, total_volume_terkirim_l:4620385, total_sku_terkirim:93, sku_dengan_harga:67, sku_dengan_volume:80, period:null, hari_dalam_periode:9, qty_terkirim_hari_ini:21479, volume_terkirim_hari_ini_l:478462.6, nilai_terkirim_hari_ini_idr:1453606712, rata2_volume_harian_l:513376.1, volume_hari_ini_vs_rata2_pct:93.2, nilai_terkirim_periode_lalu_idr:18500000000 },
  warehouse: { total_shipment:692, total_hari_kerja:66, avg_shipment_per_day:10.5, avg_picker_per_shipment:3.2, avg_muat_per_shipment:2.8, avg_stuffing_per_shipment:3.0, avg_crew_size:9.0, total_karyawan_terdaftar:31, total_kemunculan:6228, total_kemunculan_dikenali:4640, token_match_pct:74.5, top_karyawan_jumlah:142, avg_kendaraan_muat_per_hari:10.5, req_kendaraan_muat_per_hari:11 }
};

// Keamanan: semua field KPI yang dirender lewat innerHTML di file ini pada
// dasarnya angka yang sudah lewat fmtInt/fmtPct/dst (sehingga tidak bisa
// membawa HTML/skrip). Tapi beberapa field seperti "period" adalah TEKS
// mentah dari respons live /api/kpi (endpoint Edge Function di server, di
// luar kendali browser). Kalau teks itu pernah berisi karakter HTML — baik
// karena datanya dimanipulasi di sumbernya atau endpoint berubah — jangan
// sampai malah dieksekusi sebagai kode di browser pengguna yang sedang
// login. esc() dipakai untuk menetralkan karakter HTML sebelum disisipkan.
function esc(s){
  return String(s===null||s===undefined?'':s).replace(/[&<>"']/g, c=>(
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}

// Konfigurasi endpoint (URL, API key) TIDAK lagi disimpan di browser.
// Server (/api/kpi.js) yang menyimpan & memanggil endpoint live lewat environment
// variable, sehingga tidak ada kunci/URL sensitif yang terekspos ke client.
const STORAGE_KEY = 'superapp_config_v1';
let config = {
  refreshInterval: 20000,
  zones: {
    stock:      { enabled:true },
    logistics:  { enabled:true },
    fefo:       { enabled:true },
    warehouse:  { enabled:true }
  }
};

let sim = JSON.parse(JSON.stringify(DATA_CONTRACT));
let timerId = null;
let lastUpdateTs = null;
let latestRaw = { stock:null, logistics:null, fefo:null, warehouse:null };
let latestStatus = { stock:'simulated', logistics:'simulated', fefo:'simulated', warehouse:'simulated' };
let lastError = { stock:null, logistics:null, fefo:null, warehouse:null };
let kpiHistory = {};
let kpiHistoryTs = {}; // timestamp (ms) paralel per entri kpiHistory[key], dipakai badge tren
const HISTORY_CAP = 40;

const KPI_CONFIGS = {
  'stock-health': {
    title:'Kesehatan Stok Keseluruhan', zone:'Stock Monitoring FG', zoneKey:'stock',
    value:d=>d.health_pct, fmt:v=>fmtPct(v)+'%', status:v=>classify(v,60,40,false),
    rows:d=>[['SKU Aman', fmtInt(d.safe_sku)+' / '+fmtInt(d.total_sku)],['Persentase Aman', fmtPct(d.health_pct)+'%']],
    analysis:(d,cls)=>{
      const gap = d.total_sku-d.safe_sku;
      let t = `Kesehatan stok berada di ${fmtPct(d.health_pct)}% — ${fmtInt(d.safe_sku)} dari ${fmtInt(d.total_sku)} SKU berada pada level aman (di atas safety stock, di bawah batas overstock).`;
      t += cls==='bad' ? ` ${fmtInt(gap)} SKU berisiko stockout/overstock dan perlu direview replenishment minggu ini, prioritaskan SKU kelas A terlebih dahulu.` :
           cls==='warn' ? ` Sebagian SKU mendekati ambang batas aman — pantau kelas A agar tidak jatuh ke zona kritis.` :
           ` Kondisi ini tergolong sehat dan berada dalam batas toleransi operasional.`;
      return t;
    }
  },
  'stock-forecast': {
    title:'Forecast Accuracy', zone:'Stock Monitoring FG', zoneKey:'stock',
    value:d=>d.forecast_accuracy_pct, fmt:v=>fmtPct(v)+'%', status:v=>classify(v,60,30,false),
    rows:d=>[['SKU Terakurasi', fmtInt(d.forecast_covered_sku)+' / '+fmtInt(d.total_sku)],['Akurasi', fmtPct(d.forecast_accuracy_pct)+'%']],
    analysis:(d,cls)=>{
      let t = `Akurasi forecast tercatat ${fmtPct(d.forecast_accuracy_pct)}%, mencakup ${fmtInt(d.forecast_covered_sku)} dari ${fmtInt(d.total_sku)} SKU.`;
      t += cls==='bad' ? ` Angka ini jauh di bawah wajar (idealnya >60%) — model demand planning kemungkinan besar perlu dikalibrasi ulang, dan rencana produksi/replenishment yang bersandar padanya berisiko meleset.` :
           cls==='warn' ? ` Masih di bawah target ideal — evaluasi parameter forecasting untuk SKU dengan volatilitas permintaan tinggi.` :
           ` Akurasi berada pada level yang dapat diandalkan untuk perencanaan stok.`;
      return t;
    }
  },
  'stock-cap': {
    title:'Utilisasi Kapasitas Gudang', zone:'Stock Monitoring FG', zoneKey:'stock',
    value:d=>d.capacity_util_pct, fmt:v=>fmtPct(v)+'%', status:v=>classify(v,85,95,true),
    rows:d=>[['Pallet Terpakai', fmtInt(d.pallet_used)],['Kapasitas Total', fmtInt(d.pallet_total)+' pallet']],
    analysis:(d,cls)=>{
      const over = d.pallet_used > d.pallet_total;
      const diff = Math.abs(d.pallet_total-d.pallet_used);
      let t = `Kapasitas gudang terpakai ${fmtPct(d.capacity_util_pct)}% (${fmtInt(d.pallet_used)} dari ${fmtInt(d.pallet_total)} pallet tercatat di sistem)`;
      t += over ? `, melampaui kapasitas tercatat sebesar ${fmtInt(diff)} pallet.` : `, menyisakan ${fmtInt(diff)} slot pallet.`;
      t += over ? ` Ini indikasi ada stok yang disimpan di luar area yang tercatat di sistem (overflow/gudang sewa luar) — perlu dikonfirmasi ke lapangan dan datanya dilengkapi, sekaligus evaluasi apakah relokasi/percepatan pengiriman SKU kelas A diperlukan.` :
           cls==='bad' ? ` Mendekati penuh — perlu realokasi atau percepatan pengiriman SKU kelas A sebelum kapasitas benar-benar habis dan mengganggu penerimaan barang baru.` :
           cls==='warn' ? ` Mulai padat — mulai rencanakan realokasi agar tidak mendekati batas maksimum.` :
           ` Kapasitas masih longgar dan aman untuk penerimaan barang baru.`;
      return t;
    }
  },
  'stock-total': {
    title:'Total Stok Hari Ini', zone:'Stock Monitoring FG', zoneKey:'stock',
    value:d=>d.total_stock_unit, fmt:v=>fmtInt(v)+' unit', status:()=>'good',
    rows:d=>[['Perubahan Harian', (d.stock_change_pct>=0?'▲':'▼')+fmtPct(Math.abs(d.stock_change_pct))+'%'],['Total Unit', fmtInt(d.total_stock_unit)]],
    analysis:(d)=>{
      const arah = d.stock_change_pct>=0 ? 'naik' : 'turun';
      return `Total stok hari ini ${fmtInt(d.total_stock_unit)} unit, ${arah} ${fmtPct(Math.abs(d.stock_change_pct))}% dibanding hari sebelumnya. Pergerakan ini wajar dipantau bersama akurasi forecast dan utilisasi kapasitas agar tren stok tidak menumpuk di satu arah secara berkelanjutan.`;
    }
  },
  'stock-volume': {
    title:'Volume Stok Terpakai', zone:'Stock Monitoring FG', zoneKey:'stock',
    value:d=>d.total_volume_stok_l, fmt:v=>fmtM3(v), status:()=>'neutral',
    rows:d=>[['SKU dengan Data Volume', fmtInt(d.sku_dengan_volume)+' / '+fmtInt(d.total_sku)],['Total Volume', fmtM3(d.total_volume_stok_l)]],
    analysis:(d)=>{
      const cakupan = d.total_sku ? (d.sku_dengan_volume/d.total_sku*100) : 0;
      let t = `Total volume fisik stok yang tersimpan saat ini sekitar ${fmtM3(d.total_volume_stok_l)}, dihitung dari ${fmtInt(d.sku_dengan_volume)} dari ${fmtInt(d.total_sku)} SKU (${fmtPct(cakupan,0)}%) yang punya data volume per karton di master produk.`;
      t += cakupan<80 ? ` Cakupan data volume belum lengkap — lengkapi data volume per SKU di master produk agar angka ini mewakili seluruh stok.` : ` Angka ini bisa dipakai bersama data pallet untuk mengecek konsistensi antara kapasitas pallet dan kapasitas ruang (m³) gudang.`;
      return t;
    }
  },
  'log-sla': {
    title:'SLA Loading', zone:'Logistics Monitoring', zoneKey:'logistics',
    value:d=>d.sla_pct, fmt:v=>fmtPct(v,0)+'%', status:v=>classify(v,80,60,false),
    rows:d=>[['Lewat SLA', fmtInt(d.over_sla_count)+' / '+fmtInt(d.total_shipment)],['Target', '≤ 90 menit']],
    analysis:(d,cls)=>{
      const overPct = d.total_shipment>0 ? d.over_sla_count/d.total_shipment*100 : 0;
      let t = `SLA loading tercapai pada ${fmtPct(d.sla_pct,0)}% pengiriman — ${fmtInt(d.over_sla_count)} dari ${fmtInt(d.total_shipment)} (${fmtPct(overPct,0)}%) melewati target 90 menit.`;
      t += cls==='bad' ? ` Tingkat pelanggaran ini signifikan — telusuri rute dan ekspedisi yang paling sering terlambat untuk evaluasi kontrak armada tetap.` :
           cls==='warn' ? ` Masih di bawah target ideal, perlu perhatian pada rute dengan durasi loading tertinggi.` :
           ` Performa loading berada dalam target SLA yang sehat.`;
      return t;
    }
  },
  'log-avg': {
    title:'Rata-rata Durasi Loading', zone:'Logistics Monitoring', zoneKey:'logistics',
    value:d=>d.avg_load_minutes, fmt:v=>fmtHM(v), status:v=>classify(v,90,150,true),
    rows:d=>[['Pengiriman Terpantau', fmtInt(d.total_shipment)],['Rata-rata', fmtHM(d.avg_load_minutes)]],
    analysis:(d,cls)=>{
      let t = `Rata-rata durasi loading saat ini ${fmtHM(d.avg_load_minutes)} dari ${fmtInt(d.total_shipment)} pengiriman terpantau.`;
      t += cls==='bad' ? ` Durasi rata-rata jauh di atas target 90 menit — indikasi bottleneck di proses muat/stuffing yang perlu diaudit di lapangan.` :
           cls==='warn' ? ` Sedikit di atas target — perlu identifikasi pengiriman dengan durasi ekstrem yang menarik rata-rata ke atas.` :
           ` Durasi rata-rata berada dalam target yang wajar.`;
      return t;
    }
  },
  'log-total': {
    title:'Total Pengiriman', zone:'Logistics Monitoring', zoneKey:'logistics',
    value:d=>d.total_shipment, fmt:v=>fmtInt(v)+' unit', status:()=>'good',
    rows:d=>[['Ekspedisi Aktif', fmtInt(d.active_ekspedisi)],['Total Pengiriman', fmtInt(d.total_shipment)]],
    analysis:(d)=>`Tercatat ${fmtInt(d.total_shipment)} pengiriman berjalan lewat ${fmtInt(d.active_ekspedisi)} ekspedisi aktif. Volume ini jadi basis perhitungan SLA dan durasi loading — semakin terkonsentrasi pada sedikit ekspedisi, semakin besar dampaknya bila salah satu bermasalah.`
  },
  'log-longest': {
    title:'Loading Terlama', zone:'Logistics Monitoring', zoneKey:'logistics',
    value:d=>d.longest_load_minutes, fmt:v=>fmtHM(v), status:v=> v>240?'bad':(v>120?'warn':'good'),
    rows:d=>[['Durasi', fmtHM(d.longest_load_minutes)],['Referensi Kasus', 'Supriatna → Korea']],
    analysis:(d,cls)=>{
      let t = `Loading terlama pada siklus ini berdurasi ${fmtHM(d.longest_load_minutes)}.`;
      t += cls==='bad' ? ` Jauh melebihi rata-rata wajar — kemungkinan ada kendala dokumen ekspor, antrian dermaga, atau ketersediaan armada yang perlu ditelusuri langsung ke lapangan.` :
           cls==='warn' ? ` Berada di atas rata-rata — layak jadi kasus evaluasi proses loading.` :
           ` Masih dalam rentang wajar dibanding rata-rata pengiriman lain.`;
      return t;
    }
  },
  'log-wait': {
    title:'Rata-rata Waktu Tunggu Driver', zone:'Logistics Monitoring', zoneKey:'logistics',
    value:d=>d.avg_wait_minutes, fmt:v=>fmtHM(v), status:v=>classify(v,20,45,true),
    rows:d=>[['Waktu Tunggu', fmtHM(d.avg_wait_minutes)],['Pengiriman Terpantau', fmtInt(d.total_shipment)]],
    analysis:(d,cls)=>{
      let t = `Rata-rata driver menunggu ${fmtHM(d.avg_wait_minutes)} sebelum proses loading dimulai, dari ${fmtInt(d.total_shipment)} pengiriman yang terpantau.`;
      t += cls==='bad' ? ` Waktu tunggu ini cukup lama — kemungkinan ada bottleneck di antrian dermaga, dokumen, atau kesiapan tim muat sebelum kendaraan bisa mulai dimuat. Ini turut menambah durasi total loading di luar waktu muat itu sendiri.` :
           cls==='warn' ? ` Sedikit di atas wajar — cek apakah ada pola waktu tertentu (jam sibuk) yang membuat driver lebih sering menunggu.` :
           ` Waktu tunggu tergolong singkat dan tidak banyak menambah beban durasi loading total.`;
      return t;
    }
  },
  'log-volveh': {
    title:'Rata-rata Volume Muat / Kendaraan', zone:'Logistics Monitoring', zoneKey:'logistics',
    value:d=>d.total_vehicle_count>0 ? (d.total_volume_muat_l/d.total_vehicle_count) : 0,
    fmt:v=>fmtM3(v), status:()=>'neutral',
    rows:d=>[['Total Volume Dimuat', fmtM3(d.total_volume_muat_l)],['Jumlah Armada/Kendaraan', fmtInt(d.total_vehicle_count)]],
    analysis:(d)=>{
      const perVeh = d.total_vehicle_count>0 ? (d.total_volume_muat_l/d.total_vehicle_count) : 0;
      return `Total ${fmtM3(d.total_volume_muat_l)} volume produk dimuat lewat ${fmtInt(d.total_vehicle_count)} unit armada/kendaraan, rata-rata ${fmtM3(perVeh)} per kendaraan. Angka ini berguna untuk mengecek apakah jenis armada yang dipakai sudah sesuai kapasitas — rata-rata yang jauh di bawah kapasitas standar kendaraan mengindikasikan pemuatan kurang optimal (kendaraan terlalu besar untuk volume yang diangkut), sementara yang mendekati/melebihi kapasitas berisiko overload.`;
    }
  },
  'wh-shipday': {
    title:'Rata-rata Pengiriman / Hari Kerja', zone:'Produktivitas Tim Gudang', zoneKey:'warehouse',
    value:d=>d.avg_shipment_per_day, fmt:v=>fmtPct(v), status:()=>'neutral',
    rows:d=>[['Total Pengiriman', fmtInt(d.total_shipment)],['Hari Kerja', fmtInt(d.total_hari_kerja)]],
    analysis:(d)=>`Selama ${fmtInt(d.total_hari_kerja)} hari kerja tercatat ${fmtInt(d.total_shipment)} pengiriman, rata-rata ${fmtPct(d.avg_shipment_per_day)} pengiriman per hari. Angka ini jadi dasar perhitungan kebutuhan tenaga kerja dan kendaraan muat harian di kartu lain pada zona ini.`
  },
  'wh-crew': {
    title:'Rata-rata Tenaga / Pengiriman', zone:'Produktivitas Tim Gudang', zoneKey:'warehouse',
    value:d=>d.avg_crew_size, fmt:v=>fmtPct(v), status:()=>'neutral',
    rows:d=>[['Picker', fmtPct(d.avg_picker_per_shipment)],['Muat', fmtPct(d.avg_muat_per_shipment)],['Stuffing', fmtPct(d.avg_stuffing_per_shipment)],['Total Kru', fmtPct(d.avg_crew_size)]],
    analysis:(d)=>`Rata-rata ${fmtPct(d.avg_crew_size)} orang terlibat per pengiriman — terdiri dari ${fmtPct(d.avg_picker_per_shipment)} picker, ${fmtPct(d.avg_muat_per_shipment)} tenaga muat, dan ${fmtPct(d.avg_stuffing_per_shipment)} tenaga stuffing. Kombinasi ini bisa dipakai bersama proyeksi pengiriman/hari untuk merencanakan jadwal shift harian.`
  },
  'wh-picker': {
    title:'Rata-rata Tim Picker / Pengiriman', zone:'Produktivitas Tim Gudang', zoneKey:'warehouse',
    value:d=>d.avg_picker_per_shipment, fmt:v=>fmtPct(v)+' orang', status:()=>'neutral',
    rows:d=>[['Picker / Pengiriman', fmtPct(d.avg_picker_per_shipment)],['% dari Total Kru', fmtPct(d.avg_crew_size?d.avg_picker_per_shipment/d.avg_crew_size*100:0,0)+'%']],
    analysis:(d)=>`Tahap picking rata-rata membutuhkan ${fmtPct(d.avg_picker_per_shipment)} orang per pengiriman, atau sekitar ${fmtPct(d.avg_crew_size?d.avg_picker_per_shipment/d.avg_crew_size*100:0,0)}% dari total ${fmtPct(d.avg_crew_size)} tenaga yang terlibat. Dipakai bersama rata-rata ${fmtPct(d.avg_shipment_per_day)} pengiriman/hari untuk memperkirakan kebutuhan picker harian.`
  },
  'wh-muat': {
    title:'Rata-rata Tim Muat / Pengiriman', zone:'Produktivitas Tim Gudang', zoneKey:'warehouse',
    value:d=>d.avg_muat_per_shipment, fmt:v=>fmtPct(v)+' orang', status:()=>'neutral',
    rows:d=>[['Muat / Pengiriman', fmtPct(d.avg_muat_per_shipment)],['% dari Total Kru', fmtPct(d.avg_crew_size?d.avg_muat_per_shipment/d.avg_crew_size*100:0,0)+'%']],
    analysis:(d)=>`Tahap muat rata-rata membutuhkan ${fmtPct(d.avg_muat_per_shipment)} orang per pengiriman, atau sekitar ${fmtPct(d.avg_crew_size?d.avg_muat_per_shipment/d.avg_crew_size*100:0,0)}% dari total ${fmtPct(d.avg_crew_size)} tenaga yang terlibat. Angka ini berkaitan langsung dengan kartu "Kebutuhan Kendaraan Muat / Hari" — tiap kendaraan butuh tim muat yang memadai agar SLA loading tercapai.`
  },
  'wh-stuffing': {
    title:'Rata-rata Tim Stuffing / Pengiriman', zone:'Produktivitas Tim Gudang', zoneKey:'warehouse',
    value:d=>d.avg_stuffing_per_shipment, fmt:v=>fmtPct(v)+' orang', status:()=>'neutral',
    rows:d=>[['Stuffing / Pengiriman', fmtPct(d.avg_stuffing_per_shipment)],['% dari Total Kru', fmtPct(d.avg_crew_size?d.avg_stuffing_per_shipment/d.avg_crew_size*100:0,0)+'%']],
    analysis:(d)=>`Tahap stuffing rata-rata membutuhkan ${fmtPct(d.avg_stuffing_per_shipment)} orang per pengiriman, atau sekitar ${fmtPct(d.avg_crew_size?d.avg_stuffing_per_shipment/d.avg_crew_size*100:0,0)}% dari total ${fmtPct(d.avg_crew_size)} tenaga yang terlibat. Bila tahap ini jadi bottleneck durasi loading, cek kartu "Loading Terlama" dan "Rata-rata Durasi Loading" di zona Logistics Monitoring.`
  },
  'wh-match': {
    title:'Cakupan Pengenalan Nama Petugas', zone:'Produktivitas Tim Gudang', zoneKey:'warehouse',
    value:d=>d.token_match_pct, fmt:v=>fmtPct(v)+'%', status:v=>classify(v,85,60,false),
    rows:d=>[['Kemunculan Dikenali', fmtInt(d.total_kemunculan_dikenali)+' / '+fmtInt(d.total_kemunculan)],['Karyawan Terdaftar', fmtInt(d.total_karyawan_terdaftar)]],
    analysis:(d,cls)=>{
      let t = `Dari ${fmtInt(d.total_kemunculan)} kemunculan nama di log Logistics, ${fmtInt(d.total_kemunculan_dikenali)} (${fmtPct(d.token_match_pct)}%) berhasil dicocokkan ke salah satu dari ${fmtInt(d.total_karyawan_terdaftar)} karyawan terdaftar.`;
      t += cls==='bad' ? ` Cakupan masih rendah — banyak nama di log kemungkinan tergabung tanpa spasi atau salah eja, sehingga produktivitas per orang belum bisa dihitung akurat untuk sebagian besar kemunculan.` :
           cls==='warn' ? ` Masih ada celah pencocokan yang cukup besar — rapikan format input nama di aplikasi Logistics Monitoring agar cakupan naik.` :
           ` Cakupan pencocokan sudah cukup tinggi untuk dijadikan dasar evaluasi produktivitas per orang.`;
      return t;
    }
  },
  'wh-top': {
    title:'Petugas Paling Aktif', zone:'Produktivitas Tim Gudang', zoneKey:'warehouse',
    value:d=>d.top_karyawan_jumlah, fmt:v=>fmtInt(v)+'x', status:()=>'neutral',
    rows:d=>[['Jumlah Kemunculan', fmtInt(d.top_karyawan_jumlah)],['Dari Total Kemunculan Dikenali', fmtInt(d.total_kemunculan_dikenali)]],
    analysis:(d)=>`Petugas paling aktif tercatat muncul ${fmtInt(d.top_karyawan_jumlah)} kali dari ${fmtInt(d.total_kemunculan_dikenali)} kemunculan nama yang berhasil dikenali. Beban kerja yang terkonsentrasi pada segelintir orang layak dicek — apakah karena penjadwalan tidak merata atau memang keahlian tertentu.`
  },
  'wh-vehicle': {
    title:'Kebutuhan Rata-rata Kendaraan Muat / Hari', zone:'Produktivitas Tim Gudang', zoneKey:'warehouse',
    value:d=>d.req_kendaraan_muat_per_hari, fmt:v=>fmtInt(v)+' unit', status:()=>'neutral',
    rows:d=>[['Rata-rata Pengiriman/Hari', fmtPct(d.avg_kendaraan_muat_per_hari)],['Kebutuhan Kendaraan (dibulatkan)', fmtInt(d.req_kendaraan_muat_per_hari)+' unit']],
    analysis:(d)=>{
      return `Berdasarkan ${fmtInt(d.total_shipment)} pengiriman selama ${fmtInt(d.total_hari_kerja)} hari kerja, rata-rata ada ${fmtPct(d.avg_kendaraan_muat_per_hari)} pengiriman per hari. Dengan asumsi satu pengiriman membutuhkan satu kendaraan muat, kebutuhan armada harian dibulatkan ke atas menjadi ${fmtInt(d.req_kendaraan_muat_per_hari)} unit kendaraan agar seluruh pengiriman rata-rata tertampung tanpa kekurangan armada di hari-hari sibuk.`;
    }
  },
  'fefo-compliance': {
    title:'Kepatuhan FEFO', zone:'FEFO Monitoring', zoneKey:'fefo',
    value:d=>d.compliance_pct, fmt:v=>fmtPct(v)+'%', status:v=>classify(v,90,75,false),
    rows:d=>[['Pelanggaran Urutan', fmtInt(d.violation_count)],['Kepatuhan', fmtPct(d.compliance_pct)+'%']],
    analysis:(d,cls)=>{
      let t = `Kepatuhan FEFO seluruh gudang berada di ${fmtPct(d.compliance_pct)}%, dengan ${fmtInt(d.violation_count)} kejadian pelanggaran urutan pengambilan pasti (first-expired-first-out) tercatat.`;
      t += cls==='bad' ? ` Level ini butuh intervensi SOP picking segera untuk mencegah risiko near-expired menumpuk.` :
           cls==='warn' ? ` Masih perlu perbaikan proses picking agar mendekati target di atas 90%.` :
           ` Ini level yang sehat — tetap pantau tren pelanggaran agar tidak naik dari waktu ke waktu.`;
      return t;
    }
  },
  'fefo-dead': {
    title:'Dead Stock / Near-Expired', zone:'FEFO Monitoring', zoneKey:'fefo',
    value:d=>d.dead_stock_pct, fmt:v=>fmtPct(v)+'%', status:v=>classify(v,2,5,true),
    rows:d=>[['Risiko Kedaluwarsa', fmtPct(d.dead_stock_pct)+'%'],['Kategori', 'Near-Expired / Dead Stock']],
    analysis:(d,cls)=>{
      let t = `Proporsi dead stock / near-expired saat ini ${fmtPct(d.dead_stock_pct)}%.`;
      t += cls==='bad' ? ` Level ini tinggi — perlu program clearance/diskon segera sebelum barang benar-benar kedaluwarsa.` :
           cls==='warn' ? ` Mulai muncul risiko kedaluwarsa — pantau batch dengan sisa umur simpan pendek.` :
           ` Risiko kedaluwarsa sangat terkendali berkat rotasi FEFO yang berjalan baik.`;
      return t;
    }
  },
  'fefo-trace': {
    title:'Batch Traceability', zone:'FEFO Monitoring', zoneKey:'fefo',
    value:d=>d.traceability_pct, fmt:v=>fmtPct(v,0)+'%', status:v=>classify(v,95,85,false),
    rows:d=>[['Traceability', fmtPct(d.traceability_pct,0)+'%'],['Cakupan', 'Qty tercatat kode batch']],
    analysis:(d,cls)=>{
      let t = `Sebanyak ${fmtPct(d.traceability_pct,0)}% kuantitas tercatat lengkap dengan kode batch.`;
      t += cls!=='good' ? ` Ada celah pencatatan batch yang perlu ditutup agar penelusuran mundur (traceability) tetap andal saat dibutuhkan (mis. recall).` :
           ` Traceability berada pada level yang andal untuk kebutuhan audit maupun penelusuran mundur.`;
      return t;
    }
  },
  'fefo-qty': {
    title:'Total Kuantitas Terkirim', zone:'FEFO Monitoring', zoneKey:'fefo',
    value:d=>d.total_qty_ctn, fmt:v=>(v/1000000).toFixed(2).replace('.',',')+' jt ctn', status:()=>'good',
    rows:d=>[['Total Karton', fmtInt(d.total_qty_ctn)],['Freshness SLED', '99,9%']],
    analysis:(d)=>`Total ${(d.total_qty_ctn/1000000).toFixed(2).replace('.',',')} juta karton telah dikirim pada periode berjalan dengan freshness SLED terjaga di 99,9%, menunjukkan rotasi stok yang konsisten mengikuti urutan FEFO.`
  },
  'fefo-volume': {
    title:'Volume Barang Terkirim', zone:'FEFO Monitoring', zoneKey:'fefo',
    value:d=>d.total_volume_terkirim_l, fmt:v=>fmtM3(v), status:()=>'neutral',
    rows:d=>[['SKU dengan Data Volume', fmtInt(d.sku_dengan_volume||0)+' / '+fmtInt(d.total_sku_terkirim||0)],['Total Volume', fmtM3(d.total_volume_terkirim_l)]],
    analysis:(d)=>{
      const cakupan = d.total_sku_terkirim ? (d.sku_dengan_volume/d.total_sku_terkirim*100) : 0;
      let t = `Total volume fisik barang yang terkirim pada periode berjalan sekitar ${fmtM3(d.total_volume_terkirim_l)}, dihitung dari ${fmtInt(d.sku_dengan_volume||0)} dari ${fmtInt(d.total_sku_terkirim||0)} SKU (${fmtPct(cakupan,0)}%) yang punya data volume per karton di master produk.`;
      t += cakupan<80 ? ` Cakupan data volume belum lengkap — lengkapi data volume per SKU di master produk agar angka ini mewakili seluruh barang terkirim.` : ` Angka ini berguna untuk estimasi kebutuhan armada/kontainer berdasarkan volume, bukan cuma jumlah karton.`;
      return t;
    }
  },
  'fefo-today-volume': {
    title:'Volume Pengiriman Hari Ini', zone:'FEFO Monitoring', zoneKey:'fefo',
    value:d=>d.volume_terkirim_hari_ini_l, fmt:v=>fmtM3(v), status:()=>'neutral',
    rows:d=>[['Volume Hari Ini', fmtM3(d.volume_terkirim_hari_ini_l)],['Rata-rata Harian', fmtM3(d.rata2_volume_harian_l)]],
    analysis:(d)=>{
      const diff = d.volume_hari_ini_vs_rata2_pct - 100;
      let t = `Volume pengiriman hari ini tercatat ${fmtM3(d.volume_terkirim_hari_ini_l)}, dibanding rata-rata harian ${fmtM3(d.rata2_volume_harian_l)} (${fmtPct(d.volume_hari_ini_vs_rata2_pct,0)}% dari rata-rata).`;
      t += diff < -20 ? ` Jauh di bawah rata-rata — bisa jadi hari libur/awal minggu, atau indikasi keterlambatan proses pengiriman yang perlu dicek.` :
           diff > 20 ? ` Di atas rata-rata harian — pastikan kapasitas loading dan armada di Logistics Monitoring cukup menampung lonjakan ini.` :
           ` Berada dalam rentang wajar dibanding rata-rata harian periode berjalan.`;
      return t;
    }
  },
  'fefo-growth': {
    title:'Pertumbuhan Penjualan', zone:'FEFO Monitoring', zoneKey:'fefo',
    value:d=> d.nilai_terkirim_periode_lalu_idr>0 ? ((d.total_nilai_terkirim_idr-d.nilai_terkirim_periode_lalu_idr)/d.nilai_terkirim_periode_lalu_idr*100) : 0,
    fmt:v=>(v>=0?'▲':'▼')+fmtPct(Math.abs(v))+'%',
    status:v=>classify(v,0,-10,false),
    rows:d=>{
      const growth = d.nilai_terkirim_periode_lalu_idr>0 ? ((d.total_nilai_terkirim_idr-d.nilai_terkirim_periode_lalu_idr)/d.nilai_terkirim_periode_lalu_idr*100) : 0;
      return [['Arah Tren', growth>=0?'Naik':'Turun'],['Perubahan', (growth>=0?'▲':'▼')+fmtPct(Math.abs(growth))+'%']];
    },
    analysis:(d,cls)=>{
      const growth = d.nilai_terkirim_periode_lalu_idr>0 ? ((d.total_nilai_terkirim_idr-d.nilai_terkirim_periode_lalu_idr)/d.nilai_terkirim_periode_lalu_idr*100) : 0;
      const arah = growth>=0 ? 'tumbuh' : 'turun';
      let t = `Nilai barang terkirim (proxy penjualan) ${arah} ${fmtPct(Math.abs(growth))}% dibanding periode sebelumnya.`;
      t += cls==='bad' ? ` Penurunan cukup signifikan — perlu ditelusuri apakah karena permintaan turun, stockout SKU kelas A (cek kartu Kesehatan Stok), atau keterlambatan pengiriman (cek zona Logistics Monitoring).` :
           cls==='warn' ? ` Sedikit menurun — pantau tren periode berikutnya sebelum dianggap sebagai masalah struktural.` :
           ` Tren pertumbuhan positif dan sehat pada periode berjalan.`;
      return t;
    }
  }
};

function fmtInt(n){ return Math.round(n).toLocaleString('id-ID'); }
function fmtRupiah(n){
  const v = Number(n)||0;
  if(Math.abs(v) >= 1e12) return 'Rp '+(v/1e12).toFixed(2).replace('.',',')+' T';
  if(Math.abs(v) >= 1e9) return 'Rp '+(v/1e9).toFixed(2).replace('.',',')+' M';
  if(Math.abs(v) >= 1e6) return 'Rp '+(v/1e6).toFixed(1).replace('.',',')+' jt';
  return 'Rp '+fmtInt(v);
}
function fmtM3(liter){
  const m3 = (Number(liter)||0)/1000;
  return fmtInt(m3)+' m³';
}
function fmtPct(n,d=1){ return n.toFixed(d).replace('.',','); }
function fmtHM(mins){
  const h = Math.floor(mins/60), m = Math.round(mins%60);
  return (h>0? h+'j ':'') + m+'m';
}

function classify(val, warnBelow, badBelow, invert){
  if(invert){
    if(val>=badBelow) return 'bad'; if(val>=warnBelow) return 'warn'; return 'good';
  }
  if(val<badBelow) return 'bad'; if(val<warnBelow) return 'warn'; return 'good';
}

function stepSim(zoneKey){
  const base = DATA_CONTRACT[zoneKey];
  const cur = sim[zoneKey];
  for(const k in base){
    const b = base[k];
    if(b === 0){ continue; }
    const stepPct = 0.012;
    const delta = b * stepPct * (Math.random()*2-1);
    let v = cur[k] + delta;
    const lo = b*0.9, hi = b*1.1;
    cur[k] = Math.max(Math.min(v,hi),lo);
  }
  return cur;
}

// Satu-satunya sumber data live: endpoint SERVER SENDIRI (/api/kpi), yang di
// belakang layar memanggil keempat endpoint Supabase Edge Function secara
// server-to-server (menghindari CORS di browser dan menyembunyikan API key).
// Zona "warehouse" dihitung dari Edge Function "warehouse-productivity-api",
// yang mengagregasi tabel logistics (picker/muat/stuffing) + data_karyawan —
// bukan endpoint terpisah yang di-input manual, tapi tetap sumber live asli.
const API_ENDPOINT = '/api/kpi';
let lastApiResult = null;
let lastApiFetchFailed = false;

async function fetchFromServer(){
  try{
    if (window.SCM_AUTH_READY) await window.SCM_AUTH_READY;
    const doFetch = (window.SCM_AUTH && window.SCM_AUTH.authFetch) || fetch;
    const res = await doFetch(API_ENDPOINT, { method:'GET', headers:{'Accept':'application/json'}, cache:'no-store' });
    if(!res.ok) throw new Error('HTTP '+res.status);
    const json = await res.json();
    lastApiResult = json;
    lastApiFetchFailed = false;
  }catch(e){
    console.warn('[SCM Control Tower] Gagal memanggil /api/kpi, seluruh zona jatuh ke simulasi:', e.message);
    lastApiResult = null;
    lastApiFetchFailed = true;
  }
}

function fetchZone(zoneKey){
  const z = config.zones[zoneKey];
  if(!z.enabled){
    lastError[zoneKey] = 'Zona ini dinonaktifkan (toggle "Coba Live" di Konfigurasi masih mati).';
    return { status:'simulated', data: stepSim(zoneKey) };
  }
  if(lastApiFetchFailed || !lastApiResult){
    lastError[zoneKey] = 'Tidak bisa menghubungi server aplikasi (/api/kpi) — periksa apakah server berjalan dan environment variable endpoint sudah diatur.';
    return { status:'simulated', data: stepSim(zoneKey) };
  }
  const zoneResult = lastApiResult.zones && lastApiResult.zones[zoneKey];
  if(zoneResult && zoneResult.status === 'live' && zoneResult.data){
    lastError[zoneKey] = null;
    return { status:'live', data: zoneResult.data };
  }
  lastError[zoneKey] = (zoneResult && zoneResult.error) || 'Server tidak mengembalikan data live untuk zona ini.';
  return { status:'simulated', data: stepSim(zoneKey) };
}

function setModeUI(zoneKey, status){
  const dot = document.getElementById('dot-'+zoneKey);
  const tag = document.getElementById(zoneKey+'-modetag');
  const errBox = document.getElementById(zoneKey+'-modeerror');
  if(dot){ dot.classList.remove('live','sim'); dot.classList.add(status==='live'?'live':'sim'); }
  if(tag){ tag.textContent = status==='live' ? 'LIVE' : 'SIMULASI'; tag.classList.remove('live','sim'); tag.classList.add(status==='live'?'live':'sim'); }
  if(errBox){
    if(status!=='live' && lastError[zoneKey]){
      errBox.textContent = '⚠ '+lastError[zoneKey];
      errBox.classList.add('show');
    } else {
      errBox.textContent = '';
      errBox.classList.remove('show');
    }
  }
}

function renderStock(d, status){
  setModeUI('stock', status);
  const health = d.health_pct ?? 0;
  const cls = classify(health, 60, 40, false);
  document.getElementById('kpi-stock-health').textContent = fmtPct(health)+'%';
  document.getElementById('kpi-stock-health').className = 'v '+cls;
  document.getElementById('kpi-stock-healthsub').textContent = `${fmtInt(d.safe_sku)} dari ${fmtInt(d.total_sku)} SKU Aman`;

  const fc = d.forecast_accuracy_pct ?? 0;
  const fcCls = classify(fc, 60, 30, false);
  document.getElementById('kpi-stock-forecast').textContent = fmtPct(fc)+'%';
  document.getElementById('kpi-stock-forecast').className = 'v '+fcCls;
  document.getElementById('kpi-stock-forecastsub').textContent = `${fmtInt(d.forecast_covered_sku)}/${fmtInt(d.total_sku)} SKU terakurasi`;

  const cap = d.capacity_util_pct ?? 0;
  const capCls = classify(cap, 85, 95, true);
  document.getElementById('kpi-stock-cap').textContent = fmtPct(cap)+'%';
  document.getElementById('kpi-stock-cap').className = 'v '+capCls;
  document.getElementById('kpi-stock-capsub').textContent = `${fmtInt(d.pallet_used)} / ${fmtInt(d.pallet_total)} pallet`;

  document.getElementById('kpi-stock-total').textContent = fmtInt(d.total_stock_unit);
  const chg = d.stock_change_pct ?? 0;
  document.getElementById('kpi-stock-totalsub').textContent = `${chg>=0?'▲':'▼'}${fmtPct(Math.abs(chg))}% vs hari sebelumnya`;

  const volumeStok = d.total_volume_stok_l ?? 0;
  document.getElementById('kpi-stock-volume').textContent = fmtM3(volumeStok);
  document.getElementById('kpi-stock-volumesub').textContent = `${fmtInt(d.sku_dengan_volume||0)}/${fmtInt(d.total_sku)} SKU ada data volume`;

  const zone = document.getElementById('zone-stock');
  const badge = document.getElementById('badge-stock');
  const overallCls = (cls==='bad'||fcCls==='bad'||capCls==='bad') ? 'bad' : ((cls==='warn'||fcCls==='warn'||capCls==='warn') ? 'warn' : 'good');
  zone.className = 'zone status-'+overallCls;
  badge.className = 'zone-badge '+overallCls;
  badge.textContent = overallCls==='good' ? 'Sehat' : (overallCls==='warn' ? 'Perlu Perhatian' : 'Kritis');

  let insight;
  if(cap>100){
    const kelebihan = d.pallet_used - d.pallet_total;
    insight = `<b>Insight:</b> Stok terpakai (${fmtInt(d.pallet_used)} pallet) sudah melampaui kapasitas area yang tercatat di sistem (${fmtInt(d.pallet_total)} pallet) sebesar ${fmtInt(kelebihan)} pallet (${fmtPct(cap)}%) — indikasi ada stok yang disimpan di luar area tersebut (overflow/gudang sewa) yang belum tercatat di data kapasitas.`;
  } else if(cap>=95 && fc<30){
    insight = `<b>Insight:</b> Kapasitas gudang mendekati penuh (${fmtPct(cap)}%) dan akurasi forecast rendah (${fmtPct(fc)}%) — dua sinyal ini bersama berisiko memperbesar kelebihan/kekurangan stok kelas A.`;
  } else if(health<50){
    insight = `<b>Insight:</b> Hanya ${fmtInt(d.safe_sku)} dari ${fmtInt(d.total_sku)} SKU dalam kondisi aman — perlu peninjauan replenishment segera.`;
  } else {
    insight = `<b>Insight:</b> Kesehatan stok berada di level ${fmtPct(health)}% dengan utilisasi gudang ${fmtPct(cap)}% — kondisi terkendali, tetap pantau SKU kelas A.`;
  }
  document.getElementById('insight-stock').innerHTML = insight;

  return { health, cap, fc };
}

function renderLogistics(d, status){
  setModeUI('logistics', status);
  const sla = d.sla_pct ?? 0;
  const cls = classify(sla, 80, 60, false);
  document.getElementById('kpi-log-sla').textContent = fmtPct(sla,0)+'%';
  document.getElementById('kpi-log-sla').className = 'v '+cls;

  document.getElementById('kpi-log-avg').textContent = fmtHM(d.avg_load_minutes);
  document.getElementById('kpi-log-avgsub').textContent = `${fmtInt(d.total_shipment)} pengiriman terpantau`;

  document.getElementById('kpi-log-total').textContent = fmtInt(d.total_shipment)+' unit';
  document.getElementById('kpi-log-totalsub').textContent = `${fmtInt(d.active_ekspedisi)} ekspedisi aktif`;

  const longCls = d.longest_load_minutes > 240 ? 'bad' : (d.longest_load_minutes>120 ? 'warn':'good');
  document.getElementById('kpi-log-longest').textContent = fmtHM(d.longest_load_minutes);
  document.getElementById('kpi-log-longest').className = 'v '+longCls;

  const waitCls = classify(d.avg_wait_minutes ?? 0, 20, 45, true);
  document.getElementById('kpi-log-wait').textContent = fmtHM(d.avg_wait_minutes ?? 0);
  document.getElementById('kpi-log-wait').className = 'v '+waitCls;

  const volPerVeh = (d.total_vehicle_count>0) ? (d.total_volume_muat_l/d.total_vehicle_count) : 0;
  document.getElementById('kpi-log-volveh').textContent = fmtM3(volPerVeh);
  document.getElementById('kpi-log-volvehsub').textContent = `${fmtM3(d.total_volume_muat_l ?? 0)} ÷ ${fmtInt(d.total_vehicle_count ?? 0)} kendaraan`;

  const zone = document.getElementById('zone-logistics');
  const badge = document.getElementById('badge-logistics');
  zone.className = 'zone status-'+cls;
  badge.className = 'zone-badge '+cls;
  badge.textContent = cls==='good' ? 'Sesuai Target' : (cls==='warn' ? 'Perlu Perhatian' : 'Di Bawah Target');

  const overPct = d.total_shipment>0 ? (d.over_sla_count/d.total_shipment*100) : 0;
  const periodeLog = d.period ? ` <span style="color:var(--muted-2)">(periode ${esc(d.period)})</span>` : '';
  document.getElementById('insight-logistics').innerHTML =
    `<b>Insight:</b> ${fmtInt(d.over_sla_count)} dari ${fmtInt(d.total_shipment)} pengiriman (${fmtPct(overPct,0)}%) lewat SLA 90 menit. Loading terlama tercatat ${fmtHM(d.longest_load_minutes)}, rata-rata waktu tunggu driver ${fmtHM(d.avg_wait_minutes ?? 0)} — kandidat evaluasi rute/armada.${periodeLog}`;

  return { sla };
}

function renderFefo(d, status){
  setModeUI('fefo', status);
  const comp = d.compliance_pct ?? 0;
  const cls = classify(comp, 90, 75, false);
  document.getElementById('kpi-fefo-compliance').textContent = fmtPct(comp)+'%';
  document.getElementById('kpi-fefo-compliance').className = 'v '+cls;

  document.getElementById('kpi-fefo-dead').textContent = fmtPct(d.dead_stock_pct)+'%';
  document.getElementById('kpi-fefo-trace').textContent = fmtPct(d.traceability_pct,0)+'%';
  document.getElementById('kpi-fefo-qty').textContent = (d.total_qty_ctn/1000000).toFixed(2).replace('.',',')+' jt ctn';

  const nilaiTerkirim = d.total_nilai_terkirim_idr ?? 0;

  const volumeTerkirim = d.total_volume_terkirim_l ?? 0;
  document.getElementById('kpi-fefo-volume').textContent = fmtM3(volumeTerkirim);
  document.getElementById('kpi-fefo-volumesub').textContent = `${fmtInt(d.sku_dengan_volume||0)}/${fmtInt(d.total_sku_terkirim||0)} SKU ada data volume`;

  const volToday = d.volume_terkirim_hari_ini_l ?? 0;
  document.getElementById('kpi-fefo-todayvolume').textContent = fmtM3(volToday);
  document.getElementById('kpi-fefo-todayvolumesub').textContent = `${fmtPct(d.volume_hari_ini_vs_rata2_pct ?? 0,0)}% vs rata-rata harian`;

  const prevNilai = d.nilai_terkirim_periode_lalu_idr ?? 0;
  const growth = prevNilai>0 ? ((nilaiTerkirim-prevNilai)/prevNilai*100) : 0;
  const growthCls = classify(growth, 0, -10, false);
  document.getElementById('kpi-fefo-growth').textContent = (growth>=0?'▲':'▼')+fmtPct(Math.abs(growth))+'%';
  document.getElementById('kpi-fefo-growth').className = 'v '+growthCls;

  const zone = document.getElementById('zone-fefo');
  const badge = document.getElementById('badge-fefo');
  zone.className = 'zone status-'+cls;
  badge.className = 'zone-badge '+cls;
  badge.textContent = cls==='good' ? 'Sehat' : (cls==='warn' ? 'Perlu Perhatian' : 'Kritis');

  const periodeFefo = d.period ? ` <span style="color:var(--muted-2)">(periode ${esc(d.period)})</span>` : '';
  document.getElementById('insight-fefo').innerHTML =
    `<b>Insight:</b> Rotasi stok tertelusuri penuh (${fmtPct(d.traceability_pct,0)}%) dengan kepatuhan ${fmtPct(comp)}%, namun tercatat ${fmtInt(d.violation_count)} kejadian pelanggaran urutan FEFO pasti yang perlu dipantau. Penjualan (nilai terkirim) ${growth>=0?'tumbuh':'turun'} ${fmtPct(Math.abs(growth))}% vs periode sebelumnya.${periodeFefo}`;

  return { comp };
}

function renderWarehouse(d, status){
  setModeUI('warehouse', status);

  document.getElementById('kpi-wh-shipday').textContent = fmtPct(d.avg_shipment_per_day);
  document.getElementById('kpi-wh-shipdaysub').textContent = `${fmtInt(d.total_shipment)} pengiriman / ${fmtInt(d.total_hari_kerja)} hari kerja`;

  document.getElementById('kpi-wh-crew').textContent = fmtPct(d.avg_crew_size);

  document.getElementById('kpi-wh-picker').textContent = fmtPct(d.avg_picker_per_shipment);
  document.getElementById('kpi-wh-muat').textContent = fmtPct(d.avg_muat_per_shipment);
  document.getElementById('kpi-wh-stuffing').textContent = fmtPct(d.avg_stuffing_per_shipment);

  const matchCls = classify(d.token_match_pct, 85, 60, false);
  document.getElementById('kpi-wh-match').textContent = fmtPct(d.token_match_pct)+'%';
  document.getElementById('kpi-wh-match').className = 'v '+matchCls;
  document.getElementById('kpi-wh-matchsub').textContent = `dari ${fmtInt(d.total_karyawan_terdaftar)} karyawan terdaftar`;

  document.getElementById('kpi-wh-top').textContent = fmtInt(d.top_karyawan_jumlah);

  document.getElementById('kpi-wh-vehicle').textContent = fmtInt(d.req_kendaraan_muat_per_hari)+' unit';
  document.getElementById('kpi-wh-vehiclesub').textContent = `≈${fmtPct(d.avg_kendaraan_muat_per_hari)} pengiriman/hari, dibulatkan ke atas`;

  const zone = document.getElementById('zone-warehouse');
  const badge = document.getElementById('badge-warehouse');
  zone.className = 'zone status-'+matchCls;
  badge.className = 'zone-badge '+matchCls;
  badge.textContent = matchCls==='good' ? 'Sehat' : (matchCls==='warn' ? 'Perlu Perhatian' : 'Kritis');

  document.getElementById('insight-warehouse').innerHTML =
    `<b>Insight:</b> Dengan rata-rata ${fmtPct(d.avg_shipment_per_day)} pengiriman/hari dan ${fmtPct(d.avg_crew_size)} tenaga per pengiriman, kebutuhan armada harian sekitar ${fmtInt(d.req_kendaraan_muat_per_hari)} unit kendaraan. Cakupan pengenalan nama petugas baru ${fmtPct(d.token_match_pct)}% — rapikan format input nama di aplikasi Logistics Monitoring agar produktivitas per orang terhitung akurat.`;

  return { match: d.token_match_pct };
}

function renderHealth(stock, logistics, fefo){
  const score = (stock.health + logistics.sla + fefo.comp) / 3;
  const num = document.getElementById('healthScoreNum');
  num.innerHTML = Math.round(score)+'<span>/100</span>';
  num.style.color = score>=70 ? 'var(--good)' : (score>=50 ? 'var(--warn)' : 'var(--bad)');

  const rows = [
    ['bar-stock','val-stock',stock.health],
    ['bar-sla','val-sla',logistics.sla],
    ['bar-fefo','val-fefo',fefo.comp]
  ];
  rows.forEach(([barId,valId,v])=>{
    const cls = classify(v, 80, 60, false);
    const color = cls==='good' ? 'var(--good)' : (cls==='warn' ? 'var(--warn)' : 'var(--bad)');
    document.getElementById(barId).style.width = Math.min(100,v)+'%';
    document.getElementById(barId).style.background = color;
    document.getElementById(valId).textContent = fmtPct(v)+'%';
  });
}

function renderAlerts(stockD, logD, fefoD){
  const items = [];
  if(stockD.forecast_accuracy_pct < 40){
    items.push(['Stock FG', `<b>Forecast accuracy ${fmtPct(stockD.forecast_accuracy_pct)}%</b> — jauh di bawah wajar, hanya ${fmtInt(stockD.forecast_covered_sku)} dari ${fmtInt(stockD.total_sku)} SKU tercakup. Berisiko membuat rencana produksi dan planning stok meleset.`]);
  }
  if(stockD.capacity_util_pct >= 90){
    items.push(['Stock FG', `<b>Kapasitas gudang ${fmtPct(stockD.capacity_util_pct)}% terpakai</b> (${fmtInt(stockD.pallet_used)} dari ${fmtInt(stockD.pallet_total)} pallet) — butuh realokasi/pengiriman segera sebelum kapasitas penuh.`]);
  }
  if(logD.sla_pct < 70){
    items.push(['Logistics', `<b>SLA loading hanya ${fmtPct(logD.sla_pct,0)}%</b> — ${fmtInt(logD.over_sla_count)} dari ${fmtInt(logD.total_shipment)} pengiriman lewat target 90 menit; loading terlama tercatat ${fmtHM(logD.longest_load_minutes)}.`]);
  }
  if(fefoD.violation_count > 0){
    items.push(['FEFO', `<b>${fmtInt(fefoD.violation_count)} pelanggaran urutan FEFO pasti</b> tercatat meski tingkat kepatuhan keseluruhan masih ${fmtPct(fefoD.compliance_pct)}% — pantau agar tidak menjadi tren naik.`]);
  }
  if(items.length===0){
    items.push(['Sistem', 'Semua indikator berada dalam batas aman pada pembaruan terakhir.']);
  }
  const html = items.slice(0,4).map(([src,text])=>`<li class="alert-item"><span class="alert-src">${src}</span><p>${text}</p></li>`).join('');
  document.getElementById('alertList').innerHTML = html;
}

function updateSyncUI(liveCount){
  const pill = document.getElementById('syncPill');
  const TOTAL_ZONES = 4;
  if(liveCount===TOTAL_ZONES){
    pill.textContent = `● TERSINKRON — ${TOTAL_ZONES}/${TOTAL_ZONES} APLIKASI LIVE`;
    pill.classList.remove('sim');
  } else if(liveCount===0){
    pill.textContent = `● MODE SIMULASI — 0/${TOTAL_ZONES} LIVE`;
    pill.classList.add('sim');
  } else {
    pill.textContent = `● SEBAGIAN LIVE — ${liveCount}/${TOTAL_ZONES} APLIKASI`;
    pill.classList.add('sim');
  }
  lastUpdateTs = Date.now();
  tickClock();
}

function tickClock(){
  if(!lastUpdateTs) return;
  const secs = Math.round((Date.now()-lastUpdateTs)/1000);
  const label = secs<5 ? 'baru saja' : `${secs} detik lalu`;
  document.getElementById('lastUpdateText').textContent = `Update terakhir: ${label}`;
}
setInterval(tickClock, 1000);

async function refreshAll(){
  const icon = document.getElementById('refreshIcon');
  icon.classList.add('spin');
  try{
    await fetchFromServer();
    const stockRes = fetchZone('stock');
    const logRes = fetchZone('logistics');
    const fefoRes = fetchZone('fefo');
    const whRes = fetchZone('warehouse');
    const stock = renderStock(stockRes.data, stockRes.status);
    const logistics = renderLogistics(logRes.data, logRes.status);
    const fefo = renderFefo(fefoRes.data, fefoRes.status);
    renderWarehouse(whRes.data, whRes.status);
    renderHealth(stock, logistics, fefo);
    renderAlerts(stockRes.data, logRes.data, fefoRes.data);
    const liveCount = [stockRes.status, logRes.status, fefoRes.status, whRes.status].filter(s=>s==='live').length;
    updateSyncUI(liveCount);

    latestRaw.stock = stockRes.data; latestRaw.logistics = logRes.data; latestRaw.fefo = fefoRes.data; latestRaw.warehouse = whRes.data;
    latestStatus.stock = stockRes.status; latestStatus.logistics = logRes.status; latestStatus.fefo = fefoRes.status; latestStatus.warehouse = whRes.status;
    applyTrendIndicators();
    recordHistory();
    // "Periode data" di masthead dihitung dari data menu Analisis & Prediksi
    // (analisis.js), bukan dari zona KPI ini — minta analisis.js
    // menyegarkannya juga supaya klik "Segarkan" di sini ikut memutakhirkan
    // teksnya. Fire-and-forget: tidak menunggu/mem-block refresh KPI di atas.
    if(window.SCM_REFRESH_PERIOD) window.SCM_REFRESH_PERIOD();
    if(document.getElementById('kpiModalOverlay').classList.contains('open') && activeKpiKey){
      if(activeKpiKey === '__combined') openCombinedScoreModal();
      else renderModalContent(activeKpiKey);
    }
  } finally {
    icon.classList.remove('spin');
  }
}

function manualRefresh(){ refreshAll(); }

let activeKpiKey = null;

// Beberapa DOM id KPI tidak mengikuti pola "kpi-"+key persis (hyphen dibuang
// di beberapa tempat pada HTML lama) — daftar pengecualian didaftarkan di sini
// supaya badge tren tetap menempel ke elemen yang benar.
const KPI_DOM_ID_OVERRIDES = {
  'fefo-today-volume': 'kpi-fefo-todayvolume'
};
function domIdForKey(key){
  return KPI_DOM_ID_OVERRIDES[key] || ('kpi-' + key);
}

// Indikator ▲/▼ per kartu KPI: dibandingkan dengan NILAI BERBEDA TERAKHIR
// yang tercatat di riwayat (bisa dari beberapa refresh lalu, bukan cuma
// refresh langsung sebelumnya) — sengaja begini karena data LIVE seringkali
// persis sama antar-refresh singkat (snapshot database, bukan stream
// realtime), jadi membandingkan ke 1 langkah ke belakang saja jarang
// menangkap perubahan sungguhan. Kalau di SELURUH riwayat yang tersimpan
// (maks HISTORY_CAP entri) nilainya identik, simbol sengaja dikosongkan —
// itu tetap jujur menunjukkan "belum ada perubahan tercatat". TIDAK
// menyiratkan baik/buruk (naik belum tentu bagus, mis. Utilisasi Kapasitas).
// Harus dipanggil SEBELUM recordHistory() supaya riwayat belum ketiban nilai
// yang baru saja di-fetch.
function fmtElapsed(ms){
  const sec = Math.round(ms/1000);
  if(sec < 60) return sec+' detik lalu';
  const min = Math.round(sec/60);
  if(min < 60) return min+' menit lalu';
  const jam = Math.round(min/60);
  return jam+' jam lalu';
}
function applyTrendIndicators(){
  const now = Date.now();
  Object.keys(KPI_CONFIGS).forEach(key=>{
    const cfg = KPI_CONFIGS[key];
    const d = latestRaw[cfg.zoneKey];
    const valueEl = document.getElementById(domIdForKey(key));
    if(!valueEl) return;

    let badge = document.getElementById('trend-'+key);
    if(!badge){
      badge = document.createElement('span');
      badge.id = 'trend-'+key;
      badge.className = 'trend-badge';
      valueEl.insertAdjacentElement('afterend', badge);
    }

    if(!d){ badge.textContent = ''; badge.title=''; return; }
    let value;
    try{ value = cfg.value(d); }catch(e){ badge.textContent=''; return; }
    if(typeof value !== 'number' || Number.isNaN(value)){ badge.textContent=''; return; }

    const hist = kpiHistory[key];
    const hts = kpiHistoryTs[key];
    if(!hist || hist.length === 0){ badge.textContent=''; badge.title=''; return; }

    const noiseFloor = Math.max(Math.abs(value) * 0.0008, 0.0005);
    // Cari mundur dari entri paling baru: titik terakhir yang nilainya
    // BERBEDA dari nilai sekarang.
    let refIdx = -1;
    for(let i=hist.length-1; i>=0; i--){
      if(Math.abs(hist[i]-value) > noiseFloor){ refIdx = i; break; }
    }
    if(refIdx === -1){
      // Seluruh riwayat yang tersimpan identik dengan nilai sekarang — belum
      // ada perubahan yang tertangkap sejauh ini.
      badge.textContent=''; badge.title='';
      return;
    }
    const diff = value - hist[refIdx];
    const elapsedTxt = hts && hts[refIdx] ? fmtElapsed(now - hts[refIdx]) : 'beberapa refresh lalu';
    badge.textContent = diff > 0 ? '▲' : '▼';
    badge.title = (diff > 0 ? 'Naik' : 'Turun') + ' dibanding ' + elapsedTxt + ' (waktu itu: ' + fmtPct(hist[refIdx]) + ')';
  });
}

function recordHistory(){
  const now = Date.now();
  Object.keys(KPI_CONFIGS).forEach(key=>{
    const cfg = KPI_CONFIGS[key];
    const d = latestRaw[cfg.zoneKey];
    if(!d) return;
    const v = cfg.value(d);
    if(!kpiHistory[key]) kpiHistory[key] = [];
    if(!kpiHistoryTs[key]) kpiHistoryTs[key] = [];
    kpiHistory[key].push(v);
    kpiHistoryTs[key].push(now);
    if(kpiHistory[key].length > HISTORY_CAP) kpiHistory[key].shift();
    if(kpiHistoryTs[key].length > HISTORY_CAP) kpiHistoryTs[key].shift();
  });
  if(latestRaw.stock && latestRaw.logistics && latestRaw.fefo){
    const score = (KPI_CONFIGS['stock-health'].value(latestRaw.stock)
      + KPI_CONFIGS['log-sla'].value(latestRaw.logistics)
      + KPI_CONFIGS['fefo-compliance'].value(latestRaw.fefo)) / 3;
    if(!kpiHistory['__combined']) kpiHistory['__combined'] = [];
    kpiHistory['__combined'].push(score);
    if(kpiHistory['__combined'].length > HISTORY_CAP) kpiHistory['__combined'].shift();
  }
}

function buildSparkSvg(values, colorVar){
  if(!values || values.length < 2){
    return `<text x="130" y="30" text-anchor="middle" fill="var(--muted-2)" font-size="10">Mengumpulkan data tren…</text>`;
  }
  const w = 260, h = 52, pad = 4;
  const min = Math.min(...values), max = Math.max(...values);
  const range = (max-min) || 1;
  const pts = values.map((v,i)=>{
    const x = pad + (i/(values.length-1)) * (w-pad*2);
    const y = h - pad - ((v-min)/range) * (h-pad*2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length-1].split(',');
  return `<polyline points="${pts.join(' ')}" fill="none" stroke="${colorVar}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="3.2" fill="${colorVar}"/>`;
}

function statusColorVar(cls){
  return cls==='good' ? 'var(--good)' : (cls==='warn' ? 'var(--warn)' : 'var(--bad)');
}

function renderModalContent(key){
  const cfg = KPI_CONFIGS[key];
  const d = latestRaw[cfg.zoneKey];
  if(!cfg || !d) return;
  const val = cfg.value(d);
  const cls = cfg.status(val);
  const color = statusColorVar(cls);

  document.getElementById('modalZoneTag').textContent = cfg.zone.toUpperCase();
  document.getElementById('modalTitle').textContent = cfg.title;

  const valueEl = document.getElementById('modalValue');
  valueEl.textContent = cfg.fmt(val);
  valueEl.className = 'modal-value '+cls;

  const statusEl = document.getElementById('modalStatus');
  statusEl.textContent = cls==='good' ? 'Sehat' : (cls==='warn' ? 'Perlu Perhatian' : 'Kritis');
  statusEl.className = 'modal-status '+cls;

  document.getElementById('modalSparkSvg').innerHTML = buildSparkSvg(kpiHistory[key], color);
  const n = (kpiHistory[key]||[]).length;
  document.getElementById('modalSparkCaption').textContent = n>1 ? `Tren ${n} pembaruan terakhir sejak sesi ini dibuka` : 'Tren sejak sesi ini dibuka';

  const rows = cfg.rows(d);
  document.getElementById('modalRows').innerHTML = rows.map(([l,v])=>
    `<div class="modal-row"><div class="rl">${l}</div><div class="rv">${v}</div></div>`).join('');

  document.getElementById('modalAnalysis').textContent = cfg.analysis(d, cls);

  const status = latestStatus[cfg.zoneKey];
  document.getElementById('modalMode').textContent = status==='live'
    ? 'Sumber data: LIVE dari aplikasi terhubung'
    : 'Sumber data: MODE SIMULASI (berbasis data historis, endpoint live belum aktif/terjangkau)';
}

function openKpiModal(key){
  activeKpiKey = key;
  if(!latestRaw[KPI_CONFIGS[key].zoneKey]) return;
  renderModalContent(key);
  document.getElementById('kpiModalOverlay').classList.add('open');
}

function openCombinedScoreModal(){
  if(!latestRaw.stock || !latestRaw.logistics || !latestRaw.fefo) return;
  activeKpiKey = '__combined';

  const stockHealth = KPI_CONFIGS['stock-health'].value(latestRaw.stock);
  const slaVal = KPI_CONFIGS['log-sla'].value(latestRaw.logistics);
  const fefoComp = KPI_CONFIGS['fefo-compliance'].value(latestRaw.fefo);
  const score = (stockHealth + slaVal + fefoComp) / 3;
  const cls = classify(score, 70, 50, false);
  const color = statusColorVar(cls);

  document.getElementById('modalZoneTag').textContent = 'SKOR GABUNGAN · 3 ZONA';
  document.getElementById('modalTitle').textContent = 'Skor Kesehatan Operasional Gabungan';

  const valueEl = document.getElementById('modalValue');
  valueEl.textContent = Math.round(score) + '/100';
  valueEl.className = 'modal-value ' + cls;

  const statusEl = document.getElementById('modalStatus');
  statusEl.textContent = cls === 'good' ? 'Sehat' : (cls === 'warn' ? 'Perlu Perhatian' : 'Kritis');
  statusEl.className = 'modal-status ' + cls;

  document.getElementById('modalSparkSvg').innerHTML = buildSparkSvg(kpiHistory['__combined'], color);
  const n = (kpiHistory['__combined'] || []).length;
  document.getElementById('modalSparkCaption').textContent = n > 1 ? `Tren ${n} pembaruan terakhir sejak sesi ini dibuka` : 'Tren sejak sesi ini dibuka';

  document.getElementById('modalRows').innerHTML = [
    ['Kesehatan Stok FG', fmtPct(stockHealth) + '%'],
    ['SLA Loading Logistik', fmtPct(slaVal) + '%'],
    ['Kepatuhan FEFO', fmtPct(fefoComp) + '%'],
  ].map(([l, v]) => `<div class="modal-row"><div class="rl">${l}</div><div class="rv">${v}</div></div>`).join('');

  document.getElementById('modalAnalysis').textContent =
    `Skor ${Math.round(score)}/100 adalah rata-rata sederhana (bobot sama, 1/3 masing-masing) dari tiga indikator: `
    + `Kesehatan Stok FG (${fmtPct(stockHealth)}%), SLA Loading Logistik (${fmtPct(slaVal)}%), dan Kepatuhan FEFO (${fmtPct(fefoComp)}%). `
    + (cls === 'bad' ? 'Level ini kritis — cek indikator dengan nilai terendah terlebih dahulu, biasanya itu akar masalah utama.' :
       cls === 'warn' ? 'Masih perlu perbaikan di salah satu atau lebih indikator agar skor gabungan naik ke atas 70.' :
       'Ketiga indikator utama berada dalam kondisi baik secara bersamaan.')
    + ' Klik salah satu bar di bawah kartu ini untuk melihat rincian per indikator.';

  const liveCount = ['stock','logistics','fefo'].filter(k => latestStatus[k] === 'live').length;
  document.getElementById('modalMode').textContent = `Sumber data: ${liveCount}/3 zona LIVE, sisanya simulasi (lihat status per zona di kartu masing-masing).`;

  document.getElementById('kpiModalOverlay').classList.add('open');
}

function closeKpiModal(){
  document.getElementById('kpiModalOverlay').classList.remove('open');
  activeKpiKey = null;
}

document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeKpiModal(); });

function toggleSettings(){
  const panel = document.getElementById('settingsPanel');
  // Tombol "Konfigurasi" (dan link "Upload Data via CSV" di dalam panel ini)
  // harus tetap berfungsi walau sedang berada di tab Analisis & Prediksi —
  // panel ini cuma ada di dalam #page-tower, jadi pindah ke tab itu dulu.
  if(location.hash && location.hash !== '#tower'){
    location.hash = 'tower';
    panel.classList.add('open');
    return;
  }
  panel.classList.toggle('open');
}

function scheduleTimer(){
  if(timerId) clearInterval(timerId);
  if(config.refreshInterval > 0){
    timerId = setInterval(refreshAll, config.refreshInterval);
  }
}

function applyConfigToForm(){
  document.getElementById('stock-enabled').checked = config.zones.stock.enabled;
  document.getElementById('logistics-enabled').checked = config.zones.logistics.enabled;
  document.getElementById('fefo-enabled').checked = config.zones.fefo.enabled;
  document.getElementById('warehouse-enabled').checked = config.zones.warehouse.enabled;
  document.getElementById('intervalSelect').value = String(config.refreshInterval);
}

function readConfigFromForm(){
  config.zones.stock.enabled = document.getElementById('stock-enabled').checked;
  config.zones.logistics.enabled = document.getElementById('logistics-enabled').checked;
  config.zones.fefo.enabled = document.getElementById('fefo-enabled').checked;
  config.zones.warehouse.enabled = document.getElementById('warehouse-enabled').checked;
  config.refreshInterval = parseInt(document.getElementById('intervalSelect').value, 10);
}

function saveAndApply(){
  readConfigFromForm();
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }catch(e){ console.warn('Gagal menyimpan konfigurasi ke localStorage:', e); }
  scheduleTimer();
  refreshAll();
}

function loadConfig(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const saved = JSON.parse(raw);
      config = { ...config, ...saved, zones: { ...config.zones, ...(saved.zones||{}) } };
    }
  }catch(e){ /* belum ada konfigurasi tersimpan — pakai default */ }
  applyConfigToForm();
}

document.getElementById('contractPre').textContent = JSON.stringify(DATA_CONTRACT, null, 2);

(async function init(){
  loadConfig();
  scheduleTimer();
  await refreshAll();
  const liveCount = Object.values(latestStatus).filter(s=>s==='live').length;
  if(liveCount < 4){
    document.getElementById('settingsPanel').classList.add('open');
  }
})();
