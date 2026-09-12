use atlas_contract::{LanguageFacts, ParseRequest};
use std::{io, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::watch,
};

async fn bounded(mut reader: impl AsyncRead + Unpin, limit: usize) -> io::Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = reader.read(&mut buffer).await?;
        if n == 0 {
            return Ok(result);
        }
        if result.len() + n > limit {
            return Err(io::Error::other("worker_output_limit"));
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

pub async fn parse(
    node: &Path,
    worker: &Path,
    request: &ParseRequest,
    deadline: Duration,
    output_limit: usize,
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
        .arg("--max-old-space-size=512")
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
    let result = {
        let write = async {
            stdin.write_all(&bytes).await?;
            stdin.shutdown().await?;
            drop(stdin);
            Ok::<_, io::Error>(())
        };
        let worker_io = async {
            let (_, stdout, _stderr) = tokio::try_join!(
                write,
                bounded(stdout, output_limit),
                bounded(stderr, 64 * 1024)
            )?;
            let status = child.wait().await?;
            if !status.success() {
                return Err(io::Error::other("worker_exit_failed"));
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
            tokio::sync::watch::channel(false).1,
        )
        .await
        .unwrap_err();
        assert!(error.contains("output_limit"), "{error}");
    }
}
