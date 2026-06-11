/**
 * claude.ts — `claude -p` CLI 호출 래퍼
 *
 * 계약 (ARCHITECTURE.md):
 *   claude -p "<prompt>" --output-format json [--resume <sessionId>] [--model <CLAUDE_MODEL>]
 *   - execFile 사용 (shell escaping 회피), maxBuffer 64MB, timeout 240초
 *   - stdout JSON에서 result / session_id / is_error / total_cost_usd 사용
 *   - 실패 시 사용자에게 보여줄 한국어 에러로 변환
 */
import { execFile } from 'node:child_process';

const MAX_BUFFER = 64 * 1024 * 1024; // 64MB
const TIMEOUT_MS = 240_000; // 240초

export interface ClaudeResult {
  /** 답변 텍스트 */
  text: string;
  /** claude -p가 돌려준 session_id (매 턴 갱신될 수 있으므로 항상 최신 값을 저장할 것) */
  sessionId: string | null;
  /** 이번 호출 비용(USD) */
  costUsd: number;
}

/** 사용자에게 그대로 보여줄 수 있는 한국어 메시지를 가진 에러 */
export class ClaudeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeError';
  }
}

/** claude CLI가 설치되어 있는지 확인 (health check용) */
export function isClaudeCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 15_000 }, (err) => resolve(!err));
  });
}

interface RunOptions {
  /** 이전 대화를 이어갈 claude session_id */
  resumeSessionId?: string | null;
}

/**
 * claude -p 호출. 성공 시 ClaudeResult, 실패 시 한국어 메시지의 ClaudeError로 reject.
 *
 * 프롬프트는 argv가 아닌 stdin으로 전달한다:
 * - '-'로 시작하는 메시지(예: "--help가 뭐예요")가 CLI 플래그로 오인되는 것을 방지
 * - Linux 단일 argv 한계(MAX_ARG_STRLEN=128KiB)를 넘는 긴 메시지의 E2BIG 실패 방지
 */
export function runClaude(prompt: string, options: RunOptions = {}): Promise<ClaudeResult> {
  const args = ['-p', '--output-format', 'json'];
  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  }
  const model = process.env.CLAUDE_MODEL;
  if (model && model.trim() !== '') {
    args.push('--model', model.trim());
  }

  return new Promise<ClaudeResult>((resolve, reject) => {
    const child = execFile(
      'claude',
      args,
      { maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS },
      (err, stdout, stderr) => {
        // CLI 자체를 찾을 수 없음
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new ClaudeError(
              'claude 명령을 찾을 수 없어요. Claude Code CLI가 설치되어 있는지 확인해 주세요. (설치: npm install -g @anthropic-ai/claude-code)'
            )
          );
          return;
        }
        // 시간 초과로 강제 종료됨
        if (err && (err as { killed?: boolean }).killed) {
          reject(
            new ClaudeError(
              '응답을 기다리다 시간이 초과됐어요(4분). 요청을 조금 짧게 나눠서 다시 시도해 주세요.'
            )
          );
          return;
        }

        // 비-0 exit여도 stdout에 JSON이 있을 수 있으므로 먼저 파싱을 시도
        let parsed: unknown = null;
        if (typeof stdout === 'string' && stdout.trim() !== '') {
          try {
            parsed = JSON.parse(stdout);
          } catch {
            parsed = null;
          }
        }

        if (parsed && typeof parsed === 'object') {
          const obj = parsed as Record<string, unknown>;
          const resultText = typeof obj.result === 'string' ? obj.result : '';
          const sessionId = typeof obj.session_id === 'string' ? obj.session_id : null;
          const costUsd = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : 0;

          if (obj.is_error === true) {
            const detail = resultText ? ` ${explainDetail(resultText)}` : '';
            reject(new ClaudeError(`Claude가 요청을 처리하지 못했어요.${detail} 잠시 후 다시 시도해 주세요.`));
            return;
          }
          if (err) {
            // exit 코드는 비정상이지만 JSON은 정상 — 결과가 있으면 살리고, 없으면 에러
            if (resultText) {
              resolve({ text: resultText, sessionId, costUsd });
              return;
            }
            reject(buildExitError(err, stderr));
            return;
          }
          resolve({ text: resultText, sessionId, costUsd });
          return;
        }

        // JSON 파싱 실패
        if (err) {
          reject(buildExitError(err, stderr));
          return;
        }
        reject(
          new ClaudeError('Claude의 응답을 해석하지 못했어요. 잠시 후 다시 시도해 주세요.')
        );
      }
    );

    // 프롬프트를 stdin으로 전달
    if (child.stdin) {
      child.stdin.on('error', () => {
        // 프로세스가 먼저 종료되면 EPIPE가 날 수 있다 — 결과는 콜백에서 처리되므로 무시
      });
      child.stdin.end(prompt);
    }
  });
}

/**
 * CLI의 영어/기술 에러 원문을 비개발자가 이해할 수 있는 한국어 안내로 변환.
 * 흔한 케이스(로그인 만료, 사용량 한도 등)는 한국어 설명으로 바꾸고,
 * 알 수 없는 에러만 참고용으로 영어 원문 일부를 덧붙인다.
 */
function explainDetail(detail: string): string {
  const d = detail.toLowerCase();
  if (
    d.includes('invalid api key') ||
    d.includes('please run /login') ||
    d.includes('not logged in') ||
    d.includes('authentication') ||
    d.includes('unauthorized') ||
    d.includes('401')
  ) {
    return '로그인이 안 되어 있거나 로그인이 만료된 것 같아요. 터미널에서 claude 를 실행해 다시 로그인해 주세요.';
  }
  if (d.includes('rate limit') || d.includes('usage limit') || d.includes('quota') || d.includes('429')) {
    return '사용량 한도에 도달한 것 같아요. 잠시 기다렸다가 다시 시도해 주세요.';
  }
  if (
    d.includes('network') ||
    d.includes('enotfound') ||
    d.includes('econnrefused') ||
    d.includes('etimedout') ||
    d.includes('fetch failed')
  ) {
    return '인터넷 연결에 문제가 있는 것 같아요. 연결 상태를 확인하고 다시 시도해 주세요.';
  }
  if (d.includes('overloaded') || d.includes('529') || d.includes('500') || d.includes('internal server error')) {
    return 'Claude 서비스가 일시적으로 혼잡한 것 같아요. 잠시 후 다시 시도해 주세요.';
  }
  // 알 수 없는 에러 — 문의/검색에 쓸 수 있도록 원문 일부만 참고로 첨부
  return `(참고용 원문: ${truncate(detail, 200)})`;
}

function buildExitError(err: Error, stderr: string | undefined): ClaudeError {
  const detail = (stderr ?? '').trim();
  const suffix = detail ? ` ${explainDetail(detail)}` : '';
  return new ClaudeError(`Claude 실행 중 오류가 발생했어요.${suffix} 잠시 후 다시 시도해 주세요.`);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
