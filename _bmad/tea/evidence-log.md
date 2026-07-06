# TEA 테스트 증거 로그 (햇배달 SaaS)

> `node:test` 기반 회귀 테스트 실행 증거를 기록합니다. 실제 고객 데이터는 사용하지 않고
> 합성(가상) 주소/좌표만 사용합니다.

---

## 2026-07-06 — receipt-utils 회귀 테스트 하네스 구축

- **대상**: `functions/lib/receipt-utils.js` (OCR 전처리, 주소 파싱, Kakao 후보 선택)
- **테스트 파일**: `functions/test/receipt-utils.test.js`, `functions/test/receipt-utils.kakao.test.js`
- **방식**: 1단계 순수 함수 단위 테스트(문자열 파싱), 2단계 `global.fetch` 모킹 기반 Kakao API 후보 선택 테스트 — 실제 Kakao API 호출 없음
- **결과**: 61/63 pass (관련 없는 기존 stale 테스트 2건 제외 전항목 통과)
- **커밋**: `e2fda83`

## 2026-07-06 — P2: @ 아파트 약어 정규화 버그 수정

- **대상**: `functions/lib/receipt-utils.js`의 `parseAddressComponents` — 아파트 약어(`@`/`A`/`APT`) 정규화
- **발견 경위**: 1단계 회귀 테스트 작성 중 `[@A]\b` 정규식이 `@`를 절대 매칭하지 못하는 걸 발견 (word character 아님 → `\b` 불성립). 최초 발견 시점엔 회귀 기준선으로만 고정, 수정은 별도 라운드로 분리.
- **수정 내용**: `@`를 `(?![A-Za-z0-9_])` negative lookahead로 분리(=`\b`와 동등 효과), `A`는 기존 `\b` 패턴 그대로 유지.
- **테스트 케이스** (전부 합성 데이터, 실제 고객 주소 미사용):
  - `가상마을@ 101-203호` → `가상마을아파트` / `101동 203호` (공백+동호 포함 케이스)
  - `용산@` → `용산아파트` (문자열 끝 케이스)
  - `용산@101동` → `용산@`(치환 안 됨, `A` 케이스와 동일하게 영숫자가 바로 이어지면 경계로 안 봄)
  - 기존 `A`(단독), `APT` 케이스 회귀 없음 확인
- **실행 결과**: `node --test "test/*.test.js"` → 61/63 pass. 나머지 2건은 `smoke.test.js`의 무관한 기존 stale 테스트(`saas/app.html` APP_VERSION 가정, `database.rules.json` 단순 규칙 가정 — SEC-001로 낡아짐).
- **커밋**: `ad97c1c`
- **범위 밖으로 남긴 것**: `standardizeAddress` 전체 오케스트레이션(1~4차 폴백 순서)과 Gemini 프롬프트 자체의 복수주소 선택 로직은 여전히 통합 테스트 없음 — 백로그 참고(`_bmad/backlog.md`).
