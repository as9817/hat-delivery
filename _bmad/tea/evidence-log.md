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

## 2026-07-06 — TMS: saveToFirebase() detailAddress 필드 누락 버그 수정 배포 검증

- **대상**: `saas/driver.html` — `saveToFirebase()` (Firebase 저장 필드 화이트리스트), `renderHome()` (표시 폴백 체인)
- **발견 경위**: 이전 라운드(TMS 배송목록 상세주소 표시, 커밋 `b7f08d8`)에서 렌더링 로직만 수정하고, 합성 데이터를 `firebase database:set`으로 직접 주입해 렌더링만 검증했음. 실제 사용자가 영수증 인식 → 확인 화면 → "배송 목록에 추가" 흐름으로 저장한 경우 `detailAddress`가 저장 단계에서 누락되어 새로고침/재접속 후 사라지는 문제를 사용자가 스크린샷으로 제보.
- **Root cause**: `saveToFirebase(item)`이 Firebase에 쓰는 주문 객체를 명시적 필드 목록으로 구성하는데, 그 목록에 `detailAddress`가 없었음(다른 필드는 다 있는데 이것만 누락).
- **Fix**: `detailAddress: item.detailAddress || ''` 추가. `renderHome()`에 `d.detailAddress || d.detail_address || d.location?.detail_address` 폴백 체인 추가(이미 저장된 구버전 레코드/다른 경로 호환용).
- **커밋**: `92576e2`
- **배포**: `firebase deploy --only hosting --project hatdelivery-saas`
- **배포 후 라이브 검증 절차 및 이슈**:
  1. curl로 배포된 `driver.html` 소스에 수정된 코드가 포함됐는지 1차 확인(정적 확인)
  2. Playwright로 기존에 열려있던 브라우저 탭에서 실제 `confirmAdd()` 함수를 호출해 합성 테스트 주문(테스트고객4) 저장 → Firebase 조회 결과 `detailAddress` 필드 자체가 없음(빈 문자열도 아니고 키 자체가 없음) → **이상 신호**
  3. 원인 조사: 배포 시각(`Last-Modified` 헤더, KST 16:59:37)과 테스트 주문 생성 시각(KST 17:00:59)을 비교하면 배포 자체는 이미 완료된 시점이었음 → 배포 문제가 아니라, 해당 브라우저 탭이 배포 이전부터 열려 있어 메모리 상의 구버전 JS로 동작한 것으로 결론(페이지를 다시 로드하지 않으면 서버 파일이 갱신돼도 실행 중인 스크립트는 그대로임)
  4. 캐시버스팅 쿼리로 페이지 하드 리로드 → `document.scripts` 텍스트에 수정된 코드 문자열이 포함됨을 재확인(`hasFix: true`)
  5. 하드 리로드된 페이지에서 다시 로그인, 실제 `confirmAdd()`로 합성 주문(테스트고객5, "3105동 502호 (공동현관 비번 미기재)") 추가 → Firebase 조회 결과 `detailAddress` 필드 정상 저장 확인
  6. 배송목록 카드 스냅샷에서 큰 주소(가상로 5) 아래 상세주소 라인 정상 표시 확인
  7. 페이지 새로고침 + 재로그인 후에도 카드에 상세주소 그대로 유지됨을 재확인(realtime resync 이후에도 데이터 손실 없음)
  8. 테스트 주문 2건(테스트고객4, 테스트고객5) Firebase에서 삭제, 잔존 테스트 데이터 없음을 재조회로 확인
- **Result**: 프로덕션에서 실제 저장 → 실시간 동기화 → 새로고침 전 과정에 걸쳐 상세주소 데이터 손실 없음을 확인. 이번 검증에서 얻은 방법론적 교훈: **Cloud Function/Hosting 배포 검증 시, 배포 시각뿐 아니라 테스트에 사용하는 브라우저 탭/세션이 배포 이후에 새로 로드됐는지도 함께 확인해야 함** — 배포는 정상이어도 오래된 탭에서 테스트하면 거짓 음성(false negative)이 발생할 수 있음.
- **Sensitive data policy**: 실제 고객 이름/주소/전화번호 미사용, 합성 데이터만 사용. 테스트 주문은 검증 직후 삭제.
