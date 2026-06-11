/**
 * lessons.ts — docs/learn/*.md 레슨 목록/읽기
 *
 * - 파일명 규칙: NN-slug.md (NN이 order)
 * - 제목: frontmatter 없이 파일의 첫 `# 제목` 줄
 * - docs/learn 가 아직 없거나 비어 있어도 빈 목록으로 동작 (콘텐츠가 병렬로 만들어지는 중)
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LessonInfo {
  slug: string;
  title: string;
  order: number;
}

const LEARN_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs',
  'learn'
);

const FILE_RE = /^(\d+)-(.+)\.md$/;

function extractTitle(markdown: string, fallback: string): string {
  for (const line of markdown.split('\n')) {
    const m = line.match(/^#\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return fallback;
}

/** 레슨 목록 (order 오름차순). 디렉터리/파일이 없으면 빈 배열. */
export async function listLessons(): Promise<LessonInfo[]> {
  let files: string[] = [];
  try {
    files = await fs.readdir(LEARN_DIR);
  } catch {
    return [];
  }

  const lessons: LessonInfo[] = [];
  for (const file of files) {
    const m = file.match(FILE_RE);
    if (!m) continue;
    const order = parseInt(m[1], 10);
    const slug = m[2];
    let title = slug;
    try {
      const md = await fs.readFile(path.join(LEARN_DIR, file), 'utf8');
      title = extractTitle(md, slug);
    } catch {
      // 읽기 실패한 파일은 slug를 제목으로
    }
    lessons.push({ slug, title, order });
  }
  lessons.sort((a, b) => a.order - b.order);
  return lessons;
}

/** 레슨 한 개 읽기. 없으면 null. */
export async function getLesson(
  slug: string
): Promise<{ slug: string; title: string; markdown: string } | null> {
  // 경로 탈출 방지
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) return null;

  let files: string[] = [];
  try {
    files = await fs.readdir(LEARN_DIR);
  } catch {
    return null;
  }

  const file = files.find((f) => {
    const m = f.match(FILE_RE);
    return m !== null && m[2] === slug;
  });
  if (!file) return null;

  try {
    const markdown = await fs.readFile(path.join(LEARN_DIR, file), 'utf8');
    return { slug, title: extractTitle(markdown, slug), markdown };
  } catch {
    return null;
  }
}
