/**
 * server.ts — Express 앱 조립 (ARCHITECTURE.md의 HTTP API 표 전부)
 */
import express, { type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isClaudeCliAvailable, runClaude, ClaudeError } from './claude.js';
import * as store from './store.js';
import { listCcSessions } from './ccSessions.js';
import { advise, refineTurn } from './companion.js';
import { listLessons, getLesson } from './lessons.js';

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

// ── 채팅 ──────────────────────────────────────────────────
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const { message, sessionId } = (req.body ?? {}) as {
      message?: unknown;
      sessionId?: unknown;
    };
    if (typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({ error: '메시지를 입력해 주세요.' });
      return;
    }

    let session: store.ChatSession | null = null;
    if (typeof sessionId === 'string' && sessionId !== '') {
      session = await store.getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: '해당 채팅 세션을 찾을 수 없어요.' });
        return;
      }
    }
    if (!session) {
      session = await store.createSession(message);
    }

    const result = await runClaude(message, {
      resumeSessionId: session.claudeSessionId,
    });
    await store.appendTurn(session.id, message, result.text, result.sessionId);

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
    await store.appendTurn(session.id, draft, result.text, result.sessionId);

    res.json({ reply: result.text, sessionId: session.id, costUsd: result.costUsd });
  } catch (err) {
    sendError(res, err);
  }
});

// 알 수 없는 API 경로
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: '존재하지 않는 API 경로예요.' });
});

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT} 에서 실행 중`);
});
