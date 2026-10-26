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
