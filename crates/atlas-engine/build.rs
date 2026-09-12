//! Embeds a content-derived build fingerprint into the binary.
//!
//! The fingerprint is `sha256` over `crates/**/*.rs` plus `Cargo.lock`, keyed by
//! their workspace-relative path. It is deliberately content-derived and not a
//! timestamp: a value that changes on every rebuild would make the fingerprint
//! useless as an identity and would churn the evidence that records it.
//!
//! It is exposed at response time only (see `Store::metadata`). It must never
//! reach the persisted `Analysis`: `analysis.id` is a digest over that whole
//! structure, so a per-build value inside it would give identical source and
//! snapshot a different identity on every rebuild and break reproducible
//! publication.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

fn collect_rust_sources(dir: &Path, root: &Path, out: &mut BTreeMap<String, PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rust_sources(&path, root, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs")
            && let Ok(relative) = path.strip_prefix(root)
        {
            out.insert(relative.to_string_lossy().replace('\\', "/"), path);
        }
    }
}

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest
        .parent()
        .and_then(Path::parent)
        .expect("crates/<name> implies a workspace root")
        .to_path_buf();

    let mut sources: BTreeMap<String, PathBuf> = BTreeMap::new();
    collect_rust_sources(&root.join("crates"), &root, &mut sources);

    let lock = root.join("Cargo.lock");
    if lock.is_file() {
        sources.insert("Cargo.lock".into(), lock);
    }

    let mut hasher = Sha256::new();
    for (name, path) in &sources {
        hasher.update(name.as_bytes());
        hasher.update([0]);
        if let Ok(bytes) = std::fs::read(path) {
            hasher.update(bytes);
        }
        hasher.update([0]);
    }
    let fingerprint = format!("{:x}", hasher.finalize());

    println!("cargo:rustc-env=ATLAS_BUILD_FINGERPRINT={fingerprint}");
    for path in sources.values() {
        println!("cargo:rerun-if-changed={}", path.display());
    }
}
