//! Save staging ownership journal (T014 A): proof that a `.geul-save-*.tmp` file was created by geul, so a
//! file abandoned by an interrupted or crashed save can later be removed without touching anything else.
//!
//! A matching file name is never treated as proof of ownership. Automatic cleanup removes a staging file
//! only when all of the following hold:
//! - A record in the private journal directory (app data, `0700`, owned by this user, every ancestor
//!   trusted — the same policy as the recovery store) names the document directory path, its device/inode,
//!   the exact staging name, and the device/inode of the file this process created there with
//!   `O_CREAT|O_EXCL`. The inode line is appended only after the create succeeded, so a record can never
//!   claim an inode that geul did not create.
//! - The record is not locked. The owning save holds an exclusive `flock` on its record from creation to
//!   retirement; the kernel drops it when the process exits for any reason. A locked record (an active save
//!   in this or another geul instance) is skipped. No PID, age or name heuristic is used.
//! - The document directory, reopened from the root without following symlinks (`open_directory`), is the
//!   recorded device/inode and still passes the trusted-directory policy.
//! - At deletion time the name, examined relative to that directory handle without following links, is a
//!   regular file with the recorded device/inode, owned by this user, with a single link.
//!
//! Crash consistency (the record is written before the staging file can exist):
//! - before/while registering: the record is an anonymous locked inode (`O_TMPFILE`) linked as `<id>.save`
//!   only once its intent line is complete; a crash before the link leaves nothing. An intent-only
//!   `<id>.save` never authorizes deletion: a file present under that name is left untouched and the
//!   record is kept (unverified).
//! - after create, before/while the inode line is written: same as intent-only (a torn, unterminated
//!   tail is intent-only; any other extra content makes the record corrupt — `parse_record`).
//! - during writing, after fsync, before rename: full record, staging file present → removable when unlocked.
//! - after the successful rename: the staging name is gone → the record is retired after a directory fsync.
//! - during retirement: the record (or its unlink) may survive → the next pass sees the name absent and
//!   retires it again. Only a retirement confirmed by a journal directory fsync counts as `retired`.
//!
//! Durability: an unlink is reported as completed only after the document directory fsync succeeds; the
//! record is retired only then. A failed unlink or fsync keeps the record for a later pass. The residual
//! window between the final `fstatat` and `unlinkat` can only be exploited by parties the save threat model
//! already trusts (this user and root), exactly like the publication window in `publish.rs`.
//!
//! Journaling is best effort for saving: if the journal is unavailable, saving proceeds as before and the
//! staging file simply has no ownership evidence (an interrupted save then leaves it untouched, as before).
//! Files from earlier versions or other programs have no record and are never removed.

use std::ffi::{CStr, CString};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::publish::{open_at, open_directory, trusted_directory};

/// Upper bound of one record (two short JSON lines).
const MAX_RECORD: u64 = 8 * 1024;
/// Upper bound of journal records examined in one cleanup pass.
const MAX_SCAN: usize = 512;
/// Upper bound of directory names listed in one pass (bounded memory/time for selecting the batch).
const MAX_LIST: usize = 1 << 16;
const STAGING_PREFIX: &str = ".geul-save-";
const STAGING_SUFFIX: &str = ".tmp";

static ROOT: OnceLock<PathBuf> = OnceLock::new();

#[cfg(test)]
thread_local! {
    /// Tests configure their own journal per thread; production uses `ROOT` only.
    pub(crate) static TEST_ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
    pub(crate) static FAULT: std::cell::Cell<Option<Fault>> = const { std::cell::Cell::new(None) };
}

/// Test-only fault injection for cleanup.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Fault {
    /// `unlinkat` of a verified staging file fails.
    Unlink,
    /// The document directory fsync after a cleanup unlink fails.
    DirSync,
    /// `unlinkat` of a journal record (retirement) fails.
    JournalUnlink,
    /// The journal directory fsync after a record retirement fails.
    JournalSync,
}

#[cfg(test)]
thread_local! {
    /// Called between the first identity check and the revalidation before `unlinkat` (path replacement race).
    pub(crate) static BEFORE_UNLINK: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
    /// Called during registration after the record inode exists and before it is locked/visible.
    pub(crate) static DURING_REGISTER: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn fault() -> Option<Fault> {
    FAULT.with(std::cell::Cell::get)
}

/// Configure the journal directory once at startup (absolute path in private app data).
pub fn configure(root: PathBuf) {
    let _ = ROOT.set(root);
}

fn root() -> Option<PathBuf> {
    #[cfg(test)]
    {
        TEST_ROOT.with(|root| root.borrow().clone())
    }
    #[cfg(not(test))]
    {
        ROOT.get().cloned()
    }
}

fn euid() -> u32 {
    // SAFETY: geteuid has no arguments and cannot fail.
    unsafe { libc::geteuid() }
}

/// Open (creating if needed) the private journal directory: absolute, every ancestor trusted, owned by
/// this user, no group/other permissions. Anything else disables journaling.
fn directory(create: bool) -> Option<File> {
    use std::os::unix::fs::DirBuilderExt;
    let root = root()?;
    if !root.is_absolute() {
        return None;
    }
    if create {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&root)
            .ok()?;
    }
    let dir = open_directory(&root, euid()).ok()?;
    let meta = dir.metadata().ok()?;
    (meta.is_dir() && meta.uid() == euid() && meta.mode() & 0o077 == 0).then_some(dir)
}

fn random_id() -> Option<String> {
    let mut random = [0u8; 16];
    let mut at = 0;
    while at < random.len() {
        // SAFETY: valid remaining byte slice; no optional flags.
        let n = unsafe { libc::getrandom(random[at..].as_mut_ptr().cast(), random.len() - at, 0) };
        if n < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return None;
        }
        if n == 0 {
            return None;
        }
        at += n as usize;
    }
    Some(random.iter().map(|b| format!("{b:02x}")).collect())
}

fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Intent {
    pub(crate) v: u32,
    pub(crate) dir: String,
    pub(crate) dir_dev: u64,
    pub(crate) dir_ino: u64,
    pub(crate) name: String,
    pub(crate) created_at: u64,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Created {
    pub(crate) dev: u64,
    pub(crate) ino: u64,
}

/// One checksummed line: `<json>\t<sha256(json)>\n`.
pub(crate) fn line<T: Serialize>(value: &T) -> Option<Vec<u8>> {
    let json = serde_json::to_vec(value).ok()?;
    let mut out = json.clone();
    out.push(b'\t');
    out.extend_from_slice(digest(&json).as_bytes());
    out.push(b'\n');
    Some(out)
}

fn parse_line<T: for<'de> Deserialize<'de>>(line: &[u8]) -> Option<T> {
    let tab = line.iter().rposition(|b| *b == b'\t')?;
    let (json, sum) = (&line[..tab], &line[tab + 1..]);
    if sum != digest(json).as_bytes() {
        return None;
    }
    serde_json::from_slice(json).ok()
}

/// A staging name produced by `publish::temp_name`: exact prefix/suffix, one path component.
fn staging_name(name: &str) -> bool {
    name.len() <= 255
        && name.starts_with(STAGING_PREFIX)
        && name.ends_with(STAGING_SUFFIX)
        && !name.contains('/')
        && !name.contains('\0')
}

/// Parse a record, which must be exactly one of:
/// - `intent\n` — intent only;
/// - `intent\n` + an unterminated tail — a torn append of the inode line (crash while writing): intent only;
/// - `intent\n` + `created\n` — complete, and nothing after it.
///
/// `None` = corrupt: malformed/unsupported intent, a terminated second line that is not a valid created
/// line, or any content after the created line. Intent-only and corrupt records never authorize deletion.
fn parse_record(bytes: &[u8]) -> Option<(Intent, Option<Created>)> {
    let end = bytes.iter().position(|b| *b == b'\n')?;
    let intent: Intent = parse_line(&bytes[..end])?;
    if intent.v != 1 || !Path::new(&intent.dir).is_absolute() || !staging_name(&intent.name) {
        return None;
    }
    let rest = &bytes[end + 1..];
    match rest.iter().position(|b| *b == b'\n') {
        None => Some((intent, None)),
        Some(n) if n + 1 == rest.len() => Some((intent, Some(parse_line(&rest[..n])?))),
        Some(_) => None,
    }
}

fn lock(file: &File, blocking: bool) -> io::Result<bool> {
    let mut operation = libc::LOCK_EX;
    if !blocking {
        operation |= libc::LOCK_NB;
    }
    loop {
        // SAFETY: live file descriptor owned by `file`.
        if unsafe { libc::flock(file.as_raw_fd(), operation) } == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        match error.kind() {
            io::ErrorKind::Interrupted => continue,
            io::ErrorKind::WouldBlock => return Ok(false),
            _ => return Err(error),
        }
    }
}

fn unlink_at(dir: &File, name: &CStr) -> io::Result<()> {
    // SAFETY: live directory descriptor and NUL-terminated single component name.
    if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Outcome of removing a journal record name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Retirement {
    /// Name removed (or already absent) and the journal directory fsync succeeded.
    Confirmed,
    /// Name removed in the running system, but the directory fsync failed: after a crash the record may
    /// reappear, and the next cleanup pass then re-evaluates it from scratch (idempotent).
    Unconfirmed,
    /// The name could not be removed; the record stays for a later pass.
    Failed,
}

fn retire_record(journal: &File, name: &CStr) -> Retirement {
    #[cfg(test)]
    let unlinked = if fault() == Some(Fault::JournalUnlink) {
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    } else {
        unlink_at(journal, name)
    };
    #[cfg(not(test))]
    let unlinked = unlink_at(journal, name);
    match unlinked {
        Ok(()) => {}
        // Already absent (another pass retired it): confirm the directory state like a fresh removal.
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Retirement::Failed,
    }
    #[cfg(test)]
    let synced = fault() != Some(Fault::JournalSync) && journal.sync_all().is_ok();
    #[cfg(not(test))]
    let synced = journal.sync_all().is_ok();
    if synced {
        Retirement::Confirmed
    } else {
        Retirement::Unconfirmed
    }
}

/// `fstatat(dir, name, AT_SYMLINK_NOFOLLOW)`.
fn stat_at(dir: &File, name: &CStr) -> io::Result<libc::stat> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: live directory descriptor, NUL-terminated name, stat buffer to fill.
    let result = unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fstatat succeeded and filled the buffer.
    Ok(unsafe { stat.assume_init() })
}

/// The ownership record of one staging attempt, locked for as long as this value lives.
pub struct Entry {
    journal: File,
    record: File,
    name: CString,
}

/// Register an intent to create `temp` inside the verified document directory `dir` (path `dir_path`).
/// Returns `None` when journaling is unavailable; the caller then stages without ownership evidence.
pub(crate) fn register(dir: &File, dir_path: &Path, temp: &CStr) -> Option<Entry> {
    let journal = directory(true)?;
    let dir_meta = dir.metadata().ok()?;
    let intent = Intent {
        v: 1,
        dir: dir_path.to_str()?.to_owned(),
        dir_dev: dir_meta.dev(),
        dir_ino: dir_meta.ino(),
        name: temp.to_str().ok()?.to_owned(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs()),
    };
    if !staging_name(&intent.name) {
        return None;
    }
    let id = random_id()?;
    let name = CString::new(format!("{id}.save")).ok()?;
    // The record is an anonymous inode (`O_TMPFILE`) until it is locked and its intent line is complete;
    // only then is it linked under its final name (create-only: `linkat` never replaces). Cleanup can
    // therefore never observe an unlocked, half-registered record, and a crash before the link leaves
    // nothing behind. Without `O_TMPFILE` support journaling is simply unavailable (fail closed).
    let mut record = open_at(&journal, c".", libc::O_TMPFILE | libc::O_RDWR, 0o600).ok()?;
    #[cfg(test)]
    DURING_REGISTER.with(|hook| {
        if let Some(hook) = hook.borrow().as_ref() {
            hook();
        }
    });
    if lock(&record, false).ok() != Some(true)
        || !line(&intent).is_some_and(|bytes| record.write_all(&bytes).is_ok())
    {
        return None;
    }
    #[cfg(test)]
    DURING_REGISTER.with(|hook| {
        if let Some(hook) = hook.borrow().as_ref() {
            hook();
        }
    });
    let anonymous = CString::new(format!("/proc/self/fd/{}", record.as_raw_fd())).ok()?;
    // SAFETY: NUL-terminated /proc path of our own descriptor, held journal directory, single-component
    // name. AT_SYMLINK_FOLLOW resolves the magic link to the anonymous inode; EEXIST never replaces.
    let linked = unsafe {
        libc::linkat(
            libc::AT_FDCWD,
            anonymous.as_ptr(),
            journal.as_raw_fd(),
            name.as_ptr(),
            libc::AT_SYMLINK_FOLLOW,
        )
    } == 0;
    if !linked {
        return None;
    }
    Some(Entry {
        journal,
        record,
        name,
    })
}

impl Entry {
    /// Record the inode this process just created with `O_EXCL`, then make the record durable before any
    /// document bytes are written. A failure leaves an intent-only record (never authorizes deletion).
    pub(crate) fn created(&mut self, created: &std::fs::Metadata) -> bool {
        let Some(bytes) = line(&Created {
            dev: created.dev(),
            ino: created.ino(),
        }) else {
            return false;
        };
        self.record.write_all(&bytes).is_ok()
            && self.record.sync_all().is_ok()
            && self.journal.sync_all().is_ok()
    }

    /// The staging name no longer holds a file of this save (published, removed and confirmed, or
    /// replaced by something else): drop the record. A failed or unconfirmed retirement leaves (or may
    /// resurrect after a crash) a record that the next cleanup pass only retires again, because the name
    /// no longer holds the recorded inode. Never a document-save failure.
    pub(crate) fn retire(self) -> Retirement {
        retire_record(&self.journal, &self.name)
    }

    /// Keep the record (unlocked by closing) for a later cleanup pass: removal not confirmed.
    pub(crate) fn release(self) {}
}

/// Outcome counts of one cleanup pass (no paths, so it can be reported without leaking file names).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// Abandoned staging files removed and confirmed by a directory fsync.
    pub removed: usize,
    /// Records whose retirement was durably confirmed without deleting anything (name absent or holding
    /// another file).
    pub retired: usize,
    /// Records of active saves (locked by a live owner).
    pub active: usize,
    /// Records kept because ownership could not be proven (intent-only with a file present, corrupt
    /// record, directory missing/moved/untrusted, unexpected metadata).
    pub unverified: usize,
    /// Removal or confirmation failures: staging unlink/document-directory fsync failed (record kept), or
    /// the record retirement failed/was unconfirmed (counted in addition to `removed` when the file
    /// removal itself was confirmed).
    pub failed: usize,
}

/// Run one bounded cleanup pass over the configured journal. Never scans document directories beyond
/// the single recorded name of each record.
///
/// Fair bounded traversal: record IDs are visited in ID order starting after a persisted cursor, at most
/// `MAX_SCAN` records per pass, wrapping around; the cursor then names the last record visited. Records
/// that stay unprocessable (corrupt, unverified, active) therefore cannot starve later ones across
/// passes. Directory listing itself stops after `MAX_LIST` names (beyond that, listing order decides).
/// Only `<32 hex>.save` names are records; other names (including legacy `.new` files of the 8071d3f
/// protocol, which an older instance may be registering) are never touched.
pub fn cleanup() -> Report {
    let mut report = Report::default();
    let Some(journal) = directory(false) else {
        return report;
    };
    let Ok(entries) = std::fs::read_dir(format!("/proc/self/fd/{}", journal.as_raw_fd())) else {
        return report;
    };
    let names = entries
        .take(MAX_LIST)
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok());
    let batch = select_batch(names, read_cursor(&journal).as_deref(), MAX_SCAN);
    for id in &batch {
        if let Ok(name) = CString::new(format!("{id}.save")) {
            cleanup_record(&journal, &name, &mut report);
        }
    }
    if let Some(last) = batch.last() {
        write_cursor(&journal, last);
    }
    report
}

/// The next batch of at most `limit` record IDs from a listing (any order): the smallest IDs after
/// `cursor` in ID order, then — wrapping around — the smallest up to and including it. Non-record names
/// are ignored. Independent of listing order, so repeated passes visit every listed record.
fn select_batch(
    names: impl Iterator<Item = String>,
    cursor: Option<&str>,
    limit: usize,
) -> Vec<String> {
    let mut after = std::collections::BinaryHeap::new();
    let mut before = std::collections::BinaryHeap::new();
    for name in names {
        let Some(id) = name.strip_suffix(".save").filter(|id| record_id(id)) else {
            continue;
        };
        let heap = if cursor.is_some_and(|c| id <= c) {
            &mut before
        } else {
            &mut after
        };
        heap.push(id.to_owned());
        if heap.len() > limit {
            heap.pop();
        }
    }
    let mut batch = after.into_sorted_vec();
    let mut wrapped = before.into_sorted_vec();
    wrapped.truncate(limit - batch.len());
    batch.extend(wrapped);
    batch
}

const CURSOR: &CStr = c"cursor";

fn record_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The last visited record ID, or `None` (start from the beginning) when absent or not exactly an ID.
fn read_cursor(journal: &File) -> Option<String> {
    let file = open_at(journal, CURSOR, libc::O_RDONLY | libc::O_NONBLOCK, 0).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.uid() != euid() || meta.len() != 32 {
        return None;
    }
    let mut id = String::new();
    file.take(33).read_to_string(&mut id).ok()?;
    record_id(&id).then_some(id)
}

/// Best effort: the cursor only affects fairness, never deletion eligibility. A fixed-size in-place write
/// (no temporary names); a torn or concurrent write just yields an invalid cursor (restart from the
/// beginning) or another instance's position.
fn write_cursor(journal: &File, id: &str) {
    use std::os::unix::fs::FileExt;
    let Ok(file) = open_at(journal, CURSOR, libc::O_WRONLY | libc::O_CREAT, 0o600) else {
        return;
    };
    if file
        .metadata()
        .is_ok_and(|m| m.is_file() && m.uid() == euid())
    {
        let _ = file
            .write_all_at(id.as_bytes(), 0)
            .and_then(|_| file.set_len(32));
    }
}

fn same_object(dir: &File, name: &CStr, held: &std::fs::Metadata) -> bool {
    stat_at(dir, name).is_ok_and(|stat| {
        stat.st_mode & libc::S_IFMT == libc::S_IFREG
            && (stat.st_dev, stat.st_ino) == (held.dev(), held.ino())
    })
}

fn cleanup_record(journal: &File, name: &CStr, report: &mut Report) {
    let Ok(mut record) = open_at(journal, name, libc::O_RDWR | libc::O_NONBLOCK, 0) else {
        report.unverified += 1;
        return;
    };
    let Ok(meta) = record.metadata() else {
        report.unverified += 1;
        return;
    };
    if !meta.is_file() || meta.uid() != euid() || meta.len() > MAX_RECORD {
        report.unverified += 1;
        return;
    }
    match lock(&record, false) {
        Ok(true) => {}
        Ok(false) => {
            report.active += 1;
            return;
        }
        Err(_) => {
            report.unverified += 1;
            return;
        }
    }
    // The owner may have retired (unlinked) the record between our open and lock.
    let Ok(meta) = record.metadata() else {
        report.unverified += 1;
        return;
    };
    if meta.nlink() != 1 || !same_object(journal, name, &meta) {
        return;
    }
    let mut bytes = Vec::new();
    if (&mut record)
        .take(MAX_RECORD + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        report.unverified += 1;
        return;
    }
    let Some((intent, created)) = parse_record(&bytes) else {
        report.unverified += 1;
        return;
    };
    let retire = |report: &mut Report| match retire_record(journal, name) {
        Retirement::Confirmed => report.retired += 1,
        Retirement::Unconfirmed | Retirement::Failed => report.failed += 1,
    };
    // The recorded directory, reopened from the root without following links and still trusted.
    let Ok(dir) = open_directory(Path::new(&intent.dir), euid()) else {
        report.unverified += 1;
        return;
    };
    let Ok(dir_meta) = dir.metadata() else {
        report.unverified += 1;
        return;
    };
    if (dir_meta.dev(), dir_meta.ino()) != (intent.dir_dev, intent.dir_ino)
        || trusted_directory(&dir, &dir_meta, euid(), euid()).is_err()
    {
        report.unverified += 1;
        return;
    }
    let Ok(staging) = CString::new(intent.name.as_str()) else {
        report.unverified += 1;
        return;
    };
    let stat = match stat_at(&dir, &staging) {
        Ok(stat) => stat,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // Nothing of ours is left under that name. Confirm the directory state before forgetting it
            // (a rename or earlier unlink might not be durable yet).
            if dir.sync_all().is_ok() {
                retire(report);
            } else {
                report.failed += 1;
            }
            return;
        }
        Err(_) => {
            report.unverified += 1;
            return;
        }
    };
    let Some(created) = created else {
        // Intent-only: a file exists, but there is no proof this process created it.
        report.unverified += 1;
        return;
    };
    let regular = stat.st_mode & libc::S_IFMT == libc::S_IFREG;
    let same = (stat.st_dev, stat.st_ino) == (created.dev, created.ino);
    if !regular || !same {
        // The name holds something else (replaced, symlink, directory): never ours to delete.
        retire(report);
        return;
    }
    if stat.st_uid != euid() || stat.st_nlink != 1 {
        report.unverified += 1;
        return;
    }
    #[cfg(test)]
    BEFORE_UNLINK.with(|hook| {
        if let Some(hook) = hook.borrow().as_ref() {
            hook();
        }
    });
    // Revalidate at the point of deletion, relative to the same directory handle.
    let still = stat_at(&dir, &staging).is_ok_and(|now| {
        now.st_mode & libc::S_IFMT == libc::S_IFREG
            && (now.st_dev, now.st_ino) == (created.dev, created.ino)
            && now.st_uid == euid()
            && now.st_nlink == 1
    });
    if !still {
        report.unverified += 1;
        return;
    }
    #[cfg(test)]
    let unlinked = if fault() == Some(Fault::Unlink) {
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    } else {
        unlink_at(&dir, &staging)
    };
    #[cfg(not(test))]
    let unlinked = unlink_at(&dir, &staging);
    if unlinked.is_err() {
        report.failed += 1;
        return;
    }
    #[cfg(test)]
    let synced = fault() != Some(Fault::DirSync) && dir.sync_all().is_ok();
    #[cfg(not(test))]
    let synced = dir.sync_all().is_ok();
    if !synced {
        // Removal not confirmed durable: keep the record (the next pass sees the name absent,
        // syncs again and only then retires it).
        report.failed += 1;
        return;
    }
    report.removed += 1;
    if retire_record(journal, name) != Retirement::Confirmed {
        report.failed += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::testutil::TempDir;
    use crate::services::save::publish;
    use std::os::unix::fs::{symlink, PermissionsExt};

    struct Setup {
        _tmp: TempDir,
        docs: PathBuf,
        journal: PathBuf,
        target: PathBuf,
    }

    impl Drop for Setup {
        fn drop(&mut self) {
            TEST_ROOT.with(|root| *root.borrow_mut() = None);
            FAULT.with(|f| f.set(None));
            BEFORE_UNLINK.with(|hook| *hook.borrow_mut() = None);
            DURING_REGISTER.with(|hook| *hook.borrow_mut() = None);
        }
    }

    fn setup() -> Setup {
        let tmp = TempDir::new();
        let docs = tmp.path().join("docs");
        std::fs::create_dir(&docs).unwrap();
        std::fs::set_permissions(&docs, std::fs::Permissions::from_mode(0o700)).unwrap();
        let journal = tmp.path().join("journal");
        TEST_ROOT.with(|root| *root.borrow_mut() = Some(journal.clone()));
        let target = docs.join("original.hwp");
        std::fs::write(&target, b"original").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        Setup {
            _tmp: tmp,
            docs,
            journal,
            target,
        }
    }

    fn staging(dir: &Path) -> Vec<PathBuf> {
        let mut found: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(STAGING_PREFIX))
            })
            .collect();
        found.sort();
        found
    }

    /// Journal record files (`.save`/`.new`); the traversal cursor is not a record.
    fn records(journal: &Path) -> Vec<PathBuf> {
        match std::fs::read_dir(journal) {
            Ok(entries) => entries
                .map(|e| e.unwrap().path())
                .filter(|p| p.extension().is_some_and(|e| e == "save" || e == "new"))
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// A staged save abandoned like a crashed process (file + unlocked record left behind).
    fn abandoned(s: &Setup) -> PathBuf {
        let staged = publish::stage(&s.target, b"interrupted").unwrap();
        let found = staging(&s.docs);
        assert_eq!(found.len(), 1);
        staged.abandon();
        assert_eq!(records(&s.journal).len(), 1);
        found[0].clone()
    }

    fn write_record(s: &Setup, name: &str, created: Option<(u64, u64)>, torn: bool) -> PathBuf {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .create(&s.journal)
            .unwrap();
        std::fs::set_permissions(&s.journal, std::fs::Permissions::from_mode(0o700)).unwrap();
        let meta = std::fs::metadata(&s.docs).unwrap();
        let mut bytes = line(&Intent {
            v: 1,
            dir: s.docs.to_str().unwrap().into(),
            dir_dev: meta.dev(),
            dir_ino: meta.ino(),
            name: name.into(),
            created_at: 1,
        })
        .unwrap();
        if let Some((dev, ino)) = created {
            let mut second = line(&Created { dev, ino }).unwrap();
            if torn {
                second.truncate(second.len() / 2);
            }
            bytes.extend(second);
        }
        let path = s.journal.join(format!("{}.save", "ab".repeat(16)));
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap()
            .write_all(&bytes)
            .unwrap();
        path
    }

    #[test]
    fn proven_abandoned_staging_file_is_removed_and_the_original_is_untouched() {
        let s = setup();
        let orphan = abandoned(&s);
        assert!(orphan.exists());
        let report = cleanup();
        assert_eq!(
            report,
            Report {
                removed: 1,
                ..Default::default()
            }
        );
        assert!(staging(&s.docs).is_empty());
        assert!(records(&s.journal).is_empty());
        assert_eq!(std::fs::read(&s.target).unwrap(), b"original");
        // Idempotent: nothing left to do.
        assert_eq!(cleanup(), Report::default());
    }

    #[test]
    fn successful_and_failed_saves_leave_no_staging_file_or_record() {
        let s = setup();
        let mut staged = publish::stage(&s.target, b"saved").unwrap();
        assert_eq!(records(&s.journal).len(), 1);
        let published = publish::publish(&mut staged, &s.target).unwrap();
        assert!(published.durable);
        drop(staged);
        assert!(records(&s.journal).is_empty());
        assert_eq!(std::fs::read(&s.target).unwrap(), b"saved");
        // A failed (dropped) staging removes its file durably, then its record.
        drop(publish::stage(&s.target, b"dropped").unwrap());
        assert!(staging(&s.docs).is_empty());
        assert!(records(&s.journal).is_empty());
        assert_eq!(std::fs::read(&s.target).unwrap(), b"saved");
    }

    #[test]
    fn active_staging_and_another_instance_lock_are_never_cleaned() {
        let s = setup();
        let staged = publish::stage(&s.target, b"active").unwrap();
        let report = cleanup();
        assert_eq!(report.active, 1);
        assert_eq!(report.removed, 0);
        assert_eq!(staging(&s.docs).len(), 1);
        drop(staged);
        // Another live owner (separate open file description, e.g. a concurrent geul instance).
        let orphan = abandoned(&s);
        let record = records(&s.journal).pop().unwrap();
        let holder = File::open(&record).unwrap();
        assert!(lock(&holder, false).unwrap());
        assert_eq!(cleanup().active, 1);
        assert!(orphan.exists());
        drop(holder);
        assert_eq!(cleanup().removed, 1);
        assert!(!orphan.exists());
    }

    #[test]
    fn foreign_files_matching_the_pattern_and_legacy_orphans_are_untouched() {
        let s = setup();
        let foreign = s
            .docs
            .join(format!(".geul-save-1-0-{}.tmp", "0".repeat(32)));
        std::fs::write(&foreign, b"foreign").unwrap();
        std::fs::create_dir_all(&s.journal).unwrap();
        std::fs::set_permissions(&s.journal, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(cleanup(), Report::default());
        assert_eq!(std::fs::read(&foreign).unwrap(), b"foreign");
        assert_eq!(std::fs::read(&s.target).unwrap(), b"original");
    }

    #[test]
    fn replaced_name_symlink_and_hard_link_are_never_deleted() {
        let s = setup();
        // Different inode under the recorded name: not ours, record retired, file kept.
        let orphan = abandoned(&s);
        let replacement = s.docs.join("replacement");
        std::fs::write(&replacement, b"user data").unwrap();
        std::fs::rename(&replacement, &orphan).unwrap();
        assert_eq!(cleanup().retired, 1);
        assert_eq!(std::fs::read(&orphan).unwrap(), b"user data");
        std::fs::remove_file(&orphan).unwrap();
        // Symlink under the recorded name (pointing at the original): neither is touched.
        let orphan = abandoned(&s);
        std::fs::remove_file(&orphan).unwrap();
        symlink(&s.target, &orphan).unwrap();
        assert_eq!(cleanup().retired, 1);
        assert!(std::fs::symlink_metadata(&orphan)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(&s.target).unwrap(), b"original");
        std::fs::remove_file(&orphan).unwrap();
        // Our inode, but hard-linked elsewhere: not proven safe, both names and the record kept.
        let orphan = abandoned(&s);
        let other = s.docs.join("linked");
        std::fs::hard_link(&orphan, &other).unwrap();
        assert_eq!(cleanup().unverified, 1);
        assert!(orphan.exists() && other.exists());
        assert_eq!(records(&s.journal).len(), 1);
    }

    #[test]
    fn replacement_between_check_and_unlink_is_detected() {
        let s = setup();
        let orphan = abandoned(&s);
        let swap = orphan.clone();
        let docs = s.docs.clone();
        BEFORE_UNLINK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                let other = docs.join("other");
                std::fs::write(&other, b"raced").unwrap();
                std::fs::rename(&other, &swap).unwrap();
            }))
        });
        assert_eq!(cleanup().unverified, 1);
        assert_eq!(std::fs::read(&orphan).unwrap(), b"raced");
        assert_eq!(records(&s.journal).len(), 1);
    }

    #[test]
    fn directory_path_replacement_cannot_redirect_deletion() {
        let s = setup();
        let orphan = abandoned(&s);
        let name = orphan.file_name().unwrap().to_owned();
        // Move the real directory away and point the recorded path at it through a symlink.
        let moved = s.docs.with_file_name("moved");
        std::fs::rename(&s.docs, &moved).unwrap();
        symlink(&moved, &s.docs).unwrap();
        assert_eq!(cleanup().unverified, 1);
        assert!(moved.join(&name).exists());
        // A different real directory at the recorded path holding the same name: identity mismatch.
        std::fs::remove_file(&s.docs).unwrap();
        std::fs::create_dir(&s.docs).unwrap();
        std::fs::set_permissions(&s.docs, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(s.docs.join(&name), b"other directory").unwrap();
        assert_eq!(cleanup().unverified, 1);
        assert_eq!(
            std::fs::read(s.docs.join(&name)).unwrap(),
            b"other directory"
        );
        assert!(moved.join(&name).exists());
        assert_eq!(records(&s.journal).len(), 1);
    }

    #[test]
    fn crash_during_registration_never_authorizes_deletion() {
        let s = setup();
        let name = format!(".geul-save-1-0-{}.tmp", "1".repeat(32));
        let file = s.docs.join(&name);
        std::fs::write(&file, b"unknown").unwrap();
        let meta = std::fs::metadata(&file).unwrap();
        // Intent only (crash after create, before the inode line).
        let record = write_record(&s, &name, None, false);
        assert_eq!(cleanup().unverified, 1);
        assert!(file.exists() && record.exists());
        std::fs::remove_file(&record).unwrap();
        // Torn inode line (crash while appending) is intent-only too.
        let record = write_record(&s, &name, Some((meta.dev(), meta.ino())), true);
        assert_eq!(cleanup().unverified, 1);
        assert!(file.exists() && record.exists());
        std::fs::remove_file(&record).unwrap();
        // A corrupt intent line is never interpreted.
        std::fs::write(
            s.journal.join(format!("{}.save", "cd".repeat(16))),
            b"{}\tbad\n",
        )
        .unwrap();
        assert_eq!(cleanup().unverified, 1);
        assert!(file.exists());
        // A `.new` name (only the 8071d3f protocol created one) is never deleted: an older instance may be
        // registering it right now, and it never names a staging file (T014 stabilization, item 5).
        std::fs::remove_file(s.journal.join(format!("{}.save", "cd".repeat(16)))).unwrap();
        let new = s.journal.join(format!("{}.new", "ef".repeat(16)));
        std::fs::write(&new, b"partial").unwrap();
        assert_eq!(cleanup(), Report::default());
        assert!(new.exists());
        assert!(file.exists());
    }

    #[test]
    fn crash_during_retirement_only_retires_the_record() {
        let s = setup();
        // The staging name was already published (renamed) before the crash: name absent.
        let name = format!(".geul-save-1-0-{}.tmp", "2".repeat(32));
        let meta = std::fs::metadata(&s.target).unwrap();
        let record = write_record(&s, &name, Some((meta.dev(), meta.ino())), false);
        assert_eq!(cleanup().retired, 1);
        assert!(!record.exists());
        assert_eq!(std::fs::read(&s.target).unwrap(), b"original");
    }

    #[test]
    fn unlink_or_directory_sync_failure_keeps_the_ownership_record() {
        let s = setup();
        let orphan = abandoned(&s);
        FAULT.with(|f| f.set(Some(Fault::Unlink)));
        assert_eq!(cleanup().failed, 1);
        assert!(orphan.exists());
        assert_eq!(records(&s.journal).len(), 1);
        FAULT.with(|f| f.set(Some(Fault::DirSync)));
        let report = cleanup();
        assert_eq!((report.failed, report.removed), (1, 0));
        assert!(!orphan.exists());
        // Removal not confirmed durable: the record survives until a successful sync.
        assert_eq!(records(&s.journal).len(), 1);
        FAULT.with(|f| f.set(None));
        assert_eq!(cleanup().retired, 1);
        assert!(records(&s.journal).is_empty());
    }

    #[test]
    fn unavailable_or_untrusted_journal_disables_evidence_but_not_saving() {
        let s = setup();
        std::fs::create_dir_all(&s.journal).unwrap();
        std::fs::set_permissions(&s.journal, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut staged = publish::stage(&s.target, b"saved").unwrap();
        assert!(records(&s.journal).is_empty());
        assert!(publish::publish(&mut staged, &s.target).unwrap().durable);
        assert_eq!(std::fs::read(&s.target).unwrap(), b"saved");
        // Unjournaled abandoned file is never cleaned.
        std::fs::set_permissions(&s.journal, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::remove_dir(&s.journal).unwrap();
        TEST_ROOT.with(|root| *root.borrow_mut() = None);
        publish::stage(&s.target, b"x").unwrap().abandon();
        TEST_ROOT.with(|root| *root.borrow_mut() = Some(s.journal.clone()));
        assert_eq!(cleanup(), Report::default());
        assert_eq!(staging(&s.docs).len(), 1);
    }

    // ---- T014 A/B stabilization (2026-11-09) ----

    fn intent_line(s: &Setup, name: &str) -> Vec<u8> {
        let meta = std::fs::metadata(&s.docs).unwrap();
        line(&Intent {
            v: 1,
            dir: s.docs.to_str().unwrap().into(),
            dir_dev: meta.dev(),
            dir_ino: meta.ino(),
            name: name.into(),
            created_at: 1,
        })
        .unwrap()
    }

    #[test]
    fn record_parsing_accepts_only_the_exact_one_or_two_line_format() {
        let s = setup();
        let name = format!(".geul-save-1-0-{}.tmp", "3".repeat(32));
        let intent = intent_line(&s, &name);
        let created = line(&Created { dev: 1, ino: 2 }).unwrap();
        let full = [intent.clone(), created.clone()].concat();
        assert!(matches!(parse_record(&intent), Some((_, None))));
        assert!(matches!(
            parse_record(&full),
            Some((_, Some(Created { dev: 1, ino: 2 })))
        ));
        // Torn created line (crash while appending): intent only, never ownership.
        for cut in [1, created.len() / 2, created.len() - 1] {
            let torn = [intent.clone(), created[..cut].to_vec()].concat();
            assert!(matches!(parse_record(&torn), Some((_, None))), "cut {cut}");
        }
        // Anything beyond the documented lines, or a malformed intent, is corrupt.
        let mut bad_sum = full.clone();
        let at = intent.len() + created.len() - 2;
        bad_sum[at] = if bad_sum[at] == b'0' { b'1' } else { b'0' };
        for corrupt in [
            [full.clone(), created.clone()].concat(),
            [full.clone(), b"x".to_vec()].concat(),
            [full.clone(), b"\n".to_vec()].concat(),
            [intent.clone(), b"\n".to_vec(), created.clone()].concat(),
            [intent.clone(), b"garbage\n".to_vec()].concat(),
            bad_sum,
            intent[..intent.len() - 1].to_vec(),
            b"{}\tbad\n".to_vec(),
            Vec::new(),
        ] {
            let parsed = parse_record(&corrupt);
            assert!(
                !matches!(parsed, Some((_, Some(_)))),
                "corrupt record must never carry ownership: {:?}",
                String::from_utf8_lossy(&corrupt)
            );
        }
        assert!(parse_record(&[full.clone(), b"x".to_vec()].concat()).is_none());
        assert!(parse_record(&[full, created].concat()).is_none());
    }

    #[test]
    fn a_valid_record_with_trailing_content_never_deletes_the_staging_file() {
        let s = setup();
        for tail in [b"extra\n".to_vec(), b"x".to_vec(), b"\n".to_vec()] {
            let orphan = abandoned(&s);
            let record = records(&s.journal).pop().unwrap();
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&record)
                .unwrap();
            file.write_all(&tail).unwrap();
            drop(file);
            assert_eq!(cleanup().unverified, 1);
            assert!(orphan.exists(), "tail {tail:?}");
            assert!(record.exists());
            std::fs::remove_file(&record).unwrap();
            std::fs::remove_file(&orphan).unwrap();
        }
    }

    #[test]
    fn retirement_is_counted_only_when_durably_confirmed_and_reconciles_on_the_next_pass() {
        let s = setup();
        let name = format!(".geul-save-1-0-{}.tmp", "4".repeat(32));
        let meta = std::fs::metadata(&s.target).unwrap();
        // Record unlink fails: nothing retired, record kept for the next pass.
        let record = write_record(&s, &name, Some((meta.dev(), meta.ino())), false);
        FAULT.with(|f| f.set(Some(Fault::JournalUnlink)));
        let report = cleanup();
        assert_eq!((report.retired, report.failed), (0, 1));
        assert!(record.exists());
        // Unlink succeeds but the journal directory fsync fails: the name is gone in the running system,
        // yet the retirement is not reported as confirmed.
        FAULT.with(|f| f.set(Some(Fault::JournalSync)));
        let report = cleanup();
        assert_eq!((report.retired, report.failed), (0, 1));
        assert!(!record.exists());
        // If the unconfirmed unlink is lost by a crash, the reappearing record is simply re-evaluated.
        FAULT.with(|f| f.set(None));
        let record = write_record(&s, &name, Some((meta.dev(), meta.ino())), false);
        assert_eq!(cleanup().retired, 1);
        assert!(!record.exists());
        assert_eq!(cleanup(), Report::default());
        // The removal path keeps `removed` about the file and reports the record retirement separately.
        let orphan = abandoned(&s);
        FAULT.with(|f| f.set(Some(Fault::JournalSync)));
        let report = cleanup();
        assert_eq!((report.removed, report.retired, report.failed), (1, 0, 1));
        assert!(!orphan.exists());
        FAULT.with(|f| f.set(None));
        assert_eq!(std::fs::read(&s.target).unwrap(), b"original");
    }

    #[test]
    fn a_failed_record_retirement_never_fails_the_document_save() {
        let s = setup();
        FAULT.with(|f| f.set(Some(Fault::JournalUnlink)));
        let mut staged = publish::stage(&s.target, b"saved").unwrap();
        let published = publish::publish(&mut staged, &s.target).unwrap();
        drop(staged);
        FAULT.with(|f| f.set(None));
        assert!(published.durable);
        assert_eq!(std::fs::read(&s.target).unwrap(), b"saved");
        // The surviving record no longer names a file of that save and is retired by cleanup.
        assert_eq!(records(&s.journal).len(), 1);
        assert_eq!(cleanup().retired, 1);
        assert!(records(&s.journal).is_empty());
        assert!(staging(&s.docs).is_empty());
    }

    #[test]
    fn bounded_cleanup_passes_eventually_reach_a_record_behind_unprocessable_entries() {
        let s = setup();
        std::fs::create_dir_all(&s.journal).unwrap();
        std::fs::set_permissions(&s.journal, std::fs::Permissions::from_mode(0o700)).unwrap();
        // More than one pass worth of corrupt records, created first so they enumerate first.
        let corrupt: Vec<PathBuf> = (0..MAX_SCAN + 40)
            .map(|i| {
                let path = s.journal.join(format!("{i:032x}.save"));
                std::fs::write(&path, b"corrupt").unwrap();
                path
            })
            .collect();
        // Unrelated non-record files are ignored and never counted against the batch.
        std::fs::write(s.journal.join("notes.txt"), b"x").unwrap();
        publish::stage(&s.target, b"interrupted").unwrap().abandon();
        let orphan = staging(&s.docs).pop().unwrap();
        // Give the abandoned record the ID that sorts last, so it is behind every corrupt record.
        let record = records(&s.journal)
            .into_iter()
            .find(|p| !corrupt.contains(p))
            .unwrap();
        std::fs::rename(&record, s.journal.join(format!("{}.save", "f".repeat(32)))).unwrap();
        let first = cleanup();
        assert_eq!((first.unverified, first.removed), (MAX_SCAN, 0));
        assert!(orphan.exists());
        let second = cleanup();
        let removed = second.removed;
        // The 40 remaining corrupt records, the orphan, then wrap-around fills the batch.
        assert_eq!(second.unverified, MAX_SCAN - 1);
        assert_eq!(
            removed, 1,
            "the abandoned record behind the corrupt batch was reached"
        );
        assert!(!orphan.exists());
        assert!(
            corrupt.iter().all(|p| p.exists()),
            "unverified records are never deleted"
        );
        assert!(s.journal.join("notes.txt").exists());
        assert_eq!(std::fs::read(&s.target).unwrap(), b"original");
    }

    #[test]
    fn concurrent_cleanup_during_registration_cannot_invalidate_the_record() {
        let s = setup();
        let journal = s.journal.clone();
        DURING_REGISTER.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                // Another instance's cleanup runs at the most sensitive point of registration.
                let report = cleanup();
                assert_eq!(report.removed + report.retired, 0);
                assert!(records(&journal).iter().all(|p| p.exists()));
            }))
        });
        let staged = publish::stage(&s.target, b"active").unwrap();
        DURING_REGISTER.with(|hook| *hook.borrow_mut() = None);
        // The registration survived: one locked record proves the staging file and protects it.
        let found = records(&s.journal);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].extension().unwrap(), "save");
        assert_eq!(cleanup().active, 1);
        assert_eq!(staging(&s.docs).len(), 1);
        // Once abandoned, the same proven record is still cleaned normally.
        staged.abandon();
        assert_eq!(cleanup().removed, 1);
        assert!(staging(&s.docs).is_empty());
        assert!(records(&s.journal).is_empty());
    }

    #[test]
    fn batch_selection_progresses_through_every_record_regardless_of_listing_order() {
        let ids: Vec<String> = (0..1300u32).map(|i| format!("{i:032x}")).collect();
        // Adversarial listing: the same 512 records always listed first, plus noise names.
        let listing = || {
            ids.iter()
                .map(|id| format!("{id}.save"))
                .chain([
                    "cursor".to_owned(),
                    format!("{}.new", "e".repeat(32)),
                    "x.save".to_owned(),
                ])
                .collect::<Vec<_>>()
        };
        let mut cursor: Option<String> = None;
        let mut seen = std::collections::BTreeSet::new();
        for pass in 0..3 {
            let batch = select_batch(listing().into_iter(), cursor.as_deref(), MAX_SCAN);
            assert!(batch.len() <= MAX_SCAN, "pass {pass}");
            assert!(batch.windows(2).all(|w| w[0] != w[1]));
            seen.extend(batch.iter().cloned());
            cursor = batch.last().cloned();
        }
        assert_eq!(
            seen.len(),
            ids.len(),
            "three bounded passes cover all 1300 records"
        );
        // Wrap-around: after the last ID the next pass restarts from the smallest.
        let batch = select_batch(listing().into_iter(), Some(&ids[1299]), MAX_SCAN);
        assert_eq!(batch.first(), Some(&ids[0]));
        // A listing order where the target is last still reaches it once the cursor passes the others.
        let mut reversed = listing();
        reversed.reverse();
        let batch = select_batch(reversed.into_iter(), Some(&ids[1000]), MAX_SCAN);
        assert_eq!(batch[0], ids[1001]);
        // The old behaviour (first MAX_SCAN listed names, no cursor) never reaches ids[1299].
        let first_listed: Vec<String> = listing().into_iter().take(MAX_SCAN).collect();
        for _ in 0..3 {
            let old = select_batch(first_listed.clone().into_iter(), None, MAX_SCAN);
            assert!(!old.contains(&ids[1299]));
        }
    }
}
