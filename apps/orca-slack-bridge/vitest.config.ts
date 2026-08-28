import { defineConfig } from 'vitest/config';

// vitest의 모듈 러너는 import.meta.main을 구현하지 않아 값이 undefined로 보인다.
// cli.ts는 그 부재를 "진입점을 판정할 수 없는 런타임"으로 보고 즉시 실패시키므로,
// 러너가 빠뜨린 사실을 그대로 채워준다: test가 로드하는 모듈은 진입점이 아니다.
export default defineConfig({
  define: { 'import.meta.main': 'false' },
  // Several acceptance files exercise the same production singleton pipe and OS capability names.
  // Run files serially so the full suite validates lifecycle handoff instead of racing global resources.
  test: { fileParallelism: false, setupFiles: ['./test/setup-isolation.ts'] },
});
