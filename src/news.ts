/**
 * news.ts — 📰 오늘의 클로드: 뉴스 캐시/갱신
 *
 * 계약 (ARCHITECTURE.md "뉴스 캐시/갱신"):
 * - 캐시: data/news.json = { fetchedAt: ISO, items: NewsItem[] }. TTL 6시간.
 * - 갱신: claude -p 에 --allowedTools WebSearch 를 붙여 최근 Claude·Claude Code 소식,
 *   좋은 사용 패턴, 새로운 하네스/루프 디자인을 검색·큐레이션 → NewsItem[] 5~8개를
 *   fenced JSON 코드블록으로 출력하게 한다.
 * - 서버는 응답에서 JSON 블록을 관대하게 추출·검증(필수 필드 누락 항목은 버림) 후 저장.
 *   (배열은 답변 끝에 오므로 마지막 ```json 펜스부터 역방향 탐색 — splitGuidance와 동일한 방식)
 * - 동시 갱신 방지: 모듈 레벨 in-flight 플래그. 갱신 실패 시 기존 캐시 유지 + 콘솔 경고
 *   + 백오프(FAILURE_BACKOFF_MS) + 응답 lastError로 프런트에 실패 상태 전달.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runClaude } from './claude.js';
import { listChannels, type Channel } from './channels.js';

export type NewsItem = {
  title: string; // 한국어 제목 (원문이 영어면 번역)
  summary: string; // 2-3문장 한국어 요약
  whyGood: string; // "이게 왜 좋은가/나에게 무슨 의미인가" 한 줄
  url: string; // 출처 링크
  source: string; // 예: 'Anthropic 블로그', 'Claude Docs', 'Hacker News', 'X(@karpathy)'
};

type NewsCache = { fetchedAt: string; items: NewsItem[] };

const CACHE_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'news.json'
);

const TTL_MS = 6 * 60 * 60 * 1000; // 6시간

/** 갱신 실패 후 이 시간 동안은 재시도하지 않는다 (10초 폴링이 비싼 WebSearch 호출을 반복 기동하는 것 방지) */
const FAILURE_BACKOFF_MS = 10 * 60 * 1000; // 10분

/** 다이제스트/캐시 폭주 방지 상한 (companion.ts의 DIGEST_MAX_* 캡핑과 같은 취지) */
const MAX_ITEMS = 8;
const MAX_FIELD_CHARS: Record<keyof NewsItem, number> = {
  title: 200,
  summary: 1000,
  whyGood: 300,
  url: 2000,
  source: 100,
};

/** 비정상적으로 긴 모델 출력에서 균형 매칭이 O(n²)로 이벤트 루프를 막지 않도록 스캔 길이 상한 */
const MAX_SCAN_CHARS = 256 * 1024; // 256KB
const MAX_BALANCED_ATTEMPTS = 200;

/** 동시 갱신 방지용 in-flight 플래그 (갱신 중 들어온 재요청은 무시) */
let refreshing = false;

/** negative cache: 마지막 실패 시각/메시지 (백오프 + 프런트 실패 표시용) */
let lastFailedAt = 0;
let lastErrorMessage: string | null = null;

/** 구독 채널이 바뀌면 TTL과 무관하게 다음 조회에서 갱신하도록 하는 플래그 */
let staleOverride = false;

/**
 * 캐시를 낡은 것으로 표시한다 (구독 채널 추가/삭제 시 server.ts가 호출).
 * 실패 백오프도 초기화해, 채널을 막 추가한 사용자가 10분을 기다리지 않게 한다.
 */
export function markNewsStale(): void {
  staleOverride = true;
  lastFailedAt = 0;
  lastErrorMessage = null;
}

// ── 캐시 읽기/쓰기 ─────────────────────────────────────────

async function readCache(): Promise<NewsCache | null> {
  let raw: string;
  try {
    raw = await fs.readFile(CACHE_FILE, 'utf8');
  } catch {
    return null; // 캐시가 아직 없음
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.fetchedAt !== 'string' || !Array.isArray(obj.items)) return null;
    // 저장 시점에 이미 검증했지만, 파일이 손으로 고쳐졌을 수 있으니 한 번 더 거른다
    const items = coerceNewsItems(obj.items);
    return { fetchedAt: obj.fetchedAt, items };
  } catch {
    return null; // 손상된 캐시는 없는 것으로 취급 (다음 갱신이 덮어쓴다)
  }
}

async function writeCache(cache: NewsCache): Promise<void> {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  // store.ts와 동일하게 임시 파일 + rename으로 원자적 교체
  const tmp = `${CACHE_FILE}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
  await fs.rename(tmp, CACHE_FILE);
}

function isStale(cache: NewsCache): boolean {
  const t = Date.parse(cache.fetchedAt);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > TTL_MS;
}

// ── 공개 API: GET /api/companion/news 용 ──────────────────

/**
 * 캐시를 즉시 반환하고, 캐시가 없거나 6시간이 지났으면 백그라운드 갱신을 시작한다.
 * (갱신이 끝날 때까지 기다리지 않는다 — 프런트는 refreshing이면 폴링한다)
 */
export async function getNews(): Promise<{
  items: NewsItem[];
  fetchedAt: string | null;
  refreshing: boolean;
  lastError: string | null;
}> {
  const cache = await readCache();
  if (!cache || isStale(cache) || staleOverride) {
    // 직전 갱신이 실패했다면 백오프 시간 동안은 재시도하지 않는다
    // (프런트의 10초 폴링/탭 재진입이 실패한 WebSearch 호출을 반복 기동하는 것 방지)
    if (Date.now() - lastFailedAt >= FAILURE_BACKOFF_MS) {
      startBackgroundRefresh();
    }
  }
  return {
    items: cache?.items ?? [],
    fetchedAt: cache?.fetchedAt ?? null,
    refreshing,
    lastError: refreshing ? null : lastErrorMessage,
  };
}

function startBackgroundRefresh(): void {
  if (refreshing) return; // 이미 갱신 중 → 무시
  refreshing = true;
  void refreshNews()
    .then(() => {
      lastFailedAt = 0;
      lastErrorMessage = null;
    })
    .catch((err) => {
      // 실패해도 기존 캐시는 그대로 유지된다 — 백오프 기록 + 콘솔 경고
      lastFailedAt = Date.now();
      lastErrorMessage = err instanceof Error && err.message ? err.message : '소식 갱신에 실패했어요.';
      console.warn(
        '[news] 소식 갱신에 실패했어요. 기존 캐시를 그대로 유지합니다.',
        err instanceof Error ? err.message : err
      );
    })
    .finally(() => {
      refreshing = false;
    });
}

// ── 갱신 (claude -p + WebSearch) ──────────────────────────

function buildCurationPrompt(channels: Channel[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const channelBlock =
    channels.length > 0
      ? [
          '',
          '사용자가 직접 구독한 채널도 있습니다. 아래 각 주소를 WebFetch로 직접 열어,',
          '최근 2주 사이의 새 글이 있으면 큐레이션에 포함해 주세요 (이 채널들의 항목은',
          '"source"를 "구독: <채널 이름>" 형태로 적어 주세요):',
          ...channels.map((c) => `- ${c.label}: ${c.url}`),
        ]
      : [];
  return [
    '당신은 코딩을 모르는 비개발자를 위해 Claude 소식을 골라 주는 한국어 에디터입니다.',
    `오늘 날짜는 ${today} 입니다. 웹 검색(WebSearch)을 사용해서, 오늘 기준 최근 2주 사이의`,
    'Claude / Claude Code 소식, 좋은 사용 패턴, 새로운 하네스·루프 디자인을 찾아 주세요.',
    '찾아볼 곳: Anthropic 블로그, Claude 공식 문서(docs), X(@karpathy 포함), Hacker News.',
    ...channelBlock,
    '',
    '가장 흥미롭고 유용한 것 5~8개를 골라, 답변 마지막에 아래 형식의 JSON 배열 하나를',
    '```json 펜스 코드블록으로 출력하세요. 각 항목은 다음 5개 필드를 모두 가져야 합니다:',
    '{',
    '  "title": "한국어 제목 (원문이 영어면 번역)",',
    '  "summary": "2-3문장 한국어 요약",',
    '  "whyGood": "이게 왜 좋은가 / 나에게 무슨 의미인가 한 줄",',
    '  "url": "출처 링크",',
    '  "source": "Anthropic 블로그 | Claude Docs | Hacker News | X(@karpathy) 등 출처 이름"',
    '}',
    '',
    '독자는 코딩을 모르는 비개발자입니다. summary와 whyGood은 전문용어 없이 일상어로,',
    '특히 whyGood은 "그래서 나한테 뭐가 좋은데?"에 답하는 한 줄로 써 주세요.',
    'JSON 코드블록 바깥의 설명은 한두 문장으로 짧게 해 주세요.',
  ].join('\n');
}

/** 실제 갱신 1회: 검색·큐레이션 → 추출·검증 → 캐시 저장. 실패 시 throw (호출부가 경고). */
async function refreshNews(): Promise<void> {
  const channels = await listChannels();
  // 구독 채널이 있으면 그 주소를 직접 열 수 있게 WebFetch도 허용한다
  const allowedTools = channels.length > 0 ? ['WebSearch', 'WebFetch'] : ['WebSearch'];
  const result = await runClaude(buildCurationPrompt(channels), {
    extraArgs: ['--allowedTools', ...allowedTools],
  });
  const items = extractNewsItems(result.text);
  if (items.length === 0) {
    throw new Error('응답에서 유효한 소식 항목을 하나도 추출하지 못했어요.');
  }
  await writeCache({ fetchedAt: new Date().toISOString(), items });
  staleOverride = false; // 채널 변경분이 반영된 새 캐시
  console.log(`[news] 소식 ${items.length}건을 갱신했어요.`);
}

// ── JSON 관대 추출 (단위 테스트 대상) ─────────────────────

/**
 * 텍스트에서 JSON 값 후보들을 관대하게 추출한다.
 * 1) 모든 ```json 펜스 블록을 수집해 **마지막 블록부터** 파싱 시도
 *    (프롬프트가 "답변 마지막에" 배열을 요구하고, 본문에 항목 모양 예시 객체가 섞일 수 있으므로 —
 *    splitGuidance()와 같은 역방향 탐색)
 * 2) 펜스에서 후보가 안 나오면 전체 텍스트에서 { ... } / [ ... ] 균형 매칭을 파싱 시도
 * 후보가 없으면 빈 배열 (throw 금지).
 */
export function extractJsonCandidates(text: string): unknown[] {
  const candidates: unknown[] = [];
  const fenceRe = /```json\s*([\s\S]*?)```/gi;
  const fences: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    fences.push(m[1].trim());
  }
  // 진짜 데이터는 답변 끝에 붙으므로 마지막 펜스부터 검사한다
  for (let i = fences.length - 1; i >= 0; i--) {
    try {
      candidates.push(JSON.parse(fences[i]));
    } catch {
      const fromFence = extractBalanced(fences[i]);
      if (fromFence !== undefined) candidates.push(fromFence);
    }
  }
  const fromText = extractBalanced(text);
  if (fromText !== undefined) candidates.push(fromText);
  return candidates;
}

/** (호환용) 첫 후보 하나만 돌려준다. 실패하면 undefined. */
export function extractFirstJson(text: string): unknown {
  const candidates = extractJsonCandidates(text);
  return candidates.length > 0 ? candidates[0] : undefined;
}

/**
 * 문자열/이스케이프를 고려해 첫 균형 잡힌 JSON 값({...} 또는 [...])을 찾아 파싱.
 * 비정상적으로 긴 출력에서 O(n²) 재스캔으로 이벤트 루프를 막지 않도록
 * 스캔 길이(MAX_SCAN_CHARS)와 시도 횟수(MAX_BALANCED_ATTEMPTS)에 상한을 둔다.
 */
function extractBalanced(text: string): unknown {
  if (text.length > MAX_SCAN_CHARS) text = text.slice(0, MAX_SCAN_CHARS);
  let attempts = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    if (++attempts > MAX_BALANCED_ATTEMPTS) return undefined;
    const end = scanBalancedEnd(text, i);
    if (end === null) continue;
    try {
      return JSON.parse(text.slice(i, end + 1));
    } catch {
      // 이 후보는 JSON이 아님 — 다음 여는 괄호에서 다시 시도
    }
  }
  return undefined;
}

/** start의 여는 괄호에 대응하는 닫는 괄호 인덱스 (문자열 내부의 괄호는 무시) */
function scanBalancedEnd(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * 응답 텍스트에서 NewsItem[]을 추출한다.
 * 모든 JSON 후보(마지막 펜스부터)를 검사해 유효한 NewsItem이 1개 이상 나오는
 * 첫 후보를 채택한다 — 본문에 항목 모양 예시 객체가 섞여 있어도 진짜 배열로 폴백된다.
 * 필수 필드(title, summary, whyGood, url, source)가 하나라도 빠진 항목은 버린다.
 */
export function extractNewsItems(text: string): NewsItem[] {
  for (const value of extractJsonCandidates(text)) {
    let list: unknown[];
    if (Array.isArray(value)) {
      list = value;
    } else if (
      value &&
      typeof value === 'object' &&
      Array.isArray((value as Record<string, unknown>).items)
    ) {
      list = (value as Record<string, unknown>).items as unknown[];
    } else {
      continue;
    }
    const items = coerceNewsItems(list);
    if (items.length > 0) return items;
  }
  return [];
}

/**
 * 항목 배열을 검증해 유효한 NewsItem만 남긴다 (여분 필드는 제거).
 * 다이제스트/캐시 폭주 방지: 최대 MAX_ITEMS개, 필드별 길이 상한(MAX_FIELD_CHARS) 적용.
 */
function coerceNewsItems(list: unknown[]): NewsItem[] {
  const items: NewsItem[] = [];
  for (const raw of list) {
    if (items.length >= MAX_ITEMS) break; // 프롬프트는 5~8개를 '요청'할 뿐 — 여기서 강제
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    const title = nonEmptyString(obj.title);
    const summary = nonEmptyString(obj.summary);
    const whyGood = nonEmptyString(obj.whyGood);
    const url = nonEmptyString(obj.url);
    const source = nonEmptyString(obj.source);
    if (!title || !summary || !whyGood || !url || !source) continue; // 필수 필드 누락 → 버림
    items.push({
      title: capField(title, 'title'),
      summary: capField(summary, 'summary'),
      whyGood: capField(whyGood, 'whyGood'),
      url: capField(url, 'url'),
      source: capField(source, 'source'),
    });
  }
  return items;
}

function capField(value: string, field: keyof NewsItem): string {
  const max = MAX_FIELD_CHARS[field];
  return value.length > max ? value.slice(0, max) : value;
}

function nonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}
