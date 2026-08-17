require("@tensorflow/tfjs-backend-wasm");
const faceapi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
const jpeg = require("jpeg-js");
const path = require("path");

// ---------------------------------------------------------------------------
// Deteksi & pembandingan wajah memakai face-api (SSD MobileNet + RecognitionNet)
// berjalan murni WASM -> tidak butuh library native, aman di Render free.
// Model dimuat lazy (sekali saja), lalu deskriptor 128-angka dihitung.
// ---------------------------------------------------------------------------

const WASM_DIR = path.join(__dirname, "node_modules", "@tensorflow", "tfjs-backend-wasm", "dist");
const MODEL_DIR = path.join(__dirname, "node_modules", "@vladmandic", "face-api", "model");

let _net = null;
let _rec = null;
let _ready = null;

function dist(a, b) {
  if (!a || !b || a.length !== b.length) return 9999;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) * (a[i] - b[i]);
  return Math.sqrt(s);
}

async function siapkan() {
  if (_ready) return _ready;
  _ready = (async () => {
    await faceapi.tf.setWasmPaths(WASM_DIR + path.sep);
    await faceapi.tf.ready();
    _net = new faceapi.SsdMobilenetv1({ size: 256 });
    _rec = new faceapi.FaceRecognitionNet();
    await _net.loadFromDisk(MODEL_DIR);
    await _rec.loadFromDisk(MODEL_DIR);
    console.log("[face] model siap (backend:", faceapi.tf.getBackend() + ")");
  })();
  return _ready;
}

function decodeToTensor(base64) {
  const buf = Buffer.from(base64, "base64");
  const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
  const { width, height } = img;
  // Kecilkan gambar agar tidak membebani memori/CPU (penting di Render free 512MB).
  const maks = 400;
  const skala = Math.min(1, maks / Math.max(width, height));
  const w = Math.max(1, Math.round(width * skala));
  const h = Math.max(1, Math.round(height * skala));
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(x / skala));
      const sy = Math.min(height - 1, Math.floor(y / skala));
      const si = (sy * width + sx) * 4;
      const di = (y * w + x) * 3;
      data[di] = img.data[si];
      data[di + 1] = img.data[si + 1];
      data[di + 2] = img.data[si + 2];
    }
  }
  const t = faceapi.tf.tensor3d(data, [h, w, 3]);
  return t;
}

/// Ambil deskriptor wajah (Array 128 angka) dari base64 foto JPEG. null jika tak ada wajah.
async function deskriptorFoto(base64) {
  if (!base64) return null;
  try {
    await siapkan();
    const t = decodeToTensor(base64);
    try {
      const boxes = await _net.locateFaces(t, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.2 }));
      if (!boxes.length) return null;
      const d = await _rec.computeFaceDescriptor(t, boxes[0]);
      return Array.from(d);
    } finally {
      t.dispose();
    }
  } catch (e) {
    console.error("[face] gagal hitung deskriptor:", e.message);
    return null;
  }
}

module.exports = { siapkan, deskriptorFoto, dist };
