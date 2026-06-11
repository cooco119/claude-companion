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
import { runClaude } from './claude.js';
import { parseTranscript, type TranscriptMessage } from './ccSessions.js';

/** 다듬기 대화마다 함께 내려가는 안내 카드 데이터 (ARCHITECTURE.md의 Guidance) */
export type Guidance = {
  recommendedModel: string; // 'Haiku 4.5' | 'Sonnet 4.6' | 'Opus 4.8' | 'Fable 5'
  modelReason: string; // 한 줄, 비개발자 언어
  steps: Array<{ label: string; mode: 'plan' | 'execute' | 'checkpoint'; note?: string }>;
};

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
  '',
  '추가 규칙 — 매 턴(이번 답변 포함, 이후 모든 답변에서도) 답변 맨 끝에 아래 형식의 Guidance',
  '객체 하나를 ```json 펜스 코드블록으로 꼭 출력하세요. 작업이 아직 모호하더라도 현재까지의',
  '추정치로라도 출력해야 합니다. 형식:',
  '```json',
  '{',
  '  "recommendedModel": "Haiku 4.5 | Sonnet 4.6 | Opus 4.8 | Fable 5 중 하나",',
  '  "modelReason": "비개발자 언어로 한 줄 이유",',
  '  "steps": [',
  '    { "label": "단계 이름", "mode": "plan | execute | checkpoint", "note": "선택 메모" }',
  '  ]',
  '}',
  '```',
  '모델 추천은 다음 기준(triage 매트릭스)을 따르세요:',
  '- 경로가 정해진 짧은 일 → Sonnet 4.6 (아주 단순 반복 → Haiku 4.5)',
  '- 경로가 열린 짧은 일 → Sonnet 4.6 (막히면 Opus 4.8)',
  '- 경로가 정해진 긴 일 → Opus 4.8',
  '- 경로도 길이도 열린 긴 일 → Fable 5',
  'steps는 2~5개로 하고, 각 단계의 mode 의미:',
  "- 'plan': 플래닝 먼저 (🗺️ 실행 전에 계획부터 세우는 게 안전한 단계)",
  "- 'execute': 바로 실행 (⚡ 그냥 시키면 되는 단계)",
  "- 'checkpoint': 확인 후 진행 (✋ 결과를 사람이 확인하고 넘어가야 하는 단계)",
].join('\n');

/** refineTurn의 결과: 본문(reply)에서 Guidance JSON 블록을 떼어낸 깨끗한 응답 */
export interface RefineResult {
  reply: string;
  guidance?: Guidance;
  sessionId: string | null;
  costUsd: number;
}

/**
 * 응답 텍스트에서 Guidance JSON 블록을 추출·검증하고 본문에서 제거한다.
 * - ```json 펜스 블록 중 Guidance처럼 생긴 것(뒤에서부터 탐색)을 찾는다.
 * - 파싱/검증에 실패하면 guidance 없이 원문 그대로 돌려준다 (throw 금지).
 */
export function splitGuidance(text: string): { reply: string; guidance?: Guidance } {
  const fenceRe = /```json\s*([\s\S]*?)```/gi;
  const matches: Array<{ block: string; inner: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    matches.push({ block: m[0], inner: m[1], index: m.index });
  }
  // Guidance는 답변 끝에 붙으므로 마지막 블록부터 검사한다
  for (let i = matches.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(matches[i].inner.trim());
    } catch {
      continue;
    }
    const guidance = validateGuidance(parsed);
    if (!guidance) continue;
    // String.replace(문자열 검색)는 항상 '첫' 일치를 지우므로, 본문에 동일한 블록이
    // 예시로 한 번 더 있으면 엉뚱한 쪽이 지워진다 — 매치 위치(index)로 정확히 잘라낸다.
    const { block, index } = matches[i];
    const reply = (text.slice(0, index) + text.slice(index + block.length)).trim();
    return { reply, guidance };
  }
  return { reply: text.trim() };
}

/** Guidance 형태 검증. steps[].mode가 plan/execute/checkpoint 외 값이면 그 step은 버린다. */
function validateGuidance(value: unknown): Guidance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.recommendedModel !== 'string' || obj.recommendedModel.trim() === '') return null;
  if (typeof obj.modelReason !== 'string' || obj.modelReason.trim() === '') return null;
  if (!Array.isArray(obj.steps)) return null;

  const steps: Guidance['steps'] = [];
  for (const raw of obj.steps) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.label !== 'string' || s.label.trim() === '') continue;
    const mode = s.mode;
    if (mode !== 'plan' && mode !== 'execute' && mode !== 'checkpoint') continue; // 계약 외 mode → 버림
    const step: Guidance['steps'][number] = { label: s.label.trim(), mode };
    if (typeof s.note === 'string' && s.note.trim() !== '') step.note = s.note.trim();
    steps.push(step);
  }
  return {
    recommendedModel: obj.recommendedModel.trim(),
    modelReason: obj.modelReason.trim(),
    steps,
  };
}

/**
 * 보내기 전 요청문 다듬기 한 턴.
 * 첫 턴이면 시스템 지시 + 초안을 함께 보내고, 이후 턴은 --resume으로 이어간다.
 */
export async function refineTurn(
  draft: string,
  resumeClaudeSessionId: string | null
): Promise<RefineResult> {
  const result = resumeClaudeSessionId
    ? await runClaude(draft, { resumeSessionId: resumeClaudeSessionId })
    : await runClaude(
        [
          REFINE_SYSTEM,
          '',
          '사용자가 Claude Code에 보내려는 요청문 초안:',
          '"""',
          draft,
          '"""',
          '',
          '위 규칙대로 다듬기를 시작해 주세요.',
        ].join('\n')
      );
  // Guidance JSON 블록을 본문에서 떼어낸다 (reply에는 JSON이 남지 않게)
  const { reply, guidance } = splitGuidance(result.text);
  return { reply, guidance, sessionId: result.sessionId, costUsd: result.costUsd };
}
