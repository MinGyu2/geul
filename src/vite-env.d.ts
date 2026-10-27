/// <reference types="vite/client" />

/** package.json의 version. vite.config.ts의 define으로 주입한다. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** "1"이면 자동 검사용 진단 속성(문서 글자 포함)을 DOM에 노출한다. 일반 빌드에서는 설정하지 않는다. */
  readonly VITE_GEUL_TEST_HOOKS?: string;
  /** "1"이고 VITE_GEUL_TEST_HOOKS도 "1"이면 rhwp 실행 취소·다시 실행 명령을 시험 빌드에서만 켠다(src/commands/registry.ts). */
  readonly VITE_GEUL_TEST_RHWP_HISTORY?: string;
  readonly VITE_GEUL_TEST_RHWP_FORMAT?: string;
}
