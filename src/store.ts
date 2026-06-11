/**
 * store.ts — 앱 자체 채팅 세션 저장 (data/sessions.json 단일 파일, MVP)
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export type ChatMessage = { role: 'user' | 'assistant'; text: string; at: string /* ISO */ };

export type ChatSession = {
  id: string; // 앱이 만드는 uuid
  title: string; // 첫 사용자 메시지 앞 40자
  claudeSessionId: string | null; // claude -p의 session_id (resume용)
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
};

const DATA_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'sessions.json'
);

/**
 * 모든 mutate(읽기-수정-쓰기)를 단일 promise 체인으로 직렬화한다.
 * /api/chat과 /api/companion/refine이 동시에 들어와도 load→save가 겹쳐
 * 서로의 변경을 덮어쓰는(lost update) 일이 없도록 한다.
 */
let mutateChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutateChain.then(fn, fn);
  // 체인은 에러가 나도 끊기지 않게 유지
  mutateChain = next.catch(() => undefined);
  return next;
}

async function load(): Promise<ChatSession[]> {
  let raw: string;
  try {
    raw = await fs.readFile(DATA_FILE, 'utf8');
  } catch {
    // 파일이 아직 없음 → 빈 목록으로 시작
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatSession[]) : [];
  } catch (err) {
    // 파일이 손상됨 → 무음 초기화로 기존 데이터를 잃지 않도록
    // 손상본을 백업해 두고 에러를 표면화한다.
    const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
    try {
      await fs.copyFile(DATA_FILE, backup);
    } catch {
      // 백업 실패는 무시 (원본은 그대로 남는다)
    }
    console.error(
      `[store] ${DATA_FILE} 파일이 손상되어 읽을 수 없어요. 손상본을 ${backup} 에 백업했어요.`,
      err
    );
    throw new Error(
      '저장된 대화 파일(data/sessions.json)이 손상되어 읽을 수 없어요. 손상본은 같은 폴더에 백업해 두었어요.'
    );
  }
}

async function save(sessions: ChatSession[]): Promise<void> {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  // 임시 파일에 먼저 쓴 뒤 rename으로 원자적 교체 — 쓰기 도중 죽어도 원본이 깨지지 않는다.
  const tmp = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(sessions, null, 2), 'utf8');
  await fs.rename(tmp, DATA_FILE);
}

/** 목록용 요약 (updatedAt 내림차순) */
export async function listSessions(): Promise<
  Array<{ id: string; title: string; updatedAt: string; messageCount: number }>
> {
  const sessions = await load();
  return sessions
    .slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
    }));
}

export async function getSession(id: string): Promise<ChatSession | null> {
  const sessions = await load();
  return sessions.find((s) => s.id === id) ?? null;
}

/** 새 세션 생성. title은 첫 사용자 메시지 앞 40자 기준 (titlePrefix로 '[다듬기] ' 등 부착 가능) */
export async function createSession(
  firstUserMessage: string,
  titlePrefix = ''
): Promise<ChatSession> {
  const now = new Date().toISOString();
  const session: ChatSession = {
    id: randomUUID(),
    title: titlePrefix + firstUserMessage.trim().slice(0, 40),
    claudeSessionId: null,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  return withLock(async () => {
    const sessions = await load();
    sessions.push(session);
    await save(sessions);
    return session;
  });
}

/**
 * 한 턴(사용자+어시스턴트 메시지) 추가 + 최신 claudeSessionId 저장.
 * 응답의 session_id는 매 턴 갱신될 수 있으므로 항상 최신 값으로 덮어쓴다.
 */
export async function appendTurn(
  id: string,
  userText: string,
  assistantText: string,
  claudeSessionId: string | null
): Promise<ChatSession | null> {
  return withLock(async () => {
    const sessions = await load();
    const session = sessions.find((s) => s.id === id);
    if (!session) return null;
    const now = new Date().toISOString();
    session.messages.push({ role: 'user', text: userText, at: now });
    session.messages.push({ role: 'assistant', text: assistantText, at: now });
    if (claudeSessionId) session.claudeSessionId = claudeSessionId;
    session.updatedAt = now;
    await save(sessions);
    return session;
  });
}
