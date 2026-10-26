import { describe, expect, it, vi } from 'vitest';
import { Component } from '../../src/model/component';
import { Page } from '../../src/model/page';
import { ViewTree } from '../../src/model/viewtree';
import { OperationPageChecker, OperationPageJudge } from '../../src/runner/operation_page_checker';
import { getSyncDecisionAction } from '../../src/runner/sync_runner';
import { LLMOperationPageJudge } from '../../src/runner/llm_operation_page_judge';

interface PageOptions { bundle?: string; ability?: string; path?: string; title?: string; action?: string; extra?: boolean; offset?: number; }
function createPage(options: PageOptions = {}): Page {
    const root = new Component();
    root.type = 'Root';
    root.bounds = [{ x: 0, y: 0 }, { x: 1000 + (options.offset ?? 0), y: 800 }];
    if (options.title) {
        const title = new Component();
        title.type = 'Text';
        title.id = 'page-title';
        title.text = options.title;
        title.bounds = [{ x: 10 + (options.offset ?? 0), y: 10 }, { x: 300, y: 60 }];
        root.addChild(title);
    }
    if (options.action) {
        const action = new Component();
        action.type = 'Button';
        action.id = 'primary-action';
        action.text = options.action;
        action.clickable = true;
        action.enabled = true;
        action.bounds = [{ x: 20 + (options.offset ?? 0), y: 100 }, { x: 220, y: 160 }];
        root.addChild(action);
    }
    if (options.extra) {
        const extra = new Component();
        extra.type = 'Image';
        extra.id = 'device-specific-decoration';
        extra.bounds = [{ x: 500, y: 100 }, { x: 700, y: 200 }];
        root.addChild(extra);
    }
    return new Page(new ViewTree(root), options.ability ?? 'EntryAbility', options.bundle ?? 'com.example.demo', options.path ?? 'pages/Home');
}

const targetBundle = 'com.example.demo';

describe('OperationPageChecker', () => {
    it('accepts the same logical page with different coordinates and dimensions', () => {
        const left = createPage({ title: 'Home', action: 'Open', offset: 0 });
        const right = createPage({ title: 'Home', action: 'Open', offset: 400 });
        const result = new OperationPageChecker({ targetBundleName: targetBundle }).checkRules(left, right);
        expect(result.decision).toBe('SAME_PAGE');
        expect(result.leftPageSig).not.toBe(result.rightPageSig);
    });

    it('accepts device-specific component tree changes when semantic anchors match', () => {
        const left = createPage({ title: 'Home', action: 'Open' });
        const right = createPage({ title: 'Home', action: 'Open', extra: true });
        expect(new OperationPageChecker({ targetBundleName: targetBundle }).checkRules(left, right).decision).toBe('SAME_PAGE');
    });

    it('detects different logical pages from conflicting semantic titles', () => {
        const left = createPage({ title: 'Home', action: 'Open' });
        const right = createPage({ title: 'Settings', action: 'Save' });
        expect(new OperationPageChecker({ targetBundleName: targetBundle }).checkRules(left, right).decision).toBe('DIFFERENT_PAGE');
    });

    it('detects a strong semantic heading conflict without relying on route names', () => {
        const makePage = (heading: string, route: string): Page => {
            const root = new Component();
            root.type = 'Root';
            root.bounds = [{ x: 0, y: 0 }, { x: 1000, y: 800 }];
            const text = new Component();
            text.type = 'Text';
            text.text = heading;
            text.bounds = [{ x: 20, y: 20 }, { x: 400, y: 80 }];
            root.addChild(text);
            return new Page(new ViewTree(root), 'EntryAbility', targetBundle, route);
        };
        const result = new OperationPageChecker({ targetBundleName: targetBundle }).checkRules(
            makePage('History', 'pages/NavigationPage'),
            makePage('New tab', 'pcpages/PcNavigationPage'),
        );
        expect(result.decision).toBe('DIFFERENT_PAGE');
        expect(result.source).toBe('RULES');
    });
    it('uses route plus disjoint semantic text and stable IDs as evidence of a fork', () => {
        const makePage = (textValue: string, controlId: string, route: string): Page => {
            const root = new Component();
            root.type = 'Root';
            root.bounds = [{ x: 0, y: 0 }, { x: 1000, y: 800 }];
            let parent = root;
            for (let index = 0; index < 4; index += 1) {
                const next = new Component();
                next.type = 'Container';
                parent.addChild(next);
                parent = next;
            }
            parent.id = controlId;
            const text = new Component();
            text.type = 'Paragraph';
            text.text = textValue;
            parent.addChild(text);
            return new Page(new ViewTree(root), 'EntryAbility', targetBundle, route);
        };
        const result = new OperationPageChecker({ targetBundleName: targetBundle }).checkRules(
             makePage('History', 'historyPage', 'pages/NavigationPage'),
             makePage('New tab', 'newTabPage', 'pcpages/PcNavigationPage'),
        );
        expect(result.decision).toBe('DIFFERENT_PAGE');
        expect(result.reason).toContain('non-overlapping business text');
    });
    it('does not treat arbitrary page-specific controls as sufficient fork evidence', () => {
        const makePage = (textValue: string, controlId: string, route: string): Page => {
            const root = new Component();
            root.type = 'Root';
            root.bounds = [{ x: 0, y: 0 }, { x: 1000, y: 800 }];
            const content = new Component();
            content.type = 'Column';
            content.id = controlId;
            content.parent = root;
            root.addChild(content);
            const text = new Component();
            text.type = 'Paragraph';
            text.text = textValue;
            text.parent = content;
            content.addChild(text);
            return new Page(new ViewTree(root), 'EntryAbility', targetBundle, route);
        };
        const result = new OperationPageChecker({ targetBundleName: targetBundle }).checkRules(
            makePage('History', 'history-content', 'pages/NavigationPage'),
            makePage('New tab', 'new-tab-content', 'pcpages/PcNavigationPage'),
        );
        expect(result.decision).toBe('UNCERTAIN');
        expect(result.rule).toBe('INSUFFICIENT_EVIDENCE');
    });
    it('does not use package name alone as page identity', () => {
        const left = createPage({ title: 'Home', action: 'Open' });
        const right = createPage({ title: 'Settings', action: 'Save', path: 'pages/Home' });
        expect(new OperationPageChecker({ targetBundleName: targetBundle }).checkRules(left, right).decision).toBe('DIFFERENT_PAGE');
    });

    it('allows a route mismatch when semantic evidence proves the same page', () => {
        const left = createPage({ title: 'Home', action: 'Open', path: 'pages/Index' });
        const right = createPage({ title: 'Home', action: 'Open', path: 'pages/Home' });
        expect(new OperationPageChecker({ targetBundleName: targetBundle }).checkRules(left, right).decision).toBe('SAME_PAGE');
    });

    it('defers a logical homepage with route and content differences to the LLM', async () => {
        const makePage = (route: string, textValue: string): Page => {
            const root = new Component();
            root.type = 'Root';
            root.bounds = [{ x: 0, y: 0 }, { x: 1000, y: 800 }];
            const pageShell = new Component();
            pageShell.type = 'Stack';
            pageShell.id = 'homePage';
            pageShell.parent = root;
            root.addChild(pageShell);
            const text = new Component();
            text.type = 'Text';
            text.text = textValue;
            text.parent = pageShell;
            pageShell.addChild(text);
            return new Page(new ViewTree(root), 'EntryAbility', targetBundle, route);
        };
        const left = makePage('pages/NavigationPage', 'Home');
        const right = makePage('pcpages/PcNavigationPage', 'New tab');
        const rules = new OperationPageChecker({ targetBundleName: targetBundle }).checkRules(left, right);
        expect(rules.decision).toBe('UNCERTAIN');
        expect(rules.rule).toBe('INSUFFICIENT_EVIDENCE');
        const result = await new OperationPageChecker({
            targetBundleName: targetBundle,
            llmJudge: { judge: vi.fn().mockResolvedValue({ decision: 'SAME_PAGE', reason: 'same logical homepage', evidence: ['matching home identity'], unresolvedIssues: [] }) },
        }).check(left, right, { phase: 'initial', history: [] });
        expect(result.decision).toBe('SAME_PAGE');
        expect(result.source).toBe('LLM');
    });
    it('does not treat shared public navigation controls as proof of the same page', () => {
        const makePage = (route: string): Page => {
            const root = new Component();
            root.type = 'Root';
            root.bounds = [{ x: 0, y: 0 }, { x: 1000, y: 800 }];
            const tabBar = new Component();
            tabBar.type = 'TabBar';
            tabBar.id = 'bottomTabBar';
            tabBar.parent = root;
            root.addChild(tabBar);
            const home = new Component();
            home.type = 'Button';
            home.id = 'tab-home';
            home.text = 'Home';
            home.clickable = true;
            home.enabled = true;
            home.parent = tabBar;
            tabBar.addChild(home);
            return new Page(new ViewTree(root), 'EntryAbility', targetBundle, route);
        };
        const result = new OperationPageChecker({ targetBundleName: targetBundle }).checkRules(
            makePage('pages/My'),
            makePage('pcpages/NewTab'),
        );
        expect(result.decision).toBe('UNCERTAIN');
        expect(result.rule).toBe('INSUFFICIENT_EVIDENCE');
    });

    it('uses business evidence when common navigation controls are shared', () => {
        const makePage = (route: string, content: string, contentId: string): Page => {
            const root = new Component();
            root.type = 'Root';
            root.bounds = [{ x: 0, y: 0 }, { x: 1000, y: 800 }];
            const tabBar = new Component();
            tabBar.type = 'TabBar';
            tabBar.id = 'bottomTabBar';
            root.addChild(tabBar);
            const tab = new Component();
            tab.type = 'Button';
            tab.id = 'tab-home';
            tab.text = 'Home';
            tab.clickable = true;
            tab.enabled = true;
            tabBar.addChild(tab);
            const contentContainer = new Component();
            contentContainer.type = 'Column';
            contentContainer.id = contentId;
            contentContainer.parent = root;
            root.addChild(contentContainer);
            const contentText = new Component();
            contentText.type = 'Text';
            contentText.text = content;
            contentText.parent = contentContainer;
            contentContainer.addChild(contentText);
            return new Page(new ViewTree(root), 'EntryAbility', targetBundle, route);
        };
        const result = new OperationPageChecker({ targetBundleName: targetBundle }).checkRules(
            makePage('pages/My', 'My page content', 'my-content'),
            makePage('pcpages/NewTab', 'New tab content', 'new-tab-content'),
        );
        expect(result.decision).toBe('DIFFERENT_PAGE');
        expect(result.rule).toBe('HEADING_CONFLICT');
    });
    it('returns UNCERTAIN when identity and semantic evidence are missing', () => {
        const left = createPage({ bundle: targetBundle, ability: '', path: '', title: '', action: '' });
        const right = createPage({ bundle: targetBundle, ability: '', path: '', title: '', action: '' });
        expect(new OperationPageChecker({ targetBundleName: targetBundle }).checkRules(left, right).decision).toBe('UNCERTAIN');
    });

    it('does not classify a system window or failed collection as a confirmed fork', () => {
        const system = createPage({ bundle: 'com.ohos.sceneboard', ability: '', path: '', title: '', action: '' });
        const target = createPage({ title: 'Home', action: 'Open' });
        const checker = new OperationPageChecker({ targetBundleName: targetBundle });
        expect(checker.checkRules(system, target).decision).toBe('UNCERTAIN');
        expect(checker.checkRules(undefined, target).decision).toBe('UNCERTAIN');
    });

    it('treats a visible UI extension overlay as a collection failure', () => {
        const root = new Component();
        root.type = 'Root';
        const extension = new Component();
        extension.type = 'UIExtensionComponent';
        root.addChild(extension);
        const result = new OperationPageChecker({ targetBundleName: targetBundle }).checkRules(
            new Page(new ViewTree(root), 'EntryAbility', targetBundle, 'pages/Home'),
            createPage({ title: 'Home', action: 'Open' }),
        );
        expect(result.decision).toBe('UNCERTAIN');
        expect(result.source).toBe('COLLECTION');
        expect(result.rule).toBe('COLLECTION_INVALID');
        expect(result.unresolvedIssues.join(' ')).toContain('UIExtensionComponent');
    });

    it('does not use hidden components as page identity evidence', () => {
        const root = new Component();
        root.type = 'Root';
        const hiddenTitle = new Component();
        hiddenTitle.type = 'Text';
        hiddenTitle.id = 'page-title';
        hiddenTitle.text = 'History';
        hiddenTitle.visible = false;
        root.addChild(hiddenTitle);
        const result = new OperationPageChecker({ targetBundleName: targetBundle }).checkRules(
            new Page(new ViewTree(root), 'EntryAbility', targetBundle, 'pages/Home'),
            createPage({ title: 'New tab', action: 'Open' }),
        );
        expect(result.decision).toBe('UNCERTAIN');
        expect(result.leftSummary.titleCandidates).toEqual([]);
    });

    it('calls LLM only when rules are uncertain', async () => {
        const judge: OperationPageJudge = { judge: vi.fn().mockResolvedValue({ decision: 'SAME_PAGE', reason: 'mock', evidence: ['mock evidence'], unresolvedIssues: [] }) };
        const checker = new OperationPageChecker({ targetBundleName: targetBundle, llmJudge: judge });
        const certain = await checker.check(createPage({ title: 'Home', action: 'Open' }), createPage({ title: 'Home', action: 'Open', offset: 20 }), { phase: 'initial' });
        expect(certain.decision).toBe('SAME_PAGE');
        expect(judge.judge).not.toHaveBeenCalled();
        const uncertain = await checker.check(createPage({ title: '', action: '' }), createPage({ title: '', action: '', path: 'pages/Other' }), { phase: 'after_event' });
        expect(uncertain.decision).toBe('SAME_PAGE');
        expect(judge.judge).toHaveBeenCalledTimes(1);
    });

    it('keeps UNCERTAIN when the LLM judge throws', async () => {
        const judge: OperationPageJudge = { judge: vi.fn().mockRejectedValue(new Error('network unavailable')) };
        const checker = new OperationPageChecker({ targetBundleName: targetBundle, llmJudge: judge });
        const result = await checker.check(createPage({ title: '', action: '' }), createPage({ title: '', action: '', path: 'pages/Other' }), { step: 3, phase: 'after_event' });
        expect(result.decision).toBe('UNCERTAIN');
        expect(result.source).toBe('LLM');
        expect(result.unresolvedIssues.join(' ')).toContain('network unavailable');
    });

    it('stops the current branch after a DIFFERENT_PAGE decision', () => {
        expect(getSyncDecisionAction('SAME_PAGE')).toBe('CONTINUE');
        expect(getSyncDecisionAction('DIFFERENT_PAGE')).toBe('STOP_DIVERGED');
        expect(getSyncDecisionAction('UNCERTAIN')).toBe('STOP_UNCERTAIN');
    });
});

describe('LLMOperationPageJudge', () => {
    function judgeWith(content: string, config = { enabled: true, baseURL: 'http://mock', apiKey: 'test', model: 'mock', timeoutMs: 50, maxRetries: 0 }) {
        const client = { complete: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }) };
        return { judge: new LLMOperationPageJudge({ config, client }), client };
    }
    const input = { phase: 'initial' as const, history: [], left: new OperationPageChecker({ targetBundleName: targetBundle }).summarize(createPage({ title: 'Home', action: 'Open' })), right: new OperationPageChecker({ targetBundleName: targetBundle }).summarize(createPage({ title: 'Home', action: 'Open' })) };

    it.each(['SAME_PAGE', 'DIFFERENT_PAGE', 'UNCERTAIN'])('accepts valid decision %s', async (decision) => {
        const { judge } = judgeWith(JSON.stringify({ decision, reason: 'mock reason', evidence: ['mock'], unresolvedIssues: [] }));
        expect((await judge.judge(input)).decision).toBe(decision);
    });

    it('falls back to text summaries when an image request is rejected', async () => {
        const complete = vi.fn().mockImplementation((request: { messages: Array<{ content: unknown }> }) => {
            const userContent = request.messages[1]?.content;
            if (Array.isArray(userContent)) {
                return Promise.reject(new Error('image input is unsupported'));
            }
            return Promise.resolve({ choices: [{ message: { content: JSON.stringify({ decision: 'SAME_PAGE', reason: 'text fallback', evidence: ['text'], unresolvedIssues: [] }) } }] });
        });
        const judge = new LLMOperationPageJudge({
            config: { enabled: true, baseURL: 'http://mock', apiKey: 'test', model: 'mock', timeoutMs: 50, maxRetries: 0, useScreenshots: true },
            client: { complete },
        });
        const result = await judge.judge({ ...input, leftScreenshotDataUrl: 'data:image/png;base64,left', rightScreenshotDataUrl: 'data:image/png;base64,right' });
        expect(result.decision).toBe('SAME_PAGE');
        expect(complete).toHaveBeenCalledTimes(2);
    });

    it('sends page summaries and enabled screenshots to the LLM request', async () => {
        let captured: { messages: Array<{ content: unknown }> } | undefined;
        const complete = vi.fn().mockImplementation((request: { messages: Array<{ content: unknown }> }) => {
            captured = request;
            return Promise.resolve({ choices: [{ message: { content: JSON.stringify({ decision: 'UNCERTAIN', reason: 'insufficient evidence', evidence: [], unresolvedIssues: [] }) } }] });
        });
        const judge = new LLMOperationPageJudge({
            config: { enabled: true, baseURL: 'http://mock', apiKey: 'test', model: 'mock', timeoutMs: 50, maxRetries: 0, useScreenshots: true },
            client: { complete },
        });
        await judge.judge({ ...input, step: 4, leftScreenshotDataUrl: 'data:image/png;base64,left', rightScreenshotDataUrl: 'data:image/png;base64,right' });
        expect(captured).toBeDefined();
        const userContent = captured!.messages[1].content;
        expect(Array.isArray(userContent)).toBe(true);
        expect(JSON.stringify(userContent)).toContain('stablePageIds');
        expect((userContent as unknown[]).filter((part) => typeof part === 'object' && part !== null && 'image_url' in part).length).toBe(2);
    });
    it('returns UNCERTAIN for malformed JSON, invalid schema, timeout, and disabled configuration', async () => {
        const malformed = judgeWith('not json');
        const malformedResult = await malformed.judge.judge(input);
        expect(malformedResult.decision).toBe('UNCERTAIN');
        const invalid = judgeWith(JSON.stringify({ decision: 'NOPE', reason: 'bad', evidence: [], unresolvedIssues: [] }));
        const invalidResult = await invalid.judge.judge(input);
        expect(invalidResult.decision).toBe('UNCERTAIN');
        expect(invalidResult.unresolvedIssues.join(' ')).toContain('Response=');
        expect(invalidResult.unresolvedIssues.join(' ')).toContain('NOPE');
        const timeout = new LLMOperationPageJudge({ config: { enabled: true, baseURL: 'http://mock', apiKey: 'test', model: 'mock', timeoutMs: 1, maxRetries: 0 }, client: { complete: () => new Promise(() => undefined) } });
        expect((await timeout.judge(input)).decision).toBe('UNCERTAIN');
        const disabled = new LLMOperationPageJudge({ config: { enabled: false, timeoutMs: 50, maxRetries: 0 }, client: { complete: vi.fn() } });
        expect((await disabled.judge(input)).decision).toBe('UNCERTAIN');
    });
});
