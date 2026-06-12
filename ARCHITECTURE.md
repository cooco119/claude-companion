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
- **앱 자신의 세션 제외**: 이 앱이 띄우는 claude -p 호출(물어보기/다듬기/조언/소식)도 서버 cwd의
  프로젝트 디렉터리에 세션을 만들므로, cwd 인코딩 디렉터리는 목록에서 제외한다.

## HTTP API (src/server.ts가 조립)

| Method/Path | Body | 응답 |
|---|---|---|
| `GET /api/health` | - | `{ ok: true, claudeCli: boolean }` (claude CLI 존재 여부) |
| `POST /api/ask` | `{ question: string, context?: AskContext, quote?: string, sessionId?: string }` | `{ reply: string, sessionId: string, costUsd: number }` — **물어보기(튜터)**. sessionId는 앱 세션 id, title 앞에 `[물어보기] ` |
| `GET /api/sessions` | - | `{ sessions: Array<{id,title,updatedAt,messageCount}> }` |
| `GET /api/sessions/:id` | - | `ChatSession` (404 가능) |
| `GET /api/lessons` | - | `{ lessons: Array<{slug,title,order}> }` — `docs/learn/*.md`의 frontmatter 없이 첫 `# 제목`과 파일명 `NN-slug.md`의 NN을 order로 |
| `GET /api/lessons/:slug` | - | `{ slug, title, markdown }` |
| `GET /api/cc-sessions` | - | `{ sessions: Array<{path /* 절대경로 */, project, file, mtime, preview}> }` |
| `POST /api/companion/advise` | `{ transcriptPath: string, focus?: string }` | `{ advice: string, costUsd: number }` — 세션을 읽고 조언+다른 관점+구체화 질문 |
| `POST /api/companion/refine` | `{ draft: string, sessionId?: string }` | `{ reply: string, sessionId: string, costUsd: number, guidance?: Guidance }` — 보내기 전 다듬기 대화 (앱 세션으로 저장, title 앞에 `[다듬기] `) |
| `POST /api/companion/feedback` | `{ transcriptPath: string }` | `{ report: string /* markdown */, costUsd: number }` — 선택한 CC 세션 회고 → "어떻게 더 잘 쓸지" 피드백 리포트 |
| `GET /api/companion/news` | - | `{ items: NewsItem[], fetchedAt: string \| null, refreshing: boolean, lastError?: string \| null }` — 캐시 즉시 반환; 캐시가 없거나 6시간 지났으면 백그라운드 갱신 시작 후 `refreshing:true` |

**제거된 API (v0.2 IA 개편):** `POST /api/chat`(물어보기 `/api/ask`로 대체), `POST /api/companion/news/ask`(FAB 물어보기가 소식 맥락을 흡수). 라우트와 관련 코드를 삭제한다.

```ts
type AskContext = {
  source: string;   // 사용자가 보던 화면: '배우기' | '새 소식' | '컴패니언' 등
  title?: string;   // 예: 읽던 레슨 제목, 보던 소식 제목
  text: string;     // 보던 내용 본문 (서버가 4000자로 절단)
};
type NewsItem = {
  title: string;       // 한국어 제목 (원문이 영어면 번역)
  summary: string;     // 2-3문장 한국어 요약
  whyGood: string;     // "이게 왜 좋은가/나에게 무슨 의미인가" 한 줄
  url: string;         // 출처 링크
  source: string;      // 예: 'Anthropic 블로그', 'Claude Docs', 'Hacker News', 'X(@karpathy)'
};
type Guidance = {
  recommendedModel: string;            // 'Haiku 4.5' | 'Sonnet 4.6' | 'Opus 4.8' | 'Fable 5'
  modelReason: string;                 // 한 줄, 비개발자 언어
  steps: Array<{ label: string; mode: 'plan' | 'execute' | 'checkpoint'; note?: string }>;
};
```

### 뉴스 캐시/갱신 (src/news.ts)

- 캐시: `data/news.json` = `{ fetchedAt: ISO, items: NewsItem[] }`. TTL 6시간.
- 갱신: `claude -p` 호출에 `--allowedTools WebSearch` 를 붙여 (claude.ts에 extraArgs 옵션 추가)
  Claude 공식 docs 변경/Anthropic 블로그/X의 @karpathy/Hacker News 등에서 **최근 Claude·
  Claude Code 소식, 좋은 사용 패턴, 새로운 하네스/루프 디자인**을 검색·큐레이션해 NewsItem[]
  5~8개를 **fenced JSON 코드블록**으로 출력하게 한다. 서버는 응답에서 첫 JSON 블록을 관대하게
  추출·검증(필수 필드 누락 항목은 버림)하고 캐시에 저장.
- 동시 갱신 방지: 모듈 레벨 in-flight 플래그 (갱신 중 재요청은 무시). 갱신 실패 시 기존 캐시 유지.

### 다듬기 guidance (src/companion.ts 확장)

refine 시스템 지시에 추가: 매 턴 답변 끝에 ```json 펜스로 Guidance 객체를 출력하게 한다 —
작업이 아직 모호하면 현재 추정치로라도. 서버는 이 블록을 **본문에서 떼어내** `guidance` 필드로
반환한다(reply에는 JSON이 남지 않게). 모델 추천은 fablicator triage 매트릭스를 따른다:
  - 경로가 정해진 짧은 일 → Sonnet 4.6 (아주 단순 반복 → Haiku 4.5)
  - 경로가 열린 짧은 일 → Sonnet 4.6 (막히면 Opus 4.8)
  - 경로가 정해진 긴 일 → Opus 4.8
  - 경로도 길이도 열린 긴 일 → Fable 5
steps는 2~5개, 각각 mode: 'plan'(플래닝 먼저 🗺️) / 'execute'(바로 실행 ⚡) / 'checkpoint'(확인 후 진행 ✋).

에러는 모두 `{ error: string }` (한국어) + 적절한 status.

### 컴패니언 프롬프트 원칙 (src/companion.ts)

advise: 트랜스크립트 다이제스트(최근 사용자/어시스턴트 텍스트 메시지 ~30개, 전체 8천자 내 절단)를
넣고, 다음 구조의 한국어 답을 요구: ① 지금 상황 한 줄 요약 ② 조언 1–2개 ③ 다른 관점 1개
④ 구체화 질문 1–2개. 말투는 비개발자 친화(전문용어엔 한 줄 설명).

refine: "사용자가 Claude Code에 보낼 요청문을 같이 다듬는 코치. 바로 고쳐 쓰지 말고, 모호한 점을
1–2개 물어보고, 충분히 명확해지면 최종 요청문을 코드블록으로 제안" 시스템 지시 + `--resume` 연속 대화.

feedback: 같은 다이제스트를 쓰되 **회고 리포트** — 따뜻하고 비판적이지 않은 한국어 마크다운으로:
① 이 세션 한 줄 요약 ② 잘하신 점 2–3개 ③ 더 잘 쓰는 법 3–5개 (각 항목: 왜 + **"그때 이렇게
말해보세요"** 식 고쳐 쓴 예시 인용) ④ 추천 레슨 1–2개 (01~11 제목을 프롬프트에 주입, 앱의 배우기
탭 안내) ⑤ 한 줄 격려. 일회성 호출(세션 저장 안 함).

### 물어보기 튜터 (src/tutor.ts)

시스템 지시: "Claude Code 전담 튜터. 코딩을 모르는 한국어 사용자에게 비개발자 언어로, 전문용어엔
한 줄 설명. Claude Code/이 앱 사용법 질문에 집중하고, 무관한 잡담은 claude.ai가 더 편하다고 부드럽게
안내. 답 끝에 '직접 해보기' 한 줄(터미널이나 앱에서 바로 시도할 것)을 붙인다." 레슨 제목 목록
(lessons.ts에서)을 주입해 관련 레슨을 안내할 수 있게 한다.
첫 턴 프롬프트 = 시스템 지시 + (context가 있으면) "사용자가 지금 보던 화면: [source/title]\n내용:
…(4000자 절단)" + (quote가 있으면) "사용자가 드래그한 부분: \"…\"" + 질문. 이후 턴은 `--resume`
(컨텍스트/인용은 매 턴 새로 올 수 있으므로 있으면 질문 앞에 붙인다).

## 프런트 (public/) — v0.2 IA

- `index.html` + `style.css` + `app.js` (vanilla JS, 모듈 없이 단일 파일 OK)
- 좌측 사이드바 탭 3개: **🎓 배우기 / 📰 새 소식 / 🧭 컴패니언** (채팅 탭 삭제)
- 배우기: 레슨 목록 → 클릭 시 marked로 렌더 (기존 그대로)
- 새 소식 (독립 탭): GET news 즉시 렌더 (refreshing이면 "새 소식 가져오는 중…" 배너 + 10초 폴링
  최대 5분, 탭 이탈 시 중단), 카드마다 제목/요약/whyGood 강조/출처 링크, lastError 시 안내.
  **별도 Q&A 입력은 없다** — 소식에 대한 질문은 FAB 물어보기가 흡수.
- 컴패니언 (코치 데스크, **좌우 스플릿** — 넓은 화면 2열, 좁으면 세로 스택):
  - (좌) **진행 중인 작업**: CC 세션 목록 → 선택 후 버튼 2개 — "조언 받기"(+선택적 focus)와
    **"피드백 리포트 받기"**(companion/feedback, 결과 마크다운 렌더 — 1~2분 걸릴 수 있다는 안내).
  - (우) **보내기 전 다듬기**: 기존 다듬기 대화 + guidance 렌더(모델 추천 카드 + 단계 타임라인
    배지: 🗺️ 플래닝 먼저 / ⚡ 바로 실행 / ✋ 확인 후 진행).
- **❓ 물어보기 FAB**: 모든 화면 우하단 고정 플로팅 버튼 → 우측 슬라이드 패널(오버레이).
  - 패널 상단에 "지금 보고 계신 것" 컨텍스트 칩: 현재 탭에서 열려 있는 것(읽던 레슨 제목+본문,
    보던 소식 카드들 제목+요약, 컴패니언이면 선택 세션/다듬기 초안)을 자동 수집해 AskContext로
    동봉. 칩의 × 로 컨텍스트 제외 가능. 수집 텍스트는 클라이언트에서도 4000자 절단.
  - 대화는 POST /api/ask, sessionId 유지, "새 대화" 버튼. 응답 marked+DOMPurify 렌더.
  - **드래그 질문**: 앱 콘텐츠 영역에서 텍스트 선택 시 선택 근처에 "❓ 이 부분 물어보기" 칩 표시
    (selectionchange + 디바운스) → 클릭하면 패널이 열리고 선택 텍스트가 quote로 인용 표시·전송됨.
    입력창/버튼 안의 선택, 빈 선택, 패널 내부 선택에는 칩을 띄우지 않는다.
- 디자인: 따뜻하고 단순하게. 시스템 폰트, 큰 글자, 버튼에 라벨 명확히. 다크모드 불필요.
- 디자인: 따뜻하고 단순하게. 시스템 폰트, 큰 글자, 버튼에 라벨 명확히. 다크모드 불필요.

## 파일 소유권 (병렬 빌드 충돌 방지)

- 백엔드 에이전트: `src/**` 만
- 프런트 에이전트: `public/**` 만
- 콘텐츠 에이전트: `README.md`, `docs/**` 만
- `package.json`/`tsconfig.json`/이 파일: 고정 (수정 금지; 의존성 추가 필요하면 결과 보고에 적기)
