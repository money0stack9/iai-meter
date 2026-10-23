# iAI Meter

0G Router 계정의 크레딧과 사용량을 **읽기 전용**으로 보여주는 도구입니다. 로컬 CLI, HTTP 위젯, MCP 서버로 실행할 수 있습니다.

> **고지:** 이 프로젝트는 0G, OpenAI, Anthropic의 공식 제품이 아닙니다. 사용자 제품 코드는 모두 0G `claude-opus-5.5`(standard)로 작성했습니다. Codex는 계획 수립, 변경 적용, 테스트 실행을 맡았습니다.

## 기능

- **여러 계정을 읽기 전용으로 조회**합니다. 정확한 크레딧과 사용량을 보여 줍니다. 조회 함수(getter)는 추론 호출이나 결제를 절대 발생시키지 않습니다.
- **일일 리셋 시각은 UTC 00:00(KST 09:00)**입니다. 일일 카운트는 Router가 제공하는 값만 사용합니다. 존재하지 않는 무료 한도(allowance)를 임의로 만들지 않습니다.
- **잔액은 두 가지로 표시**합니다.
  - 보고된 크레딧(reported)
  - 보수적 잔액(conservative): 보고값에서 pending과 알려진 미정산액을 뺀 값
  - 미정산 여부를 알 수 없으면(unsettled unknown) 실제 잔액이 더 낮을 수 있다고 표시합니다.
- **합계는 현재 검증된 계정만 더합니다.** 조회에 실패한 계정은 0으로 계산하지 않고 합계에서 제외합니다. 계정 수는 `accountCount`(전체), `balanceAccountCount`(잔액 반영), `usageAccountCount`(사용량 반영)로 표시됩니다.
- **중복을 거부합니다.** 같은 계정 ID나 동일한 키가 있으면 설정을 받아들이지 않습니다. 단, 서로 다른 키로 등록한 같은 계정은 감지할 수 없습니다.
- **갱신 주기**는 다음과 같습니다.
  - 데이터: 60초마다 폴링
  - 모델 목록: 10분마다 갱신
  - 리셋 카운트다운: 1초마다 갱신
- **토큰 추정치**는 계정별로 가정한 입력 비용을 잔액에서 먼저 뺀 뒤, 남은 금액을 선택한 모델의 **출력** 단가로 나눈 값입니다. 할당량(quota)이 아닙니다.
- **통화와 가격:** 0G 백엔드 원본 값은 마이크로 USD(1 USD = 1,000,000) 단위입니다. 이 도구의 UI와 API는 이를 소수점 6자리 USD 문자열(예: `"5.000000"`)로 정규화해 보여 줍니다. 모델과 가격 정보는 0G가 제공하는 가격 정보를 따릅니다.
- 공개 코드에는 어떤 자격 증명도 들어 있지 않습니다.

## 설치

Node.js 22 이상이 필요합니다. 가능하면 현재 LTS 버전을 권장합니다.

```bash
npm ci        # lockfile 기준으로 의존성 설치
npm test      # 테스트 실행
npm run demo  # 가짜 데이터로 데모 서버 실행
```

데모 주소는 http://127.0.0.1:8787/widget 입니다. 데모의 모든 값은 **명백한 가짜(DEMO) 데이터**이며, 화면에도 데모임이 표시됩니다.

## 실제 계정으로 사용

1. `.env.example`을 `.env`로 복사합니다. 그런 다음 편집기로 `.env`를 열어 키를 입력합니다.
   - 실제 키를 명령줄에 직접 입력하지 마세요. 셸 기록에 남습니다.
   - `.env`는 git 추적에서 제외됩니다(`.gitignore`).
   - `.env`는 본인만 읽을 수 있게 둡니다. macOS/Linux: `chmod 600 .env`, Windows: 파일 권한을 소유자 계정만 접근하도록 설정합니다.

```bash
cp .env.example .env   # 템플릿 복사(값은 비어 있음)
```

2. 상태를 한 번 조회합니다.

```bash
node --env-file=.env src/cli.js status --json   # 현재 상태를 JSON으로 출력
```

`--config`를 지정하지 않으면 기본 설정으로 `IAI_MANAGEMENT_KEY` 하나를 읽습니다. 여기에 넣는 키는 `account:read` 권한의 **관리(management) 키**입니다. 추론(inference) 키는 넣지 마세요.

### 여러 계정

`config/accounts.example.json`의 형식은 다음과 같습니다.

```json
{
  "accounts": [
    { "id": "a", "label": "Account A", "keyEnv": "IAI_ACCOUNT_A_KEY" },
    { "id": "b", "label": "Account B", "keyEnv": "IAI_ACCOUNT_B_KEY" }
  ]
}
```

키는 설정 파일에 넣지 않습니다. `.env`의 `IAI_ACCOUNT_A_KEY`, `IAI_ACCOUNT_B_KEY`에 입력하고, 설정 파일에는 환경 변수 이름(`keyEnv`)만 적습니다.

### 명령

`--env-file`은 Node 플래그이므로 `src/cli.js` **앞**에 둡니다. `--config`, `--json` 같은 앱 옵션은 `src/cli.js`와 명령 **뒤**에 붙입니다.

```bash
# 상태 1회 조회
node --env-file=.env src/cli.js status --config config/accounts.example.json --json
# 로컬 HTTP 서버와 위젯 실행
node --env-file=.env src/cli.js serve --config config/accounts.example.json
# 로컬 MCP 서버 실행
node --env-file=.env src/cli.js mcp --config config/accounts.example.json
# 가짜 데이터 데모 실행
node src/cli.js demo
```

- 유효한 명령은 `status`, `demo`, `serve`, `mcp`입니다.
- 키가 없는 계정은 `unconfigured`로 표시되며, `status`는 종료 코드 1로 끝납니다.
- `--config`를 지정하지 않으면 기본 설정을 사용합니다. 지정한 파일이 없거나 잘못되면 `invalid_config` 오류로 종료합니다. 데모 모드로 대체 실행하지 않습니다.

**선택: 자체 호스팅 실행 도우미.** `scripts/run-with-credentials.py`는 본인 소유·권한 600·심볼릭 링크가 아닌 JSON 파일(`{"별칭": {"management_key": "..."}}`)에서 관리 키만 읽고, 매핑 파일(`{"IAI_ACCOUNT_A_KEY": "별칭"}`)에 따라 자식 프로세스 환경 변수로만 전달합니다. 예: `python3 scripts/run-with-credentials.py --credentials-file <비공개파일> --mapping-file <매핑> --node <node 절대경로> --app <저장소 절대경로> --config <설정 절대경로> --mode serve`. 개인 서비스 설정(launchd, systemd 등)에서 호출할 수 있지만, 특정 플랫폼 연동은 검증되지 않았습니다.

### HTTP 엔드포인트

| 메서드 | 경로 | 용도 |
|---|---|---|
| GET | `/api/v1/status` | 계정 상태와 합계 |
| GET | `/api/v1/models` | 모델과 가격 |
| GET | `/healthz` | 헬스 체크 |
| GET | `/widget` | 위젯 UI |
| POST | `/mcp` | MCP 엔드포인트 |

**보안:** 서버는 루프백(127.0.0.1)에만 바인딩합니다. Host와 Origin 헤더를 엄격하게 검사하며 CORS를 허용하지 않습니다. 내장 서버는 **OAuth를 구현하지 않습니다.**

### API 응답 예시

아래는 정규화된 응답의 **발췌**입니다(`accounts`와 일부 필드는 생략). 실제 계정 데이터는 포함하지 않았습니다. 전체 필드는 `status --json` 출력을 기준으로 확인하세요.

```json
{
  "schema": "iai-meter.portfolio.v1",
  "state": "partial",
  "creditDayUtc": "2026-10-23",
  "resetsAt": "2026-10-24T00:00:00.000Z",
  "accountCount": 2,
  "balanceAccountCount": 1,
  "usageAccountCount": 0,
  "totals": {
    "reportedCreditUsd": "5.000000",
    "conservativeAvailableUsd": "4.800000",
    "costUsd": null,
    "totalTokens": null
  }
}
```

합계에 반영할 계정이 없는 항목은 `0`이 아니라 `null`입니다. 제외된 계정 행은 마지막으로 확인된 스냅샷을 유지할 수 있으며, 행 전체를 `null`로 만들지 않고 합계 제외 플래그로 구분합니다.

## Claude Desktop(로컬 MCP)

`config/claude-desktop.example.json`을 참고합니다. `/ABS/PATH`는 저장소의 절대 경로로 바꿉니다.

```json
{
  "mcpServers": {
    "iai-meter": {
      "command": "node",
      "args": ["--env-file=/ABS/PATH/.env", "/ABS/PATH/src/cli.js", "mcp", "--config", "/ABS/PATH/config/accounts.example.json"]
    }
  }
}
```

- **Windows:** 절대 경로를 쓰고, JSON 안의 백슬래시는 이스케이프합니다. 예: `"C:\\ABS\\PATH\\.env"`
- GUI 앱은 셸의 PATH를 상속하지 않을 수 있습니다. 이 경우 `command`에 node 실행 파일의 절대 경로가 필요할 수 있습니다.
- **Claude Code(선택):** 공식 Claude Code 문서의 MCP 설정 안내를 따르세요. 이 문서에서는 별도 플래그를 안내하지 않습니다.
- **카드형 UI:** 카드 UI가 표시되는지는 호스트의 MCP Apps 지원 여부에 따라 다릅니다.

## ChatGPT(웹)

- ChatGPT 웹에서 원격 MCP를 쓰려면 HTTPS와, 지원되는 OAuth 또는 인증 게이트웨이가 필요합니다. v0.1에는 이 기능이 포함되어 있지 않습니다.
- 인증 없는 개인 API나 터널을 **절대 공개하지 마세요.**
- 실제 앱 연결은 아직 검증되지 않았습니다.
- GitHub에 공개하는 것은 플러그인 디렉터리 승인을 받는 것과 다릅니다.

## 웹사이트 임베드

- 같은 출처(same-origin)의 iframe으로 임베드합니다: `<iframe src="/widget"></iframe>`
- 원격에서 제공할 때는 서버 측에 인증된 게이트웨이를 두어야 합니다.
- localhost iframe을 아무 사이트에나 붙여 넣는 방식으로는 동작하지 않습니다.
- 키는 브라우저나 URL에 절대 노출하지 않습니다.
- HTTPS 프록시 뒤에서 운영하려면 Host/Origin을 신뢰할 수 있도록 올바르게 설정해야 합니다.
- 이 문서는 인증 문제가 해결된 것처럼 보이는 프로덕션 배포 방법을 제공하지 않습니다.

## 참고 자료

- https://developers.openai.com/plugins/build/app-quickstart
- https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/
- https://0gfoundation.github.io/0g-router/
- https://0g.ai/blog/introducing-infinite-ai

## 라이선스

MIT. 자세한 내용은 [LICENSE](LICENSE)를 참고하세요.
