/**
 * companion.ts — 컴패니언 기능: advise(세션 조언) / refine(요청문 다듬기)
 *
 * 프롬프트 원칙 (ARCHITECTURE.md):
 * - advise: 트랜스크립트 다이제스트(최근 텍스트 메시지 ~30개, 전체 8천자 내 절단)를 넣고
 *   ① 상황 한 줄 요약 ② 조언 1–2개 ③ 다른 관점 1개 ④ 구체화 질문 1–2개 구조의 한국어 답.
 *   말투는 비개발자 친화(전문용어엔 한 줄 설명).
 * - refine: 바로 고쳐 쓰지 말고 모호한 점을 1–2개 묻고, 충분히 명확해지면 최종 요청문을
 *   코드블록으로 제안하는 코치. --resume으로 연속 대화.
 */
import { runClaude, type ClaudeResult } from './claude.js';
import { parseTranscript, type TranscriptMessage } from './ccSessions.js';

const DIGEST_MAX_MESSAGES = 30;
const DIGEST_MAX_CHARS = 8000;

/** 최근 사용자/어시스턴트 텍스트 메시지 ~30개를 전체 8천자 내로 절단한 다이제스트 */
export function buildDigest(messages: TranscriptMessage[]): string {
  const recent = messages.slice(-DIGEST_MAX_MESSAGES);
  const lines = recent.map((m) => {
    const who = m.role === 'user' ? '사용자' : 'Claude';
    return `[${who}] ${m.text.trim()}`;
  });
  let digest = lines.join('\n\n');
  if (digest.length > DIGEST_MAX_CHARS) {
    // 최근 내용이 더 중요하므로 앞쪽을 잘라낸다
    digest = '…(앞부분 생략)…\n' + digest.slice(digest.length - DIGEST_MAX_CHARS);
  }
  return digest;
}

/** 진행 중인 Claude Code 세션을 읽고 조언 + 다른 관점 + 구체화 질문을 준다 */
export async function advise(
  transcriptPath: string,
  focus?: string
): Promise<{ advice: string; costUsd: number }> {
  const messages = await parseTranscript(transcriptPath);
  if (messages.length === 0) {
    throw new Error('세션 파일에서 대화 내용을 읽지 못했어요. 다른 세션을 선택해 보세요.');
  }
  const digest = buildDigest(messages);

  const focusPart =
    focus && focus.trim() !== ''
      ? `\n\n사용자가 특히 궁금해하는 점: ${focus.trim()}`
      : '';

  const prompt = [
    '당신은 코딩을 모르는 비개발자가 Claude Code를 잘 쓰도록 돕는 친절한 한국어 코치입니다.',
    '아래는 사용자가 진행 중인 Claude Code 세션의 최근 대화 내용입니다.',
    '',
    '--- 세션 대화 시작 ---',
    digest,
    '--- 세션 대화 끝 ---',
    focusPart,
    '',
    '다음 구조로 한국어로 답해 주세요:',
    '① 지금 상황 한 줄 요약',
    '② 조언 1–2개',
    '③ 다른 관점 1개',
    '④ 구체화 질문 1–2개 (사용자가 Claude에게 그대로 물어볼 수 있는 형태)',
    '',
    '말투는 비개발자 친화적으로, 전문용어가 나오면 한 줄 설명을 덧붙여 주세요.',
  ].join('\n');

  const result = await runClaude(prompt);
  return { advice: result.text, costUsd: result.costUsd };
}

const REFINE_SYSTEM = [
  '당신은 사용자가 Claude Code에 보낼 요청문을 같이 다듬는 한국어 코치입니다.',
  '규칙:',
  '- 요청문을 바로 고쳐 쓰지 마세요. 먼저 모호한 점을 1–2개만 물어보세요.',
  '- 대화를 통해 충분히 명확해지면, 그때 최종 요청문을 코드블록으로 제안하세요.',
  '- 말투는 코딩을 모르는 비개발자도 편한, 친절하고 짧은 한국어로.',
].join('\n');

/**
 * 보내기 전 요청문 다듬기 한 턴.
 * 첫 턴이면 시스템 지시 + 초안을 함께 보내고, 이후 턴은 --resume으로 이어간다.
 */
export async function refineTurn(
  draft: string,
  resumeClaudeSessionId: string | null
): Promise<ClaudeResult> {
  if (resumeClaudeSessionId) {
    return runClaude(draft, { resumeSessionId: resumeClaudeSessionId });
  }
  const prompt = [
    REFINE_SYSTEM,
    '',
    '사용자가 Claude Code에 보내려는 요청문 초안:',
    '"""',
    draft,
    '"""',
    '',
    '위 규칙대로 다듬기를 시작해 주세요.',
  ].join('\n');
  return runClaude(prompt);
}
