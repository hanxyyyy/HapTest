import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import type { Logger } from 'log4js';
import { HapTestLogger } from '../utils/logger';

export type OperationPageDecision = 'SAME_PAGE' | 'DIFFERENT_PAGE' | 'UNCERTAIN';

export interface LogicalComponentSummary {
    type: string;
    id?: string;
    key?: string;
    text?: string;
    hint?: string;
    interactive: boolean;
    publicLayout: boolean;
    parentTypes: string[];
}

export interface OperationPageSummary {
    valid: boolean;
    invalidReasons: string[];
    bundleName: string;
    abilityName: string;
    pagePath: string;
    rootType: string;
    titleCandidates: string[];
    semanticHeadings: string[];
    visibleTexts: string[];
    stableIds: string[];
    interactiveLabels: string[];
    businessTexts: string[];
    businessInteractiveLabels: string[];
    pageSpecificIds: string[];
    stablePageIds: string[];
    publicIds: string[];
    components: LogicalComponentSummary[];
    collection?: {
        capturedAt?: string;
        deviceId?: string;
        screenSize?: string;
        screenshotPath?: string;
        source?: string;
    };
}

export interface OperationPageLLMInput {
    step?: number;
    phase: 'initial' | 'after_event';
    event?: string;
    history: string[];
    left: OperationPageSummary;
    right: OperationPageSummary;
    leftDevice?: { deviceType?: string; screenSize?: string };
    rightDevice?: { deviceType?: string; screenSize?: string };
    ruleDecision?: OperationPageDecision;
    ruleReason?: string;
    ruleEvidence?: string[];
    triggerReason?: string;
    leftScreenshotDataUrl?: string;
    rightScreenshotDataUrl?: string;
}

export interface OperationPageLLMResult {
    decision: OperationPageDecision;
    reason: string;
    evidence: string[];
    unresolvedIssues: string[];
}

export type OperationPageMessageContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

export interface OperationPageCompletionRequest {
    model: string;
    messages: Array<{ role: 'system' | 'user'; content: OperationPageMessageContent }>;
}

export interface OperationPageCompletionClient {
    complete(request: OperationPageCompletionRequest): Promise<unknown>;
}

export interface LLMOperationPageConfig {
    enabled: boolean;
    baseURL?: string;
    apiKey?: string;
    model?: string;
    timeoutMs: number;
    maxRetries: number;
    useScreenshots?: boolean;
}

export interface LLMOperationPageJudgeOptions {
    config: LLMOperationPageConfig;
    client?: OperationPageCompletionClient;
    logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 2;
const logger = HapTestLogger.getLogger();

function parseBoolean(value: string | undefined): boolean {
    return value?.trim().toLowerCase() === 'true';
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function loadDotEnv(): string | undefined {
    const candidates = [path.resolve(process.cwd(), '.env'), path.resolve(__dirname, '../../.env')];
    const envPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!envPath) {
        return undefined;
    }

    let content: string;
    try {
        content = fs.readFileSync(envPath, 'utf-8');
    } catch {
        return undefined;
    }

    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        const separator = trimmed.indexOf('=');
        if (separator <= 0) {
            continue;
        }
        const key = trimmed.slice(0, separator).trim();
        let value = trimmed.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
    return envPath;
}

export function loadLLMOperationPageConfig(): LLMOperationPageConfig {
    const envPath = loadDotEnv();
    logger.debug(`[operation-page-llm] dotenv=${envPath ? 'loaded' : 'not-found'}`);
    return {
        enabled: parseBoolean(process.env.LLM_ENABLED),
        baseURL: process.env.LLM_BASE_URL?.trim() || undefined,
        apiKey: process.env.LLM_API_KEY?.trim() || undefined,
        model: process.env.LLM_MODEL?.trim() || undefined,
        timeoutMs: parsePositiveInteger(process.env.LLM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
        maxRetries: parseNonNegativeInteger(process.env.LLM_MAX_RETRIES, DEFAULT_MAX_RETRIES),
        useScreenshots: parseBoolean(process.env.LLM_USE_SCREENSHOTS),
    };
}

function getResponseContent(response: unknown): string | undefined {
    if (!response || typeof response !== 'object') {
        return undefined;
    }
    const choices = (response as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0 || !choices[0] || typeof choices[0] !== 'object') {
        return undefined;
    }
    const message = (choices[0] as { message?: unknown }).message;
    if (!message || typeof message !== 'object') {
        return undefined;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        const text = content
            .filter((part): part is { text: string } => Boolean(part) && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string')
            .map((part) => part.text)
            .join('');
        return text || undefined;
    }
    return undefined;
}

function sanitizeResponseForDiagnostics(value: unknown, key = ''): unknown {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.includes('authorization') || normalizedKey.includes('api_key') || normalizedKey.includes('apikey')) {
        return '[REDACTED]';
    }
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeResponseForDiagnostics(item));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeResponseForDiagnostics(entryValue, entryKey)]));
    }
    return value;
}

function serializeResponseForDiagnostics(response: unknown): string {
    try {
        return JSON.stringify(sanitizeResponseForDiagnostics(response));
    } catch {
        return '[unserializable LLM response]';
    }
}

function summarizePageForDiagnostics(summary: OperationPageSummary): Record<string, unknown> {
    return {
        collection: summary.collection,
        valid: summary.valid,
        invalidReasons: summary.invalidReasons,
        bundleName: summary.bundleName,
        abilityName: summary.abilityName,
        pagePath: summary.pagePath,
        titleCandidates: summary.titleCandidates,
        visibleTexts: summary.visibleTexts,
        stablePageIds: summary.stablePageIds,
        pageSpecificIds: summary.pageSpecificIds,
        publicIds: summary.publicIds,
        interactiveLabels: summary.interactiveLabels,
        businessTexts: summary.businessTexts,
        businessInteractiveLabels: summary.businessInteractiveLabels,
    };
}
function parseJudgeResult(content: string): OperationPageLLMResult {
    const normalized = content.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    let parsed: unknown;
    try {
        parsed = JSON.parse(normalized);
    } catch {
        throw new Error('LLM response is not valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('LLM response must be a JSON object.');
    }

    const result = parsed as Record<string, unknown>;
    const decision = result.decision;
    if (decision !== 'SAME_PAGE' && decision !== 'DIFFERENT_PAGE' && decision !== 'UNCERTAIN') {
        throw new Error('LLM response contains an invalid decision.');
    }
    if (typeof result.reason !== 'string' || !result.reason.trim()) {
        throw new Error('LLM response reason must be a string.');
    }
    if (!Array.isArray(result.evidence) || !result.evidence.every((item) => typeof item === 'string')) {
        throw new Error('LLM response evidence must be a string array.');
    }
    if (!Array.isArray(result.unresolvedIssues) || !result.unresolvedIssues.every((item) => typeof item === 'string')) {
        throw new Error('LLM response unresolvedIssues must be a string array.');
    }
    if (decision !== 'UNCERTAIN' && result.evidence.length === 0) {
        throw new Error('LLM response must include evidence for a definite decision.');
    }
    return {
        decision,
        reason: result.reason,
        evidence: result.evidence,
        unresolvedIssues: result.unresolvedIssues,
    };
}

function createOpenAIClient(config: LLMOperationPageConfig): OperationPageCompletionClient {
    const client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        timeout: config.timeoutMs,
        maxRetries: 0,
    });
    return {
        complete: async (request) => {
            return client.chat.completions.create({
                model: request.model,
                temperature: 0,
                messages: request.messages as any,
            });
        },
    };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`LLM request timed out after ${timeoutMs}ms.`)), timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

export class LLMOperationPageJudge {
    private readonly config: LLMOperationPageConfig;
    private readonly client: OperationPageCompletionClient;
    private readonly log: Logger;

    constructor(options: LLMOperationPageJudgeOptions) {
        this.config = options.config;
        this.client = options.client ?? createOpenAIClient(options.config);
        this.log = options.logger ?? logger;
    }

    async judge(input: OperationPageLLMInput): Promise<OperationPageLLMResult> {
        if (!this.config.enabled || !this.config.model) {
            return {
                decision: 'UNCERTAIN',
                reason: 'LLM operation-page judging is disabled or no model is configured.',
                evidence: [],
                unresolvedIssues: ['LLM is not configured for this run.'],
            };
        }

        const { leftScreenshotDataUrl, rightScreenshotDataUrl, ...textInput } = input;
        const prompt = [
            'Determine whether the two device pages represent the same logical operation page or compatible business state.',
            'Do not judge layout quality, pixel similarity, bounds, coordinates, component counts, or visual adaptation as a path fork.',
            'Use bundle, ability, route, stable page identities, titles, visible semantic labels, interactive entries, and the operation context. Treat ordinary page-specific controls and public navigation ids as supporting evidence only.',
            'Return only one JSON object with exactly these fields: decision, reason, evidence, unresolvedIssues.',
            'decision must be exactly one of: SAME_PAGE, DIFFERENT_PAGE, UNCERTAIN. Do not use aliases such as SAME, DIFFERENT, SAME_LOGICAL_PAGE, or DIFFERENT_LOGICAL_PAGE.',
            'reason must be a string; evidence and unresolvedIssues must be arrays of strings.',
            JSON.stringify(textInput),
        ].join('\n');
        const systemMessage = 'You are a conservative operation-page identity judge. Never invent evidence.';
        let includeScreenshots = Boolean(this.config.useScreenshots && (leftScreenshotDataUrl || rightScreenshotDataUrl));
        const buildRequest = (withScreenshots: boolean): OperationPageCompletionRequest => {
            const content: OperationPageMessageContent = withScreenshots
                ? [
                    { type: 'text', text: prompt },
                    ...(leftScreenshotDataUrl ? [{ type: 'image_url' as const, image_url: { url: leftScreenshotDataUrl } }] : []),
                    ...(rightScreenshotDataUrl ? [{ type: 'image_url' as const, image_url: { url: rightScreenshotDataUrl } }] : []),
                ]
                : prompt;
            return {
                model: this.config.model!,
                messages: [
                    { role: 'system', content: systemMessage },
                    { role: 'user', content },
                ],
            };
        };

        const attempts = this.config.maxRetries + 1;
        let lastError = 'LLM request failed.';
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            let rawResponse: unknown;
            const requestStartedAt = Date.now();
            try {
                const request = buildRequest(includeScreenshots);
                this.log.info(`[operation-page-llm] request step=${input.step ?? '?'} phase=${input.phase} attempt=${attempt}/${attempts} screenshots={left:${Boolean(leftScreenshotDataUrl)},right:${Boolean(rightScreenshotDataUrl)}} modelConfigured=${Boolean(this.config.model)} pages=${JSON.stringify({ left: summarizePageForDiagnostics(input.left), right: summarizePageForDiagnostics(input.right) })}`);
                rawResponse = await withTimeout(this.client.complete(request), this.config.timeoutMs);
                const content = getResponseContent(rawResponse);
                if (!content) {
                    throw new Error('LLM response content is empty.');
                }
                const parsed = parseJudgeResult(content);
                this.log.info(`[operation-page-llm] response step=${input.step ?? '?'} phase=${input.phase} attempt=${attempt}/${attempts} elapsedMs=${Date.now() - requestStartedAt} raw=${serializeResponseForDiagnostics(rawResponse)} parsed=${JSON.stringify(parsed)}`);
                return parsed;
            } catch (error) {
                const message = error instanceof Error ? error.message : 'LLM request failed.';
                const responseDetails = rawResponse === undefined ? '' : ` Response=${serializeResponseForDiagnostics(rawResponse)}`;
                lastError = `${message}${responseDetails}`;
                this.log.warn(`[operation-page-llm] response step=${input.step ?? '?'} phase=${input.phase} attempt=${attempt}/${attempts} elapsedMs=${Date.now() - requestStartedAt} error=${lastError}`);
                if (includeScreenshots) {
                    includeScreenshots = false;
                    attempt = 0;
                    this.log.warn('[operation-page-llm] image request failed; retrying with text-only page summaries.');
                    continue;
                }
                this.log.warn(`[operation-page-llm] request failed attempt=${attempt}/${attempts}: ${lastError}`);
            }
        }

        return {
            decision: 'UNCERTAIN',
            reason: 'LLM operation-page judging failed.',
            evidence: [],
            unresolvedIssues: [lastError],
        };
    }

    static createFromEnvironment(): { judge?: LLMOperationPageJudge; unavailableReason?: string; useScreenshots: boolean } {
        const config = loadLLMOperationPageConfig();
        logger.info(`[operation-page-llm] config enabled=${config.enabled} baseURLConfigured=${Boolean(config.baseURL)} modelConfigured=${Boolean(config.model)} apiKeyConfigured=${Boolean(config.apiKey)} timeoutMs=${config.timeoutMs} maxRetries=${config.maxRetries} screenshots=${Boolean(config.useScreenshots)}`);
        if (!config.enabled) {
            return { useScreenshots: Boolean(config.useScreenshots) };
        }
        if (!config.apiKey || !config.baseURL || !config.model) {
            return {
                unavailableReason: 'LLM_ENABLED=true but LLM_BASE_URL, LLM_API_KEY, or LLM_MODEL is missing.',
                useScreenshots: Boolean(config.useScreenshots),
            };
        }
        return { judge: new LLMOperationPageJudge({ config }), useScreenshots: Boolean(config.useScreenshots) };
    }
}
