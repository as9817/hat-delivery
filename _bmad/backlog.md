# 백로그 (햇배달 SaaS)

> 보안 핫픽스(SEC-001/SEC-002) 및 이후 정리 라운드에서 나온 후속 작업을 추적합니다.
> 상세 보안 이슈는 `SECURITY_ISSUES.md` 참고, 여기는 전체 작업 백로그용입니다.

---

## 완료

### P2: Fix @ Apartment Abbreviation Normalization
- **Status**: ✅ Deployed / Verified
- **Commit**: `ad97c1c`
- **Result**: `@` apartment abbreviation now normalizes correctly when used as a standalone abbreviation (previously never matched due to `\b` not forming a boundary after a non-word character).
- **Tests**: Synthetic regression tests added (`functions/test/receipt-utils.test.js`); related tests passing.
- **Remaining unrelated failures**: Existing stale smoke tests only at the time — since fixed, see below.
- **Deploy**: See "Functions 배포: OCR/주소 파싱 리팩터 + @ 약어 수정 + 의존성 선언" entry below — code-complete and confirmed live in production.

### Functions 배포: OCR/주소 파싱 리팩터 + @ 약어 수정 + 의존성 선언
- **Status**: ✅ Deployed / Verified
- **Scope**:
  - `e2fda83` OCR/address parsing refactor
  - `ad97c1c` @ apartment abbreviation fix
  - `6675cc2` functions dependency declaration
- **Deploy target**: Firebase Functions only, project `hatdelivery-saas`. Hosting/DB rules not touched.
- **Evidence**:
  - git status clean before deploy
  - full functions test suite 63/63 pass
  - `firebase deploy --only functions` success
  - authenticated testmart `geocodeAddress` call: 200
  - synthetic `@` apartment abbreviation and `A` abbreviation return identical result
  - server log confirms query normalized to apartment wording
  - `processReceipt` unauthenticated: 401
  - `processReceipt` tenant mismatch: 403
  - `processReceipt` own tenant reaches Vision stage
  - error-level function logs: 0
- **Result**: Production Functions now match committed OCR/address parsing changes — no remaining deploy gap.
- **Sensitive data policy**: No real customer addresses, phone numbers, tokens, or receipt logs recorded. Details in `_bmad/tea/evidence-log.md`.

### `functions/test/smoke.test.js` stale 테스트 수정 + `DEPLOY_CHECKLIST.md` API 키 마스킹
- **Status**: ✅ Completed
- **Commit**: `1f8fa37`

### TMS: saveToFirebase() detailAddress 필드 누락 버그 수정
- **Status**: ✅ Deployed / Verified
- **Commit**: `92576e2`
- **Root cause**: `saas/driver.html`의 `saveToFirebase()`가 Firebase에 쓰는 필드를 명시적으로 화이트리스트 처리하는데, 그 목록에 `detailAddress`가 빠져 있었음. TMS 배송목록 카드 표시 로직(`renderHome()`)은 이전 라운드에서 이미 수정했지만, 정작 저장 단계에서 값이 누락되어 실시간 동기화(재접속/새로고침) 후 상세주소가 사라지는 문제였음.
- **Fix**: `saveToFirebase()`의 저장 객체에 `detailAddress: item.detailAddress || ''` 추가. `renderHome()`에는 `d.detailAddress || d.detail_address || d.location?.detail_address` 폴백 체인도 추가.
- **검증 경위**: 최초 검증 시 합성 데이터를 `firebase database:set`으로 직접 주입해 렌더링만 확인했었는데, 이는 실제 저장 경로(`confirmAdd()` → `saveToFirebase()`)를 통과하지 않아 버그를 놓치는 원인이 됨. 이번 라운드에서는 실제 프로덕션 함수 `confirmAdd()`를 호출하는 방식으로 재검증.
- **배포 후 라이브 검증** (합성 테스트 주문만 사용):
  - Hosting 배포 (`firebase deploy --only hosting --project hatdelivery-saas`) 완료 확인 (Last-Modified 헤더로 배포 시각 확인)
  - 최초 검증 시도에서 배포 이전에 열려 있던 브라우저 탭이 구버전 JS를 메모리에 유지하고 있어 `detailAddress`가 여전히 누락되는 것을 발견 → 페이지 하드 리로드 후 재시도로 원인 규명 (배포 자체는 정상이었음, 탭 재사용이 원인)
  - 하드 리로드 후 testmart 기사 계정(`test1`)으로 로그인, 실제 `confirmAdd()` 함수를 호출해 합성 주문(테스트고객5, "3105동 502호 (공동현관 비번 미기재)") 추가
  - 배송목록 카드에 큰 주소(가상로 5) 아래 상세주소 라인이 정상 표시됨을 스냅샷으로 확인
  - Firebase RTDB 직접 조회로 `detailAddress` 필드 저장 확인
  - 페이지 새로고침 + 재로그인 후에도 상세주소가 카드에 그대로 유지됨을 재확인
  - 테스트 주문 2건(테스트고객4, 테스트고객5) 모두 Firebase에서 삭제, 잔존 테스트 데이터 없음 확인
- **Sensitive data policy**: 실제 고객 이름/주소/전화번호 미사용, 합성 데이터만 사용.

### TMS: 업데이트 안내 배너 최소 범위 개선 (버전 상수/겹침/문서화) + 배너 감지 로직 미작동 버그 발견 및 수정
- **Status**: ✅ Deployed / Verified
- **Commits**: `68b3732`(버전 범프 + 배너 sticky 전환 + 배포 체크리스트 문서화), `9c5cc12`(버전 리스너 `_fbDb` 수정)
- **범위(사전 합의)**:
  1. `APP_VERSION` `'3'` → `'4'`
  2. `#update-banner`를 `position:fixed` 오버레이에서 `position:sticky`(문서 흐름 내)로 전환 — 헤더 겹침 방지, 문구를 "새 버전이 배포되었습니다. 새로고침해주세요."로 통일
  3. `DEPLOY_CHECKLIST.md`에 TMS 배포 시 `APP_VERSION`/Firebase `settings/appVersion` 동시 갱신 절차 명문화, 인증/권한 변경 배포 시에만 "로그아웃 후 재로그인" 문구를 검토하라는 안내 추가(코드 자동화는 안 함, 문서화만)
  4. PWA `manifest.json`/`sw.js` 경로 문제는 이번 범위에서 다루지 않고 백로그로만 기록 (아래 참고)
  5. 배포 자동화 스크립트는 이번 범위에서 만들지 않음 — 후속 과제로 기록 (아래 참고)
- **배포 후 검증 중 발견한 별도 버그**: 업데이트 배너의 "감지" 로직 자체가 프로덕션에서 **한 번도 정상 작동한 적이 없었음**.
  - 원인: `showApp()`의 버전 리스너가 `firebase.database().ref('settings/appVersion')`(인자 없는 기본 앱 참조)를 호출하는데, TMS는 `firebase.initializeApp(config, 'driver')`로 **이름 있는 앱**을 사용하므로 기본(`[DEFAULT]`) 앱이 존재하지 않아 이 호출이 매번 `FirebaseError`를 던짐.
  - 이 예외는 `doLogin()`의 try/catch로 전파되지만, 그 시점엔 이미 로그인 화면이 숨겨진 뒤라 사용자 화면엔 아무 문제 없이 정상 작동하는 것처럼 보였고, 정작 버전 리스너는 한 번도 등록에 성공한 적이 없었음.
  - 사용자 승인 하에 이번 범위에 포함해 수정: `firebase.database()` → `_fbDb`(이미 초기화된 이름 있는 앱의 database 인스턴스, 파일 전체에서 이미 쓰이던 패턴)로 교체. 한 줄 변경.
- **검증**:
  - `node --test` 63/63 pass (수정 전/후 동일)
  - 로컬 정적 검증: 수정된 sticky 배너가 헤더와 겹치지 않음(바운딩 박스 비교로 확인), 새로고침 버튼 줄바꿈 방지 스타일 추가
  - 실제 프로덕션 Firebase(testmart/test1)로 로그인하는 로컬 사본 2종으로 실사용 시나리오 검증:
    - 수정된 코드 + `APP_VERSION='3'`(Firebase 값 `"4"`와 불일치) → 배너 정상 표시(`display:flex`) 확인
    - 수정된 코드 + `APP_VERSION='4'`(Firebase 값 `"4"`와 일치) → 배너 숨김(`display:none`) 확인
    - 수정 전 코드(커밋 `92576e2` 시점 사본)로는 동일 조건에서 배너가 뜨지 않음을 먼저 재현해 버그를 확정한 뒤 수정
  - Hosting 배포 후 라이브 소스에 `_fbDb.ref('settings/appVersion')`와 `APP_VERSION = '4'` 반영 확인
  - Firebase `settings/appVersion`은 이미 `"4"`였으므로 별도 갱신 없이 유지
- **Sensitive data policy**: 실제 고객 데이터 미사용. 검증 중 실제 Firebase 프로젝트에 대해 읽기 전용 조회 및 임시 리스너 연결만 수행, 쓰기 작업 없음.

### TMS: 공동현관 비밀번호/출입정보(accessInfo) 1차 구현 + 학습주소 phone-priority 키 수정
- **Status**: ✅ Deployed / Verified
- **Commits**: `6485a85`(accessInfo 기능 전체), `fb7c26f`(APP_VERSION 5로 범프)
- **범위**:
  - `detailAddress`(상세주소)와 `accessInfo`(공동현관 비밀번호/출입정보)를 분리한 별도 필드로 추가
  - TMS OCR 확인 화면에 출입정보 입력칸 추가(상세주소 입력칸 바로 아래)
  - 배송목록 카드에 `🔐` 배지로 출입정보 표시(상세주소 배지 아래, 버튼 영역과 분리된 별도 줄)
  - `saveToFirebase(item)`/`confirmAdd()`에 `accessInfo` 배관 연결
  - `settings/learnedLocations`에 `access_info`/`name`/`phone` 필드 저장/조회 지원
  - `processReceipt`가 학습주소 적용 시 `access_info`를 반환하되, 이번 영수증 주소와 학습된 `road_address`가 유사할 때만 포함(오적용 방지) — `functions/lib/receipt-utils.js`의 `isSimilarAddress`/`buildLearnedLocationResponse` 순수함수로 구현
  - **추가 발견 및 수정**: 서버 조회(`resolveLearnKey`)는 전화번호 우선인데 클라이언트 저장(`saveLearnedAddress()`, `confirmAdd()` 자동학습)은 항상 성명 키만 써서, 전화번호가 있는 영수증에서는 학습된 `access_info`/`detail_address`를 못 불러오는 기존 버그를 발견 → 클라이언트에도 동일한 `resolveLearnKey(phone, name)` 로직을 복제해 전화번호 우선 키로 저장하도록 수정, 전화번호 인식 실패 케이스 대비 성명 키에도 동일 데이터 dual-write
- **범위 밖으로 남긴 것(백로그 기록만, 아래 항목 참고)**: OCR 원문 괄호 안 출입정보 자동 분리, 학습주소 저장 자동화 스크립트, 기존 이름 키로만 쌓인 과거 데이터 마이그레이션
- **테스트**: `node --test` 77/77 pass (신규 14개 — `isSimilarAddress` 5, `buildLearnedLocationResponse` 6, phone-key/access_info 연동 3)
- **배포**: Functions(`firebase deploy --only functions`) + Hosting(`firebase deploy --only hosting`) 순서로 배포, 배포 후 `settings/appVersion`을 `APP_VERSION`과 동일하게(`5`) 갱신
- **배포 후 라이브 검증** (합성 데이터만 사용, testmart 테넌트, 검증 직후 전부 삭제):
  - 실제 `confirmAdd()`로 상세주소만/출입정보만/둘다/둘다없음 4가지 조합 저장 → 새로고침 후에도 카드에 유지 확인
  - 배지와 버튼 영역(길찾기/완료체크/✏️) 겹침 없음을 바운딩 박스로 확인(모바일 폭 375px)
  - `saveLearnedAddress()` 호출 → phone 키/name 키 양쪽에 동일 데이터(access_info/name/phone 포함) 저장 확인
  - **`processReceipt` 실제 배포 엔드포인트를 합성 영수증 이미지(canvas로 생성한 "성명/연락처/주소/합계금액" 텍스트)로 직접 호출**해 Vision OCR → Gemini 파싱 → 학습주소 조회 전체 파이프라인을 실제로 거침:
    - 학습된 주소와 동일한 주소로 영수증 작성 → 응답에 `access_info` 포함, 서버 로그에도 `access_info 적용: true` 확인
    - 학습된 주소와 다른 주소로 영수증 작성(동일 전화번호) → 응답의 `access_info`는 빈 값, `road_address`/`detail_address`는 기존 학습값 유지, 서버 로그에 `access_info 적용: false` 확인
  - Functions 에러 로그(`severity>=ERROR`) 배포 이후 0건 확인
  - 브라우저 콘솔 에러는 기존에 알려진 manifest.json/sw.js 404(별도 백로그 항목, 무관)뿐 — accessInfo 관련 신규 에러 없음
  - 테스트 주문 4건 + 학습주소 레코드 3건 전부 삭제, 잔존 없음 확인
- **Sensitive data policy**: 전 과정 합성 데이터만 사용(가짜 이름/전화번호/주소/출입정보). Functions 로그 확인 중 무관한 실제 고객 영수증 로그가 우연히 노출됐으나 본 기록에도 대화 응답에도 옮겨 적지 않음.

### TMS: OCR 괄호 출입정보 자동 분리(splitDetailAndAccessInfo) 배포/검증
- **Status**: ✅ Deployed / Verified (Functions만 배포, Hosting/DB rules 미변경)
- **Commit**: `39f77b8`
- **Scope**: `functions/lib/receipt-utils.js`(`splitDetailAndAccessInfo` 신규, `buildLearnedLocationResponse` 병합 로직 반영), `functions/index.js`(학습주소 미적용 경로에도 분리 적용), `functions/test/receipt-utils.test.js`(신규 13케이스). `saas/driver.html` 변경 없음 — 서버가 미리 분리해 보내면 기존 "화면 입력값 우선" 구조로 충분.
- **키워드 조정**: "종" 단독 매칭 제거(승인받은 수정) — "종로" 등 지명과 겹칠 오탐 리스크 때문. "현관 104열쇠 2634종"은 "열쇠" 키워드로 여전히 분리됨을 회귀 테스트로 확인.
- **Deploy**: `firebase deploy --only functions --project hatdelivery-saas`만 실행. Hosting/`database.rules.json`은 건드리지 않음(`saas/driver.html` 변경 없어서 불필요).
- **Evidence**: `node --test` 90/90 pass. 배포 후 라이브 검증은 아래 evidence-log 참고 — `processReceipt` 실제 엔드포인트를 합성 영수증 이미지로 호출해 4가지 케이스(동/호+출입정보 분리, #기호 포함 분리, 애매한 케이스 미분리, 괄호 없음) 전부 요청된 그대로 확인.
- **Sensitive data policy**: 합성 데이터만 사용, 검증 후 학습주소 레코드 4건 전부 삭제. Functions 로그 확인 시 배포 이후 시간대(`timestamp>="2026-07-07T05:00:00Z"`)로 한정.

### TMS: 학습주소 주소-유사도 게이트 + Cloud Functions PII 로그 마스킹 배포/검증
- **Status**: ✅ Deployed / Verified (Functions만 배포, Hosting/DB rules 미변경)
- **Commits**: `50fec90`(게이트 수정 + PII 마스킹 + 테스트), `44ba8b2`(receiveOrder PII 백로그 등록, docs만)
- **Scope**: `functions/lib/receipt-utils.js`(`buildLearnedLocationResponse` 게이트, `maskForLog` 신규), `functions/index.js`(로그 마스킹 적용), `functions/test/receipt-utils.test.js`+`smoke.test.js`(신규/보강 11케이스). `saas/driver.html`/`database.rules.json`/Hosting 변경 없음.
- **Deploy**: `firebase deploy --only functions --project hatdelivery-saas`만 실행.
- **Evidence**: `node --test` 97/97 pass. 배포 후 실제 `processReceipt` 엔드포인트를 합성 영수증 이미지로 호출해 3가지 케이스(같은 전화번호+같은 주소 → 학습값 전부 적용 / 같은 전화번호+다른 주소 → 학습값 완전 미적용 & 이번 영수증 주소 기준 표준화 진행 / 같은 이름(전화번호 없음)+다른 주소 → 이름 fallback 오적용 없음) 전부 요청된 그대로 확인. `gcloud logging read`로 배포 이후 ERROR 로그 0건, Gemini parsed 로그가 `[len:N]`/`(없음)` 형태로 마스킹되어 실제 이름/전화번호/주소 원문이 로그에 없음을 JSON 페이로드로 직접 확인.
- **Sensitive data policy**: 합성 데이터만 사용, 검증 후 학습주소 레코드 2건 전부 삭제(주문 데이터는 생성되지 않음 — processReceipt만 호출, confirmAdd 미호출). 로그 확인은 배포 이후 시간대(`timestamp>="2026-07-07T07:00:00Z"`)로 한정, 실제 고객 데이터 미노출 확인.

### receiveOrder/parseOrderWithGemini PII 로그 마스킹 배포/검증
- **Status**: ✅ Deployed / Verified (Functions만 배포, Hosting/DB rules 미변경)
- **Commit**: `9db0c18`
- **Scope**: `functions/index.js`(`receiveOrder`/`parseOrderWithGemini`의 `logger.info`/`warn` 호출을 `maskForLog`/길이/카운트 기반으로 마스킹, 응답 바디·Firebase 저장 필드는 변경 없음), `functions/test/smoke.test.js`(정적 검사 4케이스 추가). 위 "학습주소 게이트" 라운드에서 등록했던 백로그 항목(receiveOrder PII 로그 노출) 해결.
- **Deploy**: `firebase deploy --only functions --project hatdelivery-saas`만 실행.
- **Evidence**: `node --test` 101/101 pass. 배포 후 실제 `receiveOrder` 엔드포인트를 합성 SMS 메시지로 2회 호출(정상 주문 1건, 스팸 메시지 1건) — 응답 바디(`success`/`orderId`/`parsed` 스키마)가 기존과 동일하게 유지됨을 확인. `gcloud logging read`로 배포 이후 ERROR 로그 0건, `Gemini 원본 응답 길이`/`원본 메시지 길이`/`최종 이름(마스킹)`/`주문 접수 완료` 등 모든 관련 로그가 `[len:N]`/`(없음)` 형태로만 남고 실제 성명/전화번호/주소/원문 메시지가 로그 어디에도 없음을 JSON 페이로드로 직접 확인.
- **Sensitive data policy**: 합성 데이터만 사용(가짜 이름/전화번호/주소/품목). 검증 중 생성된 테스트 주문 2건(`orders/ext_...`, 테넌트 스코프 밖 루트 경로) 전부 삭제 확인. `ORDER_AUTH_TOKEN` 값은 로컬 `.env`에서 셸 변수로만 로드해 사용, 대화 응답이나 로그에 출력하지 않음.

### TMS: OCR 실패 UX 개선(401/403/500/세션만료 안내) 배포/검증
- **Status**: ✅ Deployed / Verified (Hosting만 배포, Functions/DB rules 미변경)
- **Commits**: `941d9f0`(UX 개선 코드), `7f5a691`(APP_VERSION 6 범프)
- **Scope**: `saas/driver.html`만 변경 — `_authHeader()`(세션 만료 시 명확한 안내), `friendlyErrorMessage()` 신규 공용 헬퍼(401/403/500을 상태별 안내로 변환), `startOCR()`/`regeocodeAddr()`가 실패 시 서버 message를 읽어 반영. OCR/학습주소/DB 저장 로직, Cloud Functions 변경 없음.
- **Deploy**: `firebase deploy --only hosting --project hatdelivery-saas`만 실행. `DEPLOY_CHECKLIST.md` "4-1" 절차대로 배포 전 `APP_VERSION` 5→6 범프, 배포 후 `settings/appVersion`도 6으로 갱신.
- **Evidence**: `node --test` 101/101 pass(변경이 클라이언트 전용이라 그대로). 배포 후 실제 라이브에서 검증:
  - 정상 OCR 흐름: 실제 `startOCR()` 호출로 합성 영수증 이미지 처리 → 이름/주소/전화/금액 정상 채워지고 결과 화면 전환 확인(회귀 없음)
  - 401/403/500: 실제 배포된 `processReceipt` 엔드포인트를 인증 없음/테넌트 불일치/빈 이미지(Vision 실패 유발)로 각각 호출 → `friendlyErrorMessage()`가 상태 코드별 안내 문구로 정확히 변환함을 확인
  - 업데이트 배너/appVersion 동기화: 배포 전부터 열려있던 탭(구버전 코드, `APP_VERSION='5'` in-memory)에서 로그인 시 배너가 정상 표시됨을 확인, 새로 로드한 탭(`APP_VERSION='6'`)에서는 배너가 뜨지 않음을 확인
- **Sensitive data policy**: 합성 데이터만 사용. `startOCR()`/오류 테스트 호출은 `confirmAdd()`를 거치지 않아 Firebase에 아무 데이터도 생성되지 않음 — 재조회로 잔존 없음 확인.

### OMS/TMS ETA 계산 기준 통일 + TMS 배송카드 ETA 배지 + app.html sendToDelivery() ReferenceError 수정
- **Status**: ✅ Deployed / Verified (Hosting만 배포, Functions/DB rules 미변경)
- **Commits**: `08e77d3`(ETA 통일 + 배지 + 버그수정), `c9df2af`(APP_VERSION 7 범프)
- **배경**: read-only 분석 라운드에서 OMS(`app.html`)와 TMS(`driver.html`)에 서로 다른 3개의 ETA/정차시간 계산식이 흩어져 있는 것을 발견(`app.html`의 `_calcStopMinutes`, `driver.html`의 `fetchTrafficTime()` 내부 인라인 로직, `driver.html`의 `launchNav()` 개별 기록용 고정상수). 사용자가 "TMS 단독 신규 기능이 아니라 OMS/TMS ETA 기준 통일"로 스코프를 재정의하고 통일 기준(35km/h, 거리×1.4, 금액 5단계, 건물키워드 7개)을 직접 지정.
- **Scope**:
  - `saas/app.html`: 공용 상수(`ETA_AVG_SPEED_KMH`/`ETA_DISTANCE_FACTOR`/`ETA_BUILDING_KEYWORDS`) 신설, `_calcStopMinutes()`를 금액 5구간+건물키워드 방식으로 교체, `_calcEstimatedMinutes()`(카카오 API 실패 시 haversine 폴백)에 1.4배 거리보정 추가, `sendToDelivery()`의 미정의 변수(`ROUTE_AVG_SPEED_KMH`/`STOP_MINUTES_PER_ORDER`) 참조로 인한 ReferenceError 버그를 공용 상수로 교체해 수정. `_kakaoRouteOptimize()`/`_calcEstimatedMinutesAsync()`/`_swapOptimizeClusters()` 등 자동배정/Swap 최적화 알고리즘 구조 자체는 변경 없음(입력값만 변경).
  - `saas/driver.html`: 동일 상수/`_calcStopMinutes` 복제(동기화 필요 주석 포함, `resolveLearnKey`와 동일 패턴), 배송카드용 ETA 배지 신규(`_calcEtaMinutesTo`/`_buildEtaDisplayMap`/`_renderEtaBadge`) — 좌표없음/위치공유필요/계산값(단독 추정 "약 N분 후" 또는 경로최적화 후 누적 "대략 HH:MM 도착 예상") 3상태 구분. `fetchTrafficTime()`의 3번째 divergent 정차시간 공식을 공용 `_calcStopMinutes()`로 통일.
  - `launchNav()`의 개별 Firebase `eta` 기록(자체 고정상수 사용)은 이번 라운드에서 미변경 — 잔존 불일치, 필요 시 별도 라운드.
- **영향도(사용자에게 사전 설명 완료)**: 15만~20만원 구간 정차시간 10분→8분, haversine 폴백 경로에 1.4배 거리보정 신규 적용(카카오 실시간 경로 성공 케이스는 영향 없음), 건물키워드 목록 변경(숫자패턴 `\d+동\s*\d+호`/소문자 `apt` 제거, 맨션/주공/타운/하이츠 신규 추가) — 자동배정 큐/Swap 알고리즘 구조는 그대로이나 비용 함수 입력값이 바뀌어 근소한 동률 케이스의 배정 결과가 달라질 수 있음.
- **테스트**: `node --test "test/*.test.js"` **101/101 pass**(functions/ 미변경, 영향 없음 확인용 재실행). `saas/app.html`은 이 세션에 OMS Firebase 로그인 정보가 없어 브라우저 실행 불가 → 실제 커밋된 소스를 Node로 추출해 샌드박스에서 실행: 금액 5구간 경계값 전부(0~500000원 전 구간), 건물키워드 7개 전부(아파트/빌라/맨션/주공/타운/하이츠/오피스텔) 매칭 확인, 순수 "101동 202호" 패턴 비매칭 확인(요청대로 동/호 단독 키워드 미사용), `sendToDelivery()` 수정 블록이 ReferenceError 없이 정상 동작함을 확인.
- **Deploy**: `firebase deploy --only hosting --project hatdelivery-saas`만 실행. `DEPLOY_CHECKLIST.md` "4-1" 절차대로 배포 전 `APP_VERSION` 6→7 범프(커밋에 포함), 배포 후 Firebase `settings/appVersion`도 "7"로 갱신.
- **배포 후 라이브 검증**: `_bmad/tea/evidence-log.md`의 "2026-07-08 — OMS/TMS ETA 통일 배포 검증" 참고. TMS는 testmart 실계정으로 카드 배지 4개 상태(좌표있음/건물키워드/좌표없음/GPS꺼짐-마트위치대체/경로최적화 누적) 전부 실브라우저 확인, 모바일 폭 겹침 없음 확인, 완료체크/취소 플로우 회귀 없음 확인, 업데이트 배너 정상 동작 확인. OMS는 로그인 정보 부재로 샌드박스 소스 검증으로 대체(사용자 승인).
- **Sensitive data policy**: 합성 데이터만 사용. 검증 중 생성한 TMS 테스트 배송 3건은 로컬스토리지에만 존재(Firebase 미기록), 검증 종료 후 전부 정리 확인.

### P1-001: 기사앱 비밀번호 찾기 기능 복구 (Cloud Function 이전 + mustChangePassword 강제)
- **Status**: ✅ Deployed / Verified (Functions + Hosting)
- **Commits**: `1c8c84f`(핵심 기능: `resetDriverPassword` 신규, `issueDriverToken` 필드 확장, `doFindPw()` 마이그레이션, 강제 변경 게이트), `bc098ea`(APP_VERSION 8), `639acd2`(findpw-modal z-index 버그 수정 + APP_VERSION 9), `aea2cbb`(bcryptjs CDN 경로 버그 수정 + APP_VERSION 10)
- **배경**: `doFindPw()`가 Firebase Auth 로그인 전 상태에서 클라이언트가 직접 `tenants/{tenantId}/driverAccounts/{driverId}`를 read/write하려 시도해 `database.rules.json`의 `auth != null` 규칙에 항상 막혀 100% 실패하던 문제(`SECURITY_ISSUES.md` P1-001). 상세 설계/구현 내용은 `SECURITY_ISSUES.md` P1-001 항목 참고(중복 방지를 위해 이 항목에는 요약만 기록).
- **핵심 변경**: `resetDriverPassword` Cloud Function 신규(전화번호 본인확인, 계정 미존재/비활성/불일치 전부 동일 메시지, 계정당 1시간 5회 레이트리밋, 임시비밀번호는 bcrypt 해시로만 저장, `mustChangePassword:true`, PII 없는 감사 로그). `issueDriverToken` 응답에 `mustChangePassword` 필드 추가. `driver.html`에 로그인 직후 강제 비밀번호 변경 화면 신설(`enterAppOrForceChange`/`doForceChangePw`) — 기존 TMS에는 이 강제 로직이 아예 없었음(OMS `omsAccounts`에만 있던 패턴을 이식). `database.rules.json`은 전혀 변경하지 않음(Admin SDK가 규칙을 우회, 로그인 후 비밀번호 변경 write는 기존 규칙으로 이미 허용되는 범위).
- **검증 중 발견한 두 건의 사전 버그(이번 라운드에 함께 수정, 사용자 승인)**: (1) `#findpw-modal`의 z-index(3000)가 `#login-screen`(9999)보다 낮아 실제 클릭이 로그인 화면으로 새어나가 모달의 "확인" 버튼이 클릭 불가능했던 문제 — `elementFromPoint`로 직접 확인. (2) `driver.html`의 bcryptjs CDN 경로가 잘못된 패키지명(`bcrypt.js`)이라 항상 404 → Chrome ORB 차단 → `dcodeIO` 전역이 절대 정의되지 않던 문제(`curl -I`로 404 확인, 올바른 이름 `bcryptjs`는 200 확인) — `app.html`은 이미 올바른 경로+jsdelivr 폴백을 쓰고 있어 영향 없었음. 두 버그 모두 이번 세션에서 새로 만든 코드가 아니라 기존에 잠재해 있던 문제였고, 방금 만든 기능이 실제로 도달하지 못하게 막고 있어서 함께 고쳤음.
- **테스트**: `node --test "test/*.test.js"` **109/109 pass**(기존 101 + 신규 8, `functions/test/driver-pw-reset.test.js`에서 실제 커밋된 소스를 mock DB로 추출 검증).
- **배포**: `firebase deploy --only functions,hosting --project hatdelivery-saas`(1차) + `--only hosting`(z-index/CDN 수정 2회 후속 배포). `database.rules.json` 배포 안 함. `DEPLOY_CHECKLIST.md` §4-1 절차대로 매 배포마다 `APP_VERSION` 범프(8→9→10) + `settings/appVersion` 동기화.
- **배포 후 라이브 검증** (testmart tenant, `tenants/testmart/driverAccounts/pwtest1`·`pwtest_inactive` 합성 계정만 사용, 실제 운영 기사 계정/비밀번호 미접촉): 존재하지 않는 ID/비활성 계정/전화번호 불일치 → 전부 동일한 401 일반 메시지(REST 직접 호출로 확인) / 레이트리밋 5회 실패 후 6번째 429 확인 / 감사 로그 필드가 `driverId,reason,success,tenantId,timestamp`뿐이고 전화번호 문자열 미포함 확인 / 실제 UI로 비밀번호 찾기 → 임시 비밀번호 발급 및 로그인 필드 자동 입력 확인 / 임시 비밀번호로 로그인 → 강제 변경 화면 노출 확인(로그인 직후 경로 + 세션 복원 경로 양쪽 모두) / 새 비밀번호 저장 → `mustChangePassword:false` 해제 확인(RTDB 직접 조회) / 새 비밀번호로 재로그인 시 강제 화면 재노출 없음 확인 / 기존 일반 계정(test1)은 이번 변경과 무관하게 회귀 없이 정상 로그인 확인 / 업데이트 배너 정상 동작 확인.
- **Sensitive data policy**: 합성 계정(`pwtest1`, `pwtest_inactive`, 가짜 전화번호)만 사용, 실제 고객/기사 데이터 미접촉. 검증 중 생성된 합성 계정 2건과 관련 감사 로그 9건 전부 삭제, `curl`로 재조회해 잔존 없음(`null`) 확인. 임시 비밀번호/해시 값은 파일에 기록하되 대화 응답에는 노출하지 않음.
- **후속(이번 범위 밖)**: IP 기반 레이트리밋, 테넌트 내부 역할 분리(기존 백로그 항목).

### TMS: "이전 배송완료 사진 보기" MVP (배송완료 화면 참고용)
- **Status**: ✅ Deployed / Verified (Hosting만 배포, Functions/DB rules 미변경)
- **Commits**: `07ed9b8`(기능 구현 + `SECURITY_ISSUES.md` Storage 규칙 기록), `bc4980f`(APP_VERSION 11 범프)
- **배경**: 배송기사가 오배송 방지를 위해 이전 배송완료 사진(도어록/문 앞 위치 확인용)을 참고하고 싶다는 요청. 강제 확인/체크박스 없이 "선택형 참고"로 1차 MVP 범위를 좁혀 진행(read-only 분석 2라운드 후 구현).
- **핵심 변경**: `saas/driver.html`에 `isSimilarAddress()`(`functions/lib/receipt-utils.js`와 동일 규칙 클라이언트 이식), `saveDeliveryPhotoHistory()`(완료사진 Storage 업로드 성공 후 `tenants/{tenantId}/deliveryPhotoHistory/{learnKey}`에 최근 1장만 overwrite, 신규 Storage 업로드 없이 기존 `photoUrl` 재사용), `findPreviousDeliveryPhoto()`(learnKey 조회 + 주소 유사도 재검증 + 자기 자신 제외, 실패 시 전부 null), `viewPhotoUrl()`(기존 `#photo-viewer` 모달 재사용, 삭제 버튼 숨김 처리) 신규 추가. 배송완료 화면(`openCompleteScreen()`)에만 노출, 배송카드 목록은 변경 없음. `database.rules.json`/`storage.rules` 변경 없음(신규 경로가 기존 `tenants/{tenantId}` 규칙을 그대로 상속).
- **테스트**: `node --test "test/*.test.js"` **109/109 pass**(functions 미변경). 로컬 정적 서버 + Playwright로 실제 커밋 소스의 매칭 로직 8개 시나리오(이력없음/같은주소/다른주소/유사주소/자기자신제외/조회예외/키없음/저장필드) 전부 mock DB로 검증, 검증 중 `openCompleteScreen()`의 `.then()`에 `.catch()`가 빠져있던 실제 방어 코딩 허점을 발견해 수정.
- **Deploy**: `firebase deploy --only hosting --project hatdelivery-saas`만 실행. `DEPLOY_CHECKLIST.md` §4-1 절차대로 배포 전 `APP_VERSION` 10→11 범프, 배포 후 `settings/appVersion`도 "11"로 갱신.
- **배포 후 라이브 검증**: `_bmad/tea/evidence-log.md`의 "2026-07-08 — 이전 배송완료 사진 보기 MVP 배포 검증" 참고. testmart 실계정으로 실제 `submitComplete()` 완료 플로우를 3회 수행(합성 데이터)해 이력없음/같은주소 표시/다른주소 미표시 3개 케이스 전부 실제 Firebase 조회로 확인, photo-viewer 모달·삭제버튼 숨김·모바일 375px 레이아웃·업데이트 배너 전부 정상, 콘솔 에러 0건.
- **남은 리스크**: Storage 규칙이 코드베이스에서 관리되지 않는 기존 이슈(`SECURITY_ISSUES.md` 참고, 이번 기능은 기존 `photoUrl` 메커니즘을 재사용할 뿐 새 리스크를 추가하지 않음), 테넌트 내부 역할 분리 미해결(같은 테넌트 기사 간 상호 열람 가능한 기존 신뢰 경계 그대로), `openCompleteScreen()`을 거치지 않는 대체 완료 경로(`capturePhoto()`/`toggleDone()`)는 이번 라운드에서 손대지 않아 해당 경로로 완료된 배송은 `deliveryPhotoHistory`가 갱신되지 않음(필요 시 별도 라운드).
- **Sensitive data policy**: 합성 데이터만 사용(가짜 이름/전화번호/주소). 검증 중 실제 완료 플로우로 생성된 테스트 orders 3건, `deliveryPhotoHistory` 1건, Storage 사진 1건 전부 REST/Storage API로 삭제, 재조회로 잔존 없음(`null`/`404`) 확인.

### TMS 기사 사용률 개선 1차 — OCR 빠른 확인모드 + 반복배송 학습 체감 UX
- **Status**: ✅ Deployed / Verified (Functions + Hosting 배포, `database.rules.json` 미변경)
- **Commits**: `ac046e9`(핵심 기능: 결과화면 신호등 상태 + 자동학습 + 카드 배지), `2876dd5`(APP_VERSION 12 범프)
- **배경**: 와마트 민락점 기사 피드백 — OCR이 틀릴 때마다 전체 폼을 다시 확인해야 해서 느리고, 자주 가는 주소도 매번 새로 처리되는 느낌. 후보 주소 목록 UI는 만들지 않는다는 전제 하에(시스템이 이미 최선의 주소 1개를 자동 선택하는 기존 구조를 그대로 활용), read-only 분석 2라운드를 거쳐 구현.
- **핵심 변경**:
  - `functions/index.js`: `processReceipt` 응답의 `location`에 `source` 필드 추가(`'learned'`/`'standardized'`/`'raw_fallback'`) — 클라이언트가 신호등 상태를 판정하는 유일한 신규 서버 신호. `standardizeAddress()` 내부 로직 자체는 변경 없음.
  - `saas/driver.html`: `computeResultStatus()`/`renderResultStatus()` 신규(필드별+화면 전체 초록/파랑/노랑/빨강 판정), 값 있는 필드는 잠금(탭하면 즉시 편집), 값 없는 필드는 처음부터 편집 가능. 기존에 초기 `readOnly`를 설정하지 않아 동작이 뒤집혀 있던 죽은 코드 `toggleEdit()`/`setEditMode()`를 이 로직으로 대체. `startOCR()`의 `showRetakePrompt()` 자동 호출 제거 — 필드 일부가 비어도 곧장 결과화면으로 진입하고, 완전 실패(주소 없음, 빨강)일 때만 화면 안 링크로 재촬영 안내. 결과화면에 원본 영수증 사진 확대 보기(기존 `#photo-viewer`/`viewPhotoUrl()` 재사용, 신규 모달 없음) 추가. `confirmAdd()`가 기사의 수정 여부와 무관하게 성공적으로 표준화된 주소를 조용히 `learnedLocations`에 자동 학습(`autoSaveLearnedAddressIfSafe()`, `isSimilarAddress` 게이트로 오적용 방지). 배송카드에 반복배송 배지(학습주소 적용/이전 배송사진 있음/출입정보 있음/길찾기 가능)를 `confirmAdd()` 시점에 저장해둔 필드만으로 렌더링(카드 렌더링 시 Firebase 추가 조회 없음). 카드/결과화면 버튼 개수는 기존 그대로 유지, 라벨/역할만 상태별 전환.
- **테스트**: `node --test "test/*.test.js"` **109/109 pass**. 배포 전 Node 샌드박스로 실제 커밋 소스 검증 — `computeResultStatus()` 8개 시나리오, `autoSaveLearnedAddressIfSafe()` 4개 시나리오(신규저장/유사주소갱신/**다른주소 오적용 방지**/좌표없으면 미저장) 전부 통과. 로컬 Playwright로 4개 상태 UI·사진뷰어 재사용·모바일 375px 확인.
- **Deploy**: `firebase deploy --only functions,hosting --project hatdelivery-saas`. `DEPLOY_CHECKLIST.md` §4-1 절차대로 배포 전 `APP_VERSION` 11→12 범프, 배포 후 `settings/appVersion`도 "12"로 갱신.
- **배포 후 라이브 검증**: `_bmad/tea/evidence-log.md`의 "2026-07-08 — OCR 빠른 확인모드 배포 검증" 참고. testmart 실계정으로 실제 `processReceipt` 엔드포인트를 3가지 합성 영수증(캔버스 렌더링)으로 호출해 `standardized`(초록)/`raw_fallback`(노랑)/`learned`(파랑) 3개 `source` 값 전부 실제로 확인, `showRetakePrompt` 없이 결과화면 진입 확인, 자동 학습 실제 저장 확인, **같은 전화번호 다른 주소 덮어쓰기 방지 실측 확인**, 배송카드 배지 실제 렌더링 확인, 모바일 375px 겹침 없음, 콘솔 에러 0건.
- **부수 발견(버그 아님)**: 처음 테스트한 원거리 주소(강남구/중구)가 예상과 달리 `raw_fallback`으로 나와 원인을 Cloud Functions 로그로 추적한 결과, testmart 마트 반경(3km) 밖이라 카카오 검색 결과가 의도적으로 거부되고 있었음(`kakaoAddrSearch 쿼리: 최근접 X.Xkm > 3km → reject`) — 기존 원거리 오배송 방지 설계가 정상 작동한 것으로 확인.
- **남은 리스크/후속**: `isSimilarAddress`가 카카오 표준화 과정에서 단어가 추가/변형되는 경우(예: "지하" 삽입) 원본 OCR 텍스트와 문자열이 달라져 학습주소가 미적용될 수 있음 — 실제 라이브 테스트에서 재현됨. 다만 이는 오적용 방지를 우선하는 기존 "애매하면 미적용" 원칙과 일치하므로 즉시 수정 대상은 아니며, 운영 중 발생 빈도를 모니터링해 필요 시 별도 개선(예: 표준화 후 주소로 재비교) 검토. "이전 배송사진 있음" 카드 배지는 이번 라운드에서 완료 사진 업로드까지 가는 전체 플로우 재검증은 생략(직전 라운드에서 이미 검증된 기능이라 카드 렌더링 로직만 확인). `capturePhoto()`/`toggleDone()` 등 `openCompleteScreen()`을 거치지 않는 대체 완료 경로는 이번 범위 밖(기존 "이전 배송사진" 라운드와 동일한 한계).
- **Sensitive data policy**: 합성 데이터만 사용(가짜 이름/전화번호/실제 존재하지만 무관한 공개 도로명 주소). 검증 중 실제 `confirmAdd()`로 생성된 테스트 orders 4건, `learnedLocations`(전화번호 키+이름 키), Storage 영수증 사진 3건 전부 REST/Storage API로 삭제, 재조회로 잔존 없음(`null`/`404`) 확인.

### TMS 배송순번/경로최적화 UX 개선 — 경로최적화 반영 + 나중에 배송 섹션
- **Status**: ✅ Deployed / Verified (Hosting만 배포, Functions/`database.rules.json`/`storage.rules` 미변경)
- **Commits**: `55fe40d`(핵심 기능: 경로최적화/드래그 결과 반영 + 상세주소·출입정보 표시 + 나중에 배송 섹션), `6fc8257`(APP_VERSION 13 범프)
- **배경**: 기사 피드백 — 경로최적화에서 순서를 바꿔도 배송목록엔 반영이 안 되고, 경로최적화 화면엔 상세주소가 안 보이며, 배달 중 후번 배송을 먼저 처리하고 싶을 때 현재 배송을 뒤로 미룰 방법이 없었음. read-only 분석 라운드에서 `routeOrder`(경로최적화 화면 전용)와 `deliveries`(배송목록)가 완전히 독립된 배열이라 자동정렬/드래그 결과가 카드 순번에 전혀 반영되지 않는 구조적 원인을 확인 후 구현.
- **핵심 변경**: `saas/driver.html`에 `syncDeliveriesOrderFromRoute()`(신규, `optimizeRoute()`의 자동정렬 직후 + 드래그 `onEnd()` 양쪽에서 호출, `routeOrder` 순서로 `deliveries`를 안정정렬 후 `saveDeliveries()`), 경로최적화 리스트(`renderRouteList()`)에 상세주소/출입정보 표시(값 없으면 생략), `_renderDeliveryCard()`(카드 템플릿을 헬퍼로 분리), `postponeDelivery()`/`unpostponeDelivery()`(신규 — 상태는 `pending`/`delivering` 그대로 두고 UI 전용 로컬 필드 `_postponed`만 토글, Firebase에 기록 안 함), `renderHome()`이 배송중 탭 안에서 "배송중"/"나중에 배송" 두 섹션으로 분리 렌더링(섹션마다 독립 순번). "완료" 버튼은 기존과 동일하게 `openCompleteScreen()`(사진촬영 확인 화면)만 열고 상태를 바꾸지 않음 — 실제 완료는 사진 촬영 후에만 발생. `toggleDone()`의 되돌리기 경로에서 `_postponed`도 함께 초기화.
- **버튼 UX 반복**: 카드 버튼은 4개(길찾기/완료/나중 또는 복귀/✏️) 유지, ⋯ 메뉴 방식은 이번 1차에서 채택 안 함(사용자 결정). 375px에서 "다시배송중"(5글자) 라벨이 2줄로 줄바꿈되는 것을 로컬 테스트에서 발견해 "복귀"(2글자, "나중"과 동일 폭)로 축약 후 재검증.
- **배송지도(mapzone) 미변경**: `postponeDelivery()`가 `routeOrder`도 함께 동기화해두어, 배송지도의 기존 `routeOrder` 참조 로직(코드 변경 없음)이 자연히 최신 순서를 반영.
- **테스트**: `node --test "test/*.test.js"` **109/109 pass**(functions 미변경). 로컬 Playwright로 자동정렬/드래그 반영, 상세주소/출입정보 표시, 나중/복귀 왕복, 완료 후 섹션 이탈, 되돌리기 시 `_postponed` 초기화, 모바일 375px 겹침 없음 전부 확인.
- **Deploy**: `firebase deploy --only hosting --project hatdelivery-saas`. `DEPLOY_CHECKLIST.md` §4-1 절차대로 배포 전 `APP_VERSION` 12→13 범프, 배포 후 `settings/appVersion`도 "13"으로 갱신.
- **배포 후 라이브 검증**: `_bmad/tea/evidence-log.md`의 "2026-07-09 — 배송순번/나중에 배송 UX 배포 검증" 참고. testmart 실계정으로 실제 자동정렬 결과가 배송목록에 반영되는 것, 나중/복귀 상태 전환, 완료 후 진행률·탭 갱신, ETA 재계산, 모바일 375px, 라이브 도메인에서 배송지도 지도 자체는 정상 로드됨을 전부 확인. 이번 라운드는 실제 사진 촬영/업로드까지는 재현하지 않고 상태 직접 변경으로 완료 후 UI 갱신만 확인(사진촬영 플로우 자체는 이전 라운드에서 이미 검증 완료).
- **별도 발견(이번 커밋과 무관)**: 배송지도 탭에서 `kakaoWaypoints` Cloud Function 호출이 403으로 실패 — `git show`로 add/remove 라인만 필터링해 재확인한 결과 이번 커밋은 `mapzone`/`kakaoWaypoints`/`showRouteMode` 관련 코드를 전혀 변경하지 않음(주석 1줄에서만 언급). 지도/마커/줌/전체보기는 정상 동작. 카카오 다중경유지 API의 정책/제한 변경 가능성이 있다고 판단되어, 후속 조치는 "인증 오류 수정"이 아니라 **"배송지도 경로선 기능 자체를 대체 설계"**하는 방향으로 아래 백로그에 별도 기록.
- **Sensitive data policy**: 합성 데이터만 사용(가짜 이름/전화번호/실제 존재하지만 개인과 무관한 공개 도로명 주소). 이번 라운드는 전부 로컬스토리지 전용 데이터로 검증해 **Firebase 쓰기 자체가 없었음**(정리 대상 없음, 재확인으로 `todayCount:0`/`storageEmpty:null` 확인).

### TMS 라이브 사용성 피드백 1차 — 배지/버튼 노출 정리
- **Status**: ✅ Deployed / Verified (Hosting만 배포, Functions/`database.rules.json`/`storage.rules` 미변경)
- **Commits**: `eba07dc`(핵심 변경: 배지/버튼 노출 정리), `c83ee41`(APP_VERSION 14 범프)
- **배경**: 실제 라이브 사용 중 기사 피드백 6건 — (1) "길찾기 가능" 배지가 거의 모든 카드에 항상 떠서 무의미, (2) 영수증 확대 화면에서 원본 주소가 잘 안 보임, (3) "소요시간 다시 확인" 버튼이 항상 크게 떠서 부담스러움, (4) 배송카드가 크고 왼쪽으로 치우쳐 한눈에 보기 어려움, (5) "학습주소 저장" 버튼이 자동학습과 중복돼 혼란, (6) "도로명 주소 변환" 버튼의 용도/사용 시점이 설명 없음. read-only 분석 라운드를 거쳐 1차(즉시 수정)/2차(별도 라운드) 범위를 나눈 뒤 사용자 승인 하에 1차만 구현.
- **핵심 변경** (`saas/driver.html`만):
  - "길찾기 가능" 배지 완전 제거(`_renderCardInfoBadges()`, `computeResultStatus()`의 `badges.nav`, `renderResultBadges()` 3곳) — 좌표 있는 배송이 거의 전부라 상시 노출되던 무의미한 배지. 좌표 없음 경고("좌표 없음"/"위치 공유 필요" ETA 배지)는 그대로 유지.
  - "학습주소 저장" 버튼(`#save-learned-btn`) 기본 `display:none`으로 숨김. 자동학습(`autoSaveLearnedAddressIfSafe()`, 이전 라운드에서 구현)과 기능이 중복되고, 함수 자체는 `saveLearnedAddress()`가 `window._ocrLat`/`_ocrLng`(도로명 변환 "적용" 경로에서만 설정됨)를 좌표로 읽어 일반 스캔 흐름에서 누르면 좌표 없이 저장되는 잠재 버그가 있어(발견만 하고 이번 라운드에서는 미수정) UI 노출만 제거.
  - "도로명 주소 변환" → "📍 주소 다시 찾기"로 문구 변경, 하단에 "주소가 이상하거나 지번주소일 때 눌러주세요" 안내문 추가. `renderResultStatus()`에서 초록/파랑(이미 확정) 상태면 `.regeo-muted` 클래스로 톤다운, 노랑/빨강(확인 필요)이면 원래 강조 스타일 유지.
  - "소요시간 다시 확인" 버튼(`#traffic-refresh-btn`) 기본 `display:none`으로 숨김. 자체 ETA 배지는 그대로 유지. `fetchTrafficTime()`은 버튼 참조를 이미 null-safe하게 다루고 있어 숨겨도 화면 진입 시 자동 조회는 정상 동작.
  - `.delivery-item` padding 16→14px, `.dl-top`의 `align-items`를 `center`→`flex-start`로 변경(순번 원이 카드 중간에 떠 보이지 않고 이름과 같은 줄 상단에 고정).
- **테스트**: `node --test "test/*.test.js"` **109/109 pass**(functions 미변경). 별도 Node 샌드박스로 실제 커밋된 `computeResultStatus()` 8개 시나리오를 `badges.nav` 제거 후 재실행해 전부 통과 확인(회귀 없음).
- **Deploy**: `firebase deploy --only hosting --project hatdelivery-saas`. `DEPLOY_CHECKLIST.md` §4-1 절차대로 배포 전 `APP_VERSION` 13→14 범프, 배포 후 `settings/appVersion`도 "14"로 갱신.
- **배포 후 라이브 검증**: `_bmad/tea/evidence-log.md`의 "2026-07-09 — TMS 라이브 사용성 피드백 1차 배포 검증" 참고. testmart 실계정으로 실제 `confirmAdd()`를 호출해 생성한 합성 배송 2건(좌표 있음/없음)으로 배지·ETA 경고 유지 확인, OCR 결과화면 신호등 상태(파랑/노랑) 양쪽에서 버튼 노출·문구·톤다운 확인, 나중/복귀/완료화면/수정모달 실제 클릭으로 회귀 없음 확인, 모바일 375px 스크린샷으로 겹침 없음 확인.
- **중요 발견**: 경로최적화 화면 진입 시 `kakaoWaypoints` Cloud Function 호출이 라이브에서 실제로 **403**을 반환하는 것을 콘솔 로그로 직접 확인 — 아래 "배송지도(mapzone) 경로선 기능 대체 설계 필요" 항목과 동일한 원인. "소요시간 다시 확인" 버튼이 UI상 부담스러웠던 것뿐 아니라 애초에 눌러도 항상 실패하는 기능이었다는 뜻으로, 이번 라운드에서 버튼을 숨긴 결정이 실측으로 뒷받침됨. 후속 방향은 API 복구가 아니라 다중경유지 API 의존 자체를 제거하는 쪽(아래 백로그 항목 참고).
- **후속(이번 범위 밖, 아래 백로그에 별도 기록)**: `saveLearnedAddress()` 좌표 미설정 버그 수정 또는 기능 재설계, 영수증 원본 확대/줌/이동, 배송목록 compact layout 전면 재설계, 수기 출입정보 직접입력 필드, 아파트/빌라/건물명 detailAddress 자동 분리.
- **Sensitive data policy**: 합성 데이터만 사용(가짜 이름/전화번호/가상 주소). 검증 중 `confirmAdd()`로 생성된 테스트 orders 2건 전부 REST API로 삭제, 재조회로 잔존 없음(`null`) 확인. `learnedLocations` 신규 생성 없음(사전 코드 분석으로 예측한 대로 재확인). testmart 계정 비밀번호는 사용자가 세션 내에서 직접 전달했으며 이 문서/커밋/로그 어디에도 기록하지 않음.

---

## 진행 대기 (P1)

- ~~**P1-001: 기사앱 비밀번호 찾기 기능 복구**~~ → **완료**: 위 "완료" 섹션의 "P1-001: 기사앱 비밀번호 찾기 기능 복구" 항목 참고.
- **ORDER_AUTH_TOKEN 로테이션** — 현재 값은 기존 하드코딩 값과 동일하게 유지 중(운영 중단 회피 목적). 더 강력한 값으로 교체 시 MacroDroid 쪽 헤더 값도 동시에 변경 필요. 운영 준비 후 별도 진행.
- **testmart/test1 계정 비밀번호 로테이션** — "TMS 라이브 사용성 피드백 1차" 문서화 라운드(2026-07-09)에서 `_bmad/tea/evidence-log.md`(P1-001 검증 항목, 이번 세션보다 이전 커밋)에 이 계정의 평문 비밀번호가 그대로 기록돼 있던 것을 발견해 `[REDACTED]`로 마스킹 완료(git 히스토리에는 과거 커밋으로 여전히 남아있음). 같은 문자열이 `멀티테넌트_전환계획.md`에도 남아있음(이번 라운드 범위 밖이라 미수정). 테스트 계정이라도 실제 비밀번호가 저장소 히스토리에 평문으로 남아있는 상태이므로, 비밀번호 자체를 새 값으로 교체하는 것을 권장. 로테이션 시 `resetDriverPassword` Cloud Function 또는 직접 DB 갱신으로 처리 가능(P1-001 항목 참고).

## 진행 대기 (정리/품질)

- ~~**`.agents/`, `.claude/skills/` 커밋 여부 판단**~~ → **결정 완료**: `node_modules`와 동일하게 취급, `.gitignore`에 추가하고 저장소에는 포함하지 않음(각 12MB, `playwright-cli` 스킬 1개 차이만 있고 사실상 완전 중복). 필요 시 아래 명령어로 재생성:
  ```powershell
  npx bmad-method install --directory . --modules bmm --tools claude-code,codex --yes
  npx bmad-method install --directory . --custom-source https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise --tools claude-code,codex --action update --yes
  ```
- **`standardizeAddress` 오케스트레이션 통합 테스트** — 1~4차 폴백 순서 전체와 Gemini 프롬프트 동작(복수주소 선택 등)은 아직 통합 테스트 없음. 순수 함수 단위(문자열 파싱, 후보 선택)는 커버됨.
- **git 저장소 정리** — `orders.json`, `functions.zip`, `functions/node_modules` 히스토리 내 잔존 여부 및 재작성(BFG 등) 필요성 별도 논의.
- **TMS 배포 버전 갱신 자동화** — 현재는 `APP_VERSION` 상수와 Firebase `settings/appVersion`을 사람이 수동으로 맞춰야 함(`DEPLOY_CHECKLIST.md` "4-1" 절차 참고). 배포 스크립트가 배포 시각 기반 값을 자동 생성해 양쪽에 동시에 써주는 방식으로 자동화하면 수동 누락 리스크 제거 가능. 이번 라운드에서는 범위 밖으로 유보.
- **PWA manifest/sw 경로 불일치** — `saas/driver.html`이 `/hat-delivery/manifest.json`, `/hat-delivery/sw.js`를 참조하는데 실제 배포 루트(`hatdelivery-saas.web.app/`)에서 둘 다 404 확인됨(`manifest.json`은 저장소에 파일 자체가 없음). PWA 설치/오프라인 캐시 갱신 흐름이 현재 완전히 미동작 상태(콘솔에서 조용히 실패, 기능상 악영향은 없음). 실제 PWA 기능이 필요한지 확인 후 (a) 경로를 `/manifest.json`, `/sw.js`로 고치고 `manifest.json`을 새로 작성하거나 (b) 불필요하면 관련 태그/등록 스크립트를 제거하는 방향 결정 필요.
- ~~**OCR 원문 괄호 안 출입정보 자동 분리 미지원**~~ → **해결 완료**: `splitDetailAndAccessInfo()`로 구현/배포됨(위 "TMS: OCR 괄호 출입정보 자동 분리" 항목 참고). 단, 괄호 없이 자유서술된 출입정보(예: "3층 경비실 호출")는 여전히 미지원 — 필요성 확인되면 별도 라운드.
- **학습주소 이름 키 레거시 데이터 미마이그레이션** — phone-priority 저장으로 전환(dual-write 포함)했지만, 이전에 이름 키로만 쌓인 과거 운영 데이터는 그대로 남아있음. 실제 고객 데이터라 이번 라운드에서 건드리지 않음 — 필요 시 별도로 마이그레이션 스크립트 논의.
- **`driver.html`의 `launchNav()` 개별 ETA 기록이 공용 ETA 기준(`ETA_AVG_SPEED_KMH`/`_calcStopMinutes`)과 미통일** — OMS/TMS ETA 통일 라운드(위 항목 참고)에서 카드 배지와 `fetchTrafficTime()`은 통일했지만, `launchNav()`가 개별 주문마다 Firebase에 기록하는 `eta` 값은 자체 고정상수(`SPEED_KMH=35, STOP_MIN=8`)를 여전히 사용 중 — 3번째 계산식이 하나 더 남은 상태. 필요성 확인되면 별도 라운드로 통일.
- **배송지도(mapzone) 경로선 기능 대체 설계 필요** — 배송순번/경로최적화 UX 개선 라운드(위 항목 참고) 배포 검증 중 `kakaoWaypoints` Cloud Function 호출이 403으로 실패하는 것을 발견(이번 커밋과 무관, 지도/마커/줌/전체보기는 정상). 카카오 다중경유지 API의 정책/제한 변경 가능성이 있어 **"인증 오류 수정"이 아니라 "경로선 기능 자체를 대체"** 하는 방향으로 접근할 것을 제안. 방향(안): 배송지도는 참고용 지도로 유지, 배송지 마커/순번 표시는 그대로 유지, 실제 도로 경로선은 제거하거나 직선 연결로 대체, ETA는 이미 있는 자체 계산값(`_calcEstimatedMinutes` 계열) 사용, 개별 배송지 길찾기는 기존 길찾기 버튼(카카오맵 딥링크, API 호출 아님)으로 계속 처리, 다중경유지 실시간 교통 API 의존을 완전히 제거. 이번 라운드에는 포함하지 않고 별도 라운드로 분리.
  - **추가 확인(2026-07-09)**: "TMS 라이브 사용성 피드백 1차" 배포 검증 중 경로최적화 화면의 "소요시간 다시 확인" 버튼도 동일한 `kakaoWaypoints` 403으로 항상 실패하고 있었음을 실측 확인. 해당 라운드에서 이 버튼을 우선 숨김 처리했으나(임시조치), 근본 해결은 이 항목의 대체 설계로 통합해서 진행할 것.
- **TMS 장기 UX 방향 — 배송목록 + 최적 배송 순서 통합 검토** — 배송순번 UX 개선 라운드에서 나온 기사 피드백: 기사들은 지도보다 배송목록을 보고 배송하는 경향이 큼. 장기적으로는 "배송목록"과 "경로최적화"를 별개 화면으로 오가지 않고 통합하는 방향을 검토할 필요. 후속 검토 항목: (1) 배송목록 카드 자체에서 위/아래 순서 조정, (2) 배송목록 화면 안에서 경로최적화 결과를 바로 반영(현재는 별도 화면 왕복 필요), (3) "순서 확정"/"이 순서로 배송" 같은 확정 UX 필요 여부(참고: 이번 라운드 read-only 분석에서 홈플러스=확정 후 불변, 이마트=변경 시 초기화 방식이라는 벤치마크를 확인했으나 이번 1차 MVP엔 포함하지 않음), (4) 경로최적화 화면(`#mapview`)을 배송목록 화면에 통합할지 여부, (5) 배송지도(`#mapzone`)는 계속 참고용으로만 유지.
- **`saveLearnedAddress()` 좌표 미설정 버그 수정 또는 기능 재설계** — "TMS 라이브 사용성 피드백 1차" 라운드(위 항목 참고)에서 발견. `saveLearnedAddress()`가 좌표를 `window._ocrLat`/`window._ocrLng`에서 읽는데, 이 두 변수는 도로명 변환 "적용" 경로(`applyConvertedAddr()`)에서만 설정되고 일반 OCR 스캔 흐름(`startOCR()`)에서는 설정되지 않음 — 버튼을 스캔 직후 바로 누르면 좌표 없이(`lat:null, lng:null`) 학습주소가 저장됨. 이번 라운드에서는 버튼을 UI에서 숨기는 것으로 우회했고 함수 자체는 미수정. 자동학습(`autoSaveLearnedAddressIfSafe()`)이 이미 대부분의 케이스를 커버하므로, 이 수동 버튼을 완전히 제거할지 좌표 버그를 고쳐 노랑/빨강 상태의 보조 수단으로 남길지 결정 필요.
- **영수증 원본 확대/줌/이동(핀치줌·더블탭줌·드래그)** — "TMS 라이브 사용성 피드백 1차" 라운드 read-only 분석에서 확인: `.photo-viewer img`가 `object-fit:contain`만 있고 확대/이동 기능이 전혀 없어, 작은 영수증 글씨(주소/전화번호)를 화면에서 읽기 어렵다는 기사 피드백. `viewPhotoUrl()`/`viewOcrPhoto()`가 공용으로 쓰는 모달이라 개선 시 OCR 결과 대조/이전 배송사진 보기 두 기능에 동시 적용됨. 2차 UX 라운드로 분리.
- **배송목록 카드 compact layout 전면 재설계** — "TMS 라이브 사용성 피드백 1차" 라운드에서 나온 "카드가 크고 왼쪽으로 치우쳐 한눈에 보기 어렵다"는 피드백. 이번 라운드는 패딩/정렬 소폭 조정(padding 16→14px, `.dl-top` flex-start)만 진행했고, 정보 밀도를 근본적으로 낮추는 재설계(배지를 아이콘 한 줄로 통합, 상세정보는 탭해야 펼치는 방식 등)는 별도 UX 설계가 필요해 2차 라운드로 분리.
- **수기 출입정보 직접입력 필드** 및 **아파트/빌라/건물명 detailAddress 자동 분리 개선** — "TMS 라이브 사용성 피드백 1차" read-only 분석 과정에서 함께 식별된 별도 개선 후보. 각각 별도 라운드에서 범위/우선순위 재검토 필요.

## 백로그 (P2, 장기)

- **테넌트 내부 역할 분리** — 기사 계정이 `settings`/`driverAccounts` 등 민감 경로를 직접 쓰지 못하게 제한 (SEC-001은 테넌트 *간* 격리만 다룸, 테넌트 *내부* 역할 분리는 범위 밖).
- **평문 비밀번호 레거시 폴백 제거** — `functions/index.js`의 `issueDriverToken`에 남아있는 `driver.password === password` 폴백.
- ~~**`receiveOrder`/`parseOrderWithGemini`(SMS·카톡 주문 접수) PII 로그 노출**~~ → **해결 완료**: 커밋 `9db0c18`에서 `maskForLog`로 마스킹 완료, 배포/라이브 검증 완료(위 "receiveOrder/parseOrderWithGemini PII 로그 마스킹 배포/검증" 항목 참고).
