import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import type { BackupConfig } from './types.js';
import { fetchAllIssues, fetchAllComments } from './jira-client.js';
import { downloadAttachment, downloadCommentMedia, extractAttachmentIdsFromHtml } from './downloader.js';

function loadConfig(): BackupConfig {
  const required = [
    'JIRA_BASE_URL',
    'JIRA_EMAIL',
    'JIRA_API_TOKEN',
    'JIRA_PROJECT_KEY',
  ] as const;

  for (const key of required) {
    if (!process.env[key]) {
      console.error(`Missing required env: ${key}`);
      process.exit(1);
    }
  }

  return {
    baseUrl: process.env.JIRA_BASE_URL!,
    email: process.env.JIRA_EMAIL!,
    apiToken: process.env.JIRA_API_TOKEN!,
    projectKey: process.env.JIRA_PROJECT_KEY!,
  };
}

function buildOutputDir(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const timestamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}-${pad(now.getMinutes())}`;
  return `output/${timestamp}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const cfg = loadConfig();

  const outputDir = buildOutputDir();
  const attachmentsDir = `${outputDir}/attachments`;

  console.log(`[backup] Output directory: ${outputDir}`);
  console.log(`[backup] Project: ${cfg.projectKey}`);

  // Fetch all issues with progress logging
  console.log('[backup] Fetching issues...');
  const issues = await fetchAllIssues(cfg, (fetched, total) => {
    console.log(`[backup] Fetched ${fetched}/${total} issues`);
  });

  console.log(`[backup] Total issues fetched: ${issues.length}`);

  // Fetch and embed comments per issue
  console.log('[backup] Fetching comments per issue...');
  const total = issues.length;
  for (let i = 0; i < total; i++) {
    const issue = issues[i]!;
    console.log(`[backup] [${i + 1}/${total}] fetching comments for ${issue.key}`);
    issue.comments = await fetchAllComments(cfg, issue.key);
    if (i < total - 1) {
      await sleep(150);
    }
  }

  // Persist issues.json (now includes embedded comments)
  await mkdir(outputDir, { recursive: true });
  const issuesJsonPath = `${outputDir}/issues.json`;
  await writeFile(issuesJsonPath, JSON.stringify(issues, null, 2), 'utf-8');
  console.log(`[backup] issues.json written → ${issuesJsonPath}`);

  // Build run-wide dedup set seeded with issue-level attachment IDs
  const seenAttachmentIds = new Set<string>();
  for (const issue of issues) {
    for (const att of issue.fields.attachment ?? []) {
      seenAttachmentIds.add(att.id);
    }
  }

  // Collect all attachments with their issueKey
  const attachmentJobs = issues.flatMap((issue) => {
    const attachments = issue.fields.attachment ?? [];
    return attachments.map((att) => ({ att, issueKey: issue.key }));
  });

  console.log(`[backup] Attachments to download: ${attachmentJobs.length}`);

  let downloaded = 0;
  let failed = 0;

  for (let i = 0; i < attachmentJobs.length; i++) {
    const { att, issueKey } = attachmentJobs[i]!;
    const result = await downloadAttachment(cfg, att, issueKey, attachmentsDir);

    if (result.ok) {
      downloaded++;
      console.log(`[backup] Downloaded [${downloaded}/${attachmentJobs.length}] ${issueKey}/${result.filename}`);
    } else {
      failed++;
      console.warn(`[backup] WARN: Failed to download ${issueKey}/${att.filename} — ${result.error}`);
    }

    // Sleep between downloads to stay under rate limits (skip after last item)
    if (i < attachmentJobs.length - 1) {
      await sleep(150);
    }
  }

  // Build and download comment-media jobs (deduplicated against issue-level attachments)
  const commentMediaJobs: { id: string; issueKey: string }[] = [];
  for (const issue of issues) {
    for (const comment of issue.comments ?? []) {
      for (const id of extractAttachmentIdsFromHtml(comment.renderedBody)) {
        if (!seenAttachmentIds.has(id)) {
          seenAttachmentIds.add(id);
          commentMediaJobs.push({ id, issueKey: issue.key });
        }
      }
    }
  }

  console.log(`[backup] Comment media to download: ${commentMediaJobs.length}`);

  let commentMediaDownloaded = 0;
  let commentMediaFailed = 0;

  for (let i = 0; i < commentMediaJobs.length; i++) {
    const { id, issueKey } = commentMediaJobs[i]!;
    const result = await downloadCommentMedia(cfg, id, issueKey, attachmentsDir);

    if (result.ok) {
      commentMediaDownloaded++;
      console.log(
        `[backup] Comment media downloaded [${commentMediaDownloaded}/${commentMediaJobs.length}] ${issueKey}/comment-media/${result.filename}`,
      );
    } else {
      commentMediaFailed++;
      console.warn(
        `[backup] WARN: Failed to download comment media ${issueKey}/attachment-${id} — ${result.error}`,
      );
    }

    // Sleep between downloads to stay under rate limits (skip after last item)
    if (i < commentMediaJobs.length - 1) {
      await sleep(150);
    }
  }

  // Final summary
  console.log(
    `\n[backup] Done — ${issues.length} issues, ${downloaded} attachments downloaded, ${failed} failed, ${commentMediaDownloaded} comment media downloaded, ${commentMediaFailed} comment media failed`,
  );

  if (failed > 0) {
    console.warn(`[backup] ${failed} attachment(s) could not be downloaded. Check logs above.`);
  }

  if (commentMediaFailed > 0) {
    console.warn(`[backup] ${commentMediaFailed} comment media file(s) could not be downloaded. Check logs above.`);
  }
}

// T-5.4: Smoke test — copy .env.example to .env, fill real credentials, then run: pnpm start
// Verify: output/{timestamp}/issues.json is valid JSON, attachments exist under attachments/{issueKey}/

run()
  .then(() => process.exit(0))
  .catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
