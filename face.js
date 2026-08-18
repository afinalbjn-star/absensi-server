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
    _net = new faceapi.TinyFaceDetector();
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

/// Potong area wajah (dengan margin) dari tensor, kembalikan { crop, boxWajah }
/// boxWajah = box yang sudah diterjemahkan ke koordinat hasil potongan.
function potongKeWajah(t, box) {
  const [h, w] = t.shape;
  const x1 = Math.max(0, Math.floor(box.x));
  const y1 = Math.max(0, Math.floor(box.y));
  const x2 = Math.min(w, Math.ceil(box.x + box.width));
  const y2 = Math.min(h, Math.ceil(box.y + box.height));
  const m = Math.round(Math.max(x2 - x1, y2 - y1) * 0.3); // margin 30%
  const cx1 = Math.max(0, x1 - m);
  const cy1 = Math.max(0, y1 - m);
  const cx2 = Math.min(w, x2 + m);
  const cy2 = Math.min(h, y2 + m);
  let crop = t.slice([cy1, cx1, 0], [cy2 - cy1, cx2 - cx1, 3]);
  // Perbesar hasil potongan ke ~400px agar wajah besar (simulasi selfie)
  const skala = 400 / Math.max(cy2 - cy1, cx2 - cx1);
  if (skala < 1) {
    const nw = Math.max(1, Math.round((cx2 - cx1) * skala));
    const nh = Math.max(1, Math.round((cy2 - cy1) * skala));
    const resized = faceapi.tf.image.resizeBilinear(crop, [nh, nw]);
    crop.dispose();
    crop = resized;
  }
  const fx = box.x - cx1;
  const fy = box.y - cy1;
  return {
    crop,
    boxWajah: new faceapi.Box({ x: fx, y: fy, width: box.width, height: box.height }, { width: crop.shape[1], height: crop.shape[0] }),
  };
}

/// Ambil deskriptor wajah (Array 128 angka) dari base64 foto JPEG. null jika tak ada wajah.
async function deskriptorFoto(base64) {
  if (!base64) return null;
  try {
    await siapkan();
    // startScope/endScope membuang otomatis semua tensor perantara -> mencegah
    // kebocoran memori WASM yang bisa menjatuhkan Render free (512MB).
    const engine = faceapi.tf.engine();
    engine.startScope();
    try {
      const t = decodeToTensor(base64);
      // Coba ukuran kecil (hemat memori); naikkan ke 416 bila wajah tak terdeteksi
      let boxes = await _net.locateFaces(t, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.3 }));
      if (!boxes.length) {
        boxes = await _net.locateFaces(t, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 }));
      }
      if (!boxes.length) return null;
      // Potong area wajah + margin lalu perbesar ke ~400px (seperti selfie)
      // agar deskriptor lebih andal untuk membedakan orang.
      const { crop, boxWajah } = potongKeWajah(t, boxes[0].box);
      const d = await _rec.computeFaceDescriptor(crop, boxWajah);
      const out = Array.from(d);
      if (d.dispose) d.dispose();
      crop.dispose();
      return out;
    } finally {
      engine.endScope();
      if (global.gc) global.gc(); // lepas memori ke OS bila dijalankan dengan --expose-gc
    }
  } catch (e) {
    console.error("[face] gagal hitung deskriptor:", e.message);
    return null;
  }
}

module.exports = { siapkan, deskriptorFoto, dist };
