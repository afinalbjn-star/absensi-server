const path = require("path");

const USE_POSTGRES = !!process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Lapisan akses data. Mendukung Postgres (cloud) atau SQLite (lokal).
// ---------------------------------------------------------------------------

async function init() {
  if (USE_POSTGRES) {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS siswa (
        id            TEXT PRIMARY KEY,
        nama          TEXT NOT NULL,
        kelompok      TEXT NOT NULL,
        jenis_kelamin TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS absensi (
        id            SERIAL PRIMARY KEY,
        siswa_id      TEXT NOT NULL,
        nama          TEXT NOT NULL,
        kelompok      TEXT NOT NULL,
        jenis_kelamin TEXT NOT NULL,
        desa          TEXT NOT NULL,
        jam_masuk     TEXT NOT NULL,
        tanggal       TEXT NOT NULL
      );
    `);
    return {
      type: "postgres",
      saveSiswa(id, nama, kelompok, jk) {
        return pool.query(
          `INSERT INTO siswa (id, nama, kelompok, jenis_kelamin) VALUES ($1,$2,$3,$4)
           ON CONFLICT (id) DO UPDATE SET nama=$2, kelompok=$3, jenis_kelamin=$4`,
          [id, nama, kelompok, jk]
        );
      },
      sudahAbsen(siswaId, tgl, jam) {
        return pool
          .query(
            `SELECT id FROM absensi
             WHERE siswa_id=$1 AND tanggal=$2 AND substr(jam_masuk,1,5)=substr($3,1,5)`,
            [siswaId, tgl, jam]
          )
          .then((r) => r.rows[0]);
      },
      insertAbsen(siswaId, nama, kelompok, jk, desa, jam, tgl) {
        return pool
          .query(
            `INSERT INTO absensi (siswa_id, nama, kelompok, jenis_kelamin, desa, jam_masuk, tanggal)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [siswaId, nama, kelompok, jk, desa, jam, tgl]
          )
          .then((r) => r.rows[0].id);
      },
      listAbsensi(tgl) {
        return pool
          .query(`SELECT * FROM absensi WHERE tanggal=$1 ORDER BY id DESC`, [tgl])
          .then((r) => r.rows);
      },
      listAbsensiRange(dari, sampai) {
        return pool
          .query(
            `SELECT * FROM absensi WHERE tanggal BETWEEN $1 AND $2 ORDER BY tanggal ASC, id ASC`,
            [dari, sampai]
          )
          .then((r) => r.rows);
      },
      statistik(tgl) {
        return Promise.all([
          pool.query(`SELECT COUNT(*)::int AS c FROM absensi WHERE tanggal=$1`, [tgl]),
          pool.query(
            `SELECT kelompok, COUNT(*)::int AS jumlah FROM absensi WHERE tanggal=$1 GROUP BY kelompok`,
            [tgl]
          ),
        ]).then(([t, k]) => ({ total: t.rows[0].c, perKelompok: k.rows }));
      },
    };
  }

  // ------- SQLite (lokal) -------
  const Database = require("better-sqlite3");
  const db = new Database(path.join(__dirname, "data", "absensi.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS siswa (
      id            TEXT PRIMARY KEY,
      nama          TEXT NOT NULL,
      kelompok      TEXT NOT NULL,
      jenis_kelamin TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS absensi (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      siswa_id      TEXT NOT NULL,
      nama          TEXT NOT NULL,
      kelompok      TEXT NOT NULL,
      jenis_kelamin TEXT NOT NULL,
      desa          TEXT NOT NULL,
      jam_masuk     TEXT NOT NULL,
      tanggal       TEXT NOT NULL
    );
  `);
  return {
    type: "sqlite",
    saveSiswa(id, nama, kelompok, jk) {
      return Promise.resolve(
        db
          .prepare(
            `INSERT INTO siswa (id, nama, kelompok, jenis_kelamin) VALUES (?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET nama=excluded.nama, kelompok=excluded.kelompok, jenis_kelamin=excluded.jenis_kelamin`
          )
          .run(id, nama, kelompok, jk)
      );
    },
    sudahAbsen(siswaId, tgl, jam) {
      return Promise.resolve(
        db
          .prepare(
            `SELECT id FROM absensi WHERE siswa_id=? AND tanggal=? AND substr(jam_masuk,1,5)=substr(?,1,5)`
          )
          .get(siswaId, tgl, jam)
      );
    },
    insertAbsen(siswaId, nama, kelompok, jk, desa, jam, tgl) {
      return Promise.resolve(
        db
          .prepare(
            `INSERT INTO absensi (siswa_id, nama, kelompok, jenis_kelamin, desa, jam_masuk, tanggal)
             VALUES (?,?,?,?,?,?,?)`
          )
          .run(siswaId, nama, kelompok, jk, desa, jam, tgl).lastInsertRowid
      );
    },
    listAbsensi(tgl) {
      return Promise.resolve(
        db.prepare(`SELECT * FROM absensi WHERE tanggal=? ORDER BY id DESC`).all(tgl)
      );
    },
    listAbsensiRange(dari, sampai) {
      return Promise.resolve(
        db
          .prepare(`SELECT * FROM absensi WHERE tanggal BETWEEN ? AND ? ORDER BY tanggal ASC, id ASC`)
          .all(dari, sampai)
      );
    },
    statistik(tgl) {
      return Promise.resolve({
        total: db.prepare(`SELECT COUNT(*) AS c FROM absensi WHERE tanggal=?`).get(tgl).c,
        perKelompok: db.prepare(`SELECT kelompok, COUNT(*) AS jumlah FROM absensi WHERE tanggal=? GROUP BY kelompok`).all(tgl),
      });
    },
  };
}

module.exports = { init };