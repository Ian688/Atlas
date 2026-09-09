use atlas_contract::{LanguageFacts, ParseRequest};
use std::{io, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
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

pub async fn parse(
    node: &Path,
    worker: &Path,
    request: &ParseRequest,
    deadline: Duration,
    output_limit: usize,
) -> Result<LanguageFacts, String> {
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
    let mut child = command.spawn().map_err(|_| "worker_spawn_failed")?;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let result = tokio::time::timeout(deadline, async {
        let write = async {
            stdin.write_all(&bytes).await?;
            stdin.shutdown().await?;
            drop(stdin);
            Ok::<_, io::Error>(())
        };
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
    })
    .await;
    let output = match result {
        Ok(Ok(bytes)) => bytes,
        failure => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(match failure {
                Err(_) => "worker_deadline".into(),
                Ok(Err(e)) => e.to_string(),
                _ => unreachable!(),
            });
        }
    };
    serde_json::from_slice(&output).map_err(|_| "worker_invalid_response".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn deadline_kills_worker_and_output_cap_is_effective() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("worker.mjs");
        let request = ParseRequest {
            schema: "atlas.parse-request.v1".into(),
            snapshot_id: "snapshot".into(),
            files: vec![],
        };
        std::fs::write(&p, "setInterval(()=>{},1000);").unwrap();
        let start = std::time::Instant::now();
        assert_eq!(
            parse(
                Path::new("node"),
                &p,
                &request,
                Duration::from_millis(150),
                1000
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
        )
        .await
        .unwrap_err();
        assert!(error.contains("output_limit"), "{error}");
    }
}
