//! Private, bounded recovery records. Restoring always creates a new file; originals are never replaced.
#[cfg(target_os = "linux")]
use crate::document::Format;
use crate::document::{DocumentError, SaveTicket};
#[cfg(target_os = "linux")]
use serde::Deserialize;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
const MAX_HEADER: usize = 16 * 1024;
#[cfg(target_os = "linux")]
const MAX_PAYLOAD: usize = 32 * 1024 * 1024;
#[cfg(target_os = "linux")]
const MAX_TOTAL: u64 = 256 * 1024 * 1024;
#[cfg(target_os = "linux")]
const MAX_RECORDS: usize = 128;
#[cfg(target_os = "linux")]
const MAGIC: &[u8; 4] = b"GRR1";

fn failure() -> DocumentError {
    DocumentError::SaveFailure {
        stage: crate::document::SaveStage::Write,
        io: None,
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub valid: bool,
    pub name: String,
    pub revision: Option<u64>,
    pub format: Option<String>,
    pub created_at: Option<u64>,
    pub stale: bool,
}

#[cfg(target_os = "linux")]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    version: u32,
    id: String,
    original: String,
    target: String,
    source_hash: String,
    payload_hash: String,
    revision: u64,
    generation: u64,
    format: String,
    created_at: u64,
}

#[cfg(target_os = "linux")]
fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(target_os = "linux")]
struct DirectoryLock<'a>(&'a std::fs::File);
#[cfg(target_os = "linux")]
impl<'a> DirectoryLock<'a> {
    fn take(dir: &'a std::fs::File, exclusive: bool) -> Result<Self, DocumentError> {
        use std::os::fd::AsRawFd;
        loop {
            let operation = if exclusive {
                libc::LOCK_EX
            } else {
                libc::LOCK_SH
            };
            // SAFETY: live verified directory descriptor. Readers never inspect an active partial write.
            if unsafe { libc::flock(dir.as_raw_fd(), operation) } == 0 {
                return Ok(Self(dir));
            }
            if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
                return Err(failure());
            }
        }
    }
}
#[cfg(target_os = "linux")]
impl Drop for DirectoryLock<'_> {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // SAFETY: the borrowed directory descriptor outlives this guard.
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct Memory {
    /// Every opaque ID owned by a session load, with the source path its header records. Save As keeps the
    /// generation but changes that path, and `put` never replaces a record for a different original.
    ids: std::collections::BTreeMap<(u64, u64), Vec<(String, String)>>,
    forgotten: std::collections::BTreeSet<u64>,
}

pub struct RecoveryStore {
    #[cfg(target_os = "linux")]
    root: PathBuf,
    #[cfg(target_os = "linux")]
    ids: std::sync::Mutex<Memory>,
}

impl RecoveryStore {
    pub fn new(_root: PathBuf) -> Self {
        Self {
            #[cfg(target_os = "linux")]
            root: _root,
            #[cfg(target_os = "linux")]
            ids: std::sync::Mutex::new(Default::default()),
        }
    }
}

#[cfg(target_os = "linux")]
impl RecoveryStore {
    fn directory(&self) -> Result<std::fs::File, DocumentError> {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        if !self.root.is_absolute() {
            return Err(failure());
        }
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.root)
            .map_err(|_| failure())?;
        // SAFETY: geteuid has no arguments and cannot fail.
        let uid = unsafe { libc::geteuid() };
        let dir = super::save::publish::open_directory(&self.root, uid)?;
        let meta = dir.metadata().map_err(|_| failure())?;
        if meta.uid() != uid || meta.mode() & 0o077 != 0 {
            return Err(failure());
        }
        // fsync needs a readable directory handle, not O_PATH. /proc/self/fd holds the same object.
        std::fs::File::open(Self::base(&dir)).map_err(|_| failure())
    }

    fn base(dir: &std::fs::File) -> PathBuf {
        use std::os::fd::AsRawFd;
        PathBuf::from(format!("/proc/self/fd/{}", dir.as_raw_fd()))
    }

    fn record_name(name: &str) -> bool {
        let Some((id, suffix)) = name.split_once('.') else {
            return false;
        };
        id.len() == 32
            && id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            && matches!(suffix, "pending" | "recovery")
    }

    fn names(dir: &std::fs::File) -> Result<Vec<String>, DocumentError> {
        let mut names = Vec::new();
        for entry in std::fs::read_dir(Self::base(dir))
            .map_err(|_| failure())?
            .take(MAX_RECORDS + 1)
        {
            let entry = entry.map_err(|_| failure())?;
            if let Some(name) = entry.file_name().to_str() {
                if Self::record_name(name) {
                    names.push(name.to_owned());
                }
            }
        }
        names.sort();
        Ok(names)
    }

    fn read(dir: &std::fs::File, name: &str) -> Result<(Header, Vec<u8>), DocumentError> {
        use std::io::Read;
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        if !Self::record_name(name) {
            return Err(DocumentError::InvalidRequest);
        }
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(Self::base(dir).join(name))
            .map_err(|_| failure())?;
        let meta = file.metadata().map_err(|_| failure())?;
        let owner = dir.metadata().map_err(|_| failure())?.uid();
        if !meta.is_file()
            || meta.uid() != owner
            || meta.mode() & 0o077 != 0
            || meta.nlink() != 1
            || meta.len() > (72 + MAX_HEADER + MAX_PAYLOAD) as u64
        {
            return Err(failure());
        }
        let mut prefix = [0u8; 8];
        file.read_exact(&mut prefix).map_err(|_| failure())?;
        if &prefix[..4] != MAGIC {
            return Err(failure());
        }
        let n = u32::from_le_bytes(prefix[4..].try_into().map_err(|_| failure())?) as usize;
        if n > MAX_HEADER || meta.len() < (72 + n) as u64 {
            return Err(failure());
        }
        let mut checksum = [0u8; 64];
        file.read_exact(&mut checksum).map_err(|_| failure())?;
        let mut header = vec![0u8; n];
        file.read_exact(&mut header).map_err(|_| failure())?;
        if checksum.as_slice() != digest(&header).as_bytes() {
            return Err(failure());
        }
        let header: Header = serde_json::from_slice(&header).map_err(|_| failure())?;
        let expected_id = name.split_once('.').ok_or_else(failure)?.0;
        if header.version != 1
            || header.id != expected_id
            || !Path::new(&header.original).is_absolute()
            || !Path::new(&header.target).is_absolute()
            || header.source_hash.len() != 64
        {
            return Err(failure());
        }
        let mut bytes = Vec::new();
        file.take(MAX_PAYLOAD as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| failure())?;
        if bytes.len() > MAX_PAYLOAD || digest(&bytes) != header.payload_hash {
            return Err(failure());
        }
        let format = match header.format.as_str() {
            "hwp" => Format::Hwp,
            "hwpx" => Format::Hwpx,
            "docx" => Format::Docx,
            _ => return Err(failure()),
        };
        let detected =
            crate::document::detect(&mut std::io::Cursor::new(&bytes), bytes.len() as u64)?;
        if detected != format {
            return Err(failure());
        }
        Ok((header, bytes))
    }

    fn candidate(name: String, header: Option<Header>) -> Candidate {
        match header {
            Some(h) => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |n| n.as_secs());
                Candidate {
                    id: name,
                    valid: true,
                    name: Path::new(&h.target)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    revision: Some(h.revision),
                    format: Some(h.format),
                    created_at: Some(h.created_at),
                    stale: now.saturating_sub(h.created_at) > 30 * 86400,
                }
            }
            None => Candidate {
                id: name,
                valid: false,
                name: String::new(),
                revision: None,
                format: None,
                created_at: None,
                stale: false,
            },
        }
    }

    pub fn list(&self) -> Result<Vec<Candidate>, DocumentError> {
        let dir = self.directory()?;
        let _lock = DirectoryLock::take(&dir, false)?;
        Ok(Self::names(&dir)?
            .into_iter()
            .map(|name| {
                let header = Self::read(&dir, &name).ok().map(|(h, _)| h);
                Self::candidate(name, header)
            })
            .collect())
    }

    pub fn snapshot(
        &self,
        ticket: &SaveTicket<'_>,
        original: &[u8],
        target: &Path,
        bytes: &[u8],
    ) -> Result<Candidate, DocumentError> {
        if bytes.len() > MAX_PAYLOAD {
            return Err(failure());
        }
        let mut ids = self.ids.lock().map_err(|_| failure())?;
        if ids.forgotten.contains(&ticket.session_id) {
            return Err(failure());
        }
        let dir = self.directory()?;
        let key = (ticket.session_id, ticket.generation);
        let original_path = ticket
            .source
            .load
            .identity
            .path()
            .to_str()
            .ok_or_else(failure)?
            .to_owned();
        let current = ids
            .ids
            .get(&key)
            .and_then(|history| history.last())
            .filter(|(id, original)| {
                // Reuse only the latest ID for the same source; after Save As the older record keeps its own ID.
                // Preserve an orphaned/partial pending record; retry under a fresh opaque ID.
                // Keep every ID owned by this session so explicit forget can still remove them.
                *original == original_path
                    && std::fs::symlink_metadata(Self::base(&dir).join(format!("{id}.pending")))
                        .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            })
            .map(|(id, _)| id.clone());
        let id = match current {
            Some(id) => id,
            None => {
                let mut random = [0u8; 16];
                let mut at = 0;
                while at < random.len() {
                    // SAFETY: valid remaining byte slice; no optional flags.
                    let n = unsafe {
                        libc::getrandom(random[at..].as_mut_ptr().cast(), random.len() - at, 0)
                    };
                    if n < 0 {
                        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
                        {
                            continue;
                        }
                        return Err(failure());
                    }
                    if n == 0 {
                        return Err(failure());
                    }
                    at += n as usize;
                }
                let id: String = random.iter().map(|b| format!("{b:02x}")).collect();
                ids.ids
                    .entry(key)
                    .or_default()
                    .push((id.clone(), original_path.clone()));
                id
            }
        };
        let header = Header {
            version: 1,
            id,
            original: original_path,
            target: target.to_str().ok_or_else(failure)?.to_owned(),
            source_hash: digest(original),
            payload_hash: digest(bytes),
            revision: ticket.revision,
            generation: ticket.generation,
            format: match ticket.source.load.format {
                Format::Hwp => "hwp",
                Format::Hwpx => "hwpx",
                Format::Docx => "docx",
            }
            .into(),
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| failure())?
                .as_secs(),
        };
        self.put(&dir, header, bytes)
    }

    fn put(
        &self,
        dir: &std::fs::File,
        header: Header,
        bytes: &[u8],
    ) -> Result<Candidate, DocumentError> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let _lock = DirectoryLock::take(dir, true)?;
        let json = serde_json::to_vec(&header).map_err(|_| failure())?;
        if bytes.len() > MAX_PAYLOAD || json.len() > MAX_HEADER {
            return Err(failure());
        }
        let mut total = (72 + json.len() + bytes.len()) as u64;
        let mut count = 0;
        for entry in std::fs::read_dir(Self::base(dir))
            .map_err(|_| failure())?
            .take(MAX_RECORDS + 1)
        {
            count += 1;
            total = total.saturating_add(
                entry
                    .map_err(|_| failure())?
                    .metadata()
                    .map_err(|_| failure())?
                    .len(),
            );
        }
        if count >= MAX_RECORDS || total > MAX_TOTAL {
            return Err(failure());
        }
        let final_name = format!("{}.recovery", header.id);
        let final_path = Self::base(dir).join(&final_name);
        if std::fs::symlink_metadata(&final_path).is_ok() {
            // Never overwrite an invalid or foreign recovery record, even in our private store.
            let (prior, _) = Self::read(dir, &final_name)?;
            if prior.id != header.id
                || prior.original != header.original
                || prior.generation != header.generation
                || prior.revision > header.revision
            {
                return Err(failure());
            }
        }
        let pending = Self::base(dir).join(format!("{}.pending", header.id));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&pending)
            .map_err(|_| failure())?;
        // On failure leave even partial records for explicit disposition; do not confuse Drop cleanup with crash recovery.
        file.write_all(MAGIC)
            .and_then(|_| file.write_all(&(json.len() as u32).to_le_bytes()))
            .and_then(|_| file.write_all(digest(&json).as_bytes()))
            .and_then(|_| file.write_all(&json))
            .and_then(|_| file.write_all(bytes))
            .and_then(|_| file.sync_all())
            .map_err(|_| failure())?;
        Self::read(
            dir,
            pending
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(failure)?,
        )?;
        std::fs::rename(&pending, &final_path).map_err(|_| failure())?;
        dir.sync_all().map_err(|_| failure())?;
        Ok(Self::candidate(final_name, Some(header)))
    }

    pub fn discard(&self, id: &str) -> Result<(), DocumentError> {
        if !Self::record_name(id) {
            return Err(DocumentError::InvalidRequest);
        }
        let dir = self.directory()?;
        let _lock = DirectoryLock::take(&dir, true)?;
        std::fs::remove_file(Self::base(&dir).join(id)).map_err(|_| failure())?;
        dir.sync_all().map_err(|_| failure())
    }

    pub fn saved(&self, ticket: &SaveTicket<'_>) {
        let Ok(ids) = self.ids.lock() else { return };
        let Some(history) = ids.ids.get(&(ticket.session_id, ticket.generation)) else {
            return;
        };
        let Ok(dir) = self.directory() else { return };
        for (id, _) in history {
            let name = format!("{id}.recovery");
            if Self::read(&dir, &name).is_ok_and(|(h, _)| h.revision <= ticket.revision) {
                let _ = self.discard(&name);
            }
        }
    }

    pub fn forget_session(&self, session_id: u64) -> Result<(), DocumentError> {
        let mut ids = self.ids.lock().map_err(|_| failure())?;
        let mut failed = false;
        ids.forgotten.insert(session_id);
        for ((session, _), history) in ids.ids.iter() {
            if *session == session_id {
                for (id, _) in history {
                    for suffix in ["pending", "recovery"] {
                        let name = format!("{id}.{suffix}");
                        let dir = self.directory()?;
                        match std::fs::symlink_metadata(Self::base(&dir).join(&name)) {
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                            _ => {
                                if self.discard(&name).is_err() {
                                    failed = true;
                                }
                            }
                        }
                    }
                }
            }
        }
        if failed {
            Err(failure())
        } else {
            Ok(())
        }
    }

    pub fn restore(&self, id: &str, target: &Path) -> Result<PathBuf, DocumentError> {
        let dir = self.directory()?;
        let _lock = DirectoryLock::take(&dir, false)?;
        let (header, bytes) = Self::read(&dir, id)?;
        let format = match header.format.as_str() {
            "docx" => Format::Docx,
            "hwp" => Format::Hwp,
            "hwpx" => Format::Hwpx,
            _ => return Err(failure()),
        };
        let target = super::files::destination(target, format)?;
        if target == Path::new(&header.original) || target == Path::new(&header.target) {
            return Err(DocumentError::FileConflict);
        }
        let mut staged = super::save::publish::stage_new(&target, &bytes, None)?;
        let published = super::save::publish::publish_new(&mut staged, &target)?;
        if !published.durable {
            return Err(DocumentError::FilePublishedUnconfirmed);
        }
        // Candidate remains available until explicit discard; failed/repeated restores never consume it.
        Ok(target)
    }
}

#[cfg(not(target_os = "linux"))]
impl RecoveryStore {
    pub fn list(&self) -> Result<Vec<Candidate>, DocumentError> {
        Err(failure())
    }
    pub fn snapshot(
        &self,
        _ticket: &SaveTicket<'_>,
        _original: &[u8],
        _target: &Path,
        _bytes: &[u8],
    ) -> Result<Candidate, DocumentError> {
        Err(failure())
    }
    pub fn saved(&self, _ticket: &SaveTicket<'_>) {}
    pub fn forget_session(&self, _session_id: u64) -> Result<(), DocumentError> {
        Err(failure())
    }
    pub fn discard(&self, _id: &str) -> Result<(), DocumentError> {
        Err(failure())
    }
    pub fn restore(&self, _id: &str, _target: &Path) -> Result<PathBuf, DocumentError> {
        Err(failure())
    }
}

#[tauri::command]
pub async fn recovery_list(
    state: tauri::State<'_, crate::document::commands::DocumentState>,
    store: tauri::State<'_, std::sync::Arc<RecoveryStore>>,
) -> Result<Vec<Candidate>, DocumentError> {
    let store = store.inner().clone();
    state.run_blocking(move || store.list()).await
}
#[tauri::command]
pub async fn recovery_discard(
    state: tauri::State<'_, crate::document::commands::DocumentState>,
    store: tauri::State<'_, std::sync::Arc<RecoveryStore>>,
    id: String,
) -> Result<(), DocumentError> {
    let store = store.inner().clone();
    state.run_blocking(move || store.discard(&id)).await
}
#[tauri::command]
pub async fn recovery_forget_session(
    state: tauri::State<'_, crate::document::commands::DocumentState>,
    store: tauri::State<'_, std::sync::Arc<RecoveryStore>>,
    session_id: u64,
) -> Result<(), DocumentError> {
    let store = store.inner().clone();
    state
        .run_blocking(move || store.forget_session(session_id))
        .await
}

#[tauri::command]
pub async fn recovery_restore(
    state: tauri::State<'_, crate::document::commands::DocumentState>,
    store: tauri::State<'_, std::sync::Arc<RecoveryStore>>,
    id: String,
    path: String,
) -> Result<String, DocumentError> {
    let store = store.inner().clone();
    state
        .run_blocking(move || {
            store
                .restore(&id, Path::new(&path))
                .and_then(|p| p.to_str().map(str::to_owned).ok_or_else(failure))
        })
        .await
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::document::testutil::TempDir;
    use crate::document::{content_hash, identify, Limits, SessionRegistry, SessionState};
    use crate::services::save::{publish, service};
    fn setup(path: &Path) -> (SessionRegistry, crate::document::SessionInfo, Vec<u8>) {
        let bytes = crate::services::files::blank_docx().unwrap();
        std::fs::write(path, &bytes).unwrap();
        let registry = SessionRegistry::default();
        let info = registry
            .register(identify(path.to_str().unwrap(), &Limits::default()).unwrap())
            .unwrap();
        registry.begin_load(info.session_id).unwrap();
        registry
            .record_content(info.session_id, 1, content_hash(&bytes))
            .unwrap();
        let info = registry
            .transition(
                info.session_id,
                1,
                SessionState::Loading,
                SessionState::Ready,
            )
            .unwrap();
        let info = registry.commit(info.session_id, 1, 0, 1).unwrap();
        registry
            .record_preflight(
                info.session_id,
                1,
                content_hash(&bytes),
                service::preflight(Format::Docx, &bytes, &bytes, None),
            )
            .unwrap();
        (registry, info, bytes)
    }
    #[test]
    fn published_restore_reports_unconfirmed_and_preserves_both_files_and_candidate() {
        let dir = TempDir::new();
        let source = dir.path().join("source.docx");
        let (registry, info, original) = setup(&source);
        let store = RecoveryStore::new(dir.path().join("records"));
        let ticket = registry.begin_save(info.session_id, 1, 1).unwrap();
        let candidate = store
            .snapshot(&ticket, &original, &source, &original)
            .unwrap();
        let target = dir.path().join("copy.docx");
        publish::FAULT.with(|fault| fault.set(Some(publish::Fault::DirSync)));
        let restored = store.restore(&candidate.id, &target);
        publish::FAULT.with(|fault| fault.set(None));
        assert_eq!(
            restored.unwrap_err(),
            DocumentError::FilePublishedUnconfirmed
        );
        assert_eq!(std::fs::read(&target).unwrap(), original);
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert!(store.list().unwrap()[0].valid);
        assert_eq!(
            store.restore(&candidate.id, &target).unwrap_err(),
            DocumentError::FileConflict
        );
    }

    #[test]
    fn failed_record_deletion_is_reported_and_tombstone_still_blocks_late_capture() {
        let dir = TempDir::new();
        let source = dir.path().join("source.docx");
        let (registry, info, original) = setup(&source);
        let store = RecoveryStore::new(dir.path().join("records"));
        let ticket = registry.begin_save(info.session_id, 1, 1).unwrap();
        let candidate = store
            .snapshot(&ticket, &original, &source, &original)
            .unwrap();
        let id = candidate.id.trim_end_matches(".recovery");
        let pending = store.root.join(format!("{id}.pending"));
        std::fs::create_dir(&pending).unwrap(); // unlink cannot remove a directory
        assert!(store
            .discard(pending.file_name().unwrap().to_str().unwrap())
            .is_err());
        assert!(store.forget_session(info.session_id).is_err());
        assert!(pending.is_dir());
        assert!(store
            .snapshot(&ticket, &original, &source, &original)
            .is_err());
        assert_eq!(std::fs::read(&source).unwrap(), original);
    }

    #[test]
    fn partial_pending_retry_uses_fresh_id_and_preserves_partial_and_last_good_copy() {
        let dir = TempDir::new();
        let source = dir.path().join("source.docx");
        let (registry, info, original) = setup(&source);
        let store = RecoveryStore::new(dir.path().join("records"));
        let ticket = registry.begin_save(info.session_id, 1, 1).unwrap();
        let candidate = store
            .snapshot(&ticket, &original, &source, &original)
            .unwrap();
        let pending = candidate.id.replace(".recovery", ".pending");
        std::fs::write(store.root.join(&pending), b"partial").unwrap();
        let retried = store
            .snapshot(&ticket, &original, &source, &original)
            .unwrap();
        assert_ne!(retried.id, candidate.id);
        assert!(store
            .list()
            .unwrap()
            .iter()
            .any(|entry| entry.id == pending && !entry.valid));
        assert!(store
            .list()
            .unwrap()
            .iter()
            .any(|entry| entry.id == candidate.id && entry.valid));
        assert_eq!(
            std::fs::read(store.root.join(&pending)).unwrap(),
            b"partial"
        );
        store.forget_session(info.session_id).unwrap();
        assert!(store.list().unwrap().is_empty());
    }

    fn edited(original: &[u8]) -> Vec<u8> {
        use crate::adapters::wordcraft::engine::{DocxModel, DocxOp};
        let mut model = DocxModel::open(original).unwrap();
        model.apply(&[DocxOp::InsertText {
            text: "recover-content".into(),
        }]);
        let bytes = model.export().unwrap();
        assert!(model.same_as(&bytes));
        bytes
    }
    #[test]
    fn recovery_snapshot_preserves_dirty_restore_is_create_only_and_candidate_survives_retries() {
        let dir = TempDir::new();
        let source = dir.path().join("original.docx");
        let (registry, info, original) = setup(&source);
        let store = RecoveryStore::new(dir.path().join("records"));
        let output = edited(&original);
        let ticket = registry.begin_save(info.session_id, 1, 1).unwrap();
        let checked =
            service::validate_snapshot(&ticket, &Limits::default(), &output, None, true).unwrap();
        let candidate = store.snapshot(&ticket, &checked, &source, &output).unwrap();
        assert!(registry.get(info.session_id).unwrap().dirty);
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert_eq!(store.list().unwrap().len(), 1);
        assert!(store.restore(&candidate.id, &source).is_err());
        let target = dir.path().join("restored.docx");
        store.restore(&candidate.id, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), output);
        assert!(store.restore(&candidate.id, &target).is_err());
        assert!(store.list().unwrap()[0].valid);
        // Stale source never gets replaced by restoration of a prior revision.
        std::fs::write(&source, b"external update").unwrap();
        store
            .restore(&candidate.id, &dir.path().join("second-copy.docx"))
            .unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), b"external update");
        store.discard(&candidate.id).unwrap();
        assert!(store.list().unwrap().is_empty());
    }
    #[test]
    fn recovery_rejects_header_payload_corruption_symlinks_and_path_traversal() {
        use std::io::{Seek, SeekFrom, Write};
        let dir = TempDir::new();
        let source = dir.path().join("original.docx");
        let (registry, info, original) = setup(&source);
        let root = dir.path().join("records");
        let store = RecoveryStore::new(root.clone());
        let ticket = registry.begin_save(info.session_id, 1, 1).unwrap();
        let candidate = store
            .snapshot(&ticket, &original, &source, &original)
            .unwrap();
        let record = root.join(&candidate.id);
        let valid = std::fs::read(&record).unwrap();
        for offset in [8, 72, valid.len() - 1] {
            let mut bytes = valid.clone();
            bytes[offset] ^= 1;
            std::fs::write(&record, &bytes).unwrap();
            assert!(!store.list().unwrap()[0].valid);
            assert!(store
                .restore(&candidate.id, &dir.path().join("bad.docx"))
                .is_err());
            assert!(!dir.path().join("bad.docx").exists());
        }
        std::fs::write(&record, &valid).unwrap();
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .open(&record)
            .unwrap();
        f.seek(SeekFrom::End(0)).unwrap();
        f.write_all(b"tail").unwrap();
        assert!(!store.list().unwrap()[0].valid);
        std::fs::remove_file(&record).unwrap();
        std::os::unix::fs::symlink(&source, &record).unwrap();
        assert!(!store.list().unwrap()[0].valid);
        assert!(store.discard("../original.docx").is_err());
        store.discard(&candidate.id).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), original);
    }
    #[test]
    #[ignore = "helper invoked only by SIGKILL parent test"]
    fn recovery_crash_child() {
        let Some(root) = std::env::var_os("GEUL_RECOVERY_CRASH_CHILD") else {
            return;
        };
        let root = PathBuf::from(root);
        let source = root.join("original.docx");
        let (registry, info, original) = setup(&source);
        let store = RecoveryStore::new(root.join("records"));
        let output = edited(&original);
        let ticket = registry.begin_save(info.session_id, 1, 1).unwrap();
        publish::AFTER_STAGE.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(|_, _| {
                let marker = std::env::var_os("GEUL_RECOVERY_CRASH_MARKER").unwrap();
                std::fs::write(marker, b"staged").unwrap();
                loop {
                    std::thread::park();
                }
            }))
        });
        let _ = service::save_with_options(
            &registry,
            &ticket,
            &Limits::default(),
            &output,
            None,
            true,
            service::SaveOptions {
                destination: None,
                recovery: Some(&store),
            },
        );
        panic!("child must be killed while publication is interrupted");
    }
    #[test]
    fn sigkill_after_staging_is_detected_on_restart_without_overwriting_original() {
        let dir = TempDir::new();
        let marker = dir.path().join("staged.marker");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "services::recovery::tests::recovery_crash_child",
                "--nocapture",
            ])
            .env("GEUL_RECOVERY_CRASH_CHILD", dir.path())
            .env("GEUL_RECOVERY_CRASH_MARKER", &marker)
            .spawn()
            .unwrap();
        for _ in 0..200 {
            if marker.exists() {
                break;
            }
            if let Some(status) = child.try_wait().unwrap() {
                panic!("child exited before crash boundary: {status}");
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        if !marker.exists() {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("stage boundary not reached");
        }
        let original = std::fs::read(dir.path().join("original.docx")).unwrap();
        child.kill().unwrap();
        let status = child.wait().unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        let restarted = RecoveryStore::new(dir.path().join("records"));
        let candidates = restarted.list().unwrap();
        assert_eq!(candidates.len(), 1);
        assert!(candidates[0].valid);
        assert_eq!(
            std::fs::read(dir.path().join("original.docx")).unwrap(),
            original
        );
        let target = dir.path().join("after-crash.docx");
        restarted.restore(&candidates[0].id, &target).unwrap();
        assert_ne!(std::fs::read(&target).unwrap(), original);
        assert!(crate::adapters::wordcraft::engine::DocxModel::open(
            &std::fs::read(&target).unwrap()
        )
        .unwrap()
        .body_text()
        .contains("recover-content"));
        let again = RecoveryStore::new(dir.path().join("records"));
        assert_eq!(again.list().unwrap().len(), 1);
        assert!(again.restore(&candidates[0].id, &target).is_err());
        assert_eq!(
            std::fs::read(dir.path().join("original.docx")).unwrap(),
            original
        );
    }
    /// Save As with a published-but-unconfirmed result keeps the generation but changes the authoritative source path.
    fn save_as(
        durable: bool,
    ) -> (
        TempDir,
        SessionRegistry,
        u64,
        RecoveryStore,
        Vec<u8>,
        Vec<u8>,
    ) {
        let dir = TempDir::new();
        let source = dir.path().join("original.docx");
        let (registry, info, original) = setup(&source);
        let store = RecoveryStore::new(dir.path().join("records"));
        let output = edited(&original);
        let destination = dir.path().join("new.docx");
        let ticket = registry.begin_save(info.session_id, 1, 1).unwrap();
        if !durable {
            publish::FAULT.with(|fault| fault.set(Some(publish::Fault::DirSync)));
        }
        let saved = service::save_with_options(
            &registry,
            &ticket,
            &Limits::default(),
            &output,
            None,
            true,
            service::SaveOptions {
                destination: Some(&destination),
                recovery: Some(&store),
            },
        );
        publish::FAULT.with(|fault| fault.set(None));
        drop(ticket);
        let saved = saved.unwrap();
        assert_eq!(saved.durable, durable);
        assert_eq!(saved.session.dirty, !durable);
        assert_eq!(saved.session.load_generation, 1);
        assert_eq!(saved.session.display_name, "new.docx");
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert_eq!(std::fs::read(&destination).unwrap(), output);
        (dir, registry, info.session_id, store, original, output)
    }

    /// Commits one more edit against the Save As destination and records its fresh preflight.
    fn edit_after_save_as(registry: &SessionRegistry, session_id: u64, current: &[u8]) -> Vec<u8> {
        registry.commit(session_id, 1, 1, 1).unwrap();
        registry
            .record_preflight(
                session_id,
                1,
                content_hash(current),
                service::preflight(Format::Docx, current, current, None),
            )
            .unwrap();
        edited(current)
    }

    #[test]
    fn durable_save_as_clears_superseded_candidate_and_later_checkpoint_succeeds() {
        let (dir, registry, session_id, store, original, output) = save_as(true);
        assert!(store.list().unwrap().is_empty());
        let next = edit_after_save_as(&registry, session_id, &output);
        let destination = dir.path().join("new.docx");
        let ticket = registry.begin_save(session_id, 1, 2).unwrap();
        let checked =
            service::validate_snapshot(&ticket, &Limits::default(), &next, None, true).unwrap();
        let candidate = store
            .snapshot(&ticket, &checked, &destination, &next)
            .unwrap();
        assert_eq!(candidate.name, "new.docx");
        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(
            std::fs::read(dir.path().join("original.docx")).unwrap(),
            original
        );
        assert_eq!(std::fs::read(&destination).unwrap(), output);
    }

    #[test]
    fn unconfirmed_save_as_keeps_old_candidate_and_checkpoints_new_source_under_fresh_id() {
        let (dir, registry, session_id, store, original, output) = save_as(false);
        let source = dir.path().join("original.docx");
        let destination = dir.path().join("new.docx");
        let retained = store.list().unwrap();
        assert_eq!(retained.len(), 1);
        assert!(retained[0].valid);
        assert_eq!(retained[0].revision, Some(1));
        let next = edit_after_save_as(&registry, session_id, &output);
        let ticket = registry.begin_save(session_id, 1, 2).unwrap();
        assert_eq!(ticket.source.load.identity.path(), destination);
        let checked =
            service::validate_snapshot(&ticket, &Limits::default(), &next, None, true).unwrap();
        let candidate = store
            .snapshot(&ticket, &checked, &destination, &next)
            .expect("checkpoint for the Save As source must not reuse the old source's ID");
        assert_ne!(candidate.id, retained[0].id);
        // A later checkpoint for the same new source keeps replacing only its own record.
        registry.commit(session_id, 1, 2, 1).unwrap();
        drop(ticket);
        let ticket = registry.begin_save(session_id, 1, 3).unwrap();
        let again = store
            .snapshot(&ticket, &checked, &destination, &next)
            .unwrap();
        assert_eq!(again.id, candidate.id);
        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().all(|c| c.valid));
        let old_copy = dir.path().join("old-copy.docx");
        let new_copy = dir.path().join("new-copy.docx");
        store.restore(&retained[0].id, &old_copy).unwrap();
        store.restore(&candidate.id, &new_copy).unwrap();
        assert_eq!(std::fs::read(&old_copy).unwrap(), output);
        assert_eq!(std::fs::read(&new_copy).unwrap(), next);
        for target in [&source, &destination] {
            assert_eq!(
                store.restore(&candidate.id, target).unwrap_err(),
                DocumentError::FileConflict
            );
        }
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert_eq!(std::fs::read(&destination).unwrap(), output);
        store.forget_session(session_id).unwrap();
        assert!(store.list().unwrap().is_empty());
        assert!(store
            .snapshot(&ticket, &checked, &destination, &next)
            .is_err());
    }

    #[test]
    fn checkpoint_retry_without_source_change_reuses_its_own_record() {
        let dir = TempDir::new();
        let source = dir.path().join("source.docx");
        let (registry, info, original) = setup(&source);
        let store = RecoveryStore::new(dir.path().join("records"));
        let ticket = registry.begin_save(info.session_id, 1, 1).unwrap();
        let first = store
            .snapshot(&ticket, &original, &source, &original)
            .unwrap();
        let second = store
            .snapshot(&ticket, &original, &source, &original)
            .unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn stale_records_remain_explicitly_recoverable_and_storage_is_bounded() {
        let dir = TempDir::new();
        let source = dir.path().join("source.docx");
        let (registry, info, original) = setup(&source);
        let store = RecoveryStore::new(dir.path().join("records"));
        let ticket = registry.begin_save(info.session_id, 1, 1).unwrap();
        let candidate = store
            .snapshot(&ticket, &original, &source, &original)
            .unwrap();
        let held = store.directory().unwrap();
        let (mut header, bytes) = RecoveryStore::read(&held, &candidate.id).unwrap();
        header.created_at = 0;
        store.put(&held, header, &bytes).unwrap();
        assert!(store.list().unwrap()[0].stale);
        store
            .restore(&candidate.id, &dir.path().join("stale-copy.docx"))
            .unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert!(store
            .snapshot(&ticket, &original, &source, &vec![0; MAX_PAYLOAD + 1])
            .is_err());
        assert!(store.list().unwrap()[0].valid);
        store.discard(&candidate.id).unwrap();
        for i in 0..MAX_RECORDS {
            std::fs::write(
                RecoveryStore::base(&held).join(format!("{i:032x}.pending")),
                b"incomplete",
            )
            .unwrap();
        }
        assert!(store
            .snapshot(&ticket, &original, &source, &original)
            .is_err());
        assert_eq!(store.list().unwrap().len(), MAX_RECORDS);
        assert!(store.list().unwrap().iter().all(|c| !c.valid));
        assert_eq!(std::fs::read(&source).unwrap(), original);
    }
}
