import type { BackupConfig, JiraIssue, JiraComment, CommentPage, SearchResponse } from './types.js';

export function createAuthHeader(cfg: BackupConfig): string {
  return `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// TODO: migrate to /search/jql + nextPageToken when Atlassian deprecates /rest/api/3/search
export async function fetchIssuePage(
  cfg: BackupConfig,
  startAt: number,
  maxResults = 100,
): Promise<SearchResponse> {
  const url = new URL(`${cfg.baseUrl}/rest/api/3/search`);
  url.searchParams.set('jql', `project="${cfg.projectKey}" ORDER BY created ASC`);
  url.searchParams.set('startAt', String(startAt));
  url.searchParams.set('maxResults', String(maxResults));
  url.searchParams.set('fields', '*all');
  url.searchParams.set('expand', 'renderedFields,names');

  const authHeader = createAuthHeader(cfg);

  let attempt = 0;
  const maxRetries = 3;

  while (attempt <= maxRetries) {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    });

    if (res.ok) {
      return res.json() as Promise<SearchResponse>;
    }

    if (res.status === 401) {
      throw new Error(
        `Auth failed (401): check JIRA_EMAIL / JIRA_API_TOKEN — URL: ${url.toString()}`,
      );
    }

    if (res.status === 429) {
      if (attempt >= maxRetries) {
        throw new Error(`Rate limited (429) after ${maxRetries} retries — giving up.`);
      }
      const retryAfter = res.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * Math.pow(2, attempt);
      console.warn(`[jira-client] 429 rate limit — waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`);
      await sleep(waitMs);
      attempt++;
      continue;
    }

    // Other 4xx / 5xx
    const body = await res.text().catch(() => '');
    throw new Error(
      `HTTP ${res.status} from Jira — ${body.slice(0, 200)}`,
    );
  }

  throw new Error('fetchIssuePage: exhausted retry loop unexpectedly');
}

export async function fetchAllIssues(
  cfg: BackupConfig,
  onProgress?: (fetched: number, total: number) => void,
): Promise<JiraIssue[]> {
  const allIssues: JiraIssue[] = [];
  let startAt = 0;

  while (true) {
    const page = await fetchIssuePage(cfg, startAt);
    const { total, issues } = page;

    if (issues.length === 0) {
      // Infinite-loop guard: stop if server returns empty page
      break;
    }

    allIssues.push(...issues);
    startAt += issues.length;

    if (onProgress) {
      onProgress(allIssues.length, total);
    }

    if (startAt >= total) {
      break;
    }
  }

  return allIssues;
}

async function fetchCommentPage(
  cfg: BackupConfig,
  issueKey: string,
  startAt: number,
  maxResults = 100,
): Promise<CommentPage> {
  const url = new URL(`${cfg.baseUrl}/rest/api/3/issue/${issueKey}/comment`);
  url.searchParams.set('startAt', String(startAt));
  url.searchParams.set('maxResults', String(maxResults));
  url.searchParams.set('expand', 'renderedBody');

  const authHeader = createAuthHeader(cfg);

  let attempt = 0;
  const maxRetries = 3;

  while (attempt <= maxRetries) {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    });

    if (res.ok) {
      return res.json() as Promise<CommentPage>;
    }

    if (res.status === 401) {
      throw new Error(
        `Auth failed (401): check JIRA_EMAIL / JIRA_API_TOKEN — URL: ${url.toString()}`,
      );
    }

    if (res.status === 429) {
      if (attempt >= maxRetries) {
        throw new Error(`Rate limited (429) after ${maxRetries} retries — giving up.`);
      }
      const retryAfter = res.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * Math.pow(2, attempt);
      console.warn(`[jira-client] 429 rate limit — waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`);
      await sleep(waitMs);
      attempt++;
      continue;
    }

    // Other 4xx / 5xx
    const body = await res.text().catch(() => '');
    throw new Error(
      `HTTP ${res.status} from Jira — ${body.slice(0, 200)}`,
    );
  }

  throw new Error('fetchCommentPage: exhausted retry loop unexpectedly');
}

export async function fetchAllComments(
  cfg: BackupConfig,
  issueKey: string,
): Promise<JiraComment[]> {
  try {
    const allComments: JiraComment[] = [];
    let startAt = 0;

    while (true) {
      const page = await fetchCommentPage(cfg, issueKey, startAt);
      const { total, comments } = page;

      if (comments.length === 0) {
        // Infinite-loop guard: stop if server returns empty page
        break;
      }

      allComments.push(...comments);
      startAt += comments.length;

      if (startAt >= total) {
        break;
      }
    }

    return allComments;
  } catch (err) {
    console.warn(`[jira-client] failed to fetch comments for ${issueKey}: ${String(err)}`);
    return [];
  }
}
