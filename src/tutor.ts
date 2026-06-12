/**
 * tutor.ts — ❓ 물어보기 튜터 (POST /api/ask)
 *
 * 계약 (ARCHITECTURE.md "물어보기 튜터"):
 * - 시스템 지시: Claude Code 전담 튜터. 비개발자 언어 + 전문용어 한 줄 설명.
 *   Claude Code/이 앱 사용법 질문에 집중, 무관한 잡담은 claude.ai 안내.
 *   답 끝에 '직접 해보기' 한 줄. 레슨 제목 목록(lessons.ts)을 주입해 관련 레슨 안내.
 * - 첫 턴 프롬프트 = 시스템 지시 + (context가 있으면) "사용자가 지금 보던 화면: [source/title]
 *   내용: …(4000자 절단)" + (quote가 있으면) '사용자가 드래그한 부분: "…"' + 질문.
 * - 이후 턴은 --resume. 컨텍스트/인용은 매 턴 새로 올 수 있으므로 있으면 질문 앞에 붙인다.
 * - context.text는 서버에서 4000자로 절단한다 (클라이언트 절단을 믿지 않는다).
 */
import { runClaude, type ClaudeResult } from './claude.js';
import { listLessons } from './lessons.js';

/** 물어보기 패널이 함께 보내는 "지금 보고 계신 것" 컨텍스트 (ARCHITECTURE.md의 AskContext) */
export type AskContext = {
  source: string; // 사용자가 보던 화면: '배우기' | '새 소식' | '컴패니언' 등
  title?: string; // 예: 읽던 레슨 제목, 보던 소식 제목
  text: string; // 보던 내용 본문 (서버가 4000자로 절단)
};

/** context.text 서버 측 절단 상한 */
const CONTEXT_MAX_CHARS = 4000;

const TUTOR_SYSTEM = [
  '당신은 Claude Code 전담 튜터입니다. 규칙:',
  '- 코딩을 모르는 한국어 사용자를 돕습니다. 항상 비개발자 언어로, 전문용어가 나오면 한 줄 설명을 덧붙이세요.',
  '- Claude Code와 이 앱(claude-companion)의 사용법 질문에 집중하세요. 그와 무관한 잡담이 오면,',
  '  그런 이야기는 claude.ai 가 더 편하다고 부드럽게 안내해 주세요.',
  "- 답 끝에는 '직접 해보기' 한 줄을 붙이세요 — 터미널이나 이 앱에서 지금 바로 시도해 볼 수 있는 것 하나.",
].join('\n');

/** body로 들어온 context를 관대하게 검증한다. 형태가 안 맞으면 undefined (요청을 거절하지 않는다). */
export function coerceAskContext(value: unknown): AskContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.source !== 'string' || obj.source.trim() === '') return undefined;
  if (typeof obj.text !== 'string' || obj.text.trim() === '') return undefined;
  const context: AskContext = { source: obj.source.trim(), text: obj.text };
  if (typeof obj.title === 'string' && obj.title.trim() !== '') context.title = obj.title.trim();
  return context;
}

/**
 * 컨텍스트/인용을 질문 앞에 붙이는 블록 (없으면 빈 문자열).
 * context.text는 여기서 4000자로 절단한다.
 */
export function buildContextBlock(context?: AskContext, quote?: string): string {
  const parts: string[] = [];
  if (context) {
    const where = context.title ? `${context.source}/${context.title}` : context.source;
    const text =
      context.text.length > CONTEXT_MAX_CHARS
        ? context.text.slice(0, CONTEXT_MAX_CHARS) + '…(이하 생략)'
        : context.text;
    parts.push(`사용자가 지금 보던 화면: [${where}]`, `내용:\n${text}`);
  }
  if (quote && quote.trim() !== '') {
    parts.push(`사용자가 드래그한 부분: "${quote.trim()}"`);
  }
  return parts.join('\n\n');
}

/** 첫 턴 프롬프트: 시스템 지시(+레슨 제목 목록) + 컨텍스트 블록 + 질문 */
export function buildFirstTurnPrompt(
  question: string,
  lessonTitles: string[],
  context?: AskContext,
  quote?: string
): string {
  const lessonPart =
    lessonTitles.length > 0
      ? [
          '이 앱의 배우기 탭에는 아래 레슨들이 있습니다. 질문과 관련된 레슨이 있으면',
          '"배우기 탭의 「제목」 레슨도 읽어 보세요" 식으로 안내해 주세요:',
          ...lessonTitles.map((t) => `- ${t}`),
        ].join('\n')
      : '';
  const contextBlock = buildContextBlock(context, quote);
  return [TUTOR_SYSTEM, lessonPart, contextBlock, `사용자 질문:\n${question}`]
    .filter((part) => part !== '')
    .join('\n\n');
}

/** 이후 턴 프롬프트: 컨텍스트/인용이 새로 왔으면 질문 앞에 붙인다 (없으면 질문 그대로) */
export function buildResumePrompt(question: string, context?: AskContext, quote?: string): string {
  const contextBlock = buildContextBlock(context, quote);
  return contextBlock === '' ? question : `${contextBlock}\n\n사용자 질문:\n${question}`;
}

/**
 * 물어보기 한 턴.
 * 첫 턴이면 시스템 지시 + 레슨 제목 목록 + 컨텍스트 + 질문을 보내고, 이후 턴은 --resume.
 */
export async function askTurn(
  question: string,
  context: AskContext | undefined,
  quote: string | undefined,
  resumeClaudeSessionId: string | null
): Promise<ClaudeResult> {
  if (resumeClaudeSessionId) {
    return runClaude(buildResumePrompt(question, context, quote), {
      resumeSessionId: resumeClaudeSessionId,
    });
  }
  const lessons = await listLessons();
  const prompt = buildFirstTurnPrompt(
    question,
    lessons.map((l) => l.title),
    context,
    quote
  );
  return runClaude(prompt);
}
