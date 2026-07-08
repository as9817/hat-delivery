# 보안 이슈 추적 (햇배달 SaaS)

> RTDB/Cloud Functions 보안 점검 과정에서 발견된 이슈를 추적합니다.
> 이 프로젝트는 별도 이슈 트래커가 없어 이 파일로 관리합니다.

---

## SEC-001: RTDB 테넌트 간 데이터 격리 부재

- **상태**: ✅ Fixed (2026-07-06)
- **우선순위**: P0
- **원인**: `database.rules.json`의 `tenants/$tenantId`, `tenant_meta`, `users`가 `auth != null`만 검사하고 테넌트 소속을 검사하지 않음. 로그인한 임의 계정(기사 포함)이 다른 테넌트의 `tenants/{otherTenantId}/...` 전체를 read/write 가능했음.
- **조치**: `auth.token.tenantId`(기사 커스텀 토큰) 및 `users/{uid}/tenantId`(일반 관리자 계정) 기반 스코핑 규칙 추가. `users/{uid}` 전체 write는 슈퍼어드민 전용으로 제한(자기 tenantId 변경을 통한 우회 방지).
- **커밋**: `699ff4c`
- **검증**: testmart 관리자/기사 정상 접근, 교차 테넌트 read/write `permission_denied`, 슈퍼어드민 `tenant_meta` 전체 조회 정상 — 전항목 라이브 확인 완료.
- **부수 조치**: 검증 과정에서 실제 운영 테넌트(`wamartmillak`)의 OMS 2차 로그인 계정 비밀번호 해시가 노출되어 임시 비밀번호로 로테이션 완료 (`mustChangePassword: true` 유지, 실제 값은 로컬에만 보관).

---

## P1-001: 기사앱 비밀번호 찾기 기능 깨짐 (SEC-001 범위 밖)

- **상태**: ✅ Deployed / Verified (2026-07-08)
- **우선순위**: P1
- **증상**: `saas/driver.html`의 "비밀번호를 잊으셨나요?" 기능이 라이브 환경에서 100% 실패 (`permission_denied`). SEC-001 배포 이전부터 이미 깨져 있던 상태이며, SEC-001 배포로 인해 새로 발생한 회귀는 아님.
- **원인**: `doFindPw()`(`saas/driver.html`)가 로그인(Firebase Auth) 완료 전 시점에 클라이언트에서 직접 `tenants/{tenantId}/driverAccounts/{driverId}`를 read(전화번호 대조) 및 update(임시 비밀번호 저장)하려 시도. 이 시점엔 `auth`가 없어 RTDB 규칙(`auth != null` 요구)에 항상 막힘.
- **해결**: `issueDriverToken`과 동일한 패턴으로 신규 Cloud Function `resetDriverPassword`로 이전 — Admin SDK로 서버 측에서 본인 확인(전화번호 대조) 후 임시 비밀번호를 발급/저장(`database.rules.json` 변경 없음, Admin SDK가 규칙을 우회). 아래 보안 요구사항 전항목 반영.
  - 본인 확인 절차: 등록된 전화번호 대조(계정 미존재/비활성/전화번호 불일치 전부 동일한 일반 실패 메시지로 응답해 계정 존재 유추 방지)
  - Rate limit: 계정당 1시간 5회, `driverAccounts` 레코드 내부 필드로 관리(IP 기반은 후속 과제로 유보)
  - 감사 로그: `system_logs/driverPwReset`에 `{timestamp, tenantId, driverId, success, reason}`만 기록(전화번호/이름/임시비밀번호/해시 미기록)
  - `mustChangePassword: true` 강제 적용 + `issueDriverToken` 응답에 필드 추가 + `driver.html` 로그인 게이트(신규 강제 변경 화면) 신설 — 기존 TMS에는 이 강제 로직 자체가 전혀 없었음(OMS `omsAccounts`에만 존재하던 패턴을 이식)
- **검증 중 추가로 발견/수정한 두 건의 사전 버그** (이번 작업 범위가 아니었으나, 방금 만든 기능 자체가 도달 불가능해지는 직접적 차단 요인이라 함께 수정):
  - `#findpw-modal`의 `z-index:3000`이 `#login-screen`의 `z-index:9999`보다 낮아 실제 클릭이 로그인 화면으로 새어나가던 문제(모달 자체가 클릭 불가능) → `z-index:10000`으로 수정
  - `driver.html`이 로드하는 bcryptjs CDN 경로가 잘못된 패키지명(`bcrypt.js`, 404 → Chrome ORB 차단)이었던 문제 → 올바른 이름(`bcryptjs`)으로 수정 + jsdelivr 폴백 추가(`app.html`과 동일 패턴)
- **관련 파일**: `saas/driver.html`, `functions/index.js`, `functions/test/driver-pw-reset.test.js`(신규), `functions/test/smoke.test.js`. `database.rules.json` 변경 없음.
- **커밋**: `1c8c84f`(핵심 기능), `bc098ea`/`639acd2`/`aea2cbb`(APP_VERSION 범프 + 검증 중 발견한 z-index/CDN 버그 수정)
- **검증**: `_bmad/tea/evidence-log.md`의 "2026-07-08 — 기사앱 비밀번호 찾기 기능 복구(P1-001) 배포 검증" 참고.

---

## SEC-002: Cloud Functions 인증/CORS 강화

- **상태**: ✅ Deployed / Verified (2026-07-06)
- **우선순위**: P1
- **범위**: `processReceipt`, `geocodeAddress`, `reverseGeocode`, `kakaoWaypoints`의 인증 없는 CORS 전체 개방, `receiveOrder`의 하드코딩 기본 토큰 제거.
- **조치**: Firebase ID Token 인증 공통 헬퍼(`verifyAuthAndResolveTenantId`) 추가. 4개 브라우저 호출 함수는 `Authorization: Bearer <idToken>` 검증 필수화, CORS `Allow-Headers`에 `Authorization` 추가. `processReceipt`는 추가로 토큰/DB로 판정한 tenantId와 `body.tenantId` 일치 여부 검사. `receiveOrder`는 `ORDER_AUTH_TOKEN` 하드코딩 폴백 제거.
- **커밋**:
  - `b97cb43` — chore(functions): sync deployed functions into git (geocodeAddress/reverseGeocode/kakaoWaypoints/issueDriverToken이 배포는 됐으나 git에 없던 상태를 먼저 반영, 인증 변경 없음)
  - `f46ef32` — security(functions): require auth for browser callable functions (SEC-002 인증 로직만)
- **배포 대상**: Firebase Functions + Hosting, 프로젝트 `hatdelivery-saas`
- **검증 근거** (전항목 통과):
  - `functions/index.js` 문법 검사: pass
  - `app.html`/`driver.html` fetch 호출부 Authorization 헤더 반영: pass
  - OPTIONS preflight 무인증 204 반환 (4개 함수): pass
  - 미인증 호출 시 401 (`geocodeAddress`/`reverseGeocode`/`kakaoWaypoints`/`processReceipt`): pass
  - `processReceipt` tenantId 불일치 시 403: pass
  - `processReceipt` 본인 테넌트 인증 통과 후 다음 단계(Vision API)까지 정상 진행 확인: pass
  - testmart 기사 계정 TMS 정상 렌더링: pass
  - testmart 관리자 계정 OMS 정상 렌더링: pass
  - 브라우저 콘솔 에러: 0건
  - `receiveOrder` 하드코딩 폴백 제거 확인 + `ORDER_AUTH_TOKEN` 환경변수 명시적 설정 확인 (값은 마스킹, 기존 값과 동일하게 유지하여 MacroDroid 자동접수 연속성 확보)
- **롤백**: 불필요 (전항목 검증 통과, 문제 발생 없음)
- **후속 작업**:
  - `ORDER_AUTH_TOKEN`을 더 강력한 값으로 로테이션 + MacroDroid 설정 동시 변경 (P0/P1 후속, 별도 티켓)
  - 안정화 확인 후 레거시 `X-Api-Key`/`FUNCTION_API_KEY` 제거 (2차 정리)
  - P1-001 (기사앱 비밀번호 찾기 Cloud Function 이전)
  - 테넌트 내부 역할 분리
  - 평문 비밀번호 레거시 폴백 제거
  - 기존 미커밋 OCR/주소/반경 관련 작업 리뷰 (SEC-001/002와 분리 보존됨, 별도 diff 검토 → 테스트 → 커밋 필요)

---

## 후속 백로그 (P1/P2, 이번 범위 밖)

> 테넌트 내부 역할 분리, 평문 비밀번호 폴백 제거, `ORDER_AUTH_TOKEN` 로테이션, `X-Api-Key` 제거는 SEC-002 후속 작업 항목 참고.

- git 저장소 정리: `orders.json`, `functions.zip`, `functions/node_modules` 추적 해제 (히스토리 재작성 여부 별도 논의)
- **Firebase Storage 보안 규칙이 코드베이스에서 전혀 관리되지 않음** — `storage.rules` 파일이 저장소에 없고, `firebase.json`에도 `storage` 배포 설정 자체가 없음(`database`/`hosting`/`functions`만 있음). 즉 실제 운영 중인 Storage 규칙이 Firebase Console에서 직접 설정된 값인지, 프로젝트 생성 시 기본값이 그대로인지 코드만으로는 알 수 없음. read-only 검증(2026-07-08, "이전 배송완료 사진 보기" 설계 라운드) 결과, 최소한 **미인증 임의 경로 다운로드·버킷 List는 403으로 막혀 있음**을 실측 확인했으나(존재하지 않는 가짜 경로로만 테스트, 실제 파일 미접촉), 정확한 규칙 원문은 Console에서 직접 확인 필요. `delivery-photos/{tenantId}/{deliveryId}.jpg`에 저장되는 배송완료 사진의 `getDownloadURL()` 다운로드 URL은 토큰 포함 방식이라 규칙과 무관하게 "URL을 아는 사람은 접근 가능"한 구조라는 점도 별개로 인지 필요(Firebase Storage 다운로드 토큰의 기본 동작). **조치**: `firebase storage:rules:get` 또는 Console에서 현재 규칙을 확인해 `storage.rules`로 코드베이스에 옮기고 CI/배포 흐름에 편입.
