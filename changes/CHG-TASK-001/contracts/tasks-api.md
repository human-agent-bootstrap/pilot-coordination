# Task Board API v1 — CHG-TASK-001

이 문서는 실습용 계약 제안이다. Root 계획 PR에 포함해 사람이 내용을 확인하고 병합한 후에만 승인 계약이 된다.

## 참여 서비스와 실행 환경

- Provider: pilot-back (FastAPI + SQLite)
- Consumer: pilot-front (React + TypeScript + Vite)
- Backend origin: http://127.0.0.1:8000
- Frontend origin: http://127.0.0.1:5173
- Frontend 실행 명령: npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
- Backend 실행 명령: uv run --locked uvicorn app.main:app --host 127.0.0.1 --port 8000
- Frontend API origin 환경 변수: VITE_API_BASE_URL; 실습 기본값 http://127.0.0.1:8000
- Backend DB 경로 환경 변수: TASK_DB_PATH; 기본값 ./data/tasks.sqlite3
- 런타임 버전: Node.js 26, Python 3.12. Backend는 uv로 pyproject.toml과 uv.lock을 관리한다.
- 인증, 쿠키, 운영 데이터, DELETE/PATCH API는 이번 Change 범위가 아니다.

## 공통 데이터

Task 객체에는 다음 필드만 존재한다.

```json
{"id":1,"title":"첫 작업","status":"open"}
```

- id: 서버가 생성하는 양의 정수. DB에 저장하며 반복 조회 시 같은 값을 유지한다.
- title: 문자열. 앞뒤 U+0020(space), U+0009(tab), U+000A(LF), U+000D(CR)를 제거한 뒤 Unicode code point 기준 1~100자.
- status: 이번 Change에서는 문자열 open만 사용한다. 완료 처리 상태는 다음 Change에서 추가한다.
- HTTP JSON 요청/응답의 Content-Type은 application/json이다.
- 목록은 id 오름차순으로 반환한다. 등록한 작업은 SQLite에 저장되어 페이지 새로고침 및 backend 재시작 후 유지된다.

## GET /api/tasks

- 요청 body와 query parameter는 사용하지 않는다.
- 성공 status: 200.
- 성공 body에는 items 필드만 있고 Task 배열을 담는다.

```json
{"items":[{"id":1,"title":"첫 작업","status":"open"}]}
```

빈 목록:

```json
{"items":[]}
```

## POST /api/tasks

요청은 title 필드 하나만 포함한다.

```json
{"title":" 첫 작업 "}
```

성공 status: 201. 정규화한 title과 생성한 Task를 반환한다.

```json
{"id":1,"title":"첫 작업","status":"open"}
```

누락된 title, 문자열이 아닌 title, 정규화 후 빈 title, 100자를 초과한 title, 추가 필드, 파싱 불가능한 JSON은 저장하지 않고 아래 오류를 반환한다.

- status: 422.
- body:

```json
{"error":{"code":"INVALID_REQUEST","message":"제목은 공백을 제외한 1~100자 문자열이어야 합니다."}}
```

DB 저장/조회 실패 등 서버 내부 오류:

- status: 500.
- body:

```json
{"error":{"code":"INTERNAL_ERROR","message":"작업을 처리하지 못했습니다."}}
```

내부 DB 경로와 상세 exception은 응답에 노출하지 않는다. 지원하지 않는 경로와 method의 기본 404/405는 제품 흐름에 포함하지 않는다.

## CORS

- 허용 origin: http://127.0.0.1:5173.
- 허용 method: GET, POST, OPTIONS.
- 허용 request header: Content-Type.
- credentials는 사용하지 않는다.
- localhost와 127.0.0.1은 다른 origin이므로 실습에서는 위 주소를 그대로 사용한다.
- 허용 origin의 OPTIONS preflight와 실제 요청에 대해 브라우저가 응답을 읽을 수 있어야 한다.
- 허용하지 않은 origin에는 Access-Control-Allow-Origin을 반환하지 않는다.

## Frontend 동작

- 화면을 열면 실제 GET 요청으로 목록을 표시한다. 빈 목록 안내를 표시한다.
- 사용자가 등록 버튼을 누르면 POST 요청하고, 정확한 201 status 및 Task 객체를 런타임 검증한다.
- 등록 성공 후 입력을 비우고 GET으로 목록을 다시 읽는다. POST가 실패하면 입력을 유지한다.
- 공백 입력을 제출할 수 있으며 backend의 422 오류를 화면에 표시한다. 성공 안내와 새 목록 항목을 만들지 않는다.
- 요청 중 중복 등록 버튼을 비활성화한다.
- 422는 계약의 오류 메시지를 표시한다. 연결 실패/500은 작업을 처리하지 못했다고 표시한다.
- 200/201이더라도 JSON 구조가 계약과 다르면 오류로 처리하며 성공으로 표시하지 않는다.
- 오류와 상태 안내는 aria-live 영역 또는 role=alert로 접근 가능하게 표시한다.
- mock/fixture는 이 계약에서 만들며 실제 Candidate 검증에서는 mock을 사용하지 않는다.

## 검증

- Backend: 등록/조회, SQLite 재시작 지속성, 모든 422 사례, 500 실패 처리, CORS preflight, 실제 OpenAPI가 계약에 명시된 요청/응답/status/schema를 설명하는지 검사한다.
- Frontend: 계약 fixture를 사용한 목록/등록/422/연결 실패/잘못된 성공 응답 테스트와 lint/typecheck/build.
- Candidate: 실제 브라우저로 두 서비스를 연결해 등록·새로고침·오류 안내를 검증한다. 두 서비스의 정확한 merge SHA를 증거에 기록한다.
- 이 파일은 Markdown 계약이므로 /openapi.json 전체 문서와 byte-for-byte 같다는 요구는 없다. 구현자는 이 문서의 전체 API 의미와 실제 OpenAPI/runtime의 일치를 검증한다.
