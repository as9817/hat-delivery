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

---

## 진행 대기 (P1)

- **P1-001: 기사앱 비밀번호 찾기 기능 복구** — `saas/driver.html`의 `doFindPw()`가 로그인 전 클라이언트에서 직접 RTDB 접근을 시도해 SEC-001 이후 permission_denied로 100% 실패 중. `issueDriverToken`과 동일하게 Cloud Function으로 이전 필요. 상세는 `SECURITY_ISSUES.md`의 P1-001 참고.
- **ORDER_AUTH_TOKEN 로테이션** — 현재 값은 기존 하드코딩 값과 동일하게 유지 중(운영 중단 회피 목적). 더 강력한 값으로 교체 시 MacroDroid 쪽 헤더 값도 동시에 변경 필요. 운영 준비 후 별도 진행.

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

## 백로그 (P2, 장기)

- **테넌트 내부 역할 분리** — 기사 계정이 `settings`/`driverAccounts` 등 민감 경로를 직접 쓰지 못하게 제한 (SEC-001은 테넌트 *간* 격리만 다룸, 테넌트 *내부* 역할 분리는 범위 밖).
- **평문 비밀번호 레거시 폴백 제거** — `functions/index.js`의 `issueDriverToken`에 남아있는 `driver.password === password` 폴백.
