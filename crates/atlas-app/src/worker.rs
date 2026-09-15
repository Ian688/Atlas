use atlas_contract::{LanguageFacts, ParseRequest};
use std::{io, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::watch,
};

/// The runtime's own complaints are a different budget from the response, and
/// far smaller: a Node warning must not be read as "the answer was too large".
const STDERR_LIMIT: usize = 64 * 1024;

/// Read at most `limit` bytes, and fail with `overrun` when the bound is hit.
///
/// Both readers share this helper but not the label: which ceiling was reached
/// is the part a reader has to act on.
async fn bounded(
    mut reader: impl AsyncRead + Unpin,
    limit: usize,
    overrun: &str,
) -> io::Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = reader.read(&mut buffer).await?;
        if n == 0 {
            return Ok(result);
        }
        if result.len() + n > limit {
            return Err(io::Error::other(overrun.to_string()));
        }
        result.extend_from_slice(&buffer[..n]);
    }
}

async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            // A closed sender cannot change a false token into cancellation.
            std::future::pending::<()>().await;
        }
    }
}

/// Heap ceiling for the language worker, in MiB.
///
/// The worker holds the whole parsed program and the flow IR for every
/// function, so its memory scales with the project. A fixed 512 MiB cap turned
/// a large project into an opaque `worker_exit_failed`; the limit is now a
/// parameter, and hitting it is reported as its own failure with the ceiling
/// that was reached.
///
/// `output_limit` bounds that same response in bytes for the same reason: the
/// facts for one project are a single JSON document holding every symbol, call
/// and flow, so what one project needs is a property of the project, not a
/// constant Atlas can pick. The failure names the ceiling reached and the flag
/// that raises it.
pub async fn parse(
    node: &Path,
    worker: &Path,
    request: &ParseRequest,
    deadline: Duration,
    output_limit: usize,
    heap_mb: u32,
    mut cancel: watch::Receiver<bool>,
) -> Result<LanguageFacts, String> {
    if *cancel.borrow() {
        return Err("cancelled_by_signal".into());
    }
    let bytes = serde_json::to_vec(request).map_err(|_| "worker_request_encoding")?;
    if bytes.len() > 160 * 1024 * 1024 {
        return Err("worker_input_limit".into());
    }
    let worker = worker.canonicalize().map_err(|_| "worker_missing")?;
    let mut command = Command::new(node);
    command
        .arg(format!("--max-old-space-size={}", heap_mb.max(16)))
        .arg(&worker)
        .current_dir(worker.parent().unwrap())
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if *cancel.borrow() {
        return Err("cancelled_by_signal".into());
    }
    let mut child = command.spawn().map_err(|_| "worker_spawn_failed")?;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    // The response ceiling is a bound Atlas chose and the operator can raise, so
    // the failure names both the ceiling and the flag that raises it. A bare
    // `worker_output_limit` left the reader with a real project, no number, and
    // nothing to change -- the same dead end a fixed heap cap used to be.
    let output_overrun = format!(
        "worker_output_limit:limit_mb={}:raise --worker-output-mb",
        output_limit / (1024 * 1024)
    );
    let stderr_overrun = format!("worker_stderr_limit:limit_bytes={STDERR_LIMIT}");
    let result = {
        let write = async {
            stdin.write_all(&bytes).await?;
            stdin.shutdown().await?;
            drop(stdin);
            Ok::<_, io::Error>(())
        };
        let worker_io = async {
            let (_, stdout, stderr) = tokio::try_join!(
                write,
                bounded(stdout, output_limit, &output_overrun),
                bounded(stderr, STDERR_LIMIT, &stderr_overrun)
            )?;
            let status = child.wait().await?;
            if !status.success() {
                return Err(io::Error::other(classify_exit(&stderr, heap_mb)));
            }
            Ok::<_, io::Error>(stdout)
        };
        tokio::select! {
            biased;
            () = cancelled(&mut cancel) => Err("cancelled_by_signal".to_string()),
            () = tokio::time::sleep(deadline) => Err("worker_deadline".to_string()),
            outcome = worker_io => outcome.map_err(|error| error.to_string()),
        }
    };
    // Cover a cancellation arriving as the final I/O/exit becomes ready, before
    // interpreting its result. All failure paths kill and reap the owned child.
    let result = if *cancel.borrow() {
        Err("cancelled_by_signal".into())
    } else {
        result
    };
    let output = match result {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error);
        }
    };
    let facts = serde_json::from_slice(&output)
        .map_err(|error| format!("worker_invalid_response: {error}"));
    if *cancel.borrow() {
        return Err("cancelled_by_signal".into());
    }
    facts
}

/// Name the failure instead of reporting every non-zero exit the same way.
///
/// A heap exhaustion is the one failure an operator can act on, and Node says so
/// on stderr; anything else keeps the generic name. The stderr tail travels with
/// the error so the log carries the runtime's own words.
fn classify_exit(stderr: &[u8], heap_mb: u32) -> String {
    let text = String::from_utf8_lossy(stderr);
    let exhausted = text.contains("JavaScript heap out of memory")
        || text.contains("Allocation failed")
        || text.contains("Reached heap limit");
    if exhausted {
        let tail: String = text
            .lines()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | ");
        return format!(
            "worker_heap_exhausted:limit_mb={heap_mb}:raise --worker-heap-mb:stderr={tail}"
        );
    }
    let tail: String = text
        .lines()
        .rev()
        .take(3)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" | ");
    format!("worker_exit_failed:stderr={tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> ParseRequest {
        ParseRequest {
            schema: "atlas.parse-request.v1".into(),
            snapshot_id: "snapshot".into(),
            files: vec![],
        }
    }

    fn response() -> String {
        serde_json::to_string(&LanguageFacts {
            schema: "atlas.language-facts.v1".into(),
            snapshot_id: "snapshot".into(),
            producer: "test-worker".into(),
            parsed_files: vec![],
            symbols: vec![],
            calls: vec![],
            imports: vec![],
            diagnostics: vec![],
            dynamic_files: vec![],
            flow: None,
        })
        .unwrap()
    }

    #[tokio::test]
    async fn pre_cancelled_request_does_not_start_worker() {
        let tmp = tempfile::tempdir().unwrap();
        let worker = tmp.path().join("worker.mjs");
        std::fs::write(
            &worker,
            "import fs from 'node:fs';fs.writeFileSync('spawned','yes');setInterval(()=>{},1000);",
        )
        .unwrap();
        let (sender, cancel) = watch::channel(true);
        drop(sender);
        assert_eq!(
            parse(
                Path::new("node"),
                &worker,
                &request(),
                Duration::from_secs(3),
                1000,
                512,
                cancel.clone(),
            )
            .await
            .unwrap_err(),
            "cancelled_by_signal"
        );
        assert!(!tmp.path().join("spawned").exists());
        // Cancellation also precedes spawn errors, so an absent marker cannot
        // pass merely because a started worker was killed before its first I/O.
        assert_eq!(
            parse(
                &tmp.path().join("missing-node"),
                &worker,
                &request(),
                Duration::from_secs(3),
                1000,
                512,
                cancel,
            )
            .await
            .unwrap_err(),
            "cancelled_by_signal"
        );
    }

    #[tokio::test]
    async fn closed_false_sender_allows_successful_response() {
        let tmp = tempfile::tempdir().unwrap();
        let worker = tmp.path().join("worker.mjs");
        std::fs::write(
            &worker,
            format!(
                "for await (const chunk of process.stdin) {{}};process.stdout.write({});",
                serde_json::to_string(&response()).unwrap()
            ),
        )
        .unwrap();
        let (sender, cancel) = watch::channel(false);
        drop(sender);
        let facts = parse(
            Path::new("node"),
            &worker,
            &request(),
            Duration::from_secs(3),
            1000,
            512,
            cancel,
        )
        .await
        .unwrap();
        assert_eq!(facts.snapshot_id, "snapshot");
        assert_eq!(facts.producer, "test-worker");
    }

    #[cfg(unix)]
    fn process_exists(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn running_cancellation_reaps_worker_after_output_closes() {
        let tmp = tempfile::tempdir().unwrap();
        let worker = tmp.path().join("worker.mjs");
        std::fs::write(
            &worker,
            format!(
                "import fs from 'node:fs';\n\
                 for await (const chunk of process.stdin) {{}}\n\
                 process.stdout.end({},()=>{{\n\
                   process.stderr.end(()=>fs.writeFileSync('pid',String(process.pid)));\n\
                 }});\n\
                 setInterval(()=>{{}},1000);",
                serde_json::to_string(&response()).unwrap()
            ),
        )
        .unwrap();
        let (sender, cancel) = watch::channel(false);
        let task = tokio::spawn(async move {
            parse(
                Path::new("node"),
                &worker,
                &request(),
                Duration::from_secs(10),
                1000,
                512,
                cancel,
            )
            .await
        });
        let pid = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(tmp.path().join("pid")) {
                    break text.parse::<u32>().unwrap();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("worker did not signal readiness");
        assert!(process_exists(pid));
        // The pipes have been closed with a valid response, but worker exit is
        // still pending. Cancellation must own its lifetime through that wait.
        sender.send(true).unwrap();
        drop(sender);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), task)
                .await
                .expect("cancel did not stop the worker")
                .unwrap()
                .unwrap_err(),
            "cancelled_by_signal"
        );
        assert!(!process_exists(pid), "worker {pid} was not reaped");
    }

    #[tokio::test]
    async fn an_exhausted_worker_heap_is_named_with_the_ceiling_that_was_hit() {
        let tmp = tempfile::tempdir().unwrap();
        let worker = tmp.path().join("worker.mjs");
        // A worker that allocates until Node's heap ceiling stops it.
        std::fs::write(
            &worker,
            "const held=[];for(;;){held.push(new Array(1_000_000).fill(0));}",
        )
        .unwrap();
        let error = parse(
            Path::new("node"),
            &worker,
            &request(),
            Duration::from_secs(30),
            1000,
            16,
            tokio::sync::watch::channel(false).1,
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("worker_heap_exhausted"), "{error}");
        assert!(error.contains("limit_mb=16"), "{error}");
        assert!(error.contains("--worker-heap-mb"), "{error}");
        // Anything else keeps the generic name.
        assert!(classify_exit(b"SyntaxError: boom", 512).starts_with("worker_exit_failed"));
    }

    #[tokio::test]
    async fn deadline_kills_worker_and_output_cap_is_effective() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("worker.mjs");
        let request = request();
        std::fs::write(&p, "setInterval(()=>{},1000);").unwrap();
        let start = std::time::Instant::now();
        assert_eq!(
            parse(
                Path::new("node"),
                &p,
                &request,
                Duration::from_millis(150),
                1000,
                512,
                tokio::sync::watch::channel(false).1,
            )
            .await
            .unwrap_err(),
            "worker_deadline"
        );
        assert!(start.elapsed() < Duration::from_secs(3));
        std::fs::write(
            &p,
            "process.stdout.write('x'.repeat(200000));setInterval(()=>{},1000);",
        )
        .unwrap();
        let error = parse(
            Path::new("node"),
            &p,
            &request,
            Duration::from_secs(3),
            1000,
            512,
            tokio::sync::watch::channel(false).1,
        )
        .await
        .unwrap_err();
        assert!(error.contains("output_limit"), "{error}");
    }

    #[tokio::test]
    async fn the_response_ceiling_is_named_with_its_value_and_the_flag_that_raises_it() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("chatty.mjs");
        std::fs::write(&p, "process.stdout.write('x'.repeat(3*1024*1024));").unwrap();
        let error = parse(
            Path::new("node"),
            &p,
            &request(),
            Duration::from_secs(3),
            2 * 1024 * 1024,
            512,
            tokio::sync::watch::channel(false).1,
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("worker_output_limit"), "{error}");
        assert!(error.contains("limit_mb=2"), "{error}");
        assert!(error.contains("--worker-output-mb"), "{error}");
    }

    #[tokio::test]
    async fn stderr_exhaustion_is_not_reported_as_the_response_ceiling() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("noisy.mjs");
        std::fs::write(&p, "process.stderr.write('e'.repeat(200000));").unwrap();
        let error = parse(
            Path::new("node"),
            &p,
            &request(),
            Duration::from_secs(3),
            2 * 1024 * 1024,
            512,
            tokio::sync::watch::channel(false).1,
        )
        .await
        .unwrap_err();
        // A runtime that chats on stderr must not read as "the answer was too
        // large", which would send the reader to the wrong flag.
        assert!(error.starts_with("worker_stderr_limit"), "{error}");
        assert!(!error.contains("--worker-output-mb"), "{error}");
    }
}
