# T009 XML 메모리 개선과 계상 경계

상태: 부분 구현, 자원 수용 판정 INCOMPLETE. 256 MiB/부분, 1 GiB/패키지 등 기존 제한을 바꾸지 않는다.
공식 T010 WASM/브라우저 RSS 예산과 별개인 Rust 저장 검사 메모리다.

## 호환 구현

`decode`는 UTF-8을 빌리고 UTF-16을 두 번 순회하여 정확한 UTF-8 길이/유효성을 먼저 검사한 뒤 fallible 예약한 문자열에 직접 해독하여 중간 `Vec<u16>`를 없앤다.
canonical 사건의 이름공간/이름/속성 이름과 값은 작업별 immutable `Atom(Arc<String>)` 집합에서 공유한다.
동등성·정렬·해시는 문자열 값 기준이며 pointer/hash 일치만으로 보존을 승인하지 않는다.
서식 제외 정의 키를 복제해도 문자열은 공유된다. 집합은 전역 캐시가 아니며 작업 끝에서 해제된다.

`canonical_valid`는 같은 전체 파서를 끝까지 실행하되 사건열과 텍스트/기호 집합을 보관하지 않는다.
이 모드의 내부 marker 값은 외부에 반환하지 않는다. 실제 요소/속성/namespace/reference 검증은 생략하지 않는다.
header의 모양 정의 조회는 `visit_element_starts`로 열린 조상 stack과 id 집합만 유지한다.
본문의 formCharPr 조상/Start·Empty 규칙과 header 덧붙임의 정확 비교는 유지한다.
불일치가 일찍 보여도 기존 무결성 검사가 XML 끝의 오류를 검사한다.
과대 IPC 저장 프레임은 기존 크기 거부를 payload 복사보다 먼저 수행한다.

## 직접 계상과 검토용 정책

`canonical_with_payload_limit`는 다음 retained payload 용량을 checked 연산으로 합산한다:

- 사건 Vec의 capacity × 사건 크기.
- 보관된 속성 Vec들의 capacity × tuple 크기.
- 고유 Atom 문자열의 capacity 합.
- 텍스트/주석/PI 문자열의 capacity 합.

이는 allocator 계측이나 전체 peak allocation/RSS가 아니다. Arc header, allocator/hash-table metadata,
parser namespace/정규화 임시 값, UTF-16 decode, Vec 재할당 순간의 중첩, 입력/패키지와 다른 작업을 제외한다.
다음 parser 사건을 만든 후 보관 예산을 검사하므로 그 사건의 선행 임시 할당을 막는 hard cap도 아니다.
성공 결과는 지정된 retained payload 예산을 넘지 않으며 초과는 `CanonicalFailure::PayloadLimit`이다.
production 호출은 `None`이다. 공개 설정/우회 옵션이나 새 제품 거부 정책을 만들지 않았다.

예를 들어 128 MiB retained payload 제한을 적용하면 현재 허용된 255 MiB 단일 텍스트 XML도 거부된다.
이는 호환성 변경이므로 승인 없이 활성화하지 않는다. 기존 ZIP 제한과 대체 관계가 아니며,
동시 N개 검사는 N개의 입력/패키지/작업 메모리를 가질 수 있다. session별 저장 잠금은 전체 admission이 아니다.
활성화 전에는 범주/threshold/호환성 영향/동시 admission/취소/서비스 `limitExceeded` 분류를 승인·구현해야 한다.

UTF-16, 사건/속성 Vec, interner hash 예약에는 `try_reserve`를 사용한다. 그러나 quick-xml 내부,
일부 문자열 정규화/복제, 작은 Arc 할당은 여전히 비회복 할당 경로다. 완전한 OOM 안전성을 주장하지 않는다.
기존 canonical API의 fallible 예약 실패도 아직 `Invalid`로 전달되므로 resource 분류 통합이 남아 있다.
검토용 payload 오류의 서비스 저장/취소 통합 시험은 정책이 비활성이라 NOT RUN이다.
일반 저장 거부/취소의 원본·dirty·temp 보존 회귀와 이를 혼동하지 않는다.

## 관측 증거

`tests/integration/rhwp/evidence/t009-xml-memory-remediation/`에 명령·입력 신원·모든 단계 결과를 둔다.
Rust 1.99 release, 같은 16,037,113-byte header/369,946-byte ZIP 사례의 독립 프로세스 측정:
기준 전체 검사 2304.0 ms / 단계 HWM 529360 KiB, 최종 1650.0 ms /195932 KiB.
단일 before/after 관측이며 전체 저장 latency p95나 보편적인 최대 배수를 증명하지 않는다.
각 단계 clear_refs reset과 VmHWM 읽기는 성공했다. allocator 잔류와 다른 thread 영향은 포함한다.
원본/출력 header 동시 비교와 패키지 버퍼는 여전히 존재한다.

한 출력 header의 직접 retained payload는 61134007 bytes다. 단일 header 값이며 양쪽 비교 scratch의 64 MiB
목표를 달성했다고 해석하지 않는다. 제외한 heap metadata/임시 공간도 더해야 한다.
255 MiB 텍스트는 별도 프로세스의 process-wide HWM이 legacy 790140 KiB, 새 canonical 529040 KiB,
validation-only 268004 KiB였다. 새 canonical은 텍스트 자체를 약255 MiB 보관하여 제안128 MiB 목표를 넘는다.
validation의 retained event payload 0은 입력/파서/RSS가 0이라는 뜻이 아니다.

기준 구현의 decoder/canonical을 reference HEAD에서 test-only oracle로 보존했다.
독립 HWPX/DOCX 6개·53 XML 부분(2712055 bytes)과 UTF-8/16, dense/deep/repeated namespace/large attributes,
text/CDATA/refs/comments/PI 및 잘못된 끝/namespace/entity를 값 전체로 차등 검사한다.
같은 corpus의 7회 교대 실행 materialization+drop p95는 legacy 69.964 ms, 새 구현 78.211 ms(약1.12배)다.
이 component 진단은 ZIP/서비스/native 경로를 제외하며 짧은 반복이라 공식 전체 p95 수용 증거가 아니다.

## 남은 설계 결정

큰 text와 header 비교를 streaming cursor/제한 spool로 바꾸고 namespace/attribute 임시 메모리도 계상해야 한다.
기존 문서 동등성(공백/CDATA/참조/주석/PI/namespace 값/속성 순서/빈 요소/UTF-16)과 끝까지 검증을 유지한다.
유한 예산 정책 승인, fallible 파서/할당 경계, 전역 동시 admission, 취소 및 강제 자원 고갈의 실제 저장
원본 SHA/dirty/temp 검증이 남았다. 이번 개선만으로 T009 자원 수용이나 T010 RSS를 완료하지 않는다.

## 2026-10-27 특수 비교와 작업 소유 예약

이번 구현은 `t009-special-xml-resource-hardening/`의 별도 증거로 검증한다. 위의 canonical 벡터 측정은
이전 구현 기록이며 현재 header/statistics 경로를 나타내지 않는다. 기존 ZIP/파일/이벤트/8작업 상한은 그대로다.

HWPX header와 DOCX app 통계는 전체 정규화 사건 벡터 둘을 보관하지 않는다. 먼저 양쪽을 끝까지 검증한 뒤
스트리밍 의미 사건을 비교한다. 원본 malformed 우선순위는 유지한다. DOCX는 **바로 위 요소**가 정확한
extended-properties namespace와 허용된 통계 이름일 때에만 존재하는 Text의 값을 면제한다. Text 존재 여부,
Text 경계, 구조·속성·다른 텍스트는 면제하지 않는다. CDATA/참조 분할은 의미상 이어지지만, 서식 자식 제거가
원래 분리된 Text 경계를 없애지는 않는다.

header는 일반 동등성을 먼저 같은 cursor로 처리하고, 다른 `charProperties`에만 기존 좁은 append 규칙을
적용한다. 기존 정의 prefix는 값 전체가 같아야 한다. 원본 정의를 재읽을 입력 위치를 hash bucket에 인덱싱하고,
후보가 맞으면 정의 전체를 다시 비교한다. 강제 hash 충돌 회귀도 있다. 공통 부모 parser/namespace 문맥 하나만
보관하며, 정의마다 parser 복제본을 보관하지 않는다. 인덱스는 **O(정의 수)**이고 append 경로의 최대 정의 수는
기존 ID 공간 때문에 65,536이다. 비교 시 임시 cursor/열린 namespace stack은 깊이에 비례한다. UTF-16 해독,
현재 속성·주석·PI 문자열, quick-xml 내부 공간은 별도다. 모든 XML/전체 프로세스가 상수 메모리라는 뜻이 아니다.
출력 본문의 append 쓰임 조회는 전체 element-start 목록 대신 열린 조상과 참조 ID 집합을 보관한다.
Start/Empty, 읽히는 문단·표 셀·양식 ancestry 판정은 frozen comparator 및 기존 실제 엔진 회귀와 비교한다.

### 바이트 계상의 범위

`document::resources`의 Pool은 기존 DocumentState 작업 슬롯과 함께 쓰인다. production의 바이트 상한은
`None`이며 새 유한 제한을 활성화하지 않는다. ledger의 합은 실제 heap 측정이 아니라 아래 범주의 보수적인
작업 수명 예약이다. 버퍼가 먼저 해제되어도 작업이 끝날 때까지 예약을 유지하므로 합계가 실제 동시 보유량보다
클 수 있다. 독립 standalone `check_saved` 호출에는 자동 Pool이 없고, 측정/테스트는 명시적으로 scope를 제공한다.

| 범주 | 소유·할당 위치 | 예약/계상과 상한 | 수명·중첩·제외 |
|---|---|---|---|
| Tauri IPC 요청 | Tauri InvokeBody | 검증된 frame의 관측 길이, 약 512MiB payload+1MiB metadata+header | 이미 할당된 borrowed bytes; capacity/초기 Tauri 할당은 제어 불가. 출력 복사와 중첩 |
| 검증 후 payload | save commands의 Frame | 슬롯 획득·예약 뒤 try_reserve_exact; 허용 payload 512MiB 그대로 | worker/요청이 소유; IPC와 원본·패키지와 중첩. metadata JSON/복제는 별도 |
| 원본 파일 bytes | read_identified | 읽기 전 길이+1 예약·fallible 확보, take(len+1) | 초기 읽기와 게시 전 재읽기를 각각 예약. 후자의 실제 생존은 짧지만 예약은 작업 끝까지 |
| 압축 해제 bytes | ZIP ReservedBytes | 선언 크기는 힌트만; 검증 후 최초 쓰기 및 실제 capacity 성장 전에 추가 예약·fallible 확보 | 기존 256MiB/부분·1GiB/패키지 검사 유지. 양쪽 패키지와 metadata 임시 읽기 예약이 중첩. allocator 반올림·재할당 순간은 별도 |
| UTF-16 decode | XML decoder | 유효 scalar/정확 UTF-8 길이를 먼저 세고 해당 길이 예약 | 입력·상대쪽 decode와 중첩. 반복 순회마다 예약하므로 누적 예약은 동시에 살아 있는 decode보다 클 수 있음 |
| header index | special comparator | map bucket/value와 입력 위치의 객체 용량을 예약 | 최대 65,536 정의, hash control metadata·allocator·현재 parser 임시는 제외. hash로 승인하지 않음 |
| parser/comparison | quick-xml 및 사건 cursor | 단계 거부 지점과 선택된 try_reserve 오류 출처 추적 | namespace/open stack/Arc/일부 String·HashMap 및 parser 내부 할당을 전부 계상하거나 회복하지 않음 |
| staging/readback | publish::stage | 출력 길이+1 예약·fallible 확보·bounded readback | 원본·출력·임시 파일과 중첩. 디스크 파일은 heap 예약이 아님 |
| WordCraft export | 엔진 model/export | export 이후 출력 Vec capacity 계상 | 엔진 내부 serialize/model/independent reopen의 선행 할당은 별도·미계상 |
| 응답 전송 | Tauri Response/외부 caller | worker 밖으로 옮긴 load/original 응답 메모리 전체 수명은 미계상 | 이 예약으로 IPC 전송 전체·WebView·엔진·RSS를 제한한다고 주장하지 않음 |

### 소유·취소·게시

바이트 합과 증가분은 checked arithmetic을 쓴다. 정상/오류/실패/worker panic은 Operation의 마지막 소유자가
해제할 때 정확히 반환한다. frame의 metadata와 크기를 검증한 뒤 공유 8작업 슬롯을 획득하고 **그 뒤** 큰 출력
payload를 복사한다. 슬롯/예약을 못 잡으면 즉시 거부하며 대기 큐를 만들지 않는다.

async caller가 취소돼도 이미 시작한 blocking worker가 예약을 쥔다. 세션 close도 worker 소유 버퍼를 먼저
해제한 것으로 세지 않는다. 취소는 게시 허가 전 Active→Canceled로 선형화한다. 원자 게시 직전 Active→Committing
허가를 얻은 작업은 완료를 소유하며, 그 뒤의 caller 취소가 이미 시작한 원자 게시를 되돌린다고 약속하지 않는다.
취소 Drop은 IO mutex에서 기다리지 않는다. 기존 session/revision/generation/SaveTicket 검사는 유지한다.

선택된 allocator 실패·예약 거부의 출처는 작업별로 남겨 `ResourceLimit(memory)` 또는 `limitExceeded`로 전달한다.
원본 syntax 오류가 이미 증명됐으면 출력의 자원 거부가 그 근거를 지우지 않는다. 일반 malformed XML은 여전히
malformed이며 자원 부족으로 바꾸지 않는다. 모든 Arc/String/parser/engine 할당의 OOM 회복을 제공하지 않는다.

### 독립 검토용 유한 정책 — production 비활성

예시 총 예약 예산은 8GiB다(제안일 뿐 승인·활성화하지 않음). 고정된 작은 per-operation 상한을 추가하지 않고
각 작업의 관측 payload/파일 길이, 실제 ZIP buffer 성장, decode/index/staging 요청을 누적 예약한다. 기존 8개
count admission을 함께 유지하고, 바이트가 부족하면 `ResourceLimit(memory)`/`limitExceeded`로 즉시 거부한다.
큐·전역 직렬화·캐시 예산 증가는 없다. 테스트에서는 작은 정확 경계/1byte 초과 예산으로 같은 메커니즘을 실행한다.

이 정책은 기존에 가능한 8개의 큰 동시 작업이나 큰 UTF-16 반복 비교를 거부할 수 있다. 먼저 도착한 작업이
예약을 유지하므로 공정성·큰 작업의 재시도/기아 문제도 별도 정책 결정이 필요하다. 보수적인 누적 예약 때문에
실제 live bytes가 작아도 거부할 수 있다. 동시 대형 controlled-buffer 할당을 줄이는 효과는 기대할 수 있으나,
미계상 engine/parser/Tauri/allocator 메모리 때문에 8GiB RSS 보장을 의미하지 않는다. 승인 전에는 production에서
`None`을 유지한다. 128MiB retained-payload 정책이나 256MiB 부분 수용 한도 축소는 활성화하지 않았다.

검증 범위 주의: save/package.rs의 256 MiB 확장 부분 상한과 별개로 기존 형식 판별기
(document/package.rs)의 MAX_VERIFIED_PART_BYTES=64 MiB가 header 검증에 적용된다.
이번 변경은 어느 상한도 바꾸지 않았다. 255 MiB header는 전체 check_saved에서
outputMalformed(container)로 계속 거부된다. 해당 크기의 특수 비교기 측정은
package::open + compare_saved_hwpx 컴포넌트에 한정하며 서비스 수용 결과가 아니다.
