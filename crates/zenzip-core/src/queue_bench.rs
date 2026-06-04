//! P0.7 — SQLite WAL queue throughput benchmark.
//!
//! Simulates the hot path of the future queue engine:
//! 1. batched inserts inside transactions (producer side)
//! 2. claim-one-job + ack loop (worker side, worst case: one job per claim)
//!
//! Pragmas mirror the planned production defaults: WAL + synchronous=NORMAL.

use rusqlite::Connection;
use std::time::Instant;

pub struct QueueBenchResult {
    pub jobs: u32,
    pub insert_ms: f64,
    pub claim_ack_ms: f64,
}

pub fn run(path: &str, jobs: u32) -> Result<QueueBenchResult, rusqlite::Error> {
    let mut conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            queue TEXT NOT NULL,
            payload BLOB NOT NULL,
            status INTEGER NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0,
            lease_until INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs (queue, status, id);",
    )?;

    let payload = vec![0u8; 256];

    // Producer phase: batched inserts, 1000 per transaction.
    let insert_start = Instant::now();
    let batch: u32 = 1000;
    let mut inserted: u32 = 0;
    while inserted < jobs {
        let tx = conn.transaction()?;
        {
            let mut stmt =
                tx.prepare_cached("INSERT INTO jobs (queue, payload) VALUES ('bench', ?1)")?;
            let n = batch.min(jobs - inserted);
            for _ in 0..n {
                stmt.execute([&payload])?;
            }
            inserted += n;
        }
        tx.commit()?;
    }
    let insert_ms = insert_start.elapsed().as_secs_f64() * 1000.0;

    // Worker phase: claim one job (UPDATE ... RETURNING), then ack it.
    // Two commits per job — deliberately the worst case, no batching.
    let claim_start = Instant::now();
    let mut done: u32 = 0;
    loop {
        let claimed: Option<i64> = {
            let mut stmt = conn.prepare_cached(
                "UPDATE jobs SET status = 1, attempts = attempts + 1, lease_until = ?1
                 WHERE id = (SELECT id FROM jobs WHERE queue = 'bench' AND status = 0 ORDER BY id LIMIT 1)
                 RETURNING id",
            )?;
            let mut rows = stmt.query([0i64])?;
            match rows.next()? {
                Some(row) => Some(row.get(0)?),
                None => None,
            }
        };
        match claimed {
            Some(id) => {
                conn.prepare_cached("UPDATE jobs SET status = 2 WHERE id = ?1")?
                    .execute([id])?;
                done += 1;
            }
            None => break,
        }
    }
    let claim_ack_ms = claim_start.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(done, jobs, "claimed job count must match inserted count");

    Ok(QueueBenchResult {
        jobs,
        insert_ms,
        claim_ack_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bench_smoke() {
        let dir = std::env::temp_dir().join(format!("zenzip-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("smoke.db");
        let r = run(db.to_str().unwrap(), 500).unwrap();
        assert_eq!(r.jobs, 500);
        assert!(r.insert_ms > 0.0);
        assert!(r.claim_ack_ms > 0.0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
