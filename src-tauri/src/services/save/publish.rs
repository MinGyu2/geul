//! 원본 교체(T009): 같은 디렉터리(같은 파일 시스템)의 임시 파일에 쓰고 확인한 뒤 `rename`으로 바꾼다.
//!
//! 보장과 한계:
//! - POSIX `rename`은 같은 파일 시스템 안에서 대상 이름을 원자적으로 바꾼다(읽는 쪽은 옛 파일이나 새 파일 하나를 본다).
//!   이 동작을 이 프로젝트가 실제로 시험한 플랫폼은 Linux뿐이라 그 밖에서는 저장하지 않는다(`SaveUnsupported{platform}`,
//!   원본 그대로). Windows `MoveFileEx`·macOS는 T014·T016에서 따로 확인한다.
//! - 임시 파일은 `create_new`(이미 있으면 실패)로 만들고 원본의 권한 비트를 준다. 원본 소유자·그룹이 이 프로세스가
//!   만든 파일과 다르면(교체하면 소유가 바뀜) 저장하지 않는다. 하드 링크가 여럿인 파일도 저장하지 않는다(교체하면 다른
//!   이름이 옛 내용을 가리킨다). 읽기 전용 원본(소유자 쓰기 비트 없음·커널이 쓰기 거부)도 바꾸지 않는다(`read-only`).
//! - 위협 모델(T009 3차 안정화): 이 사용자·root는 믿고 그 밖의 사용자는 믿지 않는다. 그들이 검증한 임시 파일의 내용을 바꿀 수
//!   있는 원본(그룹·그 밖 쓰기 → `shared-file`, 접근 ACL → `metadata`)과 그 이름을 바꿀 수 있는 디렉터리(다른 소유자, sticky 없는
//!   그룹·그 밖 쓰기, 접근 ACL → `shared-directory`)는 저장하지 않는다. 임시 파일은 핸들 하나로 쓰고 되읽고, 검증한 상태를 기록해
//!   교체 직전에 같은지·이름이 그 inode인지, 교체 뒤 원본 이름이 그 inode인지 본다(`stage`·`publish`).
//! - 확장 속성(ACL 포함)·inode 플래그·권한 비트는 옮기지 않고, 원본과 다 쓴 임시 파일에서 읽어 같을 때만 교체한다
//!   (`metadata`: 다르거나 읽을 수 없으면 막음, `metadata.rs`).
//! - 쓴 뒤 `fsync`하고 디스크에서 다시 읽어 보낸 바이트와 같은지 확인한다. 교체 뒤 디렉터리를 `fsync`한다. 디렉터리
//!   `fsync`가 실패하면 교체는 이미 됐으므로 되돌리지 않고(옛 파일은 이미 없다) `durable: false`로 알린다. 세션은 파일
//!   기록을 새 파일로 바꾸되 dirty로 남긴다(`session.rs`). 정전 내구성 자체는 T014.
//! - 남는 경합: 교체 직전 확인(기록 잠금 안의 `unchanged`: inode·크기·수정 시각·ctime·권한·소유·링크 수)과 `rename`
//!   사이에 다른 프로세스가 원본을 바꾸면 그 변경은 덮인다. POSIX에는 "이 inode일 때만 바꾸기"가 없어(`renameat2`의
//!   `RENAME_EXCHANGE`로 바꾼 뒤 확인·되돌리기도 그 사이 읽는 쪽에 새 파일을 보인다) 이 창은 줄일 뿐 없앨 수 없다.
//! - 실패하면(교체 전) 임시 파일을 지우고(이름이 아직 그 inode일 때만) 원본은 건드리지 않는다. 프로세스가 중간에 끝나면 `.geul-save-*.tmp`가 남을 수
//!   있다(원본은 그대로). 남은 임시 파일의 정리·복구는 T014다(다른 파일을 지우는 정리 규칙은 두지 않는다).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::document::{
    describe_published, DocumentError, IoProblem, Published, SaveStage, SaveUnsupportedReason,
};

static COUNTER: AtomicU64 = AtomicU64::new(0);
/// 임시 파일 이름이 이미 있을 때 다음 이름으로 해 보는 횟수.
const MAX_NAME_ATTEMPTS: usize = 64;

/// 시험용: 다음 임시 파일 이름의 번호.
#[cfg(test)]
pub fn next_name_number() -> u64 {
    COUNTER.load(Ordering::Relaxed)
}

/// 시험용 실패 주입 지점.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    Create(io::ErrorKind),
    Write(io::ErrorKind),
    /// 되읽은 내용이 다름(디스크 오류 흉내).
    Verify,
    Rename(io::ErrorKind),
    /// 교체 직전에 원본이 바뀐 것처럼(외부 수정 흉내).
    BeforePublish,
    /// 교체 뒤 디렉터리 `fsync` 실패.
    DirSync,
    /// 원본 메타데이터를 읽지 못함.
    Inspect,
    /// 임시 파일을 만든 직후의 실패(만든 뒤 첫 단계).
    AfterCreate,
    /// 교체 직후 원본 이름이 다른 파일로 바뀜(믿는 쪽의 경합 흉내).
    SwapAfterRename,
}

/// 시험용 훅(원본 경로, 임시 파일 경로를 받는다).
#[cfg(test)]
pub type Hook = Box<dyn Fn(&Path, &Path)>;

#[cfg(test)]
thread_local! {
    pub static FAULT: std::cell::Cell<Option<Fault>> = const { std::cell::Cell::new(None) };
    /// 시험용: 임시 파일을 다 쓴 뒤·교체 직전 확인 전에 원본 경로로 부른다(저장 중 chmod·링크·xattr 변경 흉내).
    pub static BEFORE_CHECK: std::cell::RefCell<Option<Hook>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub fn before_check(target: &Path, staged: &Staged) {
    BEFORE_CHECK.with(|hook| {
        if let Some(hook) = hook.borrow().as_ref() {
            hook(target, &staged.path);
        }
    });
}

#[cfg(test)]
pub fn fault() -> Option<Fault> {
    FAULT.with(std::cell::Cell::get)
}

fn io_problem(error: &io::Error) -> IoProblem {
    match error.kind() {
        io::ErrorKind::PermissionDenied => IoProblem::PermissionDenied,
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded => IoProblem::StorageFull,
        io::ErrorKind::ReadOnlyFilesystem => IoProblem::ReadOnly,
        _ => IoProblem::Other,
    }
}

fn failure(stage: SaveStage, error: &io::Error) -> DocumentError {
    DocumentError::SaveFailure {
        stage,
        io: Some(io_problem(error)),
    }
}

/// 써 두고 아직 게시하지 않은 임시 파일. 만든 직후부터 이 값이 지우기를 맡는다(만든 뒤 지킬 값 없이 실패할 단계가 없다).
/// `file`은 만들 때 연 읽기·쓰기 핸들 하나로, 쓰기·되읽기·검증 뒤 상태 기록·게시 전후 확인을 모두 이 핸들로 한다(이름으로
/// 다시 열지 않는다). 버릴 때는 그 이름이 아직 이 inode일 때만 지운다(다른 것으로 바뀐 이름은 남의 것이므로 두고 간다).
pub struct Staged {
    path: PathBuf,
    file: File,
    /// 검증을 마친 때의 상태(inode·크기·수정·상태 변경 시각·권한). 게시 직전에 같아야 한다.
    verified: Option<Snapshot>,
    published: bool,
}

/// 파일 상태 요약: 장치·inode, 크기, 수정 시각, 상태 변경 시각(ctime), 권한. 쓰기는 수정 시각·ctime을, chmod·chown·
/// 확장 속성 변경은 ctime을 바꾼다(일반 프로세스는 ctime을 정할 수 없다).
type Snapshot = (u64, u64, u64, (i64, i64), (i64, i64), u32);

/// 이름(`path`, 따라가지 않음)이 `held`와 같은 inode의 일반 파일인지.
#[cfg(unix)]
fn same_inode(path: &Path, held: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    fs::symlink_metadata(path).is_ok_and(|named| {
        named.file_type().is_file() && (named.dev(), named.ino()) == (held.dev(), held.ino())
    })
}

// 원본 교체는 Linux에서만 한다(`stage`가 그 밖에서는 거부): 아래는 그 밖의 플랫폼에서 빌드만 되게 하는 값이다.
#[cfg(not(unix))]
fn same_inode(_path: &Path, _held: &fs::Metadata) -> bool {
    false
}

#[cfg(not(unix))]
fn snapshot(metadata: &fs::Metadata) -> Snapshot {
    (0, 0, metadata.len(), (0, 0), (0, 0), 0)
}

#[cfg(unix)]
fn snapshot(metadata: &fs::Metadata) -> Snapshot {
    use std::os::unix::fs::MetadataExt;
    (
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        (metadata.mtime(), metadata.mtime_nsec()),
        (metadata.ctime(), metadata.ctime_nsec()),
        metadata.mode(),
    )
}

impl Staged {
    /// 임시 파일 이름이 아직 이 핸들의 inode(일반 파일)를 가리키는지. 심볼릭 링크·다른 파일·없음이면 false.
    fn owns_path(&self) -> bool {
        self.file
            .metadata()
            .is_ok_and(|held| same_inode(&self.path, &held))
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        if !self.published && self.owns_path() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn metadata_unsupported() -> DocumentError {
    DocumentError::SaveUnsupported {
        reason: SaveUnsupportedReason::Metadata,
    }
}

fn unsupported(reason: SaveUnsupportedReason) -> DocumentError {
    DocumentError::SaveUnsupported { reason }
}

/// 게시하지 않았다(원본 그대로): 검증한 임시 파일이 게시 직전에 그대로가 아니다.
fn not_published() -> DocumentError {
    DocumentError::SaveFailure {
        stage: SaveStage::Publish,
        io: None,
    }
}

/// 원본이 있는 디렉터리에서 이 사용자(`owner`, 원본 소유자 = 임시 파일 소유자)·root 밖의 사용자가 항목 이름을 바꿀 수
/// 없는지: 소유자가 `owner`나 root이고, 그룹·그 밖 쓰기 비트가 없거나 sticky(그 밖의 사용자는 남의 항목을 지우거나 이름을
/// 바꿀 수 없음)이며, 접근 ACL이 없다. 아니면(또는 확인할 수 없으면) `shared-directory`.
#[cfg(target_os = "linux")]
fn check_directory(dir: &Path, owner: u32) -> Result<(), DocumentError> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    use super::metadata;

    let shared = || unsupported(SaveUnsupportedReason::SharedDirectory);
    let handle = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(dir)
        .map_err(|error| failure(SaveStage::Write, &error))?;
    let meta = handle
        .metadata()
        .map_err(|error| failure(SaveStage::Write, &error))?;
    let others_write = meta.mode() & 0o022 != 0;
    let sticky = meta.mode() & 0o1000 != 0;
    if (meta.uid() != owner && meta.uid() != 0) || (others_write && !sticky) {
        return Err(shared());
    }
    if metadata::has_access_acl(&handle).map_err(|_| shared())? {
        return Err(shared());
    }
    Ok(())
}

/// `target`(정규화한 원본 경로)을 바꿀 수 있는 플랫폼·파일·디렉터리인지 확인하고, 같은 디렉터리에 `bytes`를 쓴 임시
/// 파일을 만든다.
///
/// 위협 모델(T009 3차 안정화): 이 사용자(같은 uid의 다른 프로세스 포함 — 원본을 언제든 직접 쓸 수 있다)와 root는 믿고,
/// 그 밖의 사용자는 믿지 않는다. 그들이 검증한 임시 파일의 내용이나 이름을 게시 전에 바꿀 수 있는 원본·디렉터리는
/// 저장하지 않는다(`shared-file`·`shared-directory`).
#[cfg(target_os = "linux")]
pub fn stage(target: &Path, bytes: &[u8]) -> Result<Staged, DocumentError> {
    use std::io::{Seek, SeekFrom};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    use super::metadata;

    // 원본을 읽기로만 연다(쓰기 열기는 닫을 때 바뀐 파일로 알려진다). 검사 뒤 FIFO로 바뀌어도 멈추지 않게 O_NONBLOCK.
    let source = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(target)
        .map_err(|error| failure(SaveStage::Write, &error))?;
    let original = source
        .metadata()
        .map_err(|error| failure(SaveStage::Write, &error))?;
    if !original.is_file() {
        return Err(DocumentError::FileConflict);
    }
    if original.nlink() > 1 {
        return Err(unsupported(SaveUnsupportedReason::HardLink));
    }
    let mode = original.mode() & 0o7777;
    if !metadata::writable(target, mode).map_err(|_| metadata_unsupported())? {
        return Err(unsupported(SaveUnsupportedReason::ReadOnly));
    }
    // 그룹·그 밖이 쓸 수 있는 원본: 임시 파일도 같은 권한이 되므로 검증 뒤 게시 전에 그들이 바꿀 수 있다.
    if mode & 0o022 != 0 {
        return Err(unsupported(SaveUnsupportedReason::SharedFile));
    }
    #[cfg(test)]
    if fault() == Some(Fault::Inspect) {
        return Err(metadata_unsupported());
    }
    let attached = metadata::attached(&source).map_err(|_| metadata_unsupported())?;
    // 접근 ACL은 권한 비트 밖의 사용자에게 쓰기를 줄 수 있고, 새 파일이 같은 ACL을 받는지도 보장할 수 없다.
    if attached.has_access_acl() {
        return Err(metadata_unsupported());
    }
    drop(source);
    let dir = target.parent().ok_or(DocumentError::Internal)?;
    check_directory(dir, original.uid())?;
    #[cfg(test)]
    if let Some(Fault::Create(kind)) = fault() {
        return Err(failure(SaveStage::Write, &io::Error::from(kind)));
    }
    // 이름이 이미 있으면(중단된 저장이 남긴 파일, 프로세스 번호 재사용, 심볼릭 링크) 그것을 건드리지 않고 다음 이름으로
    // 한다(`create_new` = O_CREAT|O_EXCL: 있는 이름·링크를 따라가지 않는다).
    let mut staged = (|| {
        let mut last = io::Error::from(io::ErrorKind::AlreadyExists);
        for _ in 0..MAX_NAME_ATTEMPTS {
            let path = dir.join(format!(
                ".geul-save-{}-{}.tmp",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            match OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600) // 아래에서 원본 권한으로(umask와 무관하게) 맞춘다
                .open(&path)
            {
                Ok(file) => {
                    return Ok(Staged {
                        path,
                        file,
                        verified: None,
                        published: false,
                    })
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => last = error,
                Err(error) => return Err(error),
            }
        }
        Err(last)
    })()
    .map_err(|error| failure(SaveStage::Write, &error))?;
    #[cfg(test)]
    if fault() == Some(Fault::AfterCreate) {
        return Err(failure(SaveStage::Write, &io::Error::other("injected")));
    }
    let created = staged
        .file
        .metadata()
        .map_err(|error| failure(SaveStage::Write, &error))?;
    if (created.uid(), created.gid()) != (original.uid(), original.gid()) {
        return Err(unsupported(SaveUnsupportedReason::Ownership));
    }
    let write = |file: &mut File| -> io::Result<()> {
        #[cfg(test)]
        if let Some(Fault::Write(kind)) = fault() {
            return Err(io::Error::from(kind));
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        // 원본 권한(그룹·그 밖 쓰기 없음은 위에서 확인): 임시 파일은 끝까지 이 사용자만 쓸 수 있다.
        file.set_permissions(fs::Permissions::from_mode(mode))?;
        file.sync_all()
    };
    write(&mut staged.file).map_err(|error| failure(SaveStage::Write, &error))?;
    // 교체로 잃을 메타데이터가 없는지: 다 쓴 임시 파일(권한 비트 포함)이 원본과 같아야 한다.
    if metadata::attached(&staged.file).map_err(|_| metadata_unsupported())? != attached {
        return Err(metadata_unsupported());
    }
    // 같은 핸들로 디스크에서 다시 읽어 보낸 바이트와 같은지(쓰기 경로의 조용한 손상).
    let mut back = Vec::with_capacity(bytes.len());
    staged
        .file
        .seek(SeekFrom::Start(0))
        .and_then(|_| staged.file.read_to_end(&mut back))
        .map_err(|error| failure(SaveStage::Write, &error))?;
    #[cfg(test)]
    if fault() == Some(Fault::Verify) {
        back.push(0);
    }
    if back != bytes {
        return Err(DocumentError::SaveFailure {
            stage: SaveStage::Write,
            io: None,
        });
    }
    let verified = staged
        .file
        .metadata()
        .map_err(|error| failure(SaveStage::Write, &error))?;
    staged.verified = Some(snapshot(&verified));
    Ok(staged)
}

#[cfg(not(target_os = "linux"))]
pub fn stage(_target: &Path, _bytes: &[u8]) -> Result<Staged, DocumentError> {
    Err(DocumentError::SaveUnsupported {
        reason: SaveUnsupportedReason::Platform,
    })
}

/// 임시 파일로 원본을 바꾼다. 교체 직전에 검증한 그 inode가 그대로인지(핸들의 상태가 검증 때와 같고, 이름이 아직 그
/// 핸들의 일반 파일을 가리킴) 확인하고, 아니면 게시하지 않는다(원본 그대로, `SaveFailure{publish}`). 이 확인과 `rename` 사이에
/// 이름을 바꿀 수 있는 것은 위협 모델에서 믿는 쪽(이 사용자·root)뿐이다(`check_directory`).
///
/// 교체가 되면 되돌리지 않는다. 이 저장이 쓴 inode의 식별·지문(교체 뒤 fstat, 실패하면 교체 전 값: 다음 저장이 충돌로
/// 막힌다)과 내구성을 돌려준다. 내구성은 원본 이름이 그 inode를 가리키는 것을 교체 뒤에 확인하고 디렉터리 `fsync`가 됐을
/// 때만 확인됨이다(아니면 미확인: 세션은 dirty로 남고, 다음 저장은 이름이 다른 파일이면 충돌로 막힌다).
pub fn publish(staged: &mut Staged, target: &Path) -> Result<Published, DocumentError> {
    let before = staged.file.metadata().map_err(|_| not_published())?;
    if staged.verified != Some(snapshot(&before)) || !staged.owns_path() {
        return Err(not_published());
    }
    #[cfg(test)]
    if let Some(Fault::Rename(kind)) = fault() {
        return Err(failure(SaveStage::Publish, &io::Error::from(kind)));
    }
    fs::rename(&staged.path, target).map_err(|error| failure(SaveStage::Publish, &error))?;
    staged.published = true;
    #[cfg(test)]
    if fault() == Some(Fault::SwapAfterRename) {
        let other = target.with_extension("swapped");
        let _ = fs::write(&other, b"swapped").and_then(|_| fs::rename(&other, target));
    }
    let after = staged.file.metadata().unwrap_or(before);
    let (identity, fingerprint) = describe_published(target, &after);
    let landed = same_inode(target, &after);
    #[cfg(test)]
    if fault() == Some(Fault::DirSync) {
        return Ok(Published {
            identity,
            fingerprint,
            durable: false,
        });
    }
    let synced = target
        .parent()
        .and_then(|dir| File::open(dir).ok())
        .is_some_and(|dir| dir.sync_all().is_ok());
    Ok(Published {
        identity,
        fingerprint,
        durable: landed && synced,
    })
}
