const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const { init } = require("./db");
const { DESA_KELOMPOK, DESA_BEBAS, normalisasi, desaValid, desaBebas, kelompokValid } = require("./desa");
const face = require("./face");

const app = express();
const PORT = process.env.PORT || 3000;

// Kunci akses untuk API sensitif (ganti via env KUNCI_AKSES di Render bila perlu)
const KUNCI_AKSES = process.env.KUNCI_AKSES || "mumi-bjn-2026";

function cekKunci(req, res) {
  if ((req.query.kunci || "") === KUNCI_AKSES) return true;
  res.status(401).json({ ok: false, pesan: "Kunci akses salah atau tidak ada." });
  return false;
}

app.use(cors());
app.use(express.json({ limit: "8mb" }));

let db;
let DB_TYPE = "sqlite";

function nowID() {
  // Selalu pakai zona waktu Indonesia Barat (WIB), terlepas dari zona server
  const fmtTgl = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const fmtJam = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const d = new Date();
  return { tgl: fmtTgl.format(d), jam: fmtJam.format(d) };
}

// Toleransi telat dalam menit (default 15, bisa diubah lewat env TOLERANSI_TELAT
// atau lewat API /api/pengaturan)
let toleransiTelat = parseInt(process.env.TOLERANSI_TELAT || "15", 10);

function menitDariJam(jam) {
  // "16.05.30" -> 965 ; "16:00" -> 960
  const p = String(jam).split(".").map((x) => parseInt(x, 10));
  return (p[0] || 0) * 60 + (p[1] || 0);
}

function telatDariJadwal(jadwalRows, desa, jamMasuk) {
  const j = (jadwalRows || []).find((r) => r.desa === desa);
  if (!j || !j.jam_mulai) return false;
  return menitDariJam(jamMasuk) > menitDariJam(j.jam_mulai) + toleransiTelat;
}

// [POST] /api/absen
app.post("/api/absen", async (req, res) => {
  if (!cekKunci(req, res)) return;
  const { nama, kelompok, jenis_kelamin, desa, kode_sekolah, foto } = req.body;

  if (!kode_sekolah || kode_sekolah !== process.env.KODE_SEKOLAH) {
    return res.status(403).json({ ok: false, pesan: "Kode sekolah salah." });
  }
  if (!nama || !kelompok || !jenis_kelamin || !desa) {
    return res.status(400).json({ ok: false, pesan: "Data tidak lengkap." });
  }
  if (foto && (typeof foto !== "string" || foto.length > 4_000_000)) {
    return res.status(400).json({ ok: false, pesan: "Foto tidak valid (maks 4 MB base64)." });
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

  // Cocokkan wajah selfie dengan foto referensi (jika sudah ada)
  let cocokWajah = null;
  if (foto) {
    const ref = await db.cariFotoRef(siswaId);
    if (ref && ref.desk_ref) {
      const d = await face.deskriptorFoto(foto);
      const j = face.dist(d, JSON.parse(ref.desk_ref));
      const toleransi = parseFloat(process.env.WAJAH_TOLERANSI || "0.40");
      cocokWajah = d && j <= toleransi ? "COCOK" : "TIDAK COCOK";
    }
  }

  const { tgl, jam } = nowID();
  const sudah = await db.sudahAbsen(siswaId, tgl, jam);
  if (sudah) {
    return res.status(409).json({ ok: false, pesan: `Sudah tercatat masuk pada jam ${jam}.` });
  }

  const id = await db.insertAbsen(siswaId, nama, kelompok, jenis_kelamin, desaFinal, jam, tgl, foto || null, cocokWajah);
  const jadwal = await db.getJadwal(tgl);
  const telat = telatDariJadwal(jadwal, desaFinal, jam);
  const pesan = cocokWajah === "TIDAK COCOK"
    ? `Absen tercatat, tapi WAJAH TIDAK COCOK dengan foto profil.`
    : `Absen berhasil. Selamat datang, ${nama}!`;
  res.status(201).json({
    ok: true,
    pesan,
    cocok_wajah: cocokWajah,
    telat,
    data: { id, jam_masuk: jam, tanggal: tgl },
  });
});

// [POST] /api/siswa/foto  ->  simpan foto referensi wajah siswa
app.post("/api/siswa/foto", async (req, res) => {
  if (!cekKunci(req, res)) return;
  const { nama, kelompok, jenis_kelamin, desa, kode_sekolah, foto } = req.body;
  if (!kode_sekolah || kode_sekolah !== process.env.KODE_SEKOLAH) {
    return res.status(403).json({ ok: false, pesan: "Kode sekolah salah." });
  }
  if (!nama || !kelompok || !jenis_kelamin || !desa || !foto) {
    return res.status(400).json({ ok: false, pesan: "Data tidak lengkap." });
  }
  if (typeof foto !== "string" || foto.length > 4_000_000) {
    return res.status(400).json({ ok: false, pesan: "Foto tidak valid (maks 4 MB base64)." });
  }
  const desaFinal = desaBebas(desa) ? DESA_BEBAS : normalisasi(desa);
  const siswaId = crypto
    .createHash("sha256")
    .update(`${nama}|${kelompok}|${jenis_kelamin}|${desaFinal}`)
    .digest("hex")
    .slice(0, 16);

  const desk = await face.deskriptorFoto(foto);
  if (!desk) {
    return res.status(400).json({ ok: false, pesan: "Tidak ada wajah terdeteksi di foto. Coba lagi dengan pencahayaan baik." });
  }

  await db.saveSiswa(siswaId, nama, kelompok, jenis_kelamin);
  await db.simpanFotoRef(siswaId, foto, JSON.stringify(desk));
  res.json({ ok: true, pesan: "Foto referensi wajah tersimpan." });
});

// [GET] /api/absensi?tanggal=YYYY-MM-DD
app.get("/api/absensi", async (req, res) => {
  const tanggal = req.query.tanggal || nowID().tgl;
  const [rows, jadwal] = await Promise.all([db.listAbsensi(tanggal), db.getJadwal(tanggal)]);
  rows.forEach((r) => (r.telat = telatDariJadwal(jadwal, r.desa, r.jam_masuk)));
  res.json({ ok: true, jumlah: rows.length, data: rows });
});

// [GET] /api/statistik?tanggal=YYYY-MM-DD
app.get("/api/statistik", async (req, res) => {
  const tanggal = req.query.tanggal || nowID().tgl;
  const [s, rows, jadwal] = await Promise.all([db.statistik(tanggal), db.listAbsensi(tanggal), db.getJadwal(tanggal)]);
  const totalTelat = rows.filter((r) => telatDariJadwal(jadwal, r.desa, r.jam_masuk)).length;
  res.json({ ok: true, tanggal, total: s.total, total_telat: totalTelat, per_kelompok: s.perKelompok });
});

// [GET] /api/rekap?tanggal=YYYY-MM-DD  ->  rekap harian per desa
app.get("/api/rekap", async (req, res) => {
  const tanggal = req.query.tanggal || nowID().tgl;
  const [rows, jadwal] = await Promise.all([db.listAbsensi(tanggal), db.getJadwal(tanggal)]);
  rows.forEach((r) => (r.telat = telatDariJadwal(jadwal, r.desa, r.jam_masuk)));
  const perDesa = {};
  for (const r of rows) {
    if (!perDesa[r.desa]) perDesa[r.desa] = [];
    perDesa[r.desa].push(r);
  }
  const data = Object.keys(perDesa)
    .sort()
    .map((desa) => ({
      desa,
      total: perDesa[desa].length,
      telat: perDesa[desa].filter((r) => r.telat).length,
      per_kelompok: Object.values(
        perDesa[desa].reduce((acc, r) => {
          acc[r.kelompok] = (acc[r.kelompok] || 0) + 1;
          return acc;
        }, {})
      ).length === 0 ? [] : (() => {
        const m = {};
        for (const r of perDesa[desa]) m[r.kelompok] = (m[r.kelompok] || 0) + 1;
        return Object.entries(m).map(([kelompok, jumlah]) => ({ kelompok, jumlah }));
      })(),
      siswa: perDesa[desa].map((r) => ({
        id: r.id,
        nama: r.nama,
        kelompok: r.kelompok,
        jam_masuk: r.jam_masuk,
        foto: r.foto || null,
        cocok_wajah: r.cocok_wajah || null,
        telat: r.telat,
      })),
    }));
  res.json({ ok: true, tanggal, total: rows.length, data });
});

// [GET] /api/rekap-bulanan?bulan=YYYY-MM  ->  rekap bulanan per siswa
app.get("/api/rekap-bulanan", async (req, res) => {
  const bulan = req.query.bulan || nowID().tgl.slice(0, 7);
  const [y, m] = bulan.split("-").map(Number);
  const akhir = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dari = `${bulan}-01`;
  const sampai = `${bulan}-${String(akhir).padStart(2, "0")}`;
  const rows = await db.listAbsensiRange(dari, sampai);
  const jadwal = await db.getJadwalRange(dari, sampai);
  const perSiswa = {};
  for (const r of rows) {
    const k = `${r.nama}|${r.kelompok}|${r.desa}`;
    if (!perSiswa[k]) {
      perSiswa[k] = {
        nama: r.nama,
        kelompok: r.kelompok,
        desa: r.desa,
        hariHadir: [],
        catatan: 0,
        cocokWajah: r.cocok_wajah === "TIDAK COCOK" ? 1 : 0,
        hariTelat: new Set(),
      };
    }
    perSiswa[k].hariHadir.push(r.tanggal);
    perSiswa[k].catatan++;
    if (r.cocok_wajah === "TIDAK COCOK") perSiswa[k].cocokWajah++;
    if (telatDariJadwal(jadwal, r.desa, r.jam_masuk)) perSiswa[k].hariTelat.add(r.tanggal);
  }
  const data = Object.values(perSiswa)
    .map((s) => ({ ...s, hariHadir: [...new Set(s.hariHadir)].sort(), hariTelat: [...s.hariTelat].sort() }))
    .sort((a, b) => a.nama.localeCompare(b.nama));
  res.json({ ok: true, bulan, total_siswa: data.length, data });
});

// [POST] /api/absen-manual  ->  petugas mencatat absen tanpa foto
app.post("/api/absen-manual", async (req, res) => {
  if (!cekKunci(req, res)) return;
  const { nama, kelompok, jenis_kelamin, desa, kode_sekolah, jam_manual } = req.body;
  if (!kode_sekolah || kode_sekolah !== process.env.KODE_SEKOLAH) {
    return res.status(403).json({ ok: false, pesan: "Kode sekolah salah." });
  }
  if (!nama || !kelompok || !jenis_kelamin || !desa) {
    return res.status(400).json({ ok: false, pesan: "Data tidak lengkap." });
  }
  if (!desaValid(desa)) {
    return res.status(400).json({ ok: false, pesan: `Desa tidak dikenal: ${desa}` });
  }
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

  const { tgl } = nowID();
  const jam = jam_manual || nowID().jam;
  const sudah = await db.sudahAbsen(siswaId, tgl, jam);
  if (sudah) {
    return res.status(409).json({ ok: false, pesan: `Sudah tercatat masuk pada jam ${jam}.` });
  }

  const id = await db.insertAbsen(siswaId, nama, kelompok, jenis_kelamin, desaFinal, jam, tgl, null, null);
  res.status(201).json({
    ok: true,
    pesan: `Absen manual tercatat untuk ${nama} (jam ${jam}).`,
    data: { id, jam_masuk: jam, tanggal: tgl },
  });
});

// [GET] /api/export?dari=YYYY-MM-DD&sampai=YYYY-MM-DD  -> untuk aplikasi desktop / Excel
app.get("/api/export", async (req, res) => {
  if (!cekKunci(req, res)) return;
  const { dari, sampai } = req.query;
  if (!dari || !sampai) return res.status(400).json({ ok: false, pesan: "Butuh ?dari= & sampai=" });
  const [semua, jadwal] = await Promise.all([db.listAbsensiRange(dari, sampai), db.getJadwalRange(dari, sampai)]);
  semua.forEach((r) => (r.telat = telatDariJadwal(jadwal, r.desa, r.jam_masuk)));
  res.json({ ok: true, total: semua.length, data: semua });
});

// [POST] /api/jadwal  ->  atur jam mulai per desa per hari (jam_mulai kosong = hapus jadwal)
app.post("/api/jadwal", async (req, res) => {
  if (!cekKunci(req, res)) return;
  const { tanggal, desa, jam_mulai } = req.body;
  if (!tanggal || !desa) return res.status(400).json({ ok: false, pesan: "Butuh tanggal & desa." });
  if (!desaValid(desa)) return res.status(400).json({ ok: false, pesan: `Desa tidak dikenal: ${desa}` });
  const jam = (jam_mulai || "").trim();
  if (!jam) {
    await db.hapusJadwal(tanggal, desa);
    return res.json({ ok: true, pesan: `Jadwal ${desa} ${tanggal} dihapus.` });
  }
  if (!/^\d{1,2}[:.]\d{2}/.test(jam)) {
    return res.status(400).json({ ok: false, pesan: "Format jam salah (contoh: 16:00)." });
  }
  const [jh, jm] = jam.split(/[:.]/).map((x) => parseInt(x, 10));
  const j = String(jh).padStart(2, "0") + "." + String(jm).padStart(2, "0") + ".00";
  await db.setJadwal(tanggal, desa, j);
  res.json({ ok: true, pesan: `Jam mulai ${desa} disimpan: ${jam}.` });
});

// [GET] /api/jadwal?tanggal=YYYY-MM-DD  ->  daftar jam mulai hari itu
app.get("/api/jadwal", async (req, res) => {
  const tanggal = req.query.tanggal || nowID().tgl;
  const rows = await db.getJadwal(tanggal);
  res.json({ ok: true, tanggal, data: rows });
});

// [GET] /api/pengaturan  ->  pengaturan server (toleransi telat)
app.get("/api/pengaturan", (_req, res) => {
  res.json({ ok: true, toleransi_telat: toleransiTelat });
});

// [POST] /api/pengaturan  ->  ubah toleransi telat (0-120 menit)
app.post("/api/pengaturan", async (req, res) => {
  if (!cekKunci(req, res)) return;
  const t = parseInt(req.body.toleransi_telat, 10);
  if (isNaN(t) || t < 0 || t > 120) {
    return res.status(400).json({ ok: false, pesan: "Toleransi harus 0-120 menit." });
  }
  await db.setPengaturan("toleransi_telat", String(t));
  toleransiTelat = t;
  res.json({ ok: true, pesan: `Toleransi telat diubah menjadi ${t} menit.` });
});

// [GET] /api/desa  ->  daftar desa + kelompoknya (termasuk QR gabungan)
app.get("/api/desa", (_req, res) =>
  res.json({ ok: true, data: DESA_KELOMPOK, desa_bebas: DESA_BEBAS })
);

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true, db: DB_TYPE }));

// Info versi (untuk verifikasi build mana yang sedang live)
app.get("/api/versi", (_req, res) =>
  res.json({ ok: true, versi: "kunci-akses-v1", fitur: ["face-match", "rekap", "rekap-bulanan", "absen-manual", "kunci-akses"] })
);

// [POST] /api/pantau/kode  ->  buat/ambil kode pantau untuk siswa
app.post("/api/pantau/kode", async (req, res) => {
  if (!cekKunci(req, res)) return;
  const { kode_sekolah, nama, kelompok, jenis_kelamin, desa } = req.body;
  if (!kode_sekolah || kode_sekolah !== process.env.KODE_SEKOLAH) {
    return res.status(403).json({ ok: false, pesan: "Kode sekolah salah." });
  }
  if (!nama || !kelompok || !jenis_kelamin || !desa) {
    return res.status(400).json({ ok: false, pesan: "Data tidak lengkap." });
  }
  const desaFinal = desaBebas(desa) ? DESA_BEBAS : normalisasi(desa);
  const siswaId = crypto
    .createHash("sha256")
    .update(`${nama}|${kelompok}|${jenis_kelamin}|${desaFinal}`)
    .digest("hex")
    .slice(0, 16);

  const kode = await db.cariKodePantau(siswaId);
  const hasil = kode || (await db.simpanKodePantau(siswaId, nama));
  res.json({ ok: true, kode: hasil, link: `/pantau?kode=${hasil}` });
});

// [GET] /api/pantau/status?kode=...  ->  status kehadiran siswa hari ini
app.get("/api/pantau/status", async (req, res) => {
  const kode = (req.query.kode || "").trim();
  if (!kode) return res.status(400).json({ ok: false, pesan: "Butuh kode." });
  const siswa = await db.cariSiswaByKode(kode);
  if (!siswa) {
    return res.json({ ok: true, ditemukan: false, pesan: "Kode tidak dikenal." });
  }
  const { tgl } = nowID();
  const absen = await db.absenTerakhirSiswa(siswa.siswa_id, tgl);
  res.json({
    ok: true,
    ditemukan: true,
    nama: siswa.nama,
    tanggal: tgl,
    absen: absen
      ? {
          jam_masuk: absen.jam_masuk,
          kelompok: absen.kelompok,
          desa: absen.desa,
          foto: absen.foto || null,
        }
      : null,
  });
});

// Halaman pantau untuk orang tua
app.get("/pantau", (_req, res) => res.sendFile(path.join(__dirname, "pantau.html")));

// Halaman absen via web (untuk iPhone / HP tanpa app)
app.get("/absen", (_req, res) => res.sendFile(path.join(__dirname, "absen.html")));
app.get("/jsqr.js", (_req, res) => res.sendFile(path.join(__dirname, "jsqr.js")));

// Dashboard
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));

init()
  .then(async (instance) => {
    db = instance;
    DB_TYPE = instance.type;
    const tersimpan = await db.getPengaturan("toleransi_telat");
    if (tersimpan !== null) {
      toleransiTelat = parseInt(tersimpan, 10) || toleransiTelat;
    }
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