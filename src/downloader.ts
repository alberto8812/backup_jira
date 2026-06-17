import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { BackupConfig, JiraAttachment, DownloadResult } from './types.js';
import { createAuthHeader } from './jira-client.js';

const ATTACHMENT_CONTENT_RE = /\/rest\/api\/3\/attachment\/content\/(\d+)/g;

export function extractAttachmentIdsFromHtml(html: string | undefined): string[] {
  if (!html) return [];
  const ids = new Set<string>();
  for (const m of html.matchAll(ATTACHMENT_CONTENT_RE)) {
    ids.add(m[1]!);
  }
  return [...ids];
}

export function sanitizeFilename(name: string): string {
  return (
    name
      // Remove null bytes
      .replace(/\0/g, '_')
      // Remove control characters (0x00–0x1F and 0x7F)
      .replace(/[\x00-\x1f\x7f]/g, '_')
      // Remove path traversal sequences
      .replace(/\.\./g, '_')
      // Remove forward and backward slashes
      .replace(/[/\\]/g, '_')
      // Collapse multiple underscores to one (cosmetic)
      .replace(/_+/g, '_')
      // Trim leading/trailing underscores
      .replace(/^_+|_+$/g, '')
      // Fallback: empty result becomes 'unnamed'
      || 'unnamed'
  );
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function downloadAttachment(
  cfg: BackupConfig,
  att: JiraAttachment,
  issueKey: string,
  baseDir: string,
): Promise<DownloadResult> {
  const safeFilename = sanitizeFilename(att.filename);
  const issueDir = `${baseDir}/${issueKey}`;

  try {
    await ensureDir(issueDir);
  } catch (err) {
    return {
      issueKey,
      filename: safeFilename,
      ok: false,
      error: `Failed to create directory ${issueDir}: ${String(err)}`,
    };
  }

  const destPath = `${issueDir}/${safeFilename}`;
  const authHeader = createAuthHeader(cfg);

  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;

    try {
      res = await fetch(att.content, {
        headers: {
          Authorization: authHeader,
        },
      });
    } catch (err) {
      if (attempt >= maxRetries) {
        return {
          issueKey,
          filename: safeFilename,
          ok: false,
          error: `Network error after ${maxRetries} retries: ${String(err)}`,
        };
      }
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }

    if (res.status === 429) {
      if (attempt >= maxRetries) {
        return {
          issueKey,
          filename: safeFilename,
          ok: false,
          error: `Rate limited (429) after ${maxRetries} retries — skipping ${att.filename}`,
        };
      }
      const retryAfter = res.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * Math.pow(2, attempt);
      console.warn(
        `[downloader] 429 for ${att.filename} — waiting ${waitMs}ms (retry ${attempt + 1}/${maxRetries})`,
      );
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      return {
        issueKey,
        filename: safeFilename,
        ok: false,
        error: `HTTP ${res.status} downloading ${att.filename}`,
      };
    }

    if (!res.body) {
      return {
        issueKey,
        filename: safeFilename,
        ok: false,
        error: `Empty response body for ${att.filename}`,
      };
    }

    try {
      const writeStream = fs.createWriteStream(destPath);
      // Node 18+ ReadableStream (web) → use pipeline from node:stream/promises
      // response.body is a Web ReadableStream; cast via unknown for TS compatibility
      await pipeline(res.body as unknown as NodeJS.ReadableStream, writeStream);

      return { issueKey, filename: safeFilename, ok: true };
    } catch (err) {
      return {
        issueKey,
        filename: safeFilename,
        ok: false,
        error: `Write error for ${att.filename}: ${String(err)}`,
      };
    }
  }

  // Should never reach here
  return {
    issueKey,
    filename: safeFilename,
    ok: false,
    error: 'Exhausted retry loop unexpectedly',
  };
}

function filenameFromContentDisposition(header: string | null, fallbackId: string): string {
  if (header) {
    // RFC 5987 filename*=UTF-8''... preferred
    const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
    if (star?.[1]) return sanitizeFilename(decodeURIComponent(star[1].replace(/^"|"$/g, '')));
    // Plain filename="..."
    const plain = /filename="?([^";]+)"?/i.exec(header);
    if (plain?.[1]) return sanitizeFilename(plain[1]);
  }
  return sanitizeFilename(`attachment-${fallbackId}`);
}

export async function downloadCommentMedia(
  cfg: BackupConfig,
  attachmentId: string,
  issueKey: string,
  baseDir: string,
): Promise<DownloadResult> {
  const mediaDir = `${baseDir}/${issueKey}/comment-media`;

  try {
    await ensureDir(mediaDir);
  } catch (err) {
    return {
      issueKey,
      filename: `attachment-${attachmentId}`,
      ok: false,
      error: `Failed to create directory ${mediaDir}: ${String(err)}`,
    };
  }

  const url = `${cfg.baseUrl}/rest/api/3/attachment/content/${attachmentId}`;
  const authHeader = createAuthHeader(cfg);

  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;

    try {
      res = await fetch(url, {
        headers: {
          Authorization: authHeader,
        },
      });
    } catch (err) {
      if (attempt >= maxRetries) {
        return {
          issueKey,
          filename: `attachment-${attachmentId}`,
          ok: false,
          error: `Network error after ${maxRetries} retries: ${String(err)}`,
        };
      }
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }

    if (res.status === 429) {
      if (attempt >= maxRetries) {
        return {
          issueKey,
          filename: `attachment-${attachmentId}`,
          ok: false,
          error: `Rate limited (429) after ${maxRetries} retries — skipping attachment-${attachmentId}`,
        };
      }
      const retryAfter = res.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * Math.pow(2, attempt);
      console.warn(
        `[downloader] 429 for attachment-${attachmentId} — waiting ${waitMs}ms (retry ${attempt + 1}/${maxRetries})`,
      );
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      return {
        issueKey,
        filename: `attachment-${attachmentId}`,
        ok: false,
        error: `HTTP ${res.status} downloading comment media attachment-${attachmentId} for ${issueKey}`,
      };
    }

    if (!res.body) {
      return {
        issueKey,
        filename: `attachment-${attachmentId}`,
        ok: false,
        error: `Empty response body for comment media attachment-${attachmentId}`,
      };
    }

    const filename = filenameFromContentDisposition(res.headers.get('Content-Disposition'), attachmentId);
    const destPath = `${mediaDir}/${filename}`;

    try {
      const writeStream = fs.createWriteStream(destPath);
      await pipeline(res.body as unknown as NodeJS.ReadableStream, writeStream);

      return { issueKey, filename, ok: true };
    } catch (err) {
      return {
        issueKey,
        filename,
        ok: false,
        error: `Write error for comment media attachment-${attachmentId}: ${String(err)}`,
      };
    }
  }

  // Should never reach here
  return {
    issueKey,
    filename: `attachment-${attachmentId}`,
    ok: false,
    error: 'Exhausted retry loop unexpectedly',
  };
}
