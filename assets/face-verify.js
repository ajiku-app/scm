// assets/face-verify.js
//
// Fungsi bersama untuk login.html dan enroll.html: memuat model face-api.js
// dan mengambil "descriptor" (128 angka) dari wajah yang tertangkap kamera.
// Model dan library dimuat dari CDN publik (bukan bagian dari repo ini) —
// lihat MODEL_URL di bawah. Ini HARUS memakai model yang SAMA dengan yang
// dipakai saat pendaftaran wajah pertama kali di sistem presensi (face-api.js
// faceRecognitionNet, 128 dimensi), karena verify-face membandingkan angka
// mentahnya (Euclidean distance), bukan gambar wajahnya.
//
// Kamera hanya bisa diakses lewat HTTPS atau localhost (batasan browser),
// jadi ini tidak akan berfungsi kalau dashboard dibuka lewat http:// biasa
// di luar localhost.

window.SCM_FACE = (function () {
  var MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights';
  var modelsReady = null;

  function loadModels() {
    if (modelsReady) return modelsReady;
    modelsReady = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL),
    ]);
    return modelsReady;
  }

  async function startCamera(videoEl) {
    var stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 } },
      audio: false,
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    return stream;
  }

  function stopCamera(stream) {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
  }

  // Mengambil descriptor dari frame video saat ini. Melempar Error dengan
  // pesan berbahasa Indonesia yang siap ditampilkan bila wajah tidak terdeteksi.
  async function captureDescriptor(videoEl) {
    await loadModels();
    var opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
    var det = await faceapi.detectSingleFace(videoEl, opts).withFaceLandmarks().withFaceDescriptor();
    if (!det) throw new Error('Wajah tidak terdeteksi. Pastikan wajah terlihat jelas dan pencahayaan cukup, lalu coba lagi.');
    return Array.from(det.descriptor);
  }

  // Sama seperti captureDescriptor, tapi sekaligus membaca ekspresi wajah
  // (faceExpressionNet) dari frame yang sama — jadi kamera cuma perlu
  // menangkap gambar sekali saja untuk verifikasi + baca ekspresi.
  // Mengembalikan { descriptor, expressions } di mana expressions berisi
  // skor 0-1 untuk: neutral, happy, sad, angry, fearful, disgusted, surprised.
  async function captureDescriptorAndExpressions(videoEl) {
    await loadModels();
    var opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
    var det = await faceapi
      .detectSingleFace(videoEl, opts)
      .withFaceLandmarks()
      .withFaceDescriptor()
      .withFaceExpressions();
    if (!det) throw new Error('Wajah tidak terdeteksi. Pastikan wajah terlihat jelas dan pencahayaan cukup, lalu coba lagi.');
    return { descriptor: Array.from(det.descriptor), expressions: det.expressions };
  }

  var EXPR_LABEL = {
    neutral: 'Netral', happy: 'Bahagia', sad: 'Sedih', angry: 'Marah',
    fearful: 'Cemas/takut', disgusted: 'Tidak nyaman', surprised: 'Terkejut',
  };

  // Ringkasan sederhana dari skor ekspresi mentah face-api.js: ekspresi paling
  // dominan + persentasenya, plus indikasi stres berbasis heuristik (jumlah
  // skor angry+fearful+sad+disgusted vs happy+neutral+surprised). Ini BUKAN
  // pengukuran klinis, hanya perkiraan kasar dari model deteksi ekspresi umum.
  function summarizeExpression(expressions) {
    var best = 'neutral', bestScore = -1;
    var stressScore = 0, calmScore = 0;
    Object.keys(EXPR_LABEL).forEach(function (key) {
      var v = expressions[key] || 0;
      if (v > bestScore) { bestScore = v; best = key; }
      if (key === 'angry' || key === 'fearful' || key === 'sad' || key === 'disgusted') stressScore += v;
      else calmScore += v;
    });
    return {
      label: EXPR_LABEL[best],
      key: best,
      percent: Math.round(bestScore * 100),
      indikasiStres: stressScore > calmScore,
    };
  }

  return {
    loadModels: loadModels,
    startCamera: startCamera,
    stopCamera: stopCamera,
    captureDescriptor: captureDescriptor,
    captureDescriptorAndExpressions: captureDescriptorAndExpressions,
    summarizeExpression: summarizeExpression,
  };
})();
