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

## 2026-07-06 — TMS: 업데이트 안내 배너 최소 범위 개선 + 배너 감지 로직 미작동 버그 발견/수정 배포 검증

- **대상**: `saas/driver.html` — `APP_VERSION` 상수, `#update-banner` 마크업/스타일, `showApp()`의 버전 리스너
- **1차 커밋(`68b3732`)**: `APP_VERSION` `'3'`→`'4'`, `#update-banner`를 `position:fixed` 오버레이 → `position:sticky` 방식으로 전환(문서 흐름 내 배치로 헤더 겹침 방지), 문구를 "새 버전이 배포되었습니다. 새로고침해주세요."로 통일, 새로고침 버튼에 `white-space:nowrap` 추가. `DEPLOY_CHECKLIST.md`에 "4-1. driver.html(TMS) 버전 갱신(필수, 수동)" 절차 신설.
- **1차 로컬 검증**: `npx serve`로 로컬 정적 서버 구동 → `login-screen` 숨기고 배너를 강제로 `display:flex`로 만든 뒤 `getBoundingClientRect()`로 배너/헤더 바운딩 박스 비교 → `overlap: false` 확인(배너 70px, 헤더는 그 아래 70px부터 시작). 스크린샷으로도 겹침 없음 재확인.
- **1차 배포**: `firebase deploy --only hosting --project hatdelivery-saas` → 라이브 소스에 `APP_VERSION='4'`와 sticky 배너 스타일 반영 확인 → Firebase `settings/appVersion`을 `"4"`로 갱신.
- **2차 검증 중 발견한 버그**: "이미 열려있던 구버전 탭에서 배너가 뜨는지" 확인하기 위해, 배포 직전 커밋(`92576e2`) 시점의 `driver.html`을 로컬에 그대로 서빙하고 실제 프로덕션 Firebase(testmart/test1)로 로그인 → `settings/appVersion`이 이미 `"4"`(로컬 `APP_VERSION='3'`과 불일치)인데도 배너가 전혀 뜨지 않음을 확인.
  - 원인 조사: `showApp()`의 버전 리스너가 `firebase.database().ref('settings/appVersion')`(인자 없는 기본 앱 참조)를 호출하는데, TMS는 `_fbApp = firebase.initializeApp(config, 'driver')`로 **이름 있는 앱**을 사용하므로 기본(`[DEFAULT]`) 앱이 없어 이 호출이 매번 `FirebaseError: No Firebase App '[DEFAULT]' has been created`를 던짐 — `browser_evaluate`로 동일한 호출을 직접 실행해 재현.
  - 이 예외는 `doLogin()`의 try/catch로 전파되지만 그 시점엔 이미 로그인 화면이 숨겨진 뒤라 화면상 아무 문제 없이 정상 작동하는 것처럼 보였음(GPS 시작, 주문 동기화 등은 예외 발생 이전 코드라 정상 실행) — 버전 리스너만 한 번도 등록에 성공한 적이 없었던 것으로 결론.
  - 사용자 승인 하에 이번 라운드에 포함해 수정(`9c5cc12`): `firebase.database()` → `_fbDb`(이미 초기화된 이름 있는 앱의 database 인스턴스)로 교체. 1줄 변경.
- **2차 로컬 검증(수정 후, 실제 프로덕션 Firebase 대상)**:
  - `node --test "test/*.test.js"` 63/63 pass (수정 전/후 동일)
  - 수정된 코드 사본 + `APP_VERSION='3'`(Firebase 값 `"4"`와 불일치) → testmart/test1 로그인 → `update-banner`의 `style.display === 'flex'` 확인(정상 표시)
  - 수정된 코드(현재 저장소 상태, `APP_VERSION='4'`, Firebase 값 `"4"`와 일치) → 동일 계정 로그인 → `update-banner`의 `style.display === 'none'` 확인(정상 숨김)
  - 두 로컬 사본 모두 실제 프로덕션 Firebase 프로젝트(`hatdelivery-saas`)에 연결해 읽기 전용으로 검증 — 쓰기 작업 없음, 합성/실사용 데이터 변경 없음
- **2차 배포**: `firebase deploy --only hosting --project hatdelivery-saas` → 라이브 소스에 `_fbDb.ref('settings/appVersion')` 반영 확인. `settings/appVersion`은 이미 `"4"`였으므로 추가 갱신 없음.
- **Result**: 업데이트 배너의 표시/문구/레이아웃뿐 아니라, 그동안 한 번도 작동하지 않았던 "감지" 로직 자체를 이번 라운드에서 실제로 살려냄. 프로덕션에서 버전 불일치 시 배너가 뜨고, 새로고침(또는 버전 일치 상태로 재접속) 시 배너가 사라지는 전체 흐름을 실제 Firebase 백엔드 대상으로 확인.
- **범위 밖으로 남긴 것(백로그 기록만)**: PWA `manifest.json`/`sw.js` 경로 불일치(둘 다 404, `manifest.json`은 파일 자체가 없음), 버전 갱신 자동화 스크립트 — `_bmad/backlog.md` 참고.
- **Sensitive data policy**: 실제 고객 데이터 미사용. 검증 전 과정에서 Firebase에 대한 쓰기 작업 없음(읽기 전용 조회 및 실시간 리스너 연결만 수행).

## 2026-07-07 — TMS: 공동현관 비밀번호/출입정보(accessInfo) 1차 구현 + phone-priority 학습주소 키 수정 배포 검증

- **대상**: `saas/driver.html`(출입정보 입력/표시/저장), `functions/lib/receipt-utils.js`(`isSimilarAddress`, `buildLearnedLocationResponse`), `functions/index.js`(`processReceipt` 학습주소 응답)
- **커밋**: `6485a85`(accessInfo 기능), `fb7c26f`(APP_VERSION 5 범프)
- **단위 테스트**: `node --test "test/*.test.js"` → **77/77 pass**
  - `isSimilarAddress` 5케이스(완전일치/공백-대소문자 무시 일치/포함관계/불일치/빈값)
  - `buildLearnedLocationResponse` 6케이스(정상 게이트 통과/주소 불일치 시 access_info만 빈값·road_address는 유지/학습 레코드 없음/road_address 없음/access_info 필드 자체 없음/lat·lng 없음)
  - phone-priority 키 연동 3케이스(전화번호 있으면 phone 키로 조회한 레코드의 access_info가 응답에 포함/전화번호 없으면 name fallback/phone 키 레코드라도 주소 불일치 시 access_info는 빈값)
- **배포**:
  - `firebase deploy --only functions --project hatdelivery-saas` → 6개 함수 전부 성공
  - `firebase deploy --only hosting --project hatdelivery-saas` → 성공, 라이브 소스에 `APP_VERSION='5'`, `res-access-info`, `dl-access-info`, `resolveLearnKey` 반영 확인
  - 배포 후 `settings/appVersion`을 `"5"`로 갱신
- **배포 후 라이브 검증** (testmart 테넌트, 합성 데이터만 사용, 검증 직후 전부 삭제):
  1. testmart/test1 계정으로 실제 프로덕션 TMS 로그인
  2. 실제 `confirmAdd()` 호출로 4가지 조합(상세주소만/출입정보만/둘다/둘다없음, 이름 "배포검증A~D") 저장
  3. 전체 페이지 새로고침(세션은 실제 Firebase Auth로 자동 복원) 후 4장 카드 모두 배지 유지 확인
  4. `.dl-detail-addr`/`.dl-access-info`와 `.row-btns`의 `getBoundingClientRect()` 비교 → 375px 모바일 폭에서 4건 전부 겹침 없음
  5. `saveLearnedAddress()` 호출 → `settings/learnedLocations/{phone}`과 `settings/learnedLocations/{name}` 양쪽에 동일 데이터(access_info/name/phone 포함) 저장 확인
  6. **`processReceipt` 실제 배포 엔드포인트 E2E 검증** — 브라우저 canvas로 "성명/연락처/주소/합계금액" 4줄 텍스트를 그린 합성 영수증 이미지를 생성해 실제 Vision OCR → Gemini 파싱 → Kakao/학습주소 조회 파이프라인을 그대로 통과시킴(사전에 `settings/learnedLocations/{phone}`에 합성 학습 레코드 시드):
     - 영수증 주소를 학습 레코드의 `road_address`와 동일하게 작성 → 응답 `location.access_info`에 학습된 값 포함, 서버 로그 `학습주소 적용: {phone} {road_address} / access_info 적용: true` 확인
     - 동일 전화번호·다른 주소로 작성 → 응답 `location.access_info`는 빈 문자열, `road_address`/`detail_address`는 학습값 그대로 유지, 서버 로그 `access_info 적용: false` 확인
  7. `gcloud logging read`로 배포 이후(`timestamp>="2026-07-07T02:30:00Z"`) `processReceipt` 및 전체 함수의 `severity>=ERROR` 로그 0건 확인
  8. 브라우저 콘솔: 기존에 알려진 `manifest.json`/`sw.js` 404(별도 백로그 항목, 무관) 외 신규 에러 없음
  9. 테스트 주문 4건(배포검증A~D) + 학습주소 레코드 3건(`010-9500-0001`, `010-9700-0001`, `배포학습검증`) 전부 삭제, 재조회로 잔존 없음 확인
- **Result**: accessInfo 기능이 저장 → 실시간 동기화 → 새로고침 → 학습주소 자동 적용(오적용 방지 게이트 포함)까지 전 구간에서 프로덕션 배포본으로 정상 동작함을 확인. 특히 `processReceipt`의 access_info 게이팅은 실제 이미지 기반 E2E 호출로 검증해, 단위테스트만으로는 확인할 수 없었던 Vision/Gemini 파싱 단계까지 포함한 전체 파이프라인이 의도대로 동작함을 확인.
- **Sensitive data policy**: 전 과정 합성 데이터만 사용. `firebase functions:log` 확인 중 이번 검증과 무관한 실제 고객 영수증 로그 일부가 우연히 노출됐으나(다른 시각대 실사용 트래픽), 본 로그와 대화 응답 어디에도 옮겨 적지 않고 배포 이후 시간대(`2026-07-07T02:30:00Z` 이후)로 한정해 조회.

## 2026-07-07 — TMS: OCR 괄호 출입정보 자동 분리(splitDetailAndAccessInfo) 설계/구현/배포 검증

- **대상**: `functions/lib/receipt-utils.js`(`splitDetailAndAccessInfo` 신규, `buildLearnedLocationResponse` 병합 로직 반영), `functions/index.js`(학습주소 미적용 경로에도 분리 적용). `saas/driver.html`은 변경 없음.
- **배경**: OCR 원문/Gemini 파싱 결과의 상세주소에 "1903동 104호 (현관 비번 1234)"처럼 괄호로 출입정보가 섞이는 경우, 기존에는 이 전체가 `detailAddress`로 합쳐졌음. `detailAddress`와 `accessInfo`를 자동으로 분리하기 위한 순수함수 신규 도입.
- **설계 결정**: `parseAddressComponents`/`standardizeAddress` 내부는 건드리지 않음 — 코드 흐름을 추적한 결과 어느 분기를 타든 괄호는 항상 최종 `detail_address` 문자열 맨 끝에 남는 구조라, `processReceipt` 응답 생성 직전에 한 번만 분리해도 전 분기를 안전하게 커버함. `driver.html`은 이미 "화면 입력값 우선, OCR 값은 fallback" 구조라 변경 불필요.
- **키워드 목록**: `공동현관/비밀번호/비번/호출/경비실/문 앞/출입/열쇠/#/*` — 1차 구현 때 포함했던 `종`은 커밋 전 사용자 승인 하에 제거(`"종로"` 등 지명과 겹칠 오탐 리스크, `"104열쇠 2634종"` 케이스도 `열쇠` 키워드만으로 충분히 커버되어 불필요 판단).
- **병합 규칙**: 학습주소(`learned.access_info`)가 이미 있으면 분리 결과로 덮어쓰지 않음(기존 값 우선). 주소 불일치 게이트(`isSimilarAddress`)에 걸리면 분리된 accessInfo도 함께 차단(기존 오적용 방지 원칙 유지). `detail_address`는 게이트와 무관하게 항상 분리.
- **테스트**: `node --test` **90/90 pass** (신규 13개 — `splitDetailAndAccessInfo` 9케이스 사용자 지정 예시 전부 + `buildLearnedLocationResponse` 연동 3케이스 + `종` 제거 회귀 확인 1케이스)
- **커밋**: `39f77b8`(구현+테스트, `종` 키워드 제거 반영)
- **배포**: `firebase deploy --only functions --project hatdelivery-saas`만 실행. Hosting/`database.rules.json`은 변경 대상이 없어 건드리지 않음.
- **배포 전 확인**: git status clean, `node --test` 90/90 재확인.
- **배포 후 라이브 검증** (testmart 테넌트, 합성 데이터만 사용, 검증 직후 전부 삭제):
  - testmart/test1 계정으로 실제 프로덕션 TMS 로그인, `_authHeader()`로 실제 Firebase ID 토큰 확보
  - 학습주소 경로(`buildLearnedLocationResponse`)를 이용해 `detail_address` 값을 정밀 통제 — `settings/learnedLocations/{phone}` 4건을 아래 값으로 시드 후, 동일 전화번호·동일 road_address의 합성 영수증 이미지(canvas로 "성명/연락처/주소/합계금액" 렌더링)를 실제 `processReceipt` 엔드포인트로 호출:
    - `"1903동 104호 (현관 비번 1234)"` → 응답 `detail_address: "1903동 104호"`, `access_info: "현관 비번 1234"` (요청된 그대로 일치)
    - `"101동 202호 (공동현관 #1234)"` → `access_info: "공동현관 #1234"` 포함
    - `"상가 2층 (왼쪽 문)"` → `access_info: ""`, `detail_address`는 원문("상가 2층 (왼쪽 문)") 그대로 유지
    - `"101동 202호"` → `access_info: ""`
  - 서버 로그(`학습주소 적용: {phone} {road_address} / access_info 적용: true/false`)로 4건 모두 클라이언트 관측 결과와 정확히 일치함을 교차 확인
  - `gcloud logging read`로 배포 이후(`timestamp>="2026-07-07T05:00:00Z"`) 전체 함수 `severity>=ERROR` 로그 0건 확인
  - 학습주소 레코드 4건(`010-9800-0001~0004`) 전부 삭제, 재조회로 잔존 없음 확인. `processReceipt` 호출만 사용해 배송 주문은 생성되지 않았음(추가 삭제 불필요) — 단, 이전 라운드에서 Firebase는 이미 삭제됐지만 이 Playwright 브라우저 프로필의 `localStorage`에 "오늘 날짜" 필터로 남아있던 이전 회차 테스트 주문 4건(`배포검증A~D`)이 화면에 재노출되는 것을 발견 → Firebase 데이터가 아닌 순수 로컬 캐시임을 직접 확인 후 `localStorage` 초기화로 정리(실제 운영/다른 기기에는 영향 없음)
- **Result**: OCR 괄호 출입정보 자동 분리 기능이 실제 배포된 `processReceipt`에서 요청된 4가지 케이스 전부(분리/포함/애매 미분리/괄호없음) 정확히 의도대로 동작함을 확인. 병합 규칙(기존 학습값 우선, 오적용 게이트 유지)도 코드 경로상 함께 적용됨.
- **Sensitive data policy**: 전 과정 합성 데이터만 사용(가짜 이름/전화번호/주소/출입정보). 실제 고객 데이터 미노출.

## 2026-07-07 — TMS: 학습주소 주소-유사도 게이트(road_address/detail_address/access_info) + Cloud Functions PII 로그 마스킹 배포 검증

- **대상**: `functions/lib/receipt-utils.js`(`buildLearnedLocationResponse`, `maskForLog`), `functions/index.js`(`parseWithGemini`, `standardizeAddress`, 학습주소 적용 로그)
- **배경**: 기존 `buildLearnedLocationResponse`는 `access_info`만 주소 유사도(`isSimilarAddress`)로 게이트하고 `road_address`/`detail_address`는 무조건 학습값을 반환해, 같은 전화번호/이름의 고객이 다른 주소로 주문하면 이번 영수증의 실제 주소가 무시되고 예전 학습 주소로 치환될 위험이 있었음(read-only 분석 라운드에서 발견). 또한 Cloud Functions 로그에 Vision 원문/Gemini 파싱 결과/학습주소 키(전화번호 포함 가능)/Kakao 검색 과정의 주소·건물명이 평문으로 남아있었음.
- **Fix**: `buildLearnedLocationResponse`가 주소 불일치 시 `null`을 반환하도록 변경(→ `processReceipt`가 자동으로 `standardizeAddress()` 폴백 진행). `maskForLog(value)` 헬퍼(`(없음)` 또는 `[len:N]`)를 도입해 `parseWithGemini`/학습주소 적용 로그/`standardizeAddress`/`kakaoAddrSearch`/`kakaoKeywordSearch`의 PII성 로그를 전부 마스킹.
- **커밋**: `50fec90`(코드+테스트), `44ba8b2`(receiveOrder PII 백로그 등록, docs만)
- **테스트**: `node --test` **97/97 pass** (기존 90 + 신규/보강 7 — 같은 전화번호+같은 주소 전체 적용, 같은 전화번호+다른 주소 null, 같은 이름(전화번호 없음)+다른 주소 null, 완전히 다른 주소 null, PII 로그 노출 방지 정적 검사 4건)
- **배포**: `firebase deploy --only functions --project hatdelivery-saas`만 실행. Hosting/`database.rules.json` 미변경.
- **배포 전 확인**: git status clean, `node --test` 97/97 재확인.
- **배포 후 라이브 검증** (testmart 테넌트, 합성 데이터만 사용, 검증 직후 전부 삭제):
  1. testmart/test1 계정으로 실제 프로덕션 TMS 로그인, `_authHeader()`로 실제 Firebase ID 토큰 확보
  2. `settings/learnedLocations`에 합성 레코드 2건 시드 — `010-9900-0001`(전화번호 키, road_address/detail_address/access_info 전부 포함), `분리검증B`(이름 키, 전화번호 없음)
  3. 실제 `processReceipt` 엔드포인트를 합성 영수증 이미지(canvas로 "성명/연락처/주소/합계금액" 렌더링)로 직접 호출해 3가지 케이스 확인:
     - **같은 전화번호 + 같은 주소** → 응답의 `road_address`/`detail_address`/`access_info` 전부 학습값 그대로 적용됨
     - **같은 전화번호 + 다른 주소** → 응답의 `road_address`가 이번 영수증의 새 주소 그대로(학습된 옛 주소로 치환되지 않음), `detail_address`/`access_info`는 빈 값(완전 미적용)
     - **같은 이름(전화번호 없음) + 다른 주소** → 응답의 `road_address`가 이번 영수증의 새 주소 그대로, `detail_address`/`access_info` 빈 값(이름 fallback 오적용 없음)
  4. `gcloud logging read`로 배포 이후(`timestamp>="2026-07-07T07:00:00Z"`) 전체 함수 `severity>=ERROR` 로그 **0건** 확인
  5. 서버 로그 직접 조회로 마스킹 확인: `[DEBUG] Vision rawText length: N`(원문 없음), `[DEBUG] Gemini parsed (마스킹): {name:"[len:N]", phone:"[len:N]"/"(없음)", address:"[len:N]", totalAmount:"실제값"}`(name/phone/address 원문 전혀 없음, totalAmount만 유지), `학습주소 적용됨.../access_info 포함: true` 및 `학습주소 존재하지만 주소 불일치로 미적용 → 이번 영수증 기준 표준화 진행`(학습키/주소 원문 없이 상태만 기록) — JSON 페이로드를 직접 파싱해 실제 성명/전화번호/주소 문자열이 로그 어디에도 없음을 확인
  6. 학습주소 레코드 2건 전부 삭제, 재조회로 잔존 없음 확인. `processReceipt`만 호출했으므로(confirmAdd 미호출) 배송 주문 데이터는 애초에 생성되지 않음.
  7. 이 Playwright 브라우저 프로필의 로그아웃 확인 다이얼로그가 자동 처리되지 않아 `localStorage`/`sessionStorage`를 직접 초기화해 세션 정리(실제 Firebase 데이터와 무관, 로컬 브라우저 상태만 정리)
- **Result**: 학습주소 오적용 방지 게이트가 실제 배포 엔드포인트에서 road_address/detail_address/access_info 전부에 대해 정확히 동작하고, Cloud Functions 로그에서 고객 PII가 더 이상 평문으로 남지 않음을 확인.
- **Sensitive data policy**: 전 과정 합성 데이터만 사용(가짜 이름/전화번호/주소/출입정보). 실제 고객 데이터 미노출, 검증 데이터 전부 삭제 확인.

## 2026-07-07 — receiveOrder/parseOrderWithGemini PII 로그 마스킹 배포 검증

- **대상**: `functions/index.js`의 `exports.receiveOrder`, `parseOrderWithGemini`(SMS·카톡 자동 주문 접수 흐름)
- **배경**: 이전 라운드(학습주소 게이트 + processReceipt PII 마스킹)에서 `receiveOrder`에도 동일한 원문 로깅 문제가 있음을 발견해 백로그로만 등록해뒀음(원본 메시지, Gemini 원본 응답, 고객명, 전화번호, 주소, 파싱 결과 전체가 `logger.info`/`warn`에 그대로 남던 문제).
- **Fix**: 원본 메시지/Gemini 응답 등 긴 텍스트 블롭은 `.length`만 기록, 고객명/전화번호/주소는 기존 `maskForLog()` 재사용. **응답 바디**(`res.json({success,orderId,parsed})`)와 **Firebase 저장 필드**(`rawMessage`, `customerName` 등)는 MacroDroid 등 호출측 기능 유지를 위해 변경하지 않음 — 로그 호출부만 수정.
- **커밋**: `9db0c18`
- **테스트**: `node --test` **101/101 pass** (기존 97 + 신규 정적 검사 4건 — 원본 메시지/Gemini 응답 미노출, 최종이름/고객DB보완/품목/접수완료 로그 미노출, STEP Kakao 로그 미노출, 응답 바디 불변 확인)
- **배포**: `firebase deploy --only functions --project hatdelivery-saas`만 실행. Hosting/`database.rules.json` 미변경.
- **배포 전 확인**: git status clean, `node --test` 101/101 재확인.
- **배포 후 라이브 검증** (합성 데이터만 사용, 검증 직후 전부 삭제):
  1. 로컬 `.env`의 `ORDER_AUTH_TOKEN` 값을 셸 변수로만 로드(대화 응답/로그에 미노출)해 실제 배포된 `receiveOrder` 엔드포인트를 합성 SMS 메시지로 호출
  2. **정상 주문 1건**: `{message:"합성테스트고객 010-9990-0001 서울 은평구 가상로 999 감자2개 계란1판 배달해주세요", channel:"sms", sender:"010-9990-0001"}` → 응답 `{success:true, orderId, parsed:{type:"order", name, address, phone, items, memo}}` — 기존과 동일한 스키마로 정상 파싱됨을 확인(첫 시도는 bash 명령줄 UTF-8 인코딩 문제로 한글이 깨져 재전송 — 파일 기반 페이로드로 재시도해 해결, 서버 로직 문제 아님)
  3. **스팸성 메시지 1건**: 인증번호 안내 문자 형태로 호출 → 응답 `{success:false, skipped:true, reason:"not_an_order"}` — 기존과 동일하게 저장 없이 스킵됨을 확인
  4. `gcloud logging read`로 배포 이후 전체 함수 `severity>=ERROR` 로그 **0건** 확인
  5. 로그 원문(JSON/텍스트 페이로드)을 직접 조회해 마스킹 확인: `Gemini 원본 응답 길이: N`, `원본 메시지 길이: N`, `최종 이름(마스킹): [len:N]`/`(없음)`, `STEP Kakao: 주소 검색 쿼리(마스킹): [len:N]`, `주문 접수 완료: {orderId} / 파싱 결과(마스킹): {name:"[len:N]", phone:"[len:N]", address:"[len:N]", itemsCount:N}` 등 — 실제 성명/전화번호/주소/원본 메시지 문자열이 로그 어디에도 없음을 확인
  6. 테스트 중 생성된 주문 2건(`orders/ext_1783409735462`, `orders/ext_1783409763495` — receiveOrder는 테넌트 스코프 없이 루트 `orders/`에 저장하는 기존 구조, 이번 라운드에서 변경하지 않음) 전부 삭제, 재조회로 잔존 없음 확인
- **Result**: receiveOrder의 PII 로그 노출 문제가 실제 배포본에서 해결됨을 확인. processReceipt에 이어 이 세션에서 다뤘던 두 주문 접수 경로(영수증 OCR, SMS·카톡 자동접수) 모두 Cloud Functions 로그의 PII 마스킹이 완료됨.
- **Sensitive data policy**: 합성 데이터만 사용(가짜 이름/전화번호/주소/품목/메모). `ORDER_AUTH_TOKEN`은 셸 변수로만 다뤄 노출 없음. 검증용 주문 2건 전부 삭제 확인.

## 2026-07-07 — TMS: OCR 실패 UX 개선(401/403/500/세션만료 안내) 배포 검증

- **대상**: `saas/driver.html`의 `_authHeader()`, `friendlyErrorMessage()`(신규), `startOCR()`, `regeocodeAddr()`
- **배경**: read-only 분석 라운드에서 발견한 문제 — `startOCR()`가 `!response.ok`면 서버가 준 구체적 `message`를 읽지 않고 바로 "서버 오류: {코드}"만 던져 401/403/500이 전부 동일하게 보였음. 세션 만료(`_fbAuth.currentUser`가 null) 시에는 `_authHeader()`에서 cryptic한 TypeError가 그대로 alert에 노출됐음. `regeocodeAddr()`도 실패 시 항상 "변환 실패 (서버 오류)"로만 뭉뚱그려짐.
- **Fix**: `_authHeader()`가 `currentUser` null이면 "로그인이 만료되었습니다. 다시 로그인해주세요."를 명시적으로 던짐. `friendlyErrorMessage(status, serverMessage, context)` 신규 헬퍼로 401/403/500(Vision/Gemini/일반)을 상태별 안내 문구로 변환, `startOCR()`/`regeocodeAddr()` 양쪽에서 재사용. OCR/학습주소/DB 저장 로직과 Cloud Functions는 전혀 변경하지 않음(클라이언트 UX만 수정).
- **커밋**: `941d9f0`(UX 개선), `7f5a691`(APP_VERSION 6 범프)
- **테스트**: `node --test` **101/101 pass**(functions 변경 없어 그대로 유지)
- **배포**: `firebase deploy --only hosting --project hatdelivery-saas`만 실행. `DEPLOY_CHECKLIST.md` "4-1" 절차대로 배포 전 `APP_VERSION` 5→6 범프(커밋에 포함), 배포 후 Firebase `settings/appVersion`도 "6"으로 갱신.
- **배포 전 확인**: git status clean, `node --test` 101/101 재확인.
- **배포 후 라이브 검증** (testmart 테넌트, 합성 데이터만 사용):
  1. 라이브 `driver.html` 소스에 `APP_VERSION='6'`, `friendlyErrorMessage`, "로그인이 만료되었습니다" 문구 반영 확인
  2. testmart/test1 계정으로 실제 프로덕션 로그인 성공
  3. **정상 OCR 흐름**: 실제 `startOCR()` 함수를 합성 영수증 이미지(성명/연락처/주소/합계금액)로 호출 → 결과 화면에 전부 정상 반영, 화면 전환 정상 — 회귀 없음 확인
  4. **401**: Authorization 헤더 없이 실제 `processReceipt` 호출 → `friendlyErrorMessage` → "로그인이 만료되었거나 인증에 실패했습니다. 다시 로그인해주세요."
  5. **403**: 정상 인증 + 다른 tenantId로 실제 호출 → "이 마트에 대한 권한이 없습니다. 마트 정보를 확인해주세요."
  6. **500**: 텍스트 없는 빈 이미지로 실제 Vision 실패 유발(`Vision: 텍스트 인식 실패` 서버 응답) → "영수증 사진을 인식하지 못했습니다. 더 밝고 선명하게 다시 촬영해주세요."
  7. **세션 만료**: 실제 `_fbAuth.signOut()` 후 `_authHeader()`/`regeocodeAddr()` 호출 → "로그인이 만료되었습니다. 다시 로그인해주세요." (토스트/예외 메시지 모두 확인)
  8. **업데이트 배너/appVersion 동기화**: 배포 전부터 열려있던 탭(구버전 코드, in-memory `APP_VERSION='5'`)에서 로그인 시 배너가 실시간으로 뜨는 것을 확인, 새로 로드한 탭(`APP_VERSION='6'`, Firebase 값과 일치)에서는 배너가 뜨지 않음을 확인
  9. 테스트 중 Firebase에 생성된 데이터 없음 확인(재조회로 잔존 없음) — `confirmAdd()`를 거치지 않아 애초에 저장이 발생하지 않음
- **Result**: OCR 실패 시 사용자 안내가 401/403/500/세션만료 전부 구분되어 표시되고, 정상 흐름과 학습주소/DB 저장 로직은 그대로 유지됨을 실제 배포본에서 확인.

## 2026-07-08 — OMS/TMS ETA 통일 배포 검증

- **대상**: `saas/app.html`(`_calcStopMinutes`, `_calcEstimatedMinutes`, `sendToDelivery`), `saas/driver.html`(동일 상수 복제 + 신규 `_calcEtaMinutesTo`/`_buildEtaDisplayMap`/`_renderEtaBadge`, `fetchTrafficTime`)
- **커밋**: `08e77d3`(ETA 통일 + TMS 배지 + app.html 버그수정), `c9df2af`(APP_VERSION 7 범프)
- **배포 전 확인**: `git status` clean(두 파일만 스테이징, functions/index.js·database.rules.json·firebase.json 미포함), `node --test "test/*.test.js"` **101/101 pass**.
- **배포**: `firebase deploy --only hosting --project hatdelivery-saas`만 실행(Functions/DB rules 배포 안 함). 배포 직후 `settings/appVersion`을 gcloud 액세스 토큰으로 `"7"`로 갱신.
- **배포 후 라이브 검증 — TMS(실 브라우저, testmart/test1 계정)**:
  1. 라이브 `driver.html` 소스에 `APP_VERSION='7'`, `_renderEtaBadge`, `ETA_DISTANCE_FACTOR`, `_calcStopMinutes` 전부 포함 확인(정적 확인)
  2. 강제 새로고침 후 실제 로그인 성공, 콘솔 에러 0건(무관한 favicon 404 제외)
  3. 로컬스토리지 전용 합성 배송 3건 주입(Firebase 미기록): 좌표+30,000원(키워드 없음) / 좌표+120,000원("아파트 101동 202호") / 좌표 없음 — 배지가 각각 "⏱ 약 24분 후" / "⏱ 약 36분 후"(정차 6+5=11분 반영) / "좌표 없음"으로 정상 렌더링됨을 스냅샷으로 확인
  4. GPS 끄고(`_lastGpsPos=null`) 마트 위치만 있는 상태로 재렌더링 → "위치 공유 필요"로 뭉개지지 않고 마트 위치 기준 대체 계산된 배지("⏱ 약 11분 후"/"⏱ 약 24분 후")로 정상 표시됨을 확인(폴백 체인 동작 확인)
  5. GPS와 마트 위치 둘 다 없는 극단 상태(`getMartLocation` 임시 오버라이드) → 정확히 "위치 공유 필요"로 표시됨을 확인, 이후 원상복구
  6. `routeOrder`에 경로최적화 결과(2번 배송지 → 1번 배송지 순서)를 주입해 재렌더링 → 누적 모드 배지가 순서를 반영해 "대략 오전 09:34 도착 예상"(2번, 먼저 방문) / "대략 오전 09:40 도착 예상"(1번, 나중 방문)으로 시간 역전 없이 정상 계산됨을 확인
  7. 모바일 폭(375×812)에서 스크린샷 확인 — 배지가 카드 우측 상단(이름 옆)에 위치해 상세주소/출입정보/전화/금액/버튼 어느 것과도 겹치지 않음을 확인(3개 카드 전부)
  8. 완료체크: `openCompleteScreen()` 실제 호출 → 수령방법/사진첨부/결제여부/메모 입력 화면이 에러 없이 정상 진입됨을 확인(사진 필수라 실제 완료 처리는 진행하지 않음 — 화면 진입 자체가 회귀 없음의 증거)
  9. 취소: 편집모달의 "이 배송 취소/삭제" 버튼 클릭 → 네이티브 확인 다이얼로그가 뜨고(Playwright 기본 동작으로 자동 취소) JS 에러 없이 안전하게 처리됨을 확인
  10. 업데이트 배너: `settings/appVersion`을 일시적으로 `"8"`로 바꿔 현재 탭(in-memory `APP_VERSION='7'`)과 불일치를 유발 → 배너 실시간 노출 확인 → 다시 `"7"`로 원복 → 배너는 즉시 사라지지 않음(1회성 트리거, 기존 설계와 일치) → 새로고침 후에는 배너가 사라지고 `APP_VERSION='7'` 유지됨을 확인
  11. 검증에 사용한 합성 배송 3건 전부 로컬스토리지에서 제거, 재렌더링으로 잔존 없음 확인(애초에 Firebase에는 기록되지 않음)
- **배포 후 검증 — OMS(샌드박스 소스 검증으로 대체, 사용자 승인)**: 이 세션에 `app.html` Firebase 로그인 정보가 없어 실 브라우저 검증 불가 → 실제 커밋/배포된 `saas/app.html` 소스를 Node에서 문자열 추출해(`new Function` 샌드박스) 직접 실행:
  - 금액 5구간 경계값 전부(0/49999/50000/50001/99999/100000/100001/149999/150000/150001/199999/200000/200001/500000) → 기대값(2/2/2/4/4/4/6/6/6/8/8/8/10/10)과 정확히 일치
  - 건물키워드 7개 중 아파트/빌라/오피스텔/하이츠 개별 테스트 → 전부 2+5=7분으로 정상 매칭, 순수 "101동 202호"(동/호 단독) → 매칭 안 됨(기존 base 2분 그대로) — 사용자가 요청한 "동/호 단독 키워드 1차 MVP 제외"가 정확히 반영됨을 확인
  - `sendToDelivery()`의 수정된 ETA 블록(이전엔 미정의 변수로 항상 ReferenceError였던 지점)을 동일한 방식으로 추출해 실행 → ReferenceError 없이 유효한 미래 타임스탬프 반환 확인
  - 이 방식은 실제 OMS 화면(주문조회/자동배정/Swap/배송전달)의 시각적 회귀는 확인하지 못하는 한계가 있음 — 사용자에게 명시적으로 안내하고 승인받음.
- **Result**: TMS는 카드 ETA 배지 4개 상태(좌표있음/건물키워드/좌표없음/GPS꺼짐-대체계산/경로최적화 누적) 전부와 기존 완료체크/취소/업데이트배너 플로우가 실제 배포본에서 회귀 없이 정상 동작함을 확인. OMS는 샌드박스 소스 검증으로 계산 로직(5구간 경계값, 7개 건물키워드, ReferenceError 버그 수정)의 정확성만 확인했고, 실제 화면 회귀는 사용자 수동 확인이 필요함(백로그에 미해결 항목으로 남기지 않고, 이 라운드의 명시적 검증 범위 한계로 기록).
- **Sensitive data policy**: 전 과정 합성 데이터만 사용(가짜 이름/전화번호/주소). TMS 테스트 배송 3건은 Firebase에 기록되지 않고 로컬스토리지에만 존재했으며 검증 종료 후 전부 제거.
- **Sensitive data policy**: 전 과정 합성 데이터만 사용(가짜 이름/전화번호/주소). 실제 고객 데이터 미노출.

## 2026-07-08 — 기사앱 비밀번호 찾기 기능 복구(P1-001) 배포 검증

- **대상**: `functions/index.js`(`resetDriverPassword` 신규, `issueDriverToken` 필드 확장), `saas/driver.html`(`doFindPw()`, `enterAppOrForceChange()`, `doForceChangePw()`, `#findpw-modal` z-index, bcryptjs CDN 경로)
- **커밋**: `1c8c84f`(핵심), `bc098ea`/`639acd2`/`aea2cbb`(APP_VERSION 8→9→10 + 검증 중 발견한 z-index/CDN 버그 수정)
- **배포 전 확인**: `git status` clean(4개 파일: `functions/index.js`, `saas/driver.html`, `functions/test/driver-pw-reset.test.js`(신규), `functions/test/smoke.test.js`), `node --test "test/*.test.js"` **109/109 pass**(기존 101 + 신규 8), `database.rules.json`/`firebase.json` diff 0줄 확인.
- **배포**: `firebase deploy --only functions,hosting --project hatdelivery-saas`(핵심 기능, `resetDriverPassword` 신규 생성 + 6개 함수 업데이트) → `settings/appVersion` "8"로 갱신 → 라이브 검증 중 아래 두 건의 사전 버그를 발견해 각각 `--only hosting`으로 추가 배포(버전 9, 10) 및 `settings/appVersion` 동기화.
- **`resetDriverPassword` 로직 검증(REST 직접 호출, 합성 계정 `tenants/testmart/driverAccounts/pwtest1`·`pwtest_inactive` 사용)**:
  1. 존재하지 않는 driverId → HTTP 401, "입력하신 정보와 일치하는 계정을 찾을 수 없습니다"
  2. 비활성 계정(`active:false`) → HTTP 401, **1번과 완전히 동일한 메시지**(계정 존재 유추 방지 확인)
  3. 전화번호 불일치 → HTTP 401, 동일한 메시지 + `pwResetAttempts` 증가 확인
  4. 동일 계정에 연속 5회 실패 후 6번째 요청 → HTTP 429, "요청이 너무 많습니다..." (레이트리밋 실제 동작 확인)
  5. 감사 로그(`system_logs/driverPwReset`) 최근 10건을 직접 조회 → 필드가 정확히 `driverId, reason, success, tenantId, timestamp`뿐이고 전화번호 문자열이 로그 어디에도 없음을 확인
- **실 UI 플로우 검증(Playwright, testmart 실브라우저)**:
  1. 최초 시도에서 "확인" 버튼 클릭이 `TimeoutError`로 실패 → `elementFromPoint`로 직접 확인한 결과 `#findpw-modal`(z-index 3000)이 `#login-screen`(z-index 9999)보다 낮아 클릭이 로그인 화면으로 새어나가는 것을 발견 → 사용자 승인 받아 `z-index:10000`으로 수정(app.html에는 없던, driver.html에만 있던 사전 버그, 이번 커밋에 포함되지 않은 기존 코드)
  2. 수정 배포 후 재시도 → 모달 "확인" 버튼 실제 클릭 성공, "임시 비밀번호가 발급되었습니다" 표시 + 로그인 필드 자동 입력 확인
  3. 발급된 임시 비밀번호로 로그인 → `issueDriverToken` 200 응답 확인 후 "🔒 새 비밀번호 설정" 강제 화면 진입 시도 → 새 비밀번호 제출 시 "오류: dcodeIO is not defined" 발생 → `curl -I`로 CDN URL을 직접 확인해 `bcrypt.js`(존재하지 않는 패키지명, 404) → `bcryptjs`(정확한 이름, 200)임을 확인, Chrome 콘솔의 `net::ERR_BLOCKED_BY_ORB`가 이 404 응답이 ORB에 의해 스크립트로 실행되지 못하고 차단된 것임을 network 로그로 확인 → 사용자 승인 받아 `app.html`과 동일한 경로 + jsdelivr `onerror` 폴백으로 수정
  4. 재배포 후 재시도 → `typeof dcodeIO !== 'undefined'` true 확인, 강제 변경 화면에서 새 비밀번호 저장 성공 → 메인 배송목록 화면 정상 진입
  5. 세션 복원 경로(`checkSession()`, 새로고침 시 재로그인 없이 세션 유지) 확인 → 저장된 세션에서도 `mustChangePassword:true`면 동일하게 강제 화면이 뜨는 것을 확인(로그인 직후 경로와 별개로 검증됨)
  6. RTDB 직접 조회로 `mustChangePassword:false` 해제 및 `password` 필드가 `$2`로 시작하는 bcrypt 해시 형식임을 확인(평문 아님)
  7. 로그아웃 → 새 비밀번호로 재로그인 → 강제 화면이 다시 뜨지 않고 바로 메인 화면 진입 확인
  8. 기존 일반 계정(`test1`/`[REDACTED]`, `mustChangePassword` 없음)으로 재로그인 → 강제 화면 없이 정상 진입, 배송목록 정상 표시(회귀 없음 확인)
  9. 업데이트 배너: `settings/appVersion`을 일시적으로 "11"로 바꿔 불일치 유발 → 배너 노출 확인 → "10"으로 원복 후 새로고침 → `APP_VERSION` 유지되며 배너 사라짐 확인
- **Result**: `resetDriverPassword`가 계정 존재 유추를 방지하는 통일된 실패 메시지, 레이트리밋, PII 없는 감사 로그 요구사항을 전부 만족하며 실제 배포본에서 정상 동작함을 확인. `mustChangePassword` 강제 변경 흐름(로그인 직후/세션 복원 양쪽)이 정상 동작하고, 새 비밀번호 재로그인 시 강제 화면이 재노출되지 않으며, 기존 일반 로그인에는 회귀가 없음을 확인. 검증 과정에서 이번 작업과 무관하게 존재하던 두 건의 사전 버그(모달 z-index, bcryptjs CDN 경로)를 발견해 함께 수정하지 않았다면 방금 만든 기능 자체가 실제 사용자에게는 여전히 작동하지 않는 상태로 남았을 것.
- **Sensitive data policy**: 합성 계정(`pwtest1`, `pwtest_inactive`, 가짜 전화번호 `010-5555-9999`/`010-5555-1111`)만 사용, 실제 운영 기사 계정/비밀번호는 전혀 접촉하지 않음. 임시 비밀번호/새 비밀번호 값은 스크린샷/스냅샷 텍스트에 일시적으로 노출됐으나 합성 계정의 값이며 검증 직후 계정 자체를 삭제. 검증 종료 후 합성 계정 2건과 관련 감사 로그 9건 전부 REST로 삭제, `curl`로 재조회해 `null`(잔존 없음) 확인. TMS 로컬스토리지 테스트 배송 데이터도 모두 정리.

## 2026-07-08 — 이전 배송완료 사진 보기 MVP 배포 검증

- **대상**: `saas/driver.html` — `isSimilarAddress()`(신규, 클라이언트 이식), `saveDeliveryPhotoHistory()`/`findPreviousDeliveryPhoto()`(신규), `viewPhotoUrl()`(신규), `openCompleteScreen()`(연동)
- **커밋**: `07ed9b8`(기능 구현 + SECURITY_ISSUES.md Storage 규칙 기록), `bc4980f`(APP_VERSION 11 범프)
- **배포 전 확인**: `git status` clean(2개 파일: `saas/driver.html`, `SECURITY_ISSUES.md`), `node --test "test/*.test.js"` **109/109 pass**(functions 미변경), `database.rules.json`/`firebase.json`/`storage.rules` 변경 없음 확인.
- **로직 검증(배포 전, Node 샌드박스로 실제 커밋 소스 추출 + mock DB)**: 이력 없음→null, 같은 전화번호+같은 주소→반환, 같은 전화번호+다른 주소→null, 유사주소(공백/포함관계)→반환, 자기 자신(같은 orderId) 제외→null, 조회 중 예외 발생→에러 없이 null, phone/name 둘 다 없음→조회 자체 미시도, `saveDeliveryPhotoHistory` 저장 필드(`photoUrl`/`address`/`completedAt`/`orderId`) 정확성 — 8개 시나리오 전부 통과.
- **UI 배선 검증(배포 전, 로컬 정적 서버 + Playwright, 실제 Firebase 미접촉)**: `findPreviousDeliveryPhoto`를 스텁으로 교체해 있음/없음/조회실패 3케이스의 링크 노출·숨김 확인, 모달 오픈 시 삭제버튼 숨김·`currentPhotoId:null` 확인. 조회실패 스텁 테스트 중 `openCompleteScreen()`의 `.then()`에 `.catch()`가 없어 unhandled rejection이 기존 전역 에러 핸들러(`logSystemError`)를 거쳐 `system_logs/errors`에 write를 시도하다 미로그인 상태라 `permission_denied`로 거부되는 것을 발견(실제 데이터 저장은 없었음, 쓰기 "시도"만 거부됨) → `.catch(()=>{})` 방어 코드 추가 후 재검증, 콘솔 에러 0건 확인.
- **배포**: `firebase deploy --only hosting --project hatdelivery-saas`만 실행. 배포 직후 `settings/appVersion`을 "11"로 갱신.
- **배포 후 라이브 검증(testmart 실계정, 실제 `submitComplete()` 완료 플로우로 합성 데이터 3건 생성)**:
  1. 라이브 페이지 하드 리로드 후 `APP_VERSION==='11'` 확인
  2. testmart/test1 계정으로 실제 로그인 성공
  3. 합성 배송 1건(가짜 전화번호+가짜 주소, 이전 이력 없음) → 완료화면에서 링크 미표시 확인 → 캔버스로 생성한 합성 이미지를 첨부해 실제 `submitComplete()` 호출 → Storage 업로드 완료 후 `tenants/testmart/deliveryPhotoHistory/{합성 전화번호}`에 `photoUrl`(실제 Storage 다운로드 URL)/`address`/`completedAt`/`orderId` 4개 필드가 정확히 생성됨을 RTDB 직접 조회로 확인
  4. 같은 전화번호+같은 주소의 합성 배송 2건째 → 완료화면 진입 시 실제 Firebase 조회로 "🖼 이전 배송사진 보기" 링크 노출 확인 → 클릭 → `#photo-viewer` 모달에 실제 Storage URL 이미지 표시, 삭제 버튼(`btn-delete-photo`) `display:none`, `currentPhotoId:null` 확인(다른 배송 사진을 이 경로로 삭제할 수 없음을 재확인)
  5. 같은 전화번호+완전히 다른 주소의 합성 배송 3건째 → 링크 미표시 확인(주소 유사도 재검증이 실제로 오적용을 막음)
  6. 모바일 폭(375×812) 스크린샷 — 링크가 주소 카드 안에 위치, 수령방법/사진첨부/결제여부/완료버튼 어느 것과도 안 겹침
  7. 업데이트 배너: `settings/appVersion`을 일시적으로 "12"로 바꿔 불일치 유발 → 배너 노출 확인 → "11"로 원복 후 새로고침 → 배너 사라짐, `APP_VERSION` 유지 확인
  8. 전 과정 콘솔 에러 0건
  9. 로컬스토리지 테스트 배송 데이터 정리. Firebase에 생성된 합성 orders 3건을 RTDB REST로 삭제, `deliveryPhotoHistory` 1건 삭제, Storage에 업로드된 합성 사진 1건을 Storage REST API로 삭제(`HTTP 204`) — 재조회로 orders/`deliveryPhotoHistory` 전부 `null`, Storage 파일 재삭제 시도 `HTTP 404`(이미 없음)로 잔존 없음 확인
- **Result**: "이전 배송완료 사진 보기"가 설계대로 동작함을 실제 라이브 환경에서 확인 — 같은 전화번호라도 주소가 다르면 절대 표시되지 않고, 조회 실패/이력 없음은 조용히 링크만 숨겨 배송완료 흐름을 방해하지 않으며, 다른 배송의 사진을 실수로 삭제할 수 있는 경로가 없음. 신규 Storage 업로드 없이 기존 `photoUrl`을 재사용해 설계 시 예상한 대로 추가 저장 비용이 발생하지 않음을 실제 배포본에서 재확인.
- **Sensitive data policy**: 전 과정 합성 데이터만 사용(가짜 이름 "합성고객A", 가짜 전화번호 `010-9900-1111`, 가짜 주소 "마포구/종로구 합성·완전히다른동네 테스트로"). 실제 고객명/전화번호/주소/photoUrl 원문은 본 로그에도, 대화 응답에도 기록하지 않음. 검증 종료 후 orders 3건/`deliveryPhotoHistory` 1건/Storage 사진 1건 전부 삭제 및 재조회로 잔존 없음 확인.

## 2026-07-08 — OCR 빠른 확인모드(TMS 기사 사용률 개선 1차) 배포 검증

- **대상**: `functions/index.js`(`processReceipt`의 `location.source` 필드), `saas/driver.html`(`computeResultStatus()`/`renderResultStatus()`, `startOCR()`, `confirmAdd()`/`autoSaveLearnedAddressIfSafe()`, `renderHome()`의 카드 배지)
- **커밋**: `ac046e9`(핵심), `2876dd5`(APP_VERSION 12 범프)
- **배포 전 확인**: `git status` clean(2개 파일만), `node --test "test/*.test.js"` **109/109 pass**, `database.rules.json`/`firebase.json`/`storage.rules` diff 0줄 확인.
- **배포 전 로직 검증(Node 샌드박스, 실제 커밋 소스 + mock DOM/DB)**:
  - `computeResultStatus()` 8개 시나리오(OCR 정상/주소없음/학습적용/최초영수증표준화성공/raw_fallback/상세주소누락/출입정보감지/이름누락) 전부 통과
  - `autoSaveLearnedAddressIfSafe()` 4개 시나리오(신규저장/기존 유사주소 갱신/**기존 비유사 주소 덮어쓰기 방지**/좌표 없으면 저장 미시도) 전부 통과
- **배포**: `firebase deploy --only functions,hosting --project hatdelivery-saas`(7개 함수 업데이트, Hosting 배포). 배포 직후 `settings/appVersion`을 "12"로 갱신.
- **배포 후 라이브 검증(testmart 실계정, 실제 `processReceipt` 엔드포인트를 캔버스 렌더링 합성 영수증 이미지로 호출)**:
  1. 하드 리로드 후 `APP_VERSION==='12'` 확인, testmart/test1 계정 실제 로그인 성공
  2. **`raw_fallback`(노랑) 확인**: 마트 반경 밖 주소(강남구/중구)로 합성 영수증 2건 스캔 → `source:'raw_fallback'`, 상태바 "🟡 주소 확인 필요" 정상 표시. Cloud Functions 로그(`gcloud functions logs read`)로 원인이 "최근접 X.Xkm > 3km → reject"(마트 반경 밖이라 의도적으로 거부)임을 직접 확인 — 버그 아님, 기존 원거리 오배송 방지 설계가 정상 동작
  3. **`standardized`(초록) 확인**: 마트 반경 내 실제 도로명 주소로 합성 영수증 스캔 → `source:'standardized'`, lat/lng 정상 확정, 상태바 "🟢 바로 추가 가능", 배지 "🗺 길찾기 가능" 확인
  4. 위 영수증을 실제 `confirmAdd()`로 배송목록에 추가(기사가 아무것도 수정하지 않은 성공 케이스) → 2초 후 RTDB 직접 조회로 `settings/learnedLocations/{합성 전화번호}`(테넌트 스코프: `tenants/testmart/settings/learnedLocations/...`)에 `road_address`/`lat`/`lng`/`name`/`phone` 필드가 정확히 자동 저장됨을 확인(토스트 없이 조용히 저장 — 설계대로)
  5. **`learned`(파랑) 확인**: 방금 학습된 것과 동일한 전화번호+표준화된 주소 문자열로 재스캔 → `source:'learned'`, 상태바 "🔵 학습주소 적용됨", 배지 4종(학습주소 적용/길찾기 가능 등) 동시 노출 확인
  6. **같은 전화번호 다른 주소 오적용 방지 실측**: 같은 전화번호로 마트 반경 내의 완전히 다른 주소를 스캔 → 서버가 `학습주소 존재하지만 주소 불일치로 미적용` 로그와 함께 `source:'standardized'`로 신규 표준화 응답(정상). 이 결과를 실제 `confirmAdd()`로 추가한 뒤 학습주소를 재조회 → **`road_address`/`updatedAt`이 기존 값 그대로 유지됨을 확인**(다른 주소로 덮어써지지 않음 — 핵심 안전장치 실측 확인)
  7. `showRetakePrompt` 관련: 위 5회의 스캔(raw_fallback 2회 포함) 전부 팝업 없이 곧장 결과화면(빠른 확인모드)으로 진입함을 확인
  8. 배송목록 화면에서 학습주소 적용 건에 "📚 학습주소 적용" + "🗺 길찾기 가능" 카드 배지가 정확히 렌더링되고, 카드 버튼(길찾기/완료체크/✏️)은 3개 그대로 유지됨을 확인
  9. 모바일 폭(375×812) 스크린샷 — 결과화면 상태바/배지/사진썸네일/필드, 배송카드 배지 전부 겹침 없음
  10. 전 과정 콘솔 에러 0건
  11. 로컬스토리지 정리. Firebase에 생성된 합성 orders 4건(이전 라운드 잔존 1건 포함), `learnedLocations`(전화번호 키+이름 키, 테넌트 스코프), Storage 영수증 사진 3건 전부 REST/Storage API로 삭제 — 재조회로 orders/학습주소 전부 `null`, Storage 파일 삭제 응답 `HTTP 204` 확인
- **Result**: `location.source` 3가지 값(`learned`/`standardized`/`raw_fallback`) 전부가 실제 배포본에서 정확한 신호등 상태로 이어지고, `showRetakePrompt` 팝업 없이 결과화면에 항상 진입하며, 성공 케이스에서도 조용한 자동 학습이 실제로 발생하고, 같은 전화번호를 쓰는 다른 주소 고객에게 절대 오적용되지 않음을 확인. 배송카드 배지가 추가 Firebase 조회 없이 정확히 렌더링됨을 확인.
- **Sensitive data policy**: 합성 데이터만 사용(가짜 이름, 가짜 전화번호, 실제 존재하지만 개인과 무관한 공개 도로명 주소만 테스트 입력으로 사용 — 학습주소 자체는 합성 전화번호로만 저장). 실제 고객명/전화번호/주소/photoUrl 원문은 본 로그에도 대화 응답에도 기록하지 않음. 검증 종료 후 생성된 모든 합성 데이터(orders 4건, learnedLocations 2건, Storage 사진 3건) 전부 삭제 및 재조회로 잔존 없음 확인.

## 2026-07-09 — 배송순번/나중에 배송 UX 배포 검증

- **대상**: `saas/driver.html` — `syncDeliveriesOrderFromRoute()`(신규), `optimizeRoute()`/`renderRouteList()`(경로최적화·드래그 결과 반영 + 상세주소/출입정보 표시), `_renderDeliveryCard()`(카드 템플릿 분리), `postponeDelivery()`/`unpostponeDelivery()`(신규), `renderHome()`(배송중/나중에 배송 섹션 분리), `toggleDone()`(되돌리기 시 `_postponed` 초기화)
- **커밋**: `55fe40d`(핵심), `6fc8257`(APP_VERSION 13 범프)
- **배포 전 확인**: `git status` clean(`saas/driver.html` 1개 파일), `node --test "test/*.test.js"` **109/109 pass**(functions 미변경), `database.rules.json`/`firebase.json`/`storage.rules` 변경 없음 확인.
- **로컬 사전 검증(배포 전)**: Playwright로 자동정렬/드래그 결과가 실제로 `deliveries` 순서에 반영되는지, 상세주소/출입정보 표시(없으면 생략), 나중/복귀 상태 전환, 모바일 375px 버튼 레이아웃을 확인 — 1회 반복 발견: "다시배송중"(5글자) 라벨이 375px에서 2줄로 줄바꿈되어 "복귀"(2글자, "나중"과 동일 폭)로 축약 후 재검증 통과.
- **배포**: `firebase deploy --only hosting --project hatdelivery-saas`만 실행. 배포 직후 `settings/appVersion`을 "13"으로 갱신.
- **배포 후 라이브 검증(testmart 실계정, 로컬스토리지 전용 합성 데이터 — Firebase orders/learnedLocations/Storage 쓰기 전혀 없음)**:
  1. 하드 리로드 후 `APP_VERSION==='13'` 확인, testmart/test1 계정 실제 로그인 성공(세션 유지 상태)
  2. 합성 배송 4건(좌표 없는 1건 포함) 로컬 생성 → `optimizeRoute()` 실제 호출 → 실제 최근접 알고리즘 결과(예: C→B→A→D)가 경로최적화 화면과 `deliveries` 배열 양쪽에 동일하게 반영됨을 확인
  3. 경로최적화 리스트에 상세주소("101동 202호", "3층")/출입정보("🔐 공동현관 1234#", "🔐 비밀번호 5678")가 정확히 표시되고, 없는 항목은 빈 줄 없이 생략됨을 확인
  4. `routeOrder`를 임의 순서(D,A,C,B)로 재배열(드래그 결과 시뮬레이션) → `syncDeliveriesOrderFromRoute()` 호출 → 배송목록 카드 순번이 정확히 같은 순서로 재배열됨을 확인, 각 카드의 ETA 배지도 새 순서 기준으로 누적 재계산됨을 확인("대략 오전 09:34/09:43/09:48" 식으로 순서대로 증가)
  5. "나중" 클릭 → 상태는 `pending` 유지, `_postponed:true`로 전환 → "⏭ 나중에 배송 (1)" 구분선과 함께 별도 섹션에 독립 순번(①)으로 표시됨을 확인
  6. 나중에 배송 섹션 카드에서 "완료" 클릭 → 기존 사진촬영 확인 화면(`complete`)으로 정상 진입, 이 시점까지 상태는 여전히 `pending`임을 확인(홈으로 복귀)
  7. "복귀" 클릭 → `_postponed:false`, 구분선 소멸, 배송중 섹션 맨 뒤로 정상 복귀
  8. 나중에 배송 상태로 만든 뒤 상태를 `done`으로 직접 전환(사진촬영/업로드 자체는 이전 라운드에서 이미 검증된 별개 플로우라 이번엔 재현하지 않음) → 진행률 "3건 남음 · 완료 1/4건", 완료 탭 카운트 "(1)"로 정상 갱신, 나중에 배송 섹션도 함께 소멸함을 확인
  9. 완료 탭에서 "되돌리기" 클릭 → `status:'pending'`, `_postponed:false`로 동시에 초기화되어 나중에 배송 섹션이 아니라 배송중 섹션에 정상 복귀함을 확인
  10. 모바일 375px 스크린샷 — 배송중/나중에 배송 두 섹션 전부 4버튼(길찾기/완료/나중 또는 복귀/✏️) 줄바꿈·겹침 없이 표시됨을 라이브 도메인에서 재확인
  11. 배송지도(`mapzone`) 탭 진입 — `typeof kakao !== 'undefined'` true, 지도/마커(마트+배송지 번호)/줌/전체보기 정상 렌더링 확인. **로컬 정적 서버에서 봤던 `kakao is not defined` 에러가 라이브 도메인에서는 발생하지 않음**을 확인(Kakao SDK 도메인 제한이 원인이었다는 추정이 맞았음)
  12. 다만 `mapzone` 진입 시 `kakaoWaypoints` Cloud Function 호출이 **403**으로 실패하는 것을 새로 발견 — `git show <commit> -- saas/driver.html`을 add/remove 라인만 필터링해 재확인한 결과 이번 커밋은 `mapzone`/`kakaoWaypoints`/`showRouteMode` 관련 실제 코드를 전혀 변경하지 않음(추가된 주석 1줄에서만 "mapzone" 단어 언급) — 이번 변경과 무관한 기존 이슈로 판단, 지도의 핵심 기능(마커/줌/전체보기)에는 영향 없음
  13. 전 과정 콘솔 에러: `kakaoWaypoints` 403 1건 외 없음(위 12번 참고, 이번 라운드 원인 아님)
  14. 정리: 이번 라운드는 전부 로컬스토리지 전용 데이터로 검증해 Firebase에 쓰기가 전혀 없었음 — `deliveries`/`routeOrder`를 비우고 `localStorage.removeItem`으로 로컬 정리, 하드 리로드 후 `todayCount:0`/`storageEmpty:null` 재확인
- **Result**: 경로최적화(자동+드래그)가 배송목록 순서·순번·ETA에 실제로 반영되고, 경로최적화 화면에서 상세주소/출입정보가 정확히 보이며, "나중에 배송" 섹션 분리가 상태를 바꾸지 않고 UI 전용으로 정확히 동작하고, "완료" 버튼이 여전히 사진촬영 확인 화면만 여는 기존 동작을 그대로 유지함을 실제 배포본에서 확인. 배송지도 탭은 지도 자체가 라이브 도메인에서 정상 동작함을 확인했으나, 별개의 사전 이슈(`kakaoWaypoints` 403)를 발견해 후속 백로그로 분리 기록.
- **Sensitive data policy**: 합성 데이터만 사용(가짜 이름, 가짜 전화번호, 실제 존재하지만 개인과 무관한 공개 도로명 주소). 실제 고객명/전화번호/주소는 본 로그에도 대화 응답에도 기록하지 않음. 이번 라운드는 로컬스토리지 전용 테스트라 Firebase 정리 대상 자체가 없었음(재확인 완료).

## 2026-07-09 — TMS 라이브 사용성 피드백 1차 배포 검증

- **대상**: `saas/driver.html` — `_renderCardInfoBadges()`/`computeResultStatus()`/`renderResultBadges()`("길찾기 가능" 배지 제거), `#save-learned-btn`(기본 숨김), `#regeo-btn`("주소 다시 찾기" 문구 변경 + 안내문 + `renderResultStatus()`의 상태별 톤다운), `#traffic-refresh-btn`(기본 숨김), `.delivery-item`/`.dl-top` CSS(패딩/정렬)
- **커밋**: `eba07dc`(핵심), `c83ee41`(APP_VERSION 14 범프)
- **배포 전 확인**: `git status` clean(`saas/driver.html` 1개 파일만 스코프), `node --test "test/*.test.js"` **109/109 pass**(functions 미변경). Node 샌드박스로 실제 커밋된 `computeResultStatus()` 8개 시나리오를 `badges.nav` 제거 후 재실행해 전부 통과 확인(회귀 없음).
- **배포**: `firebase deploy --only hosting --project hatdelivery-saas`만 실행. `firebase database:set /settings/appVersion --data '"14"'`로 배포 직후 갱신.
- **배포 후 라이브 검증(testmart/test1 실계정, Playwright로 라이브 도메인 직접 조작 — 합성 데이터만 사용)**:
  1. 최초 접속 시 브라우저 HTTP 캐시(`Cache-Control: max-age=3600`)로 인해 `APP_VERSION`이 배포 전 값(13)으로 남아있는 것을 발견 → 캐시버스트 쿼리스트링으로 재접속해 `APP_VERSION==='14'` 확인, 업데이트 배너 정상 소멸 확인. `curl`로 오리진 응답 자체(`X-Cache: MISS`)에는 처음부터 `APP_VERSION='14'`가 정상 반영돼 있었음을 별도 확인 — 배포 자체는 문제 없었고 클라이언트측 HTTP 캐시가 원인.
  2. testmart/test1 세션이 이미 인증된 상태였음을 `TENANT_ID`/`currentDriver` 직접 조회로 확인(`tenantId:'testmart'`, `driver.id:'test1'`)
  3. OCR 결과화면을 `window._pendingOCR` + 실제 `renderResultStatus()`/`computeResultStatus()` 호출로 2가지 상태 재현: (a) 파랑(학습주소 적용) — `regeo-btn` 텍스트 "📍 주소 다시 찾기", `regeo-muted` 클래스 적용(톤다운), `save-learned-btn` computed `display:none`, 배지 3종(학습주소 적용/이전 배송사진 있음/출입정보 있음)에 "길찾기 가능" 미포함 확인. (b) 노랑(주소 확인 필요) — `regeo-muted` 미적용(강조 유지), 안내문 "주소가 이상하거나 지번주소일 때 눌러주세요" 노출 확인
  4. 실제 `confirmAdd()`를 2회 호출해 합성 배송 2건 생성 — A(좌표/학습주소/이전사진/출입정보 전부 있음), B(좌표 없음) — 배송목록 카드에서 A는 배지 3종만 노출(길찾기 가능 없음), B는 ETA 배지 자리에 "좌표 없음" 정상 노출 확인
  5. `getComputedStyle()`로 `.delivery-item` padding=14px, `.dl-top` align-items=flex-start 라이브 반영 확인
  6. 경로최적화 화면에서 실제 `optimizeRoute()` 호출 → `#traffic-refresh-btn` computed `display:none` 확인. 이 과정에서 콘솔에 `kakaoWaypoints` **403** 에러가 실제로 발생하는 것을 확인(아래 "중요 발견" 참고), `#time-banner`가 실패 시 정상적으로 제거됨(기존 동작)도 함께 확인
  7. 카드 A에서 실제 클릭으로 "나중" → "나중에 배송" 섹션 이동(구분선 "⏭ 나중에 배송 (1)") → "복귀" → 배송중 섹션 복귀 왕복 확인. `openCompleteScreen()` 호출 시 `complete` 화면 정상 진입(상태 미변경) 확인. `openEditModal()` 호출 시 수정 모달 정상 오픈 확인. 셋 다 에러 없음 — 이번 변경이 손대지 않은 플로우들의 회귀 없음 확인
  8. 모바일 375×812 스크린샷 2장(배송목록 화면, OCR 결과화면) — 배지 줄바꿈, 버튼 4개 정렬, "주소 다시 찾기" 버튼+안내문 전부 겹침 없이 표시됨을 확인
  9. 콘솔 에러 전체 조회: `kakaoWaypoints` 403 2건(6번 항목 원인), `favicon.ico` 404 1건(기존부터 있던 무관 이슈) 외 없음 — 이번 변경으로 새로 발생한 에러 없음
  10. 정리: `confirmAdd()`로 생성된 orders 2건을 `firebase database:remove`로 삭제 후 재조회로 `null` 확인, `settings/learnedLocations`에 해당 전화번호/이름 키로 아무것도 생성되지 않았음을 재조회로 확인(사전 코드 분석 — `addrChanged=false`이고 A는 이미 `source==='learned'`, B는 좌표 없어 `autoSaveLearnedAddressIfSafe`가 저장을 스킵하는 경로였음 — 와 일치), 브라우저 `deliveries` 로컬 캐시도 필터링 후 재저장, 최종 하드 리로드로 "오늘 배송 건이 없습니다" 빈 상태 확인
- **중요 발견**: 6번 단계에서 `kakaoWaypoints` Cloud Function 호출이 콘솔에 **`Failed to load resource: the server responded with a status of 403`**로 실제로 실패하는 것을 직접 확인. 지난 라운드("배송순번/나중에 배송 UX" 배포 검증)에서 배송지도(mapzone) 탭에서 발견했던 것과 동일한 Cloud Function·동일한 403. 이번 라운드에서 "소요시간 다시 확인" 버튼을 UI 피로도 문제로만 보고 숨겼는데, 실측 결과 애초에 눌러도 항상 실패하는 기능이었다는 것이 확인되어 숨김 결정이 실측으로 뒷받침됨. `_bmad/backlog.md`의 "배송지도(mapzone) 경로선 기능 대체 설계 필요" 항목에 교차 기록.
- **Result**: 6개 사용성 피드백에 대응하는 1차 변경(배지 제거/버튼 숨김·문구 개선/CSS 소폭 조정) 전부가 실제 배포본에서 의도대로 동작함을 확인. 기존 플로우(나중/복귀/완료/수정) 회귀 없음, 신규 콘솔 에러 없음. 배포 검증 과정에서 `kakaoWaypoints` 403이 "소요시간 다시 확인" 기능에도 영향을 준다는 추가 근거를 확보.
- **Sensitive data policy**: 합성 데이터만 사용(가짜 이름 "배포검증A"/"배포검증좌표없음", 가짜 전화번호 01000000001/01000000002, 가상 주소). 실제 고객명/전화번호/주소는 본 로그에도 대화 응답에도 기록하지 않음. testmart 계정 비밀번호는 사용자가 세션 중 직접 전달했으며 이 로그/커밋/대화 응답 어디에도 기록하지 않음. 검증 종료 후 생성된 orders 2건 전부 삭제 및 재조회로 잔존 없음(`null`) 확인, 로컬스토리지도 정리 완료.

## 2026-07-09 — 수기 직접 입력 상세주소/출입정보 배포 검증

- **대상**: `saas/driver.html` — 직접 입력 폼(상세주소/출입정보 입력칸 신규), `addManual()`(두 값을 `geocodeAndAdd()`로 전달 + 초기화), `geocodeAndAdd()`(item 객체에 `detailAddress`/`accessInfo` 추가), `openCompleteScreen()`(완료 화면에 `accessInfo` 표시 신규)
- **커밋**: `90578cd`(핵심), `ce26a18`(APP_VERSION 15 범프)
- **배포 전 확인**: `git status` clean(`saas/driver.html` 1개 파일만 스코프), `node --test "test/*.test.js"` **109/109 pass**(functions 미변경).
- **배포 전 로컬 검증**: 로컬 정적 서버(`npx serve`)로 커밋된 소스를 그대로 서빙해 실제 프로덕션 Firebase(testmart/test1)에 로그인 후 검증. 이 origin에서는 Kakao Maps JS SDK가 도메인 제한으로 로드되지 않는 것을 확인(`kakao is not defined` — 이전 라운드의 배송지도 검증에서도 동일하게 확인된 현상)하여, `geocodeAndAdd()`가 내부적으로 사용하는 Kakao Geocoder에만 최소 스텁을 주입해 이번에 변경한 필드 전달 로직(기존 지오코딩 로직 자체는 무변경)을 검증 — 5개 필드 입력 → 배송카드에 상세주소/출입정보/배지 정상 반영, 빈 값 케이스 회귀 없음, 새로고침 후 localStorage 유지, 실제 Firebase RTDB에 `detailAddress`/`accessInfo` 저장 확인, 경로최적화 리스트 표시 확인, 완료 화면 표시(있음/없음 둘 다) 확인, OCR `confirmAdd()` 흐름 회귀 없음, 모바일 375px 3화면 겹침 없음, `learnedLocations` 미생성 확인(자동학습 미태움). 검증에 사용한 로컬 orders 4건은 실제 Firebase에 함께 기록되어 이 단계에서 즉시 REST API로 삭제.
- **배포**: `firebase deploy --only hosting --project hatdelivery-saas`만 실행. `firebase database:set /settings/appVersion --data '"15"'`로 배포 직후 갱신.
- **배포 후 라이브 검증(testmart/test1 실계정, Playwright로 라이브 도메인 직접 조작 — 합성 데이터만 사용)**:
  1. `curl`로 오리진 응답과 런타임 값 양쪽에서 `APP_VERSION==='15'` 확인(직전 라운드에서 겪은 브라우저 HTTP 캐시 이슈를 피하기 위해 캐시버스트 쿼리스트링으로 접속), testmart/test1 세션 유지 확인(`TENANT_ID`/`currentDriver` 직접 조회)
  2. 직접 입력 화면에 "상세주소 (동·호수, 층 등)"/"출입정보 / 공동현관" 입력칸이 라이브에 정상 노출됨을 스냅샷으로 확인
  3. 5개 필드를 모두 채워 실제 `addManual()` 호출(라이브 도메인이라 Kakao SDK는 실제로 로드됨 — 합성 도로명이라 좌표 자체는 못 찾았지만 이번 검증 대상인 `detailAddress`/`accessInfo` 저장 여부와는 무관) → 배송카드에 상세주소/출입정보 라벨과 "🔐 출입정보 있음" 배지, 기존 "좌표 없음" 경고 배지가 모두 정상 표시됨을 확인(좌표 없는 카드에서도 새 필드가 문제없이 함께 표시됨을 겸해 확인)
  4. 상세주소/출입정보를 비운 채로 추가 → 라벨/배지 없이 기존과 동일하게 정상 추가됨을 확인(회귀 없음)
  5. 전체 페이지 새로고침 후 localStorage에서 두 값이 그대로 유지됨을 확인
  6. Firebase RTDB(`tenants/testmart/orders/{id}`) 직접 조회로 `detailAddress`/`accessInfo` 저장 확인
  7. 경로최적화 화면에서 실제 `optimizeRoute()` 호출 → 상세주소/출입정보가 리스트에 정상 표시됨을 확인, 지난 라운드에서 숨긴 "소요시간 다시 확인" 버튼도 여전히 비노출 상태임을 재확인(회귀 없음)
  8. 완료 화면에서 `accessInfo` 있는 건은 주소 아래에 "🔐 ..." 표시, 없는 건은 요소 자체가 `display:none`으로 생략됨을 양쪽 다 확인
  9. 실제 `confirmAdd()`(OCR 흐름)를 호출해 상세주소/출입정보가 이 경로로도 정상 저장됨을 확인 — 이 과정에서 지난 라운드에 배포한 "주소 다시 찾기" 톤다운, "학습 주소 저장" 버튼 기본 숨김도 함께 재확인(회귀 없음)
  10. 모바일 375×812 스크린샷 3장(직접 입력 폼, 배송목록 카드, 완료 화면) — 새 필드/라벨/배지 전부 겹침 없이 표시됨을 확인
  11. 콘솔 에러 전체 조회: **0건**
  12. 정리: `addManual()`로 생성된 orders 3건을 `firebase database:remove`로 삭제 후 재조회로 `null` 확인, `settings/learnedLocations`에 해당 전화번호 키로 아무것도 생성되지 않았음을 재조회로 확인(자동학습 미태움 — `geocodeAndAdd()`가 학습 저장을 전혀 호출하지 않는다는 사전 코드 분석과 일치), 브라우저 `deliveries` 로컬 캐시도 필터링 후 재저장
- **Result**: 수기 직접 입력 화면에서 상세주소/출입정보를 입력하면 기존 OCR 흐름과 동일한 저장·표시 파이프라인(배송카드/경로최적화 리스트/완료 화면)을 통해 정확히 반영되고, 값이 없을 때는 기존 동작과 동일하게 생략됨을 실제 배포본에서 확인. 자동학습에 전혀 영향을 주지 않음을 확인. 기존 OCR 흐름 및 지난 라운드 변경사항(배지 제거, 버튼 숨김/톤다운) 회귀 없음.
- **Sensitive data policy**: 합성 데이터만 사용(가짜 이름/가짜 전화번호/가상 주소, 구체 값은 본 로그에 기록하지 않음). 실제 고객명/전화번호/주소는 본 로그에도 대화 응답에도 기록하지 않음. testmart 계정 비밀번호는 이 로그/커밋/대화 응답 어디에도 기록하지 않음. 검증 종료 후 생성된 orders 총 7건(로컬 사전검증 4건 + 라이브 검증 3건) 전부 삭제 및 재조회로 잔존 없음(`null`) 확인, 로컬스토리지도 정리 완료.
