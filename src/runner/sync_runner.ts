/*
 * Copyright (c) 2024 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import fs from 'fs';
import path from 'path';
import { Device } from '../device/device';
import { EventBuilder } from '../event/event_builder';
import { Event } from '../event/event';
import { ExitEvent } from '../event/system_event';
import { WaitEvent } from '../event/wait_event';
import { FuzzOptions } from './fuzz_options';
import { EnvChecker } from '../cli/env_checker';
import { HapTestLogger, LOG_LEVEL } from '../utils/logger';
import { PolicyBuilder } from '../policy/policy_builder';
import { Policy } from '../policy/policy';
import { Page } from '../model/page';
import { Hap } from '../model/hap';
import { EventAction } from './event_action';
import { LLMOperationPageJudge, OperationPageDecision } from './llm_operation_page_judge';
import { OperationPageCheckResult, OperationPageChecker } from './operation_page_checker';

const logger = HapTestLogger.getLogger();
const EVENT_INTERVAL = 1000;
const PAGE_CHECK_RETRY_LIMIT = 2;
const PAGE_CHECK_RETRY_DELAY = 300;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type SyncStatus = 'COMPLETED' | 'DIVERGED' | 'UNCERTAIN' | 'COLLECTION_FAILED' | 'ERROR';
export type SyncDecisionAction = 'CONTINUE' | 'STOP_DIVERGED' | 'STOP_UNCERTAIN';

export interface SyncResult {
    consistent: boolean;
    steps: number;
    firstMismatchStep?: number;
    leftPageSig: string;
    rightPageSig: string;
    reason?: string;
    status?: SyncStatus;
    operationPageDecision?: OperationPageDecision;
    operationPageSource?: OperationPageCheckResult['source'];
    operationPageRule?: OperationPageCheckResult['rule'];
    operationPageEvidence?: string[];
    operationPageUnresolvedIssues?: string[];
    leftPageSummary?: OperationPageCheckResult['leftSummary'];
    rightPageSummary?: OperationPageCheckResult['rightSummary'];
}

interface SyncDeviceContext {
    device: Device;
    options: FuzzOptions;
    hap: Hap;
    page: Page;
}

interface PagePairEvaluation {
    leftPage: Page;
    rightPage: Page;
    check: OperationPageCheckResult;
}

export function getSyncDecisionAction(decision: OperationPageDecision): SyncDecisionAction {
    if (decision === 'SAME_PAGE') return 'CONTINUE';
    if (decision === 'DIFFERENT_PAGE') return 'STOP_DIVERGED';
    return 'STOP_UNCERTAIN';
}

function cloneEvent(event: Event): Event {
    return EventBuilder.createEventFromJson(JSON.parse(event.toString()));
}

function createDeviceOptions(baseOptions: any, connectkey: string, outputDir: string): FuzzOptions {
    return {
        connectkey,
        hap: baseOptions.hap,
        policyName: baseOptions.policy,
        output: outputDir,
        coverage: baseOptions.coverage,
        reportRoot: baseOptions.report,
        excludes: baseOptions.exclude,
        llm: false,
        simK: Number(baseOptions.simK),
        staticConfig: baseOptions.staticConfig,
        startFromCurrentPage: baseOptions.fromCurrentPage !== false,
        deviceType: baseOptions.deviceType,
    };
}

async function initializeDevice(deviceOptions: FuzzOptions): Promise<SyncDeviceContext> {
    const device = new Device(deviceOptions);
    const envChecker = new EnvChecker(deviceOptions);
    envChecker.check();
    deviceOptions.deviceType = device.getDeviceType();
    const hap = device.buildHap(deviceOptions.sourceRoot, deviceOptions.hapFile, deviceOptions.bundleName);
    await device.connect(hap);
    const page = await device.getCurrentPage(hap, true);
    return { device, options: deviceOptions, hap, page };
}

export function compareSyncPages(leftPage: Page, rightPage: Page): OperationPageCheckResult & { consistent: boolean } {
    const targetBundle = leftPage.getBundleName() || rightPage.getBundleName();
    const checker = new OperationPageChecker({ targetBundleName: targetBundle });
    const check = checker.checkRules(leftPage, rightPage);
    return { ...check, consistent: check.decision === 'SAME_PAGE' };
}

async function stopDevice(device: Device): Promise<void> {
    try {
        await device.disconnect();
    } catch {
        // cleanup must not replace the original sync result
    }
}

function saveAndPrintResult(outputDir: string, result: SyncResult): SyncResult {
    fs.writeFileSync(path.join(outputDir, 'sync-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    return result;
}

function resultFromCheck(steps: number, check: OperationPageCheckResult, status: SyncStatus, reason: string, firstMismatchStep?: number): SyncResult {
    const result: SyncResult = {
        consistent: check.decision === 'SAME_PAGE',
        steps,
        firstMismatchStep,
        leftPageSig: check.leftPageSig,
        rightPageSig: check.rightPageSig,
        reason,
        status,
        operationPageDecision: check.decision,
        operationPageSource: check.source,
        operationPageRule: check.rule,
        operationPageEvidence: check.evidence,
        operationPageUnresolvedIssues: check.unresolvedIssues,
        leftPageSummary: check.leftSummary,
        rightPageSummary: check.rightSummary,
    };
    if (firstMismatchStep === undefined) delete result.firstMismatchStep;
    return result;
}

async function evaluatePagePair(
    checker: OperationPageChecker,
    left: SyncDeviceContext,
    right: SyncDeviceContext,
    leftPage: Page,
    rightPage: Page,
    context: { step?: number; phase: 'initial' | 'after_event'; event?: string; history: string[]; collectionSource?: string }
): Promise<PagePairEvaluation> {
    let currentLeftPage = leftPage;
    let currentRightPage = rightPage;
    const judgeContext = { ...context, leftDevice: { deviceType: left.options.deviceType, screenSize: left.device.getWidth() + 'x' + left.device.getHeight(), deviceId: left.device.getUdid() }, rightDevice: { deviceType: right.options.deviceType, screenSize: right.device.getWidth() + 'x' + right.device.getHeight(), deviceId: right.device.getUdid() } };
    let check: OperationPageCheckResult;
    if (context.phase === 'after_event') {
        try {
            const pages = await Promise.all([left.device.getCurrentPage(left.hap, true), right.device.getCurrentPage(right.hap, true)]);
            currentLeftPage = pages[0];
            currentRightPage = pages[1];
            logger.debug(`[sync-page-check] step=${context.step ?? '?'} phase=after_event recollected latest pages before comparison.`);
        } catch (error) {
            check = checker.checkRules(currentLeftPage, currentRightPage);
            check.source = 'COLLECTION';
            check.decision = 'UNCERTAIN';
            check.reason = 'Latest page collection failed before the after-event operation-page comparison.';
            check.unresolvedIssues = [...check.unresolvedIssues, String(error)];
            logger.warn(`[sync-page-check] step=${context.step ?? '?'} phase=after_event final=UNCERTAIN action=STOP_UNCERTAIN source=COLLECTION error=${String(error)}`);
            return { leftPage: currentLeftPage, rightPage: currentRightPage, check };
        }
    }
    check = await checker.check(currentLeftPage, currentRightPage, judgeContext);
    for (let attempt = 0; attempt < PAGE_CHECK_RETRY_LIMIT && check.decision === 'UNCERTAIN'; attempt += 1) {
        await sleep(PAGE_CHECK_RETRY_DELAY);
        try {
            const pages = await Promise.all([left.device.getCurrentPage(left.hap, true), right.device.getCurrentPage(right.hap, true)]);
            currentLeftPage = pages[0];
            currentRightPage = pages[1];
            check = await checker.check(currentLeftPage, currentRightPage, judgeContext);
        } catch (error) {
            check = {
                ...check,
                source: 'COLLECTION',
                reason: 'Page recollection failed while resolving an uncertain operation-page decision.',
                unresolvedIssues: [...check.unresolvedIssues, String(error)],
            };
            break;
        }
    }
    logger.info(`[sync-page-check] step=${context.step ?? '?'} phase=${context.phase} final=${check.decision} action=${getSyncDecisionAction(check.decision)} rule=${check.rule} source=${check.source}`);
    return { leftPage: currentLeftPage, rightPage: currentRightPage, check };
}

function isCollectionFailure(error: unknown): boolean {
    const message = String(error);
    return /captureLayout|layout collection|unable to find target page|foreground page|target bundle|page collection/i.test(message);
}

export async function runSyncCommand(options: any): Promise<SyncResult> {
    const outputDir = path.resolve(options.output ?? 'out/sync');
    fs.mkdirSync(outputDir, { recursive: true });
    HapTestLogger.configure(path.join(outputDir, 'haptest.log'), options.debug ? LOG_LEVEL.DEBUG : LOG_LEVEL.INFO);

    if (options.llm) {
        throw new Error('sync command does not support --llm. Use a deterministic policy for lockstep execution.');
    }
    const hapList: string[] = Array.isArray(options.hap) ? options.hap : options.hap != null ? [options.hap] : [];
    if (hapList.length !== 1) throw new Error('sync command requires exactly one -i/--hap value shared by both devices.');

    const sharedHap = hapList[0];
    const leftOptions = createDeviceOptions({ ...options, hap: sharedHap }, options.left, path.join(outputDir, 'left'));
    const rightOptions = createDeviceOptions({ ...options, hap: sharedHap }, options.right, path.join(outputDir, 'right'));
    const initialized = await Promise.allSettled([
        initializeDevice(leftOptions),
        initializeDevice(rightOptions),
    ]);
    if (initialized[0].status !== 'fulfilled' || initialized[1].status !== 'fulfilled') {
        const failures = initialized
            .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
            .map((item) => String(item.reason));
        const checker = new OperationPageChecker({ targetBundleName: sharedHap });
        const check = checker.checkRules(undefined, undefined);
        check.unresolvedIssues.push('Initial device/page collection failed before operation-page comparison.', ...failures);
        const contexts = initialized
            .filter((item): item is PromiseFulfilledResult<SyncDeviceContext> => item.status === 'fulfilled')
            .map((item) => item.value);
        await Promise.all(contexts.map((context) => stopDevice(context.device)));
        return saveAndPrintResult(outputDir, resultFromCheck(
            0,
            check,
            'COLLECTION_FAILED',
            'Initial device or page collection failed before operation-page comparison.',
        ));
    }
    const left = initialized[0].value;
    const right = initialized[1].value;
    const llm = LLMOperationPageJudge.createFromEnvironment();
    const checker = new OperationPageChecker({ targetBundleName: left.hap.bundleName, llmJudge: llm.judge, llmUnavailableReason: llm.unavailableReason, includeScreenshots: llm.useScreenshots });

    let steps = 0;
    let currentLeftPage = left.page;
    let currentRightPage = right.page;
    const history: string[] = [];
    const initial = await evaluatePagePair(checker, left, right, currentLeftPage, currentRightPage, { step: 0, phase: 'initial', history, collectionSource: 'current_initial_collection' });
    currentLeftPage = initial.leftPage;
    currentRightPage = initial.rightPage;
    let lastCheck = initial.check;
    if (getSyncDecisionAction(initial.check.decision) !== 'CONTINUE') {
        await Promise.all([stopDevice(left.device), stopDevice(right.device)]);
        const status: SyncStatus = initial.check.source === 'COLLECTION' ? 'COLLECTION_FAILED' : 'UNCERTAIN';
        const actualStatus: SyncStatus = initial.check.decision === 'DIFFERENT_PAGE' ? 'DIVERGED' : status;
        const reason = initial.check.decision === 'DIFFERENT_PAGE' ? 'Initial operation pages are different.' : 'Initial operation page could not be determined.';
        return saveAndPrintResult(outputDir, resultFromCheck(steps, initial.check, actualStatus, reason, initial.check.decision === 'DIFFERENT_PAGE' ? 0 : undefined));
    }

    const policy: Policy = PolicyBuilder.buildPolicyByName(left.device, left.hap, left.options);
    while (policy.enabled) {
        const event = await policy.generateEvent(currentLeftPage);
        if (event instanceof WaitEvent) {
            await sleep(1500);
            continue;
        }
        if (event instanceof ExitEvent) break;

        const leftEvent = event;
        const rightEvent = cloneEvent(event);
        const leftAction = new EventAction(left.device, left.hap, currentLeftPage, leftEvent, left.options.deviceType);
        const rightAction = new EventAction(right.device, right.hap, currentRightPage, rightEvent, right.options.deviceType);
        try {
            const starts = await Promise.allSettled([leftAction.start(), rightAction.start()]);
            const startFailure = starts.find((item): item is PromiseRejectedResult => item.status === 'rejected');
            if (startFailure) throw startFailure.reason;
            await sleep(EVENT_INTERVAL);
            const stops = await Promise.allSettled([leftAction.stop(), rightAction.stop()]);
            const stopFailure = stops.find((item): item is PromiseRejectedResult => item.status === 'rejected');
            if (stopFailure) throw stopFailure.reason;
        } catch (error) {
            await Promise.all([stopDevice(left.device), stopDevice(right.device)]);
            const failed = compareSyncPages(leftAction.transition.from, rightAction.transition.from);
            const status: SyncStatus = isCollectionFailure(error) ? 'COLLECTION_FAILED' : 'ERROR';
            return saveAndPrintResult(outputDir, resultFromCheck(steps, { ...failed, source: 'COLLECTION', decision: 'UNCERTAIN', reason: `Event execution failed: ${String(error)}`, unresolvedIssues: [...failed.unresolvedIssues, String(error)] }, status, `Event execution failed: ${String(error)}`, steps + 1));
        }

        steps += 1;
        const eventText = leftEvent.toString();
        history.push(eventText);
        if (history.length > 10) history.shift();
        const after = await evaluatePagePair(checker, left, right, leftAction.transition.to, rightAction.transition.to, { step: steps, phase: 'after_event', event: eventText, history, collectionSource: 'current_after_event_collection' });
        currentLeftPage = after.leftPage;
        currentRightPage = after.rightPage;
        lastCheck = after.check;
        if (getSyncDecisionAction(after.check.decision) !== 'CONTINUE') {
            await Promise.all([stopDevice(left.device), stopDevice(right.device)]);
            const status: SyncStatus = after.check.decision === 'DIFFERENT_PAGE' ? 'DIVERGED' : after.check.source === 'COLLECTION' ? 'COLLECTION_FAILED' : 'UNCERTAIN';
            const reason = after.check.decision === 'DIFFERENT_PAGE' ? 'Pages diverged after synchronized execution.' : 'Operation page could not be determined after synchronized execution.';
            return saveAndPrintResult(outputDir, resultFromCheck(steps, after.check, status, reason, after.check.decision === 'DIFFERENT_PAGE' ? steps : undefined));
        }
    }

    await Promise.all([stopDevice(left.device), stopDevice(right.device)]);
    const finalCheck = lastCheck;
    return saveAndPrintResult(outputDir, resultFromCheck(steps, finalCheck, 'COMPLETED', 'Pages stayed on the same logical operation path for all synchronized steps.'));
}
