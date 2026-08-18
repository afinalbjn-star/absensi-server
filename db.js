const path = require("path");
const crypto = require("crypto");

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
        jenis_kelamin TEXT NOT NULL,
        foto_ref      TEXT,
        desk_ref      TEXT
      );
      CREATE TABLE IF NOT EXISTS absensi (
        id            SERIAL PRIMARY KEY,
        siswa_id      TEXT NOT NULL,
        nama          TEXT NOT NULL,
        kelompok      TEXT NOT NULL,
        jenis_kelamin TEXT NOT NULL,
        desa          TEXT NOT NULL,
        jam_masuk     TEXT NOT NULL,
        tanggal       TEXT NOT NULL,
        foto          TEXT,
        cocok_wajah   TEXT
      );
      ALTER TABLE absensi ADD COLUMN IF NOT EXISTS foto TEXT;
      ALTER TABLE absensi ADD COLUMN IF NOT EXISTS cocok_wajah TEXT;
      ALTER TABLE siswa ADD COLUMN IF NOT EXISTS foto_ref TEXT;
      ALTER TABLE siswa ADD COLUMN IF NOT EXISTS desk_ref TEXT;
      CREATE TABLE IF NOT EXISTS pantau (
        kode      TEXT PRIMARY KEY,
        siswa_id  TEXT NOT NULL UNIQUE,
        nama      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jadwal (
        tanggal   TEXT NOT NULL,
        desa      TEXT NOT NULL,
        jam_mulai TEXT NOT NULL,
        PRIMARY KEY (tanggal, desa)
      );
      CREATE TABLE IF NOT EXISTS pengaturan (
        kunci TEXT PRIMARY KEY,
        nilai TEXT NOT NULL
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
      simpanFotoRef(id, fotoRef, deskRef) {
        return pool.query(
          `UPDATE siswa SET foto_ref=$2, desk_ref=$3 WHERE id=$1`,
          [id, fotoRef, deskRef]
        );
      },
      cariFotoRef(id) {
        return pool
          .query(`SELECT foto_ref, desk_ref FROM siswa WHERE id=$1`, [id])
          .then((r) => r.rows[0] || null);
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
      insertAbsen(siswaId, nama, kelompok, jk, desa, jam, tgl, foto, cocokWajah) {
        return pool
          .query(
            `INSERT INTO absensi (siswa_id, nama, kelompok, jenis_kelamin, desa, jam_masuk, tanggal, foto, cocok_wajah)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [siswaId, nama, kelompok, jk, desa, jam, tgl, foto, cocokWajah]
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
      cariKodePantau(siswaId) {
        return pool
          .query(`SELECT kode FROM pantau WHERE siswa_id=$1`, [siswaId])
          .then((r) => (r.rows[0] ? r.rows[0].kode : null));
      },
      simpanKodePantau(siswaId, nama) {
        return pool
          .query(
            `INSERT INTO pantau (kode, siswa_id, nama) VALUES ($1,$2,$3)
             ON CONFLICT (siswa_id) DO UPDATE SET nama=$3 RETURNING kode`,
            [crypto.randomBytes(6).toString("hex"), siswaId, nama]
          )
          .then((r) => r.rows[0].kode);
      },
      cariSiswaByKode(kode) {
        return pool
          .query(`SELECT siswa_id, nama FROM pantau WHERE kode=$1`, [kode])
          .then((r) => r.rows[0] || null);
      },
      absenTerakhirSiswa(siswaId, tgl) {
        return pool
          .query(`SELECT * FROM absensi WHERE siswa_id=$1 AND tanggal=$2 ORDER BY id DESC LIMIT 1`, [siswaId, tgl])
          .then((r) => r.rows[0] || null);
      },
      setJadwal(tanggal, desa, jamMulai) {
        return pool.query(
          `INSERT INTO jadwal (tanggal, desa, jam_mulai) VALUES ($1,$2,$3)
           ON CONFLICT (tanggal, desa) DO UPDATE SET jam_mulai=$3`,
          [tanggal, desa, jamMulai]
        );
      },
      hapusJadwal(tanggal, desa) {
        return pool.query(`DELETE FROM jadwal WHERE tanggal=$1 AND desa=$2`, [tanggal, desa]);
      },
      getJadwal(tgl) {
        return pool
          .query(`SELECT desa, jam_mulai FROM jadwal WHERE tanggal=$1`, [tgl])
          .then((r) => r.rows);
      },
      getJadwalRange(dari, sampai) {
        return pool
          .query(`SELECT tanggal, desa, jam_mulai FROM jadwal WHERE tanggal BETWEEN $1 AND $2`, [dari, sampai])
          .then((r) => r.rows);
      },
      getPengaturan(kunci) {
        return pool
          .query(`SELECT nilai FROM pengaturan WHERE kunci=$1`, [kunci])
          .then((r) => (r.rows[0] ? r.rows[0].nilai : null));
      },
      setPengaturan(kunci, nilai) {
        return pool.query(
          `INSERT INTO pengaturan (kunci, nilai) VALUES ($1,$2)
           ON CONFLICT (kunci) DO UPDATE SET nilai=$2`,
          [kunci, nilai]
        );
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
      jenis_kelamin TEXT NOT NULL,
      foto_ref      TEXT,
      desk_ref      TEXT
    );
    CREATE TABLE IF NOT EXISTS absensi (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      siswa_id      TEXT NOT NULL,
      nama          TEXT NOT NULL,
      kelompok      TEXT NOT NULL,
      jenis_kelamin TEXT NOT NULL,
      desa          TEXT NOT NULL,
      jam_masuk     TEXT NOT NULL,
      tanggal       TEXT NOT NULL,
      foto          TEXT,
      cocok_wajah   TEXT
    );
  `);
  // Migrasi: tambahkan kolom foto jika tabel absensi lama belum memilikinya
  const absenCols = db.prepare(`PRAGMA table_info(absensi)`).all().map((c) => c.name);
  if (!absenCols.includes("foto")) {
    db.exec(`ALTER TABLE absensi ADD COLUMN foto TEXT`);
  }
  if (!absenCols.includes("cocok_wajah")) {
    db.exec(`ALTER TABLE absensi ADD COLUMN cocok_wajah TEXT`);
  }
  const siswaCols = db.prepare(`PRAGMA table_info(siswa)`).all().map((c) => c.name);
  if (!siswaCols.includes("foto_ref")) {
    db.exec(`ALTER TABLE siswa ADD COLUMN foto_ref TEXT`);
  }
  if (!siswaCols.includes("desk_ref")) {
    db.exec(`ALTER TABLE siswa ADD COLUMN desk_ref TEXT`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS pantau (
      kode      TEXT PRIMARY KEY,
      siswa_id  TEXT NOT NULL UNIQUE,
      nama      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jadwal (
      tanggal   TEXT NOT NULL,
      desa      TEXT NOT NULL,
      jam_mulai TEXT NOT NULL,
      PRIMARY KEY (tanggal, desa)
    );
    CREATE TABLE IF NOT EXISTS pengaturan (
      kunci TEXT PRIMARY KEY,
      nilai TEXT NOT NULL
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
    simpanFotoRef(id, fotoRef, deskRef) {
      return Promise.resolve(
        db.prepare(`UPDATE siswa SET foto_ref=?, desk_ref=? WHERE id=?`).run(fotoRef, deskRef, id)
      );
    },
    cariFotoRef(id) {
      return Promise.resolve(db.prepare(`SELECT foto_ref, desk_ref FROM siswa WHERE id=?`).get(id) || null);
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
    insertAbsen(siswaId, nama, kelompok, jk, desa, jam, tgl, foto, cocokWajah) {
      return Promise.resolve(
        db
          .prepare(
            `INSERT INTO absensi (siswa_id, nama, kelompok, jenis_kelamin, desa, jam_masuk, tanggal, foto, cocok_wajah)
             VALUES (?,?,?,?,?,?,?,?,?)`
          )
          .run(siswaId, nama, kelompok, jk, desa, jam, tgl, foto, cocokWajah).lastInsertRowid
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
    cariKodePantau(siswaId) {
      const r = db.prepare(`SELECT kode FROM pantau WHERE siswa_id=?`).get(siswaId);
      return Promise.resolve(r ? r.kode : null);
    },
    simpanKodePantau(siswaId, nama) {
      const r = db
        .prepare(
          `INSERT INTO pantau (kode, siswa_id, nama) VALUES (?,?,?)
           ON CONFLICT(siswa_id) DO UPDATE SET nama=excluded.nama`
        )
        .run(crypto.randomBytes(6).toString("hex"), siswaId, nama);
      return Promise.resolve(db.prepare(`SELECT kode FROM pantau WHERE siswa_id=?`).get(siswaId).kode);
    },
    cariSiswaByKode(kode) {
      return Promise.resolve(db.prepare(`SELECT siswa_id, nama FROM pantau WHERE kode=?`).get(kode) || null);
    },
    absenTerakhirSiswa(siswaId, tgl) {
      return Promise.resolve(
        db.prepare(`SELECT * FROM absensi WHERE siswa_id=? AND tanggal=? ORDER BY id DESC LIMIT 1`).get(siswaId, tgl) || null
      );
    },
    setJadwal(tanggal, desa, jamMulai) {
      return Promise.resolve(
        db
          .prepare(
            `INSERT INTO jadwal (tanggal, desa, jam_mulai) VALUES (?,?,?)
             ON CONFLICT(tanggal, desa) DO UPDATE SET jam_mulai=excluded.jam_mulai`
          )
          .run(tanggal, desa, jamMulai)
      );
    },
    hapusJadwal(tanggal, desa) {
      return Promise.resolve(
        db.prepare(`DELETE FROM jadwal WHERE tanggal=? AND desa=?`).run(tanggal, desa)
      );
    },
    getJadwal(tgl) {
      return Promise.resolve(db.prepare(`SELECT desa, jam_mulai FROM jadwal WHERE tanggal=?`).all(tgl));
    },
    getJadwalRange(dari, sampai) {
      return Promise.resolve(
        db.prepare(`SELECT tanggal, desa, jam_mulai FROM jadwal WHERE tanggal BETWEEN ? AND ?`).all(dari, sampai)
      );
    },
    getPengaturan(kunci) {
      const r = db.prepare(`SELECT nilai FROM pengaturan WHERE kunci=?`).get(kunci);
      return Promise.resolve(r ? r.nilai : null);
    },
    setPengaturan(kunci, nilai) {
      return Promise.resolve(
        db
          .prepare(
            `INSERT INTO pengaturan (kunci, nilai) VALUES (?,?)
             ON CONFLICT(kunci) DO UPDATE SET nilai=excluded.nilai`
          )
          .run(kunci, nilai)
      );
    },
  };
}

module.exports = { init };