//! 세션별 WordCraft 모델 보관소.
//!
//! - 모델은 세션 ID와 그 모델을 만든 불러오기 시도 번호(`load_generation`)로 찾는다. 시도 번호가 다르면 옛 모델이다.
//! - 세션 기록(`SessionRegistry`)이 권한 있는 상태다. 이 보관소는 `ready` 세션의 모델만 갖도록 다음 순서를 지킨다:
//!   불러오기는 모델을 넣은 뒤 `loading → ready`로 전이하고, 전이가 실패하면(닫힘·새 시도) 그 시도의 모델만 뺀다. 닫기는
//!   기록에서 뺀 뒤 모델을 놓는다. 엔진 실패로 `failed`가 되면 그 시도의 모델을 놓는다.
//! - 잠금 순서: 보관소 지도 → (놓은 뒤) 모델 → 세션 기록. 지도 잠금을 쥔 채 모델을 잠그지 않는다(진행 중인 작업이 모델을
//!   쥐고 있어도 닫기·놓기가 기다리지 않는다. 놓인 모델은 마지막 작업이 끝날 때 버려진다).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use super::engine::DocxModel;
use crate::document::SessionId;

struct Entry {
    generation: u64,
    model: Arc<Mutex<DocxModel>>,
}

#[derive(Clone, Default)]
pub struct WordcraftModels {
    inner: Arc<Mutex<HashMap<SessionId, Entry>>>,
}

impl WordcraftModels {
    fn map(&self) -> MutexGuard<'_, HashMap<SessionId, Entry>> {
        // 지도에는 넣기·빼기만 하므로 다른 스레드의 패닉 뒤에도 내용은 일관된다.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn insert(&self, session_id: SessionId, generation: u64, model: DocxModel) {
        self.map().insert(
            session_id,
            Entry {
                generation,
                model: Arc::new(Mutex::new(model)),
            },
        );
    }

    /// 그 시도의 모델. 없거나 다른 시도의 것이면 `None`.
    pub(crate) fn get(
        &self,
        session_id: SessionId,
        generation: u64,
    ) -> Option<Arc<Mutex<DocxModel>>> {
        self.map()
            .get(&session_id)
            .filter(|entry| entry.generation == generation)
            .map(|entry| entry.model.clone())
    }

    /// 세션의 모델을 놓는다(닫기).
    pub fn release(&self, session_id: SessionId) {
        self.map().remove(&session_id);
    }

    /// 그 시도의 모델일 때만 놓는다(실패 전이·늦게 끝난 불러오기).
    pub(crate) fn release_if(&self, session_id: SessionId, generation: u64) {
        let mut map = self.map();
        if map
            .get(&session_id)
            .is_some_and(|entry| entry.generation == generation)
        {
            map.remove(&session_id);
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.map().len()
    }
}
