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
