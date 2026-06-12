/**
 * server.ts — Express 앱 조립 (ARCHITECTURE.md의 HTTP API 표 전부)
 */
import express, { type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isClaudeCliAvailable, ClaudeError } from './claude.js';
import * as store from './store.js';
import { listCcSessions } from './ccSessions.js';
import { advise, refineTurn, feedback } from './companion.js';
import { getNews, markNewsStale } from './news.js';
import { listChannels, addChannel, removeChannel } from './channels.js';
import { listLessons, getLesson } from './lessons.js';
import { askTurn, coerceAskContext } from './tutor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3456;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));

/** 에러를 { error: 한국어 } + status로 변환 */
function sendError(res: Response, err: unknown, fallbackStatus = 500): void {
  if (err instanceof ClaudeError) {
    res.status(502).json({ error: err.message });
    return;
  }
  const message =
    err instanceof Error && err.message
      ? err.message
      : '알 수 없는 오류가 발생했어요. 잠시 후 다시 시도해 주세요.';
  res.status(fallbackStatus).json({ error: message });
}

// ── 헬스 체크 ──────────────────────────────────────────────
app.get('/api/health', async (_req: Request, res: Response) => {
  const claudeCli = await isClaudeCliAvailable();
  res.json({ ok: true, claudeCli });
});

// ── ❓ 물어보기 (튜터) ─────────────────────────────────────
app.post('/api/ask', async (req: Request, res: Response) => {
  try {
    const { question, context, quote, sessionId } = (req.body ?? {}) as {
      question?: unknown;
      context?: unknown;
      quote?: unknown;
      sessionId?: unknown;
    };
    if (typeof question !== 'string' || question.trim() === '') {
      res.status(400).json({ error: '궁금한 점을 입력해 주세요.' });
      return;
    }
    // context/quote는 선택 — 형태가 안 맞으면 조용히 무시한다
    const askContext = coerceAskContext(context);
    const askQuote =
      typeof quote === 'string' && quote.trim() !== '' ? quote : undefined;

    let session: store.ChatSession | null = null;
    if (typeof sessionId === 'string' && sessionId !== '') {
      session = await store.getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: '해당 물어보기 세션을 찾을 수 없어요.' });
        return;
      }
    }
    if (!session) {
      session = await store.createSession(question, '[물어보기] ');
    }

    const result = await askTurn(question, askContext, askQuote, session.claudeSessionId);
    // 앱 세션에는 컨텍스트 블록이 섞이지 않은 질문 원문과 깨끗한 답변을 저장한다
    await store.appendTurn(session.id, question, result.text, result.sessionId);

    res.json({ reply: result.text, sessionId: session.id, costUsd: result.costUsd });
  } catch (err) {
    sendError(res, err);
  }
});

// ── 앱 세션 ───────────────────────────────────────────────
app.get('/api/sessions', async (_req: Request, res: Response) => {
  try {
    const sessions = await store.listSessions();
    res.json({ sessions });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/sessions/:id', async (req: Request, res: Response) => {
  try {
    const session = await store.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: '해당 채팅 세션을 찾을 수 없어요.' });
      return;
    }
    res.json(session);
  } catch (err) {
    sendError(res, err);
  }
});

// ── 레슨 ──────────────────────────────────────────────────
app.get('/api/lessons', async (_req: Request, res: Response) => {
  try {
    const lessons = await listLessons();
    res.json({ lessons });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/lessons/:slug', async (req: Request, res: Response) => {
  try {
    const lesson = await getLesson(req.params.slug);
    if (!lesson) {
      res.status(404).json({ error: '해당 레슨을 찾을 수 없어요.' });
      return;
    }
    res.json(lesson);
  } catch (err) {
    sendError(res, err);
  }
});

// ── Claude Code 세션 목록 ─────────────────────────────────
app.get('/api/cc-sessions', async (_req: Request, res: Response) => {
  try {
    const sessions = await listCcSessions();
    res.json({ sessions });
  } catch (err) {
    sendError(res, err);
  }
});

// ── 컴패니언: 조언 ────────────────────────────────────────
app.post('/api/companion/advise', async (req: Request, res: Response) => {
  try {
    const { transcriptPath, focus } = (req.body ?? {}) as {
      transcriptPath?: unknown;
      focus?: unknown;
    };
    if (typeof transcriptPath !== 'string' || transcriptPath.trim() === '') {
      res.status(400).json({ error: '조언을 받을 세션을 선택해 주세요.' });
      return;
    }
    const result = await advise(
      transcriptPath,
      typeof focus === 'string' ? focus : undefined
    );
    res.json({ advice: result.advice, costUsd: result.costUsd });
  } catch (err) {
    sendError(res, err);
  }
});

// ── 컴패니언: 보내기 전 다듬기 ────────────────────────────
app.post('/api/companion/refine', async (req: Request, res: Response) => {
  try {
    const { draft, sessionId } = (req.body ?? {}) as {
      draft?: unknown;
      sessionId?: unknown;
    };
    if (typeof draft !== 'string' || draft.trim() === '') {
      res.status(400).json({ error: '다듬을 요청문을 입력해 주세요.' });
      return;
    }

    let session: store.ChatSession | null = null;
    if (typeof sessionId === 'string' && sessionId !== '') {
      session = await store.getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: '해당 다듬기 세션을 찾을 수 없어요.' });
        return;
      }
    }
    if (!session) {
      session = await store.createSession(draft, '[다듬기] ');
    }

    const result = await refineTurn(draft, session.claudeSessionId);
    // 앱 세션에는 Guidance JSON이 제거된 깨끗한 본문을 저장한다
    await store.appendTurn(session.id, draft, result.reply, result.sessionId);

    res.json({
      reply: result.reply,
      sessionId: session.id,
      costUsd: result.costUsd,
      ...(result.guidance ? { guidance: result.guidance } : {}),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ── 컴패니언: 오늘의 클로드 (소식) ────────────────────────
app.get('/api/companion/news', async (_req: Request, res: Response) => {
  try {
    // 캐시 즉시 반환 — 없거나 6시간 지났으면 백그라운드 갱신 시작 후 refreshing:true
    const news = await getNews();
    res.json(news);
  } catch (err) {
    sendError(res, err);
  }
});

// ── 새 소식: 구독 채널 ────────────────────────────────────
app.get('/api/news/channels', async (_req: Request, res: Response) => {
  try {
    res.json({ channels: await listChannels() });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/news/channels', async (req: Request, res: Response) => {
  try {
    const { url, label } = (req.body ?? {}) as { url?: unknown; label?: unknown };
    if (typeof url !== 'string' || url.trim() === '') {
      res.status(400).json({ error: '구독할 채널의 주소(URL)를 입력해 주세요.' });
      return;
    }
    const channels = await addChannel(url, typeof label === 'string' ? label : undefined);
    markNewsStale(); // 다음 소식 조회에서 새 채널을 반영해 갱신
    res.json({ channels });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    sendError(res, err, msg.includes('이미 구독 중') ? 409 : 400);
  }
});

app.delete('/api/news/channels/:id', async (req: Request, res: Response) => {
  try {
    const { removed, channels } = await removeChannel(req.params.id);
    if (!removed) {
      res.status(404).json({ error: '해당 채널을 찾을 수 없어요.' });
      return;
    }
    markNewsStale();
    res.json({ channels });
  } catch (err) {
    sendError(res, err);
  }
});

// ── 컴패니언: 피드백 리포트 ───────────────────────────────
app.post('/api/companion/feedback', async (req: Request, res: Response) => {
  try {
    const { transcriptPath } = (req.body ?? {}) as { transcriptPath?: unknown };
    if (typeof transcriptPath !== 'string' || transcriptPath.trim() === '') {
      res.status(400).json({ error: '피드백을 받을 세션을 선택해 주세요.' });
      return;
    }
    const result = await feedback(transcriptPath);
    res.json({ report: result.report, costUsd: result.costUsd });
  } catch (err) {
    sendError(res, err);
  }
});

// 알 수 없는 API 경로
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: '존재하지 않는 API 경로예요.' });
});

/**
 * 기본 브라우저로 주소를 연다 (OS별 분기, 실패해도 서버는 계속 동작).
 * NO_OPEN=1 이면 열지 않는다 (테스트/서버 환경용).
 */
function openBrowser(url: string): void {
  if (process.env.NO_OPEN) return;
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      console.log('   (브라우저가 자동으로 열리지 않으면 위 주소를 직접 열어 주세요)');
    });
    child.unref();
  } catch {
    // 브라우저를 못 열어도 서버는 정상 — 주소는 이미 콘솔에 안내됨
  }
}

const server = app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`${url} 에서 실행 중`);
  console.log('잠시 후 브라우저가 자동으로 열려요. 안 열리면 위 주소를 브라우저에 직접 입력해 주세요.');
  openBrowser(url);
});

// 포트 충돌 등 listen 실패를 영어 스택트레이스 대신 한국어 안내로 보여준다.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`⚠️  포트가 이미 사용 중이에요. (포트 ${PORT})`);
    console.error('   이미 앱이 켜져 있을 가능성이 커요. 브라우저에서 아래 주소를 먼저 열어 보세요.');
    console.error(`   → http://localhost:${PORT}`);
    console.error('   이미 잘 열린다면 그대로 쓰시면 됩니다.');
    console.error('   그래도 안 되면, 켜져 있는 다른 터미널 창을 닫거나 컴퓨터를 재시작한 뒤 npm start 를 다시 실행해 주세요.');
  } else if (err.code === 'EACCES') {
    console.error(`⚠️  포트 ${PORT} 을(를) 사용할 권한이 없어요. PORT 환경변수로 3456 같은 다른 번호를 지정해 보세요.`);
  } else {
    console.error('⚠️  서버를 시작하지 못했어요.', err.message);
  }
  process.exit(1);
});
