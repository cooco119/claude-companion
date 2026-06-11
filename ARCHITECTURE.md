# claude-companion — 아키텍처 & 인터페이스 계약

> 빌드 에이전트 공용 계약. **여기 정의된 API/데이터 형태를 바꾸지 말 것** — 백엔드·프런트·문서가
> 병렬로 만들어지므로 이 파일이 단일 진실이다.

## 컨셉

코딩/agent를 모르는 비개발자가 Claude Code를 셀프서비스로 시작·학습·활용하게 돕는 로컬 웹앱.
- **배우기**: 비개발자 눈높이의 한국어 레슨 (마크다운, 앱 안에서 렌더)
- **채팅**: `claude -p` 기반 채팅 UI (세션 저장/이어가기)
- **컴패니언**: 진행 중인 Claude Code 세션을 읽고 조언/다른 관점/구체화 질문을 주거나,
  Claude에 보내기 전 요청문을 같이 다듬어 주는 코치

## 스택

- 백엔드: Node 22 + TypeScript + Express, `tsx`로 빌드 없이 실행 (`npm start`)
- 프런트: `public/`의 정적 vanilla HTML/CSS/JS (빌드 단계 없음 — 비개발자 설치 단순화)
  - 마크다운 렌더는 CDN의 `marked` 사용 (`https://cdn.jsdelivr.net/npm/marked/marked.min.js`)
- 포트: `3456` (환경변수 `PORT`로 변경 가능)
- 한국어 UI가 기본.

## `claude -p` 호출 규약 (src/claude.ts)

```
claude -p "<prompt>" --output-format json [--resume <sessionId>]
```
- `child_process.execFile('claude', [...])` 사용 (shell escaping 문제 회피), `maxBuffer` 넉넉히(64MB), timeout 240초.
- stdout JSON에서 쓰는 필드: `result`(답변 텍스트), `session_id`, `is_error`, `total_cost_usd`.
- `--resume <sessionId>`를 주면 같은 대화가 이어진다. 응답의 `session_id`는 매 턴 갱신될 수
  있으므로 **항상 최신 응답의 session_id를 저장**한다.
- 실패(비-0 exit, is_error, 파싱 실패) 시 사용자에게 보여줄 한국어 에러 메시지로 변환.
- 환경변수 `CLAUDE_MODEL`이 있으면 `--model <값>`을 덧붙인다 (기본은 CLI 기본 모델).

## 앱 자체 세션 저장 (src/store.ts)

`data/sessions.json` 하나에 저장 (MVP — DB 없음):
```ts
type ChatMessage = { role: 'user' | 'assistant'; text: string; at: string /* ISO */ };
type ChatSession = {
  id: string;            // 앱이 만드는 uuid
  title: string;         // 첫 사용자 메시지 앞 40자
  claudeSessionId: string | null; // claude -p의 session_id (resume용)
  messages: ChatMessage[];
  createdAt: string; updatedAt: string;
};
```

## Claude Code 세션 읽기 (src/ccSessions.ts)

- 위치: `~/.claude/projects/<인코딩된-프로젝트-경로>/<uuid>.jsonl`
- 각 줄은 JSON. 관심 줄: `type === 'user'`(사용자 메시지, `message.content`가 문자열 또는
  `{type:'text',text}` 배열)와 `type === 'assistant'`(`message.content` 배열에서 `type==='text'`
  항목). 그 외 줄(tool_use 등)은 건너뛴다. 파싱 안 되는 줄은 무시(throw 금지).
- 목록은 mtime 내림차순, 최근 30개. 미리보기 = 첫 사용자 메시지 앞 80자.

## HTTP API (src/server.ts가 조립)

| Method/Path | Body | 응답 |
|---|---|---|
| `GET /api/health` | - | `{ ok: true, claudeCli: boolean }` (claude CLI 존재 여부) |
| `POST /api/chat` | `{ message: string, sessionId?: string }` | `{ reply: string, sessionId: string, costUsd: number }` — sessionId는 **앱** 세션 id. 없으면 새 세션 생성 |
| `GET /api/sessions` | - | `{ sessions: Array<{id,title,updatedAt,messageCount}> }` |
| `GET /api/sessions/:id` | - | `ChatSession` (404 가능) |
| `GET /api/lessons` | - | `{ lessons: Array<{slug,title,order}> }` — `docs/learn/*.md`의 frontmatter 없이 첫 `# 제목`과 파일명 `NN-slug.md`의 NN을 order로 |
| `GET /api/lessons/:slug` | - | `{ slug, title, markdown }` |
| `GET /api/cc-sessions` | - | `{ sessions: Array<{path /* 절대경로 */, project, file, mtime, preview}> }` |
| `POST /api/companion/advise` | `{ transcriptPath: string, focus?: string }` | `{ advice: string, costUsd: number }` — 세션을 읽고 조언+다른 관점+구체화 질문 |
| `POST /api/companion/refine` | `{ draft: string, sessionId?: string }` | `{ reply: string, sessionId: string, costUsd: number }` — 보내기 전 다듬기 대화 (앱 세션으로 저장, title 앞에 `[다듬기] `) |

에러는 모두 `{ error: string }` (한국어) + 적절한 status.

### 컴패니언 프롬프트 원칙 (src/companion.ts)

advise: 트랜스크립트 다이제스트(최근 사용자/어시스턴트 텍스트 메시지 ~30개, 전체 8천자 내 절단)를
넣고, 다음 구조의 한국어 답을 요구: ① 지금 상황 한 줄 요약 ② 조언 1–2개 ③ 다른 관점 1개
④ 구체화 질문 1–2개. 말투는 비개발자 친화(전문용어엔 한 줄 설명).

refine: "사용자가 Claude Code에 보낼 요청문을 같이 다듬는 코치. 바로 고쳐 쓰지 말고, 모호한 점을
1–2개 물어보고, 충분히 명확해지면 최종 요청문을 코드블록으로 제안" 시스템 지시 + `--resume` 연속 대화.

## 프런트 (public/)

- `index.html` + `style.css` + `app.js` (vanilla JS, 모듈 없이 단일 파일 OK)
- 좌측 사이드바 탭 3개: **🎓 배우기 / 💬 채팅 / 🧭 컴패니언**
- 배우기: 레슨 목록 → 클릭 시 marked로 렌더
- 채팅: 세션 목록 + 새 채팅, 메시지 전송 중 "생각 중…" 표시 (응답이 수십 초 걸릴 수 있음을 UI에 명시)
- 컴패니언: (a) CC 세션 목록에서 선택 → "조언 받기" (+선택적 focus 입력), (b) "보내기 전 다듬기"
  텍스트영역 → 대화형으로 다듬기
- 디자인: 따뜻하고 단순하게. 시스템 폰트, 큰 글자, 버튼에 라벨 명확히. 다크모드 불필요.

## 파일 소유권 (병렬 빌드 충돌 방지)

- 백엔드 에이전트: `src/**` 만
- 프런트 에이전트: `public/**` 만
- 콘텐츠 에이전트: `README.md`, `docs/**` 만
- `package.json`/`tsconfig.json`/이 파일: 고정 (수정 금지; 의존성 추가 필요하면 결과 보고에 적기)
