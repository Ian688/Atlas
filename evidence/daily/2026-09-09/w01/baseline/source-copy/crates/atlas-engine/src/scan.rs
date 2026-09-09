use crate::{Result, digest, invalid, store::Store};
use atlas_contract::{CatalogEntry, SNAPSHOT_SCHEMA, ScanLimits, Snapshot};
use cap_std::{ambient_authority, fs::Dir};
use ignore::{
    Match,
    gitignore::{Gitignore, GitignoreBuilder},
};
use std::{
    collections::{BTreeMap, VecDeque},
    io::Read,
    path::{Path, PathBuf},
};

pub fn is_source(path: &str) -> bool {
    ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"].contains(
        &Path::new(path)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or(""),
    )
}
fn capture(dir: &Dir, path: &Path, max: u64) -> Result<Vec<u8>> {
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = dir.open_with(path, &options)?.into_std();
    let before = file.metadata()?;
    if !before.is_file() {
        return Err(invalid("not_regular_file"));
    }
    if before.len() > max {
        return Err(invalid("file_byte_limit"));
    }
    let mut bytes = Vec::new();
    (&mut file).take(max + 1).read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    let now = dir.open_with(path, &options)?.into_std().metadata()?;
    if dir.symlink_metadata(path)?.is_symlink()
        || bytes.len() as u64 > max
        || before.len() != after.len()
        || after.len() != now.len()
        || before.modified().ok() != after.modified().ok()
        || after.modified().ok() != now.modified().ok()
    {
        return Err(invalid("unstable_file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != now.dev()
            || before.ino() != now.ino()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
        {
            return Err(invalid("unstable_file_identity"));
        }
    }
    Ok(bytes)
}

/// Capability-relative filesystem traversal. Links are recorded, never traversed.
pub fn scan(root: &Path, store: &Store, limits: ScanLimits) -> Result<Snapshot> {
    if limits.max_entries == 0 || limits.max_file_bytes == 0 || limits.max_total_bytes == 0 {
        return Err(invalid("invalid_scan_limits"));
    }
    let root = root.canonicalize()?;
    if root == store.root {
        return Err(invalid("store_cannot_be_project_root"));
    }
    let dir = Dir::open_ambient_dir(&root, ambient_authority())?;
    let mut entries = vec![CatalogEntry {
        path: "".into(),
        kind: "directory".into(),
        disposition: "directory".into(),
        bytes: 0,
        blob: None,
        detail: None,
    }];
    let mut queue = VecDeque::from([(PathBuf::new(), Vec::<Gitignore>::new())]);
    let mut total = 0u64;
    let mut policy_hashes = BTreeMap::new();
    while let Some((relative, mut policies)) = queue.pop_front() {
        let policy_path = relative.join(".gitignore");
        let mut policy_bytes = None;
        if dir
            .symlink_metadata(&policy_path)
            .map(|m| m.is_file() && !m.is_symlink())
            .unwrap_or(false)
        {
            let bytes = capture(&dir, &policy_path, limits.max_file_bytes)?;
            let text = std::str::from_utf8(&bytes).map_err(|_| invalid("gitignore_not_utf8"))?;
            let mut builder = GitignoreBuilder::new(root.join(&relative));
            for line in text.lines() {
                builder
                    .add_line(Some(root.join(&policy_path)), line)
                    .map_err(|_| invalid("invalid_gitignore"))?;
            }
            policies.push(builder.build().map_err(|_| invalid("invalid_gitignore"))?);
            policy_hashes.insert(policy_path.to_string_lossy().to_string(), digest(&bytes));
            policy_bytes = Some(bytes);
        }
        let read = match dir.read_dir(if relative.as_os_str().is_empty() {
            Path::new(".")
        } else {
            &relative
        }) {
            Ok(read) => read,
            Err(_) => {
                if let Some(entry) = entries
                    .iter_mut()
                    .find(|e| e.path == relative.to_string_lossy())
                {
                    entry.disposition = "unreadable".into();
                    entry.detail = Some("directory_not_enumerated".into());
                }
                continue;
            }
        };
        let mut children = Vec::new();
        for item in read {
            children.push(item?);
            if children.len() + entries.len() > limits.max_entries {
                return Err(invalid("entry_budget_exceeded_no_snapshot_published"));
            }
        }
        children.sort_by_key(|a| a.file_name());
        for item in children {
            let p = relative.join(item.file_name());
            #[cfg(unix)]
            if p.as_os_str().as_encoded_bytes().contains(&b'\\') {
                return Err(invalid("backslash_filename_not_supported"));
            }
            let name = p
                .to_str()
                .ok_or_else(|| invalid("non_utf8_path_not_supported"))?
                .replace('\\', "/");
            let meta = dir.symlink_metadata(&p)?;
            let kind = if meta.is_symlink() {
                "symlink"
            } else if meta.is_dir() {
                "directory"
            } else if meta.is_file() {
                "file"
            } else {
                "special"
            };
            let mut entry = CatalogEntry {
                path: name.clone(),
                kind: kind.into(),
                disposition: kind.into(),
                bytes: if meta.is_file() { meta.len() } else { 0 },
                blob: None,
                detail: None,
            };
            let absolute = root.join(&p);
            let builtin = matches!(
                item.file_name().to_str(),
                Some(".git" | "node_modules" | "target")
            ) || absolute == store.root;
            let mut ignored = false;
            for policy in &policies {
                match policy.matched(&absolute, meta.is_dir()) {
                    Match::Ignore(_) => ignored = true,
                    Match::Whitelist(_) => ignored = false,
                    Match::None => {}
                }
            }
            if kind == "symlink" {
                let target = dir.read_link_contents(&p)?;
                entry.detail = Some(format!(
                    "link_not_followed;target_hash:{}",
                    digest(target.as_os_str().as_encoded_bytes())
                ));
            } else if builtin || ignored {
                entry.disposition = "ignored".into();
                entry.detail = Some(
                    if builtin {
                        "builtin_or_store_boundary"
                    } else {
                        "gitignore_boundary"
                    }
                    .into(),
                );
            } else if meta.is_dir() {
                queue.push_back((p.clone(), policies.clone()));
            } else if meta.is_file() {
                if meta.len() > limits.max_file_bytes {
                    entry.disposition = "oversize".into();
                    entry.detail = Some("file_byte_limit".into());
                } else {
                    let bytes = if p == policy_path {
                        policy_bytes
                            .clone()
                            .ok_or_else(|| invalid("policy_capture_missing"))
                    } else {
                        capture(&dir, &p, limits.max_file_bytes)
                    };
                    match bytes {
                        Ok(bytes) => {
                            total = total
                                .checked_add(bytes.len() as u64)
                                .ok_or_else(|| invalid("byte_overflow"))?;
                            if total > limits.max_total_bytes {
                                return Err(invalid(
                                    "total_byte_budget_exceeded_no_snapshot_published",
                                ));
                            }
                            entry.bytes = bytes.len() as u64;
                            entry.blob = Some(store.put_blob(&bytes)?);
                            entry.disposition = "captured".into();
                        }
                        Err(_) => {
                            entry.disposition = "unstable_or_unreadable".into();
                            entry.detail = Some("source_not_captured".into());
                        }
                    }
                }
            }
            entries.push(entry);
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let profile = format!(
        "scoped-gitignore-links-recorded-v1:{}",
        digest(&serde_json::to_vec(&policy_hashes)?)
    );
    let mut snapshot = Snapshot {
        schema: SNAPSHOT_SCHEMA.into(),
        id: String::new(),
        scan_profile: profile,
        limits,
        entries,
    };
    snapshot.id = digest(&serde_json::to_vec(&snapshot)?);
    store.publish_snapshot(&snapshot)?;
    Ok(snapshot)
}
