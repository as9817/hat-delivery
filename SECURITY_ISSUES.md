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

- **상태**: 🔲 Not started
- **우선순위**: P1
- **범위**: `processReceipt`, `geocodeAddress`, `reverseGeocode`, `kakaoWaypoints`의 인증 없는 CORS 전체 개방, `receiveOrder`의 하드코딩 기본 토큰(`'hatdelivery2026'`) 제거.
- **비고**: 다음 작업으로 설계 예정.

---

## 후속 백로그 (P1/P2, 이번 범위 밖)

- 테넌트 내부 역할 분리 (기사가 `settings`/`driverAccounts` 등 민감 경로를 직접 쓰지 못하게 제한)
- 평문 비밀번호 레거시 폴백 제거 (`functions/index.js` `issueDriverToken`)
- git 저장소 정리: `orders.json`, `functions.zip`, `functions/node_modules` 추적 해제 (히스토리 재작성 여부 별도 논의)
