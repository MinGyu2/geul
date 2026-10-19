//! 원본 교체(T009): 같은 디렉터리(같은 파일 시스템)의 임시 파일에 쓰고 확인한 뒤 `rename`으로 바꾼다.
//!
//! 보장과 한계:
//! - POSIX `rename`은 같은 파일 시스템 안에서 대상 이름을 원자적으로 바꾼다(읽는 쪽은 옛 파일이나 새 파일 하나를 본다).
//!   이 동작을 이 프로젝트가 실제로 시험한 플랫폼은 Linux뿐이라 그 밖에서는 저장하지 않는다(`SaveUnsupported{platform}`,
//!   원본 그대로). Windows `MoveFileEx`·macOS는 T014·T016에서 따로 확인한다.
//! - 임시 파일은 `create_new`(이미 있으면 실패)로 만들고 원본의 권한 비트를 준다. 원본 소유자·그룹이 이 프로세스가
//!   만든 파일과 다르면(교체하면 소유가 바뀜) 저장하지 않는다. 하드 링크가 여럿인 파일도 저장하지 않는다(교체하면 다른
//!   이름이 옛 내용을 가리킨다). 확장 속성·ACL은 옮기지 않는다(확인할 수단이 없음, T014).
//! - 쓴 뒤 `fsync`하고 디스크에서 다시 읽어 보낸 바이트와 같은지 확인한다. 교체 뒤 디렉터리를 `fsync`한다. 디렉터리
//!   `fsync`가 실패하면 교체는 이미 됐으므로 되돌리지 않고 `durable: false`로 알린다(정전 내구성은 T014).
//! - 실패하면(교체 전) 임시 파일을 지우고 원본은 건드리지 않는다. 프로세스가 중간에 끝나면 `.geul-save-*.tmp`가 남을 수
//!   있다(원본은 그대로). 남은 임시 파일의 정리·복구는 T014다(다른 파일을 지우는 정리 규칙은 두지 않는다).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::document::{DocumentError, IoProblem, SaveStage, SaveUnsupportedReason};

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
}

#[cfg(test)]
thread_local! {
    pub static FAULT: std::cell::Cell<Option<Fault>> = const { std::cell::Cell::new(None) };
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

/// 써 두고 아직 게시하지 않은 임시 파일. 게시하지 않고 버리면 지운다.
pub struct Staged {
    path: PathBuf,
    published: bool,
}

impl Drop for Staged {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl Staged {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// `target`(정규화한 원본 경로)을 바꿀 수 있는 플랫폼·파일인지 확인하고, 같은 디렉터리에 `bytes`를 쓴 임시 파일을 만든다.
#[cfg(target_os = "linux")]
pub fn stage(target: &Path, bytes: &[u8]) -> Result<Staged, DocumentError> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    let original = fs::metadata(target).map_err(|error| failure(SaveStage::Write, &error))?;
    if original.nlink() > 1 {
        return Err(DocumentError::SaveUnsupported {
            reason: SaveUnsupportedReason::HardLink,
        });
    }
    let dir = target.parent().ok_or(DocumentError::Internal)?;
    let mode = original.permissions().mode() & 0o7777;
    #[cfg(test)]
    if let Some(Fault::Create(kind)) = fault() {
        return Err(failure(SaveStage::Write, &io::Error::from(kind)));
    }
    // 이름이 이미 있으면(중단된 저장이 남긴 파일, 프로세스 번호 재사용) 그 파일을 건드리지 않고 다음 이름으로 한다.
    let (path, mut file) = (|| {
        let mut last = io::Error::from(io::ErrorKind::AlreadyExists);
        for _ in 0..MAX_NAME_ATTEMPTS {
            let path = dir.join(format!(
                ".geul-save-{}-{}.tmp",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600) // 아래에서 원본 권한으로(umask와 무관하게) 맞춘다
                .open(&path)
            {
                Ok(file) => return Ok((path, file)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => last = error,
                Err(error) => return Err(error),
            }
        }
        Err(last)
    })()
    .map_err(|error| failure(SaveStage::Write, &error))?;
    let staged = Staged {
        path,
        published: false,
    };
    let created = file
        .metadata()
        .map_err(|error| failure(SaveStage::Write, &error))?;
    if (created.uid(), created.gid()) != (original.uid(), original.gid()) {
        return Err(DocumentError::SaveUnsupported {
            reason: SaveUnsupportedReason::Ownership,
        });
    }
    let write = |file: &mut File| -> io::Result<()> {
        #[cfg(test)]
        if let Some(Fault::Write(kind)) = fault() {
            return Err(io::Error::from(kind));
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        file.set_permissions(fs::Permissions::from_mode(mode))?;
        file.sync_all()
    };
    write(&mut file).map_err(|error| failure(SaveStage::Write, &error))?;
    drop(file);
    // 디스크에서 다시 읽어 보낸 바이트와 같은지(쓰기 경로의 조용한 손상).
    let mut back = Vec::with_capacity(bytes.len());
    File::open(&staged.path)
        .and_then(|mut file| file.read_to_end(&mut back))
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
    Ok(staged)
}

#[cfg(not(target_os = "linux"))]
pub fn stage(_target: &Path, _bytes: &[u8]) -> Result<Staged, DocumentError> {
    Err(DocumentError::SaveUnsupported {
        reason: SaveUnsupportedReason::Platform,
    })
}

/// 임시 파일로 원본을 바꾼다. 성공하면 디렉터리 `fsync`가 됐는지(내구성 확인)를 돌려준다.
pub fn publish(staged: &mut Staged, target: &Path) -> Result<bool, DocumentError> {
    #[cfg(test)]
    if let Some(Fault::Rename(kind)) = fault() {
        return Err(failure(SaveStage::Publish, &io::Error::from(kind)));
    }
    fs::rename(&staged.path, target).map_err(|error| failure(SaveStage::Publish, &error))?;
    staged.published = true;
    let durable = target
        .parent()
        .and_then(|dir| File::open(dir).ok())
        .is_some_and(|dir| dir.sync_all().is_ok());
    Ok(durable)
}
