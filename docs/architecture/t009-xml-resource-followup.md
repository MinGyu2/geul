# T009 XML 비교 자원 예산 후속 제안

상태: 제안, 일부 호환 메모리 개선 구현. 상세 현재 경계는 [t009-xml-memory-accounting.md](t009-xml-memory-accounting.md) 참조. T010 완료나 RSS 승인 근거가 아니다. 기존 측정/제안은 설계 근거로 보존하며 현재 구현도 논리적 동등성과 수용 상한을 유지한다.

## 관측과 현재 할당 경계

기존 `t010-post-corrective-hardening/stages-final-60000.jsonl`의 큰 header 사례는 XML 약 16.0 MiB,
압축 ZIP 약 370 KiB, 프로세스 최대 RSS 약 516 MiB, 마지막 `check_saved` 약 2.4초였다.
이 값은 프로세스 RSS 실측이며 canonical 사건의 정확한 peak allocation 측정이 아니다.
약 32배라는 사례 비율을 최악 배수나 256 MiB 입력의 OOM 증명으로 외삽하지 않는다.
실제 OOM은 이 증거에서 관측되지 않았다. 이전 측정은 reset 오류를 무시했으므로 단계 peak의 신뢰성도 제한된다.

코드로 확인한 소유 관계:

| 단계 | 동시에 살아 있는 주요 표현 |
| --- | --- |
| `service::check_saved` → `package::open` 둘 | 호출자의 원본/출력 압축 바이트 + 원본/출력 패키지의 모든 압축 해제 `Vec<u8>` |
| `validate_hwpx` → `malformed_xml` | 두 패키지 + XML 한 부분의 `decode` 문자열 + canonical 사건 벡터. 부분별 결과는 순차 해제. manifest도 별도 정규화 |
| `compare_part` | 두 패키지 + 원본/출력의 canonical 벡터 둘. 출력 파싱 중 출력 decode 문자열도 공존 |
| `compare_saved_hwpx` header | 원본/출력 header canonical 둘(이전 교정 이후 각 한 번). 덧붙임 비교 중 원본 정의의 서식 제외 복제 키 `HashSet`, 정의 slice/index 목록, 출력 본문 `element_starts` 목록도 공존 가능 |
| `validate_hwpx_references` | header canonical 검사 후 해제; header `element_starts`로 정의 집합 생성. 이후 각 본문의 canonical 전체 벡터 + 정의 집합. 두 패키지는 계속 유지 |

`xml::decode`는 UTF-8도 소유 문자열로 복사한다. UTF-16은 중간 `Vec<u16>`와 변환 문자열도 만든다.
`canonical`은 사건마다 이름공간 URI/지역 이름/속성 이름과 값, 텍스트/주석/PI를 소유한다.
반복되는 URI도 요소·속성마다 복제되며 Vec 용량과 allocator 오버헤드가 추가된다.
`element_starts`도 이름/속성/조상 정보를 소유한다. 따라서 압축 파일 크기는 이 할당의 유용한 예산이 아니다.

기존 ZIP 상한은 부분 256 MiB, 패키지 합계 1 GiB, 항목 20,000, 디렉터리 8 MiB, 이름 4096바이트다.
XML 사건은 부분당 16,000,000개 제한이 있으나 이는 heap 바이트 예산이 아니다(검사는 loop 경계).
상한들은 입력/사건 수를 제한하지만 동시 표현의 실용적인 최대 RSS를 보장하지 않는다.
여기서 전체 이론적 peak 바이트 상한은 계산하지 않았다. 516 MiB에서 할당량을 역산하지도 않았다.

검사가 정상 오류를 반환하면 `service::save`는 `check_saved`의 안전 판정 전에 게시하지 않는다.
XML 형식 오류·기존 상한 초과는 fail-closed이며 원본 보존 회귀가 이를 확인한다.
그러나 String/Vec의 비회복 할당 실패는 안전한 `Result` 반환을 보장하지 않는다.
검사 중 프로세스 종료와 정상 거부를 구별해야 한다. 이번 세션에서 실제 OOM이나 원본 손상은 재현하지 않았다.

## 별도 구현 계약 제안

두 입력을 namespace-aware 사건 iterator로 읽어 비교하되, 사건 전체를 저장하지 않는다.
header 덧붙임 검사는 제한된 정의 인덱스/재파싱 또는 제한된 임시 spool을 사용하고,
해시만으로 동등성을 승인하지 않는다. 정의·참조 집합, XML 깊이, namespace 문자열,
텍스트 합치기, 임시 저장소와 CPU에도 명시적 예산 및 중단 경로를 둔다.
package 전체 해제를 유지한다면 비교 scratch 예산만으로 전체 저장의 RSS가 제한된다고 주장하지 않는다.

동등성은 현재와 같아야 한다: namespace URI+지역 이름, 속성 순서 무시, 접두사 선택/XML 선언 무시,
문자 참조를 푼 이어진 텍스트(CDATA 포함)와 공백 보존, 주석/PI 보존, 자기 닫힘과 명시적 빈 요소 동등.
접두사를 값으로 쓰는 속성은 현재처럼 값 그대로 비교한다.
formCharPr/정의 판독에서는 `element_starts`의 Start/Empty와 조상 구별을 별도로 유지한다.
빠른 불일치를 찾아도 남은 XML의 형식 오류 판독을 생략해 기존 finding 의미를 바꾸면 안 된다.
DTD/알 수 없는 엔티티/미선언 접두사/잘못된 인코딩/복수 root/잘린 XML은 계속 거부한다.
현재 유효 문서 corpus와 보존/음성 테스트 전체를 차등 비교한다. 새 예산으로 거부되는 유효 문서의
호환성 변화는 따로 기록하고 승인받는다. 기존 256 MiB 수용 제한을 이번 작업에서 낮추지 않는다.

후속 수용 시험 제안(구현 전 예산 확정):

- 16 MiB 기존 사례, 256 MiB 경계, 반복 namespace/많은 속성/깊은 XML/거대한 텍스트,
  조밀한 작은 사건, UTF-16, 높은 압축률, 잘못된 끝부분을 각각 별도 프로세스로 실행한다.
- 전체 프로세스 RSS와 allocator의 비교 scratch peak를 따로 계측한다. 제안 scratch 목표는
  16 MiB 사례 증가분 64 MiB 이하, 256 MiB 사례 128 MiB 이하다. 입력 패키지와 엔진 소유 메모리는
  별도 합산한다. 동시 저장 수도 예산에 포함한다. 이 수치는 아직 승인/달성되지 않았다.
- 같은 장비/빌드/입력에서 CPU 반복 측정의 p95가 기존 정상 corpus의 2배를 넘지 않는 것을 제안한다.
  악성 입력은 명시된 작업량 예산에서 종료해야 한다. 공식 D4 기준을 대체하지 않는다.
- 강제 예산 초과/파싱 오류/취소/임시 저장 오류마다 unsafe 또는 unknown으로 저장 차단,
  원본 SHA-256 불변, dirty 유지, 임시 파일 정리를 확인한다. 할당 실패 주입도 포함한다.
- 모든 검사가 끝나기 전에는 게시하지 않는다. 자원 부족을 같은 문서로 간주하거나 비교 생략으로 바꾸지 않는다.

판정: 별도 T009 자원 예산/streaming 비교 설계가 정당하다(INFERRED).
현 코드의 실용적 메모리 안전성은 UNVERIFIED이며 T010 RSS는 계속 INCONCLUSIVE다.
