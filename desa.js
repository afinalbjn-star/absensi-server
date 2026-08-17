// Data desa dan kelompoknya (sumber tunggal di server)
// QR khusus yang menerima semua desa & kelompok (untuk acara gabungan)
const DESA_BEBAS = "PENGAJIAN MUMI DAERAH";

const DESA_KELOMPOK = {
  SELATAN: [
    "KUNCI 1",
    "KUNCI 2",
    "PENGANTEN",
    "BOMO 1",
    "BOMO 2",
    "GEGER",
    "PACING 1",
    "PACING 2",
    "PACING 3",
  ],
  TIMUR: [
    "TA BARAT",
    "TA TENGAH",
    "TA TIMUR",
    "KALIPAN",
    "TA 5",
    "TA 6",
    "TA 7",
    "JATICILIK",
  ],
  DAMPET: [
    "DAMPET 1",
    "DAMPET 2",
    "DAMPET 3",
    "BALONGREJO",
    "NGUJUNG",
    "KALICILIK",
  ],
  BAURENO: [
    "SUMBEREJO",
    "BAURENO",
    "SUGIHWARAS",
    "SUMBERAGUNG",
    "KRANGKONG",
    "PEJOK",
  ],
};

// Normalisasi: nama desa tidak peka huruf besar/kecil & spasi
function normalisasi(s) {
  return String(s || "").trim().toUpperCase();
}

function desaValid(desa) {
  return (
    Object.prototype.hasOwnProperty.call(DESA_KELOMPOK, normalisasi(desa)) ||
    normalisasi(desa) === DESA_BEBAS
  );
}

function desaBebas(desa) {
  return normalisasi(desa) === DESA_BEBAS;
}

function kelompokValid(desa, kelompok) {
  const kunci = normalisasi(desa);
  if (kunci === DESA_BEBAS) return true; // QR gabungan: semua kelompok diterima
  const daftar = DESA_KELOMPOK[kunci];
  if (!daftar) return false;
  return daftar.some((k) => normalisasi(k) === normalisasi(kelompok));
}

module.exports = { DESA_KELOMPOK, DESA_BEBAS, normalisasi, desaValid, desaBebas, kelompokValid };