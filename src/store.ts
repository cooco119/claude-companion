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

async function load(): Promise<ChatSession[]> {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatSession[]) : [];
  } catch {
    // 파일이 없거나 손상됨 → 빈 목록으로 시작
    return [];
  }
}

async function save(sessions: ChatSession[]): Promise<void> {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(sessions, null, 2), 'utf8');
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
  const sessions = await load();
  sessions.push(session);
  await save(sessions);
  return session;
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
}
