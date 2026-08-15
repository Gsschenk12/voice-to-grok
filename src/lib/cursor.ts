import {
  Agent,
  Cursor,
  CursorAgentError,
  IntegrationNotConnectedError,
} from "@cursor/sdk";
import type { CommandKind } from "@/types/meeting";
import {
  buildAgentPrompt,
  buildPrExecutePrompt,
  buildPrPlanPrompt,
  type AssociatedIssueForPrompt,
} from "@/lib/prompts";

const FALLBACK_MODEL = "composer-2.5";

export type LaunchAgentParams = {
  apiKey: string;
  githubAccessToken?: string;
  kind: CommandKind;
  transcriptWindow: string;
  repoUrl: string;
  startingRef?: string;
  meetingId: string;
};

export type LaunchAgentResult = {
  agentId: string;
  runId: string;
};

export type CloudRepoRef = {
  url: string;
  startingRef?: string;
};

/**
 * Options for a one-shot cloud agent that waits for the final assistant text.
 * Pipeline stages (issue draft, matching, etc.) should prefer this over raw SDK calls.
 */
export type PromptCloudAgentParams = {
  apiKey: string;
  prompt: string;
  /** Model id (e.g. "grok-4.6"). Defaults to resolveModelId(apiKey). */
  modelId?: string;
  /** Repos to clone into the cloud VM. Empty = no-repo agent. */
  repos?: CloudRepoRef[];
  autoCreatePR?: boolean;
  skipReviewerRequest?: boolean;
  envVars?: Record<string, string>;
  metadata?: Record<string, string>;
  /** Short label for logs (e.g. "draft-issue", "issue-match"). */
  logLabel?: string;
  /** Require non-empty result.result; default true. */
  requireResultText?: boolean;
};

export type PromptCloudAgentResult = {
  text: string;
  runId: string;
  durationMs?: number;
};

function wrapCursorAgentError(err: unknown): never {
  if (err instanceof IntegrationNotConnectedError) {
    throw new Error(
      "GitHub integration is not connected for this Cursor key. Open Cursor Integrations and reconnect GitHub.",
    );
  }
  if (err instanceof CursorAgentError) {
    throw new Error(`Cursor agent failed to start: ${err.message}`);
  }
  throw err;
}

const STREAM_GONE = /stream is no longer available/i;
const TRANSIENT_PROMPT_ATTEMPTS = 3;
const TRANSIENT_PROMPT_DELAY_MS = 2000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Dropped run streams and SDK-marked retryable failures are safe to retry. */
export function isTransientCloudAgentFailure(err: unknown): boolean {
  if (err instanceof CursorAgentError && err.isRetryable) return true;
  return STREAM_GONE.test(errorMessage(err));
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTransientRetries<T>(
  fn: () => Promise<T>,
  options: {
    label?: string;
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? TRANSIENT_PROMPT_ATTEMPTS;
  const delayMs = options.delayMs ?? TRANSIENT_PROMPT_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const label = options.label ?? "cloud-prompt";

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientCloudAgentFailure(err) || attempt === attempts) {
        throw err;
      }
      console.warn(`[cursor] ${label} transient failure, retrying`, {
        attempt,
        attempts,
        message: errorMessage(err),
      });
      await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

/** Prefer a grok-named model when available; otherwise fall back. */
export async function resolveModelId(apiKey: string): Promise<string> {
  try {
    const models = await Cursor.models.list({ apiKey });
    const grok = models.find(
      (m) => /grok/i.test(m.id) || /grok/i.test(m.displayName ?? ""),
    );
    if (grok) return grok.id;
    if (models[0]?.id) return models[0].id;
  } catch (err) {
    console.warn("[cursor] models.list failed, using fallback", err);
  }
  return FALLBACK_MODEL;
}

export async function listCursorRepositories(apiKey: string): Promise<Array<{ url: string }>> {
  try {
    const repos = await Cursor.repositories.list({ apiKey });
    const list = Array.isArray(repos) ? repos : [];
    return list.map((r) => ({ url: r.url }));
  } catch (err) {
    if (err instanceof IntegrationNotConnectedError) {
      throw new Error(
        "GitHub is not connected to your Cursor account. Install the Cursor GitHub App, then retry.",
      );
    }
    throw err;
  }
}

/**
 * One-shot cloud Agent.prompt: create, run, wait, dispose.
 * Returns final assistant text. Used by pipeline stages that need a synchronous
 * model response (issue drafting, matching, future steps).
 */
export async function promptCloudAgent(
  params: PromptCloudAgentParams,
): Promise<PromptCloudAgentResult> {
  const {
    apiKey,
    prompt,
    repos = [],
    autoCreatePR = false,
    skipReviewerRequest = true,
    envVars,
    metadata,
    logLabel = "cloud-prompt",
    requireResultText = true,
  } = params;

  const modelId = params.modelId ?? (await resolveModelId(apiKey));

  try {
    return await withTransientRetries(
      async () => {
        const result = await Agent.prompt(prompt, {
          apiKey,
          model: { id: modelId },
          cloud: {
            repos: repos.map((r) => ({
              url: r.url,
              startingRef: r.startingRef ?? "main",
            })),
            autoCreatePR,
            skipReviewerRequest,
            ...(envVars && Object.keys(envVars).length > 0 ? { envVars } : {}),
            ...(metadata ? { metadata } : {}),
          },
        });

        console.info(`[cursor] ${logLabel} finished`, {
          runId: result.id,
          status: result.status,
          modelId,
          durationMs: result.durationMs,
        });

        if (result.status !== "finished") {
          const detail = result.error?.message ?? result.status;
          throw new Error(`${logLabel} agent did not finish: ${detail}`);
        }

        const text = result.result?.trim() ?? "";
        if (requireResultText && !text) {
          throw new Error(`${logLabel} agent returned no result text`);
        }

        return {
          text,
          runId: result.id,
          durationMs: result.durationMs,
        };
      },
      { label: logLabel },
    );
  } catch (err) {
    wrapCursorAgentError(err);
  }
}

/**
 * Fire-and-forget cloud agent for PR / long-running work.
 * Returns agent + run ids immediately; the run continues after dispose.
 */
export async function launchCloudAgent(params: LaunchAgentParams): Promise<LaunchAgentResult> {
  const {
    apiKey,
    githubAccessToken,
    kind,
    transcriptWindow,
    repoUrl,
    startingRef = "main",
    meetingId,
  } = params;

  const modelId = await resolveModelId(apiKey);
  const prompt = buildAgentPrompt(kind, transcriptWindow, repoUrl);

  const envVars: Record<string, string> = {};
  if (githubAccessToken) {
    envVars.GITHUB_TOKEN = githubAccessToken;
    envVars.GH_TOKEN = githubAccessToken;
  }

  try {
    await using agent = await Agent.create({
      apiKey,
      model: { id: modelId },
      cloud: {
        repos: [{ url: repoUrl, startingRef }],
        autoCreatePR: kind === "pr",
        skipReviewerRequest: true,
        ...(Object.keys(envVars).length > 0 ? { envVars } : {}),
        metadata: {
          meeting_id: meetingId,
          command: kind,
        },
      },
    });

    const run = await agent.send(prompt);
    console.info("[cursor] launched", {
      agentId: agent.agentId,
      runId: run.id,
      kind,
      meetingId,
    });

    // Cloud run continues after the SDK handle is disposed; poll via Agent.get.
    void run
      .wait()
      .then((result) => {
        console.info("[cursor] run finished", {
          agentId: agent.agentId,
          runId: run.id,
          status: result.status,
        });
      })
      .catch((err) => {
        console.error("[cursor] run.wait failed", { agentId: agent.agentId, runId: run.id, err });
      });

    return {
      agentId: agent.agentId,
      runId: run.id,
    };
  } catch (err) {
    wrapCursorAgentError(err);
  }
}

export type LaunchPrPlanExecuteParams = {
  apiKey: string;
  githubAccessToken?: string;
  transcriptWindow: string;
  repoUrl: string;
  startingRef?: string;
  meetingId: string;
  issue: AssociatedIssueForPrompt;
};

/**
 * PR path: spawn a cloud agent in plan mode, return ids immediately, then in
 * the background wait for the plan and send an agent-mode execute follow-up
 * with autoCreatePR. Does not change launchCloudAgent / promptCloudAgent.
 */
export async function launchPrPlanExecuteAgent(
  params: LaunchPrPlanExecuteParams,
): Promise<LaunchAgentResult> {
  const {
    apiKey,
    githubAccessToken,
    transcriptWindow,
    repoUrl,
    startingRef = "main",
    meetingId,
    issue,
  } = params;

  const modelId = await resolveModelId(apiKey);
  const planPrompt = buildPrPlanPrompt({ repoUrl, transcriptWindow, issue });
  const executePrompt = buildPrExecutePrompt({ issue });

  const envVars: Record<string, string> = {};
  if (githubAccessToken) {
    envVars.GITHUB_TOKEN = githubAccessToken;
    envVars.GH_TOKEN = githubAccessToken;
  }

  try {
    const agent = await Agent.create({
      apiKey,
      model: { id: modelId },
      mode: "plan",
      cloud: {
        repos: [{ url: repoUrl, startingRef }],
        autoCreatePR: true,
        skipReviewerRequest: true,
        ...(Object.keys(envVars).length > 0 ? { envVars } : {}),
        metadata: {
          meeting_id: meetingId,
          command: "pr",
          issue: `#${issue.number}`,
        },
      },
    });

    const planRun = await agent.send(planPrompt);
    console.info("[cursor] pr plan-execute launched", {
      agentId: agent.agentId,
      runId: planRun.id,
      issue: issue.number,
      meetingId,
    });

    void (async () => {
      try {
        const planResult = await planRun.wait();
        console.info("[cursor] pr plan finished", {
          agentId: agent.agentId,
          runId: planRun.id,
          status: planResult.status,
        });

        if (planResult.status !== "finished") {
          console.error("[cursor] pr plan did not finish; skipping execute", {
            agentId: agent.agentId,
            runId: planRun.id,
            status: planResult.status,
            error: planResult.error?.message,
          });
          return;
        }

        const executeRun = await agent.send(executePrompt, { mode: "agent" });
        console.info("[cursor] pr execute sent", {
          agentId: agent.agentId,
          runId: executeRun.id,
          issue: issue.number,
        });

        void executeRun
          .wait()
          .then((result) => {
            console.info("[cursor] pr execute finished", {
              agentId: agent.agentId,
              runId: executeRun.id,
              status: result.status,
            });
          })
          .catch((err) => {
            console.error("[cursor] pr execute wait failed", {
              agentId: agent.agentId,
              runId: executeRun.id,
              err,
            });
          });
      } catch (err) {
        console.error("[cursor] pr plan-execute background failed", {
          agentId: agent.agentId,
          err,
        });
      } finally {
        await agent[Symbol.asyncDispose]();
      }
    })();

    return {
      agentId: agent.agentId,
      runId: planRun.id,
    };
  } catch (err) {
    wrapCursorAgentError(err);
  }
}

/**
 * One-shot Grok (or catalog fallback) prompt on a no-repo cloud agent.
 * Used by issue matching — does not clone the target repo or edit this app.
 */
export async function promptNoRepoAgent(apiKey: string, prompt: string): Promise<string> {
  const { text } = await promptCloudAgent({
    apiKey,
    prompt,
    repos: [],
    logLabel: "issue-match",
    requireResultText: false,
  });
  return text;
}

export async function getCloudAgentInfo(apiKey: string, agentId: string) {
  return Agent.get(agentId, { apiKey });
}
