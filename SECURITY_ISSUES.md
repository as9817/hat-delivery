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

- **상태**: 🟡 Known Issue / Not fixed in SEC-001
- **우선순위**: P1
- **증상**: `saas/driver.html`의 "비밀번호를 잊으셨나요?" 기능이 라이브 환경에서 100% 실패 (`permission_denied`). SEC-001 배포 이전부터 이미 깨져 있던 상태이며, SEC-001 배포로 인해 새로 발생한 회귀는 아님.
- **원인**: `doFindPw()`(`saas/driver.html`)가 로그인(Firebase Auth) 완료 전 시점에 클라이언트에서 직접 `tenants/{tenantId}/driverAccounts/{driverId}`를 read(전화번호 대조) 및 update(임시 비밀번호 저장)하려 시도. 이 시점엔 `auth`가 없어 RTDB 규칙(`auth != null` 요구)에 항상 막힘.
- **해결 방향**: `issueDriverToken`과 동일한 패턴으로 Cloud Function으로 이전 — Admin SDK로 서버 측에서 본인 확인(전화번호 대조) 후 임시 비밀번호를 발급/저장.
- **보안 요구사항** (Cloud Function 설계 시 반영):
  - 본인 확인 절차 (전화번호 등록값 대조, 필요 시 추가 인증 수단 검토)
  - Rate limit (동일 IP/계정에 대한 무차별 대입 방지)
  - 감사 로그 기록 (요청 시각, tenantId, driverId, 성공/실패)
  - 임시 비밀번호 발급 후 `mustChangePassword: true` 강제 적용 (기존 OMS 계정 강제 변경 로직과 동일 원칙)
- **관련 파일**: `saas/driver.html`, `functions/index.js`, `database.rules.json`
- **비고**: SEC-001에서 다루지 않음. 별도 작업으로 진행.

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
