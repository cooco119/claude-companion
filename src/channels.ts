/**
 * channels.ts — 사용자 구독 채널 (새 소식 큐레이션에 포함할 URL)
 *
 * 계약 (ARCHITECTURE.md "구독 채널"):
 * - 저장: data/channels.json = Channel[]. 최대 20개.
 * - 추가: http/https URL만, 같은 주소 중복 불가. label 생략 시 호스트명.
 * - 채널 변경 시 호출부(server.ts)가 news의 markNewsStale()로 다음 조회에서 갱신을 유도한다.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export type Channel = {
  id: string;
  url: string;
  label: string;
  addedAt: string; // ISO
};

const FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'channels.json'
);

const MAX_CHANNELS = 20;
const MAX_LABEL_CHARS = 50;
const MAX_URL_CHARS = 500;

/** store.ts와 같은 취지의 직렬화 체인 — 동시 추가/삭제의 read-modify-write 경합 방지 */
let mutateChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutateChain.then(fn, fn);
  mutateChain = next.catch(() => undefined); // 체인은 실패해도 계속 산다
  return next;
}

async function load(): Promise<Channel[]> {
  let raw: string;
  try {
    raw = await fs.readFile(FILE, 'utf8');
  } catch {
    return []; // 아직 없음
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const channels: Channel[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const c = item as Record<string, unknown>;
      if (
        typeof c.id !== 'string' ||
        typeof c.url !== 'string' ||
        typeof c.label !== 'string' ||
        typeof c.addedAt !== 'string'
      )
        continue;
      channels.push({ id: c.id, url: c.url, label: c.label, addedAt: c.addedAt });
    }
    return channels;
  } catch {
    return []; // 손상된 파일은 빈 목록으로 (소식 캐시와 달리 잃어도 가벼운 데이터)
  }
}

async function save(channels: Channel[]): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(channels, null, 2), 'utf8');
  await fs.rename(tmp, FILE);
}

export async function listChannels(): Promise<Channel[]> {
  return load();
}

/** URL을 비교용으로 정규화 (말미 슬래시/대소문자 호스트 차이로 중복이 새는 것 방지) */
function normalizeUrl(u: URL): string {
  const pathname = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host.toLowerCase()}${pathname}${u.search}`;
}

/**
 * 채널 추가. 실패는 사용자에게 그대로 보여줄 한국어 메시지로 throw.
 * 성공 시 갱신된 전체 목록을 돌려준다.
 */
export async function addChannel(rawUrl: string, rawLabel?: string): Promise<Channel[]> {
  const trimmed = rawUrl.trim();
  if (trimmed === '' || trimmed.length > MAX_URL_CHARS) {
    throw new Error('주소(URL)를 확인해 주세요.');
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      '주소(URL) 형식이 올바르지 않아요. http:// 또는 https:// 로 시작하는 전체 주소를 붙여넣어 주세요.'
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('http:// 또는 https:// 로 시작하는 주소만 추가할 수 있어요.');
  }

  const label =
    rawLabel && rawLabel.trim() !== ''
      ? rawLabel.trim().slice(0, MAX_LABEL_CHARS)
      : url.hostname.replace(/^www\./, '');

  return withLock(async () => {
    const channels = await load();
    if (channels.length >= MAX_CHANNELS) {
      throw new Error(`구독 채널은 최대 ${MAX_CHANNELS}개까지 추가할 수 있어요.`);
    }
    const normalized = normalizeUrl(url);
    if (channels.some((c) => safeNormalize(c.url) === normalized)) {
      throw new Error('이미 구독 중인 채널이에요.');
    }
    channels.push({
      id: randomUUID(),
      url: url.href,
      label,
      addedAt: new Date().toISOString(),
    });
    await save(channels);
    return channels;
  });
}

/** 채널 삭제. 없는 id면 false. */
export async function removeChannel(id: string): Promise<{ removed: boolean; channels: Channel[] }> {
  return withLock(async () => {
    const channels = await load();
    const next = channels.filter((c) => c.id !== id);
    if (next.length === channels.length) return { removed: false, channels };
    await save(next);
    return { removed: true, channels: next };
  });
}

function safeNormalize(raw: string): string {
  try {
    return normalizeUrl(new URL(raw));
  } catch {
    return raw;
  }
}
