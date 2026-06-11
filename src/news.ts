/**
 * news.ts — 📰 오늘의 클로드: 뉴스 캐시/갱신 + 소식 Q&A
 *
 * 계약 (ARCHITECTURE.md "뉴스 캐시/갱신"):
 * - 캐시: data/news.json = { fetchedAt: ISO, items: NewsItem[] }. TTL 6시간.
 * - 갱신: claude -p 에 --allowedTools WebSearch 를 붙여 최근 Claude·Claude Code 소식,
 *   좋은 사용 패턴, 새로운 하네스/루프 디자인을 검색·큐레이션 → NewsItem[] 5~8개를
 *   fenced JSON 코드블록으로 출력하게 한다.
 * - 서버는 응답에서 첫 JSON 블록을 관대하게 추출·검증(필수 필드 누락 항목은 버림) 후 저장.
 * - 동시 갱신 방지: 모듈 레벨 in-flight 플래그. 갱신 실패 시 기존 캐시 유지 + 콘솔 경고.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runClaude, type ClaudeResult } from './claude.js';

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

/** 동시 갱신 방지용 in-flight 플래그 (갱신 중 들어온 재요청은 무시) */
let refreshing = false;

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
}> {
  const cache = await readCache();
  if (!cache || isStale(cache)) {
    startBackgroundRefresh();
  }
  return {
    items: cache?.items ?? [],
    fetchedAt: cache?.fetchedAt ?? null,
    refreshing,
  };
}

function startBackgroundRefresh(): void {
  if (refreshing) return; // 이미 갱신 중 → 무시
  refreshing = true;
  void refreshNews()
    .catch((err) => {
      // 실패해도 기존 캐시는 그대로 유지된다 — 콘솔 경고만 남긴다
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

function buildCurationPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    '당신은 코딩을 모르는 비개발자를 위해 Claude 소식을 골라 주는 한국어 에디터입니다.',
    `오늘 날짜는 ${today} 입니다. 웹 검색(WebSearch)을 사용해서, 오늘 기준 최근 2주 사이의`,
    'Claude / Claude Code 소식, 좋은 사용 패턴, 새로운 하네스·루프 디자인을 찾아 주세요.',
    '찾아볼 곳: Anthropic 블로그, Claude 공식 문서(docs), X(@karpathy 포함), Hacker News.',
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
  const result = await runClaude(buildCurationPrompt(), {
    extraArgs: ['--allowedTools', 'WebSearch'],
  });
  const items = extractNewsItems(result.text);
  if (items.length === 0) {
    throw new Error('응답에서 유효한 소식 항목을 하나도 추출하지 못했어요.');
  }
  await writeCache({ fetchedAt: new Date().toISOString(), items });
  console.log(`[news] 소식 ${items.length}건을 갱신했어요.`);
}

// ── JSON 관대 추출 (단위 테스트 대상) ─────────────────────

/**
 * 텍스트에서 JSON 값을 관대하게 추출한다.
 * 1) 첫 ```json 펜스 블록을 파싱 시도 (블록 안에 잡담이 섞여 있으면 블록 안에서 균형 매칭)
 * 2) 없거나 실패하면 전체 텍스트에서 첫 { ... } / [ ... ] 균형 매칭을 파싱 시도
 * 실패하면 undefined (throw 금지).
 */
export function extractFirstJson(text: string): unknown {
  const fence = /```json\s*([\s\S]*?)```/i.exec(text);
  if (fence) {
    const inner = fence[1].trim();
    try {
      return JSON.parse(inner);
    } catch {
      const fromFence = extractBalanced(inner);
      if (fromFence !== undefined) return fromFence;
    }
  }
  return extractBalanced(text);
}

/** 문자열/이스케이프를 고려해 첫 균형 잡힌 JSON 값({...} 또는 [...])을 찾아 파싱 */
function extractBalanced(text: string): unknown {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
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
 * 필수 필드(title, summary, whyGood, url, source)가 하나라도 빠진 항목은 버린다.
 */
export function extractNewsItems(text: string): NewsItem[] {
  const value = extractFirstJson(text);
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
    return [];
  }
  return coerceNewsItems(list);
}

/** 항목 배열을 검증해 유효한 NewsItem만 남긴다 (여분 필드는 제거) */
function coerceNewsItems(list: unknown[]): NewsItem[] {
  const items: NewsItem[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    const title = nonEmptyString(obj.title);
    const summary = nonEmptyString(obj.summary);
    const whyGood = nonEmptyString(obj.whyGood);
    const url = nonEmptyString(obj.url);
    const source = nonEmptyString(obj.source);
    if (!title || !summary || !whyGood || !url || !source) continue; // 필수 필드 누락 → 버림
    items.push({ title, summary, whyGood, url, source });
  }
  return items;
}

function nonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

// ── 소식 Q&A: POST /api/companion/news/ask 용 ─────────────

const NEWS_ASK_SYSTEM = [
  '당신은 코딩을 모르는 비개발자에게 Claude 관련 소식을 쉽게 풀어 설명해 주는 한국어 도우미입니다.',
  '아래 "최근 소식 다이제스트"를 기본 맥락으로 삼아 사용자의 질문에 답하세요.',
  '말투는 친절하고 짧게, 전문용어가 나오면 한 줄 설명을 덧붙이세요.',
  '다이제스트에 없는 내용을 단정하지 말고, 모르면 모른다고 말하세요.',
].join('\n');

/**
 * 소식 Q&A 한 턴. 첫 턴이면 캐시된 다이제스트(items의 title+summary)를 컨텍스트로 넣고,
 * 이후 턴은 --resume으로 같은 대화를 이어간다.
 */
export async function askNewsTurn(
  question: string,
  resumeClaudeSessionId: string | null
): Promise<ClaudeResult> {
  if (resumeClaudeSessionId) {
    return runClaude(question, { resumeSessionId: resumeClaudeSessionId });
  }
  const cache = await readCache();
  const digest =
    cache && cache.items.length > 0
      ? cache.items.map((it, i) => `${i + 1}. ${it.title} — ${it.summary}`).join('\n')
      : '(아직 가져온 소식이 없어요. 일반적인 지식 범위에서 조심스럽게 답해 주세요.)';
  const prompt = [
    NEWS_ASK_SYSTEM,
    '',
    '--- 최근 소식 다이제스트 시작 ---',
    digest,
    '--- 최근 소식 다이제스트 끝 ---',
    '',
    '사용자 질문:',
    question,
  ].join('\n');
  return runClaude(prompt);
}
