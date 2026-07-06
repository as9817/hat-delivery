# 백로그 (햇배달 SaaS)

> 보안 핫픽스(SEC-001/SEC-002) 및 이후 정리 라운드에서 나온 후속 작업을 추적합니다.
> 상세 보안 이슈는 `SECURITY_ISSUES.md` 참고, 여기는 전체 작업 백로그용입니다.

---

## 완료

### P2: Fix @ Apartment Abbreviation Normalization
- **Status**: ✅ Completed
- **Commit**: `ad97c1c`
- **Result**: `@` apartment abbreviation now normalizes correctly when used as a standalone abbreviation (previously never matched due to `\b` not forming a boundary after a non-word character).
- **Tests**: Synthetic regression tests added (`functions/test/receipt-utils.test.js`); related tests passing.
- **Remaining unrelated failures**: Existing stale smoke tests only (`saas/app.html` APP_VERSION assumption, `database.rules.json` simple-rule assumption) — not in scope for this fix.

---

## 진행 대기 (P1)

- **P1-001: 기사앱 비밀번호 찾기 기능 복구** — `saas/driver.html`의 `doFindPw()`가 로그인 전 클라이언트에서 직접 RTDB 접근을 시도해 SEC-001 이후 permission_denied로 100% 실패 중. `issueDriverToken`과 동일하게 Cloud Function으로 이전 필요. 상세는 `SECURITY_ISSUES.md`의 P1-001 참고.
- **ORDER_AUTH_TOKEN 로테이션** — 현재 값은 기존 하드코딩 값과 동일하게 유지 중(운영 중단 회피 목적). 더 강력한 값으로 교체 시 MacroDroid 쪽 헤더 값도 동시에 변경 필요. 운영 준비 후 별도 진행.

## 진행 대기 (정리/품질)

- **`functions/test/smoke.test.js` stale 테스트 수정** — `saas/app.html` APP_VERSION 존재 가정(애초에 틀림), `database.rules.json` 단순 `auth != null` 가정(SEC-001로 낡아짐) 2건 수정 후 커밋.
- **`DEPLOY_CHECKLIST.md` API 키 마스킹** — 120번째 줄 부근 실제 Google API 키 값 제거/마스킹 전까지 커밋 금지.
- ~~**`.agents/`, `.claude/skills/` 커밋 여부 판단**~~ → **결정 완료**: `node_modules`와 동일하게 취급, `.gitignore`에 추가하고 저장소에는 포함하지 않음(각 12MB, `playwright-cli` 스킬 1개 차이만 있고 사실상 완전 중복). 필요 시 아래 명령어로 재생성:
  ```powershell
  npx bmad-method install --directory . --modules bmm --tools claude-code,codex --yes
  npx bmad-method install --directory . --custom-source https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise --tools claude-code,codex --action update --yes
  ```
- **`standardizeAddress` 오케스트레이션 통합 테스트** — 1~4차 폴백 순서 전체와 Gemini 프롬프트 동작(복수주소 선택 등)은 아직 통합 테스트 없음. 순수 함수 단위(문자열 파싱, 후보 선택)는 커버됨.
- **git 저장소 정리** — `orders.json`, `functions.zip`, `functions/node_modules` 히스토리 내 잔존 여부 및 재작성(BFG 등) 필요성 별도 논의.

## 백로그 (P2, 장기)

- **테넌트 내부 역할 분리** — 기사 계정이 `settings`/`driverAccounts` 등 민감 경로를 직접 쓰지 못하게 제한 (SEC-001은 테넌트 *간* 격리만 다룸, 테넌트 *내부* 역할 분리는 범위 밖).
- **평문 비밀번호 레거시 폴백 제거** — `functions/index.js`의 `issueDriverToken`에 남아있는 `driver.password === password` 폴백.
