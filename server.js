const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const { init } = require("./db");
const { DESA_KELOMPOK, DESA_BEBAS, normalisasi, desaValid, desaBebas, kelompokValid } = require("./desa");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let db;
let DB_TYPE = "sqlite";

function nowID() {
  const d = new Date();
  const tgl = d.toLocaleDateString("en-CA");
  const jam = d.toLocaleTimeString("id-ID", { hour12: false });
  return { tgl, jam };
}

// [POST] /api/absen
app.post("/api/absen", async (req, res) => {
  const { nama, kelompok, jenis_kelamin, desa, kode_sekolah } = req.body;

  if (!kode_sekolah || kode_sekolah !== process.env.KODE_SEKOLAH) {
    return res.status(403).json({ ok: false, pesan: "Kode sekolah salah." });
  }
  if (!nama || !kelompok || !jenis_kelamin || !desa) {
    return res.status(400).json({ ok: false, pesan: "Data tidak lengkap." });
  }
  if (!desaValid(desa)) {
    return res.status(400).json({ ok: false, pesan: `Desa tidak dikenal: ${desa}` });
  }
  // QR gabungan (PENGAJIAN MUMI DAERAH) menerima semua desa & kelompok
  if (!desaBebas(desa) && !kelompokValid(desa, kelompok)) {
    return res.status(400).json({
      ok: false,
      pesan: `Kelompok "${kelompok}" tidak terdaftar di desa ${normalisasi(desa)}.`,
    });
  }

  const desaFinal = desaBebas(desa) ? DESA_BEBAS : normalisasi(desa);

  const siswaId = crypto
    .createHash("sha256")
    .update(`${nama}|${kelompok}|${jenis_kelamin}|${desaFinal}`)
    .digest("hex")
    .slice(0, 16);

  await db.saveSiswa(siswaId, nama, kelompok, jenis_kelamin);

  const { tgl, jam } = nowID();
  const sudah = await db.sudahAbsen(siswaId, tgl, jam);
  if (sudah) {
    return res.status(409).json({ ok: false, pesan: `Sudah tercatat masuk pada jam ${jam}.` });
  }

  const id = await db.insertAbsen(siswaId, nama, kelompok, jenis_kelamin, desaFinal, jam, tgl);
  res.status(201).json({
    ok: true,
    pesan: `Absen berhasil. Selamat datang, ${nama}!`,
    data: { id, jam_masuk: jam, tanggal: tgl },
  });
});

// [GET] /api/absensi?tanggal=YYYY-MM-DD
app.get("/api/absensi", async (req, res) => {
  const tanggal = req.query.tanggal || nowID().tgl;
  const rows = await db.listAbsensi(tanggal);
  res.json({ ok: true, jumlah: rows.length, data: rows });
});

// [GET] /api/statistik?tanggal=YYYY-MM-DD
app.get("/api/statistik", async (req, res) => {
  const tanggal = req.query.tanggal || nowID().tgl;
  const s = await db.statistik(tanggal);
  res.json({ ok: true, tanggal, total: s.total, per_kelompok: s.perKelompok });
});

// [GET] /api/export?dari=YYYY-MM-DD&sampai=YYYY-MM-DD  -> untuk aplikasi desktop / Excel
app.get("/api/export", async (req, res) => {
  const { dari, sampai } = req.query;
  if (!dari || !sampai) return res.status(400).json({ ok: false, pesan: "Butuh ?dari= & sampai=" });
  const semua = await db.listAbsensiRange(dari, sampai);
  res.json({ ok: true, total: semua.length, data: semua });
});

// [GET] /api/desa  ->  daftar desa + kelompoknya (termasuk QR gabungan)
app.get("/api/desa", (_req, res) =>
  res.json({ ok: true, data: DESA_KELOMPOK, desa_bebas: DESA_BEBAS })
);

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true, db: DB_TYPE }));

// Dashboard
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));

init()
  .then((instance) => {
    db = instance;
    DB_TYPE = instance.type;
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server absensi berjalan (db: ${DB_TYPE})`);
      console.log(`Buka dashboard: http://localhost:${PORT}`);
      console.log(process.env.DATABASE_URL ? "Mode: CLOUD (Postgres)" : "Mode: LOKAL (SQLite)");
    });
  })
  .catch((e) => {
    console.error("Gagal inisialisasi database:", e.message);
    process.exit(1);
  });