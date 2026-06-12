/**
 * ccSessions.ts — ~/.claude/projects 의 Claude Code 세션(JSONL) 목록/파싱
 *
 * 계약 (ARCHITECTURE.md):
 * - 위치: ~/.claude/projects/<인코딩된-프로젝트-경로>/<uuid>.jsonl
 * - 관심 줄: type==='user' (message.content가 문자열 또는 {type:'text',text} 배열),
 *   type==='assistant' (message.content 배열에서 type==='text' 항목)
 * - 그 외 줄(tool_use 등)은 건너뛴다. 파싱 안 되는 줄은 무시(throw 금지).
 * - 목록은 mtime 내림차순, 최근 30개. 미리보기 = 첫 사용자 메시지 앞 80자.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface CcSessionInfo {
  path: string; // 절대경로
  project: string;
  file: string;
  mtime: string; // ISO
  preview: string;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
}

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MAX_SESSIONS = 30;

/**
 * 이 앱 자신이 띄우는 claude -p 호출(물어보기/다듬기/조언/소식 등)도 전부
 * ~/.claude/projects/<서버 cwd 인코딩>/ 아래에 세션 파일을 만든다. 이 노이즈가
 * mtime 정렬을 점령해 사용자의 실제 Claude Code 세션을 밀어내므로 목록에서 제외한다.
 * (인코딩 규칙: cwd의 영숫자 외 문자를 '-'로 치환)
 */
const SELF_PROJECT = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');

/**
 * 스캔 루트 목록.
 * - 기본: ~/.claude/projects
 * - ccs 같은 멀티 인스턴스 도구: ~/.ccs/instances/<이름>/projects 또는
 *   ~/.ccs/instances/<이름>/.claude/projects (인스턴스별 CLAUDE_CONFIG_DIR 레이아웃 모두 지원).
 *   이 루트의 세션은 project 라벨 앞에 "ccs:<이름> "을 붙여 구분한다.
 */
async function scanRoots(): Promise<Array<{ dir: string; tag: string | null }>> {
  const roots: Array<{ dir: string; tag: string | null }> = [{ dir: PROJECTS_DIR, tag: null }];
  const instancesDir = path.join(os.homedir(), '.ccs', 'instances');
  let instances: string[] = [];
  try {
    const entries = await fs.readdir(instancesDir, { withFileTypes: true });
    instances = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return roots; // ~/.ccs/instances 없음 — 기본 루트만
  }
  for (const name of instances) {
    for (const sub of ['projects', path.join('.claude', 'projects')]) {
      const dir = path.join(instancesDir, name, sub);
      try {
        const st = await fs.stat(dir);
        if (st.isDirectory()) {
          roots.push({ dir, tag: name });
          break; // 한 인스턴스에서 먼저 발견된 레이아웃 하나만
        }
      } catch {
        // 해당 레이아웃 없음 — 다음 후보
      }
    }
  }
  return roots;
}

/** 세션 목록 — 모든 루트를 합쳐 mtime 내림차순, 최근 30개. 에러는 모두 삼키고 가능한 만큼 반환. */
export async function listCcSessions(): Promise<CcSessionInfo[]> {
  const candidates: Array<{ path: string; project: string; file: string; mtimeMs: number }> = [];

  for (const root of await scanRoots()) {
    let projectDirs: string[] = [];
    try {
      const entries = await fs.readdir(root.dir, { withFileTypes: true });
      projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue; // 이 루트는 없음
    }
    for (const project of projectDirs) {
      if (root.tag === null && project === SELF_PROJECT) continue; // 앱 자신의 -p 세션은 제외
      const dir = path.join(root.dir, project);
      let files: string[] = [];
      try {
        files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      const label = root.tag === null ? project : `ccs:${root.tag} ${project}`;
      for (const file of files) {
        const full = path.join(dir, file);
        try {
          const st = await fs.stat(full);
          candidates.push({ path: full, project: label, file, mtimeMs: st.mtimeMs });
        } catch {
          // stat 실패한 파일은 건너뜀
        }
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = candidates.slice(0, MAX_SESSIONS);

  const result: CcSessionInfo[] = [];
  for (const c of top) {
    const preview = await firstUserPreview(c.path);
    result.push({
      path: c.path,
      project: c.project,
      file: c.file,
      mtime: new Date(c.mtimeMs).toISOString(),
      preview,
    });
  }
  return result;
}

/**
 * JSONL 트랜스크립트 파싱 → user/assistant 텍스트 메시지 배열.
 * 파일을 못 읽으면 빈 배열. 어떤 줄도 throw 시키지 않는다.
 */
export async function parseTranscript(filePath: string): Promise<TranscriptMessage[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const messages: TranscriptMessage[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // 파싱 안 되는 줄은 무시
    }
    if (obj === null || typeof obj !== 'object') continue;
    const rec = obj as Record<string, unknown>;
    const message = rec.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== 'object') continue;

    if (rec.type === 'user') {
      const text = extractUserText(message.content);
      if (text.trim() !== '') messages.push({ role: 'user', text });
    } else if (rec.type === 'assistant') {
      const text = extractAssistantText(message.content);
      if (text.trim() !== '') messages.push({ role: 'assistant', text });
    }
    // 그 외 type은 건너뛴다
  }
  return messages;
}

/** user 메시지: content가 문자열 또는 {type:'text',text} 배열 */
function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: string; text: string } =>
          p !== null &&
          typeof p === 'object' &&
          (p as Record<string, unknown>).type === 'text' &&
          typeof (p as Record<string, unknown>).text === 'string'
      )
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

/** assistant 메시지: content 배열에서 type==='text' 항목만 */
function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (p): p is { type: string; text: string } =>
        p !== null &&
        typeof p === 'object' &&
        (p as Record<string, unknown>).type === 'text' &&
        typeof (p as Record<string, unknown>).text === 'string'
    )
    .map((p) => p.text)
    .join('\n');
}

/** 시스템성 user 줄(메타/로컬 커맨드 래퍼)인지 — 미리보기 품질을 위해 건너뛴다 */
function isSystemish(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<local-command-caveat>') ||
    t.startsWith('<command-name>') ||
    t.startsWith('<local-command-stdout>') ||
    t.startsWith('<command-message>')
  );
}

/** 미리보기 = (의미 있는) 첫 사용자 메시지 앞 80자 */
async function firstUserPreview(filePath: string): Promise<string> {
  const messages = await parseTranscript(filePath);
  const firstUser =
    messages.find((m) => m.role === 'user' && !isSystemish(m.text)) ??
    messages.find((m) => m.role === 'user');
  if (!firstUser) return '(사용자 메시지 없음)';
  const oneLine = firstUser.text.replace(/\s+/g, ' ').trim();
  return oneLine.slice(0, 80);
}
