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
  const t = faceapi.tf.tensor3d(new Uint8Array(img.data), [img.height, img.width, 4]);
  const rgb = t.slice([0, 0, 0], [img.height, img.width, 3]);
  t.dispose();
  return rgb;
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
