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

## 2026-07-06 — Functions 배포 검증: OCR/주소 파싱 리팩터 + @ 약어 수정 + 의존성 선언

- **Status**: Deployed / Verified
- **Scope**: `e2fda83`(OCR/address parsing refactor), `ad97c1c`(@ apartment abbreviation fix), `6675cc2`(functions dependency declaration)
- **Deploy target**: Firebase Functions only, project `hatdelivery-saas`. Hosting/DB rules not touched.
- **배경**: 커밋은 됐으나 배포 시각(마지막 Functions 배포)이 두 커밋보다 앞서 있어 미배포 상태였던 것을 git log 타임스탬프 대조로 발견 → 배포 진행.
- **배포 전 확인**:
  - `git status` clean
  - `node --test "test/*.test.js"` 전체 63/63 pass
- **배포**: `firebase deploy --only functions --project hatdelivery-saas` 성공 (6개 함수 전부 업데이트)
- **배포 후 라이브 검증** (합성 데이터만 사용, 실제 고객 주소/전화번호/토큰 미사용):
  - 인증된 testmart 계정으로 `geocodeAddress` 호출 → 200
  - 합성 `@` 약어 주소(`가상마을@ 101동 202호`)와 `A` 약어 주소(`가상마을A 101동 202호`) 호출 결과가 **완전히 동일**(같은 road_address/좌표) → `@` 정규화가 라이브에 반영됐다는 결정적 증거
  - 서버 로그(`firebase functions:log`)에서 `건물명 키워드 검색: 가상마을아파트`로 실제 내부 쿼리가 "아파트"로 정규화된 것을 직접 확인
  - `processReceipt` 미인증 호출 → 401
  - `processReceipt` 테넌트 불일치(다른 tenantId) → 403
  - `processReceipt` 본인 테넌트 → 인증 게이트 통과 후 Vision 단계까지 정상 진행(가짜 이미지라 이후 500은 예상된 결과)
  - `firebase functions:log`에서 에러 레벨 로그 0건 확인
- **Result**: 프로덕션 Functions가 커밋된 OCR/주소 파싱 변경 사항과 완전히 일치 — 남은 배포 갭 없음.
- **Sensitive data policy**: 실제 고객 주소/전화번호/토큰/영수증 로그는 기록하지 않음. 검증 중 우연히 노출된 이전 실사용 로그(영수증 스캔 기록)는 본 로그에도, 대화 응답에도 옮겨 적지 않음.
