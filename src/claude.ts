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
 */
export function runClaude(prompt: string, options: RunOptions = {}): Promise<ClaudeResult> {
  const args = ['-p', prompt, '--output-format', 'json'];
  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  }
  const model = process.env.CLAUDE_MODEL;
  if (model && model.trim() !== '') {
    args.push('--model', model.trim());
  }

  return new Promise<ClaudeResult>((resolve, reject) => {
    execFile(
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
            const detail = resultText ? ` (상세: ${truncate(resultText, 300)})` : '';
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
  });
}

function buildExitError(err: Error, stderr: string | undefined): ClaudeError {
  const detail = (stderr ?? '').trim();
  const suffix = detail ? ` (상세: ${truncate(detail, 300)})` : '';
  return new ClaudeError(`Claude 실행 중 오류가 발생했어요.${suffix} 잠시 후 다시 시도해 주세요.`);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
