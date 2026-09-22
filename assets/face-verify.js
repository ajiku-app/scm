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

  return { loadModels: loadModels, startCamera: startCamera, stopCamera: stopCamera, captureDescriptor: captureDescriptor };
})();
