export interface BackupConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  content: string; // download URL
  mimeType: string;
  size: number;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    assignee: { displayName: string } | null;
    reporter: { displayName: string } | null;
    created: string;
    updated: string;
    description: unknown;
    attachment: JiraAttachment[];
    [key: string]: unknown;
  };
  renderedFields?: Record<string, unknown>;
  names?: Record<string, string>;
}

export interface SearchResponse {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssue[];
}

export interface DownloadResult {
  issueKey: string;
  filename: string;
  ok: boolean;
  error?: string;
}
