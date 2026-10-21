import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    Device,
    TARGET_PAGE_MAX_ATTEMPTS,
    findTargetPage,
} from '../../src/device/device';
import { Hap, HapRunningState } from '../../src/model/hap';
import { Component } from '../../src/model/component';
import { Page } from '../../src/model/page';
import { ViewTree } from '../../src/model/viewtree';
import { PageBuilder } from '../../src/model/builder/page_builder';

function createPage(bundleName: string, abilityName: string, pagePath: string, rootType: string): Page {
    const root = new Component();
    root.type = rootType;
    root.bounds = [
        { x: 0, y: 0 },
        { x: 100, y: 200 },
    ];
    return new Page(new ViewTree(root), abilityName, bundleName, pagePath);
}

function createFakeDevice(pageSequences: Page[][], runningState: HapRunningState = HapRunningState.FOREGROUND) {
    const dumpLayout = vi.fn();
    for (const pages of pageSequences) {
        dumpLayout.mockResolvedValueOnce(pages);
    }
    dumpLayout.mockResolvedValue(pageSequences[pageSequences.length - 1] ?? []);

    const device = Object.create(Device.prototype) as Device;
    const privateDevice = device as any;
    privateDevice.options = {};
    privateDevice.driverCtx = { driver: { dumpLayout } };
    privateDevice.getSnapshot = vi.fn().mockReturnValue({});
    privateDevice.getHapRunningState = vi.fn().mockReturnValue(runningState);

    return { device, dumpLayout };
}

function createHap(): Hap {
    return { bundleName: 'com.example.target' } as Hap;
}

describe('Device target page selection', () => {
    beforeEach(() => {
        vi.spyOn(PageBuilder, 'buildPagesFromLayout').mockImplementation((layout) => layout as Page[]);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('returns the page that belongs to the target bundle', async () => {
        const targetPage = createPage('com.example.target', 'EntryAbility', 'pages/Index', 'root');
        const scenePage = createPage('com.ohos.sceneboard', '', '', 'WindowScene');
        const { device, dumpLayout } = createFakeDevice([[scenePage, targetPage]]);

        const result = await device.getCurrentPage(createHap());

        expect(result).toBe(targetPage);
        expect(dumpLayout).toHaveBeenCalledTimes(1);
    });

    it('retries when the target bundle is temporarily missing', async () => {
        vi.useFakeTimers();
        const targetPage = createPage('com.example.target', 'EntryAbility', 'pages/Index', 'root');
        const scenePage = createPage('com.ohos.sceneboard', '', '', 'WindowScene');
        const { device, dumpLayout } = createFakeDevice([[scenePage], [scenePage, targetPage]]);

        const resultPromise = device.getCurrentPage(createHap());
        await vi.runAllTimersAsync();

        await expect(resultPromise).resolves.toBe(targetPage);
        expect(dumpLayout).toHaveBeenCalledTimes(2);
    });

    it('does not mistake WindowScene for the target application', async () => {
        vi.useFakeTimers();
        const scenePage = createPage('com.ohos.sceneboard', 'SceneAbility', '', 'WindowScene');
        const { device, dumpLayout } = createFakeDevice(
            [[scenePage]],
            HapRunningState.FOREGROUND
        );

        const resultPromise = device.getCurrentPage(createHap()).catch((error: unknown) => error as Error);
        await vi.runAllTimersAsync();

        const error = await resultPromise;
        expect(error.message).toMatch(/Unable to find target page for bundle com\.example\.target/);
        expect(dumpLayout).toHaveBeenCalledTimes(TARGET_PAGE_MAX_ATTEMPTS);
    });

    it('reports all candidate page details after target lookup times out', async () => {
        vi.useFakeTimers();
        const scenePage = createPage('com.ohos.sceneboard', 'SceneAbility', '', 'WindowScene');
        const otherPage = createPage('com.example.other', 'OtherAbility', 'pages/Other', 'OtherRoot');
        const { device } = createFakeDevice([[scenePage, otherPage]], HapRunningState.FOREGROUND);

        const resultPromise = device.getCurrentPage(createHap()).catch((error: unknown) => error as Error);
        await vi.runAllTimersAsync();

        const error = await resultPromise;
        expect(error.message).toContain('com.ohos.sceneboard');
        expect(error.message).toContain('abilityName=SceneAbility');
        expect(error.message).toContain('root.type=WindowScene');
        expect(error.message).toContain('com.example.other');
        expect(error.message).toContain('root.type=OtherRoot');
    });

    it('recognizes EnhanceCompatibleMaximizeBtn and verifies the new window size', async () => {
        const windowedRoot = new Component();
        windowedRoot.type = 'root';
        windowedRoot.bounds = [
            { x: 0, y: 0 },
            { x: 500, y: 500 },
        ];
        const maximizeButton = new Component();
        maximizeButton.type = 'Button';
        maximizeButton.id = 'EnhanceCompatibleMaximizeBtn';
        maximizeButton.bounds = [
            { x: 450, y: 0 },
            { x: 500, y: 50 },
        ];
        windowedRoot.addChild(maximizeButton);
        const windowedPage = new Page(
            new ViewTree(windowedRoot),
            'EntryAbility',
            'com.example.target',
            'pages/Index'
        );

        const fullscreenRoot = new Component();
        fullscreenRoot.type = 'root';
        fullscreenRoot.bounds = [
            { x: 0, y: 0 },
            { x: 1000, y: 1000 },
        ];
        const fullscreenPage = new Page(
            new ViewTree(fullscreenRoot),
            'EntryAbility',
            'com.example.target',
            'pages/Index'
        );

        const device = Object.create(Device.prototype) as Device;
        const privateDevice = device as any;
        privateDevice.options = { deviceType: '2in1' };
        privateDevice.getWidth = vi.fn().mockReturnValue(1000);
        privateDevice.getHeight = vi.fn().mockReturnValue(1000);
        privateDevice.getCurrentPage = vi
            .fn()
            .mockResolvedValueOnce(windowedPage)
            .mockResolvedValueOnce(fullscreenPage);
        privateDevice.sendEvent = vi.fn().mockResolvedValue(undefined);

        const result = await device.ensureFullscreen(createHap());

        expect(result).toBe(true);
        expect(privateDevice.sendEvent).toHaveBeenCalledTimes(1);
        expect(privateDevice.getCurrentPage).toHaveBeenNthCalledWith(1, expect.anything(), true);
        expect(privateDevice.getCurrentPage).toHaveBeenNthCalledWith(2, expect.anything(), true);
    });

    it('leaves a non-fullscreen window unchanged when no maximize control exists', async () => {
        const page = createPage('com.example.target', 'EntryAbility', 'pages/Index', 'root');
        const device = Object.create(Device.prototype) as Device;
        const privateDevice = device as any;
        privateDevice.options = { deviceType: '2in1' };
        privateDevice.getWidth = vi.fn().mockReturnValue(1000);
        privateDevice.getHeight = vi.fn().mockReturnValue(1000);
        privateDevice.getCurrentPage = vi.fn().mockResolvedValue(page);
        privateDevice.sendEvent = vi.fn().mockResolvedValue(undefined);

        const result = await device.ensureFullscreen(createHap());

        expect(result).toBe(false);
        expect(privateDevice.sendEvent).not.toHaveBeenCalled();
    });
});

describe('findTargetPage', () => {
    it('only returns a non-stop page from the requested bundle', () => {
        const scenePage = createPage('com.ohos.sceneboard', '', '', 'WindowScene');
        const targetPage = createPage('com.example.target', 'EntryAbility', 'pages/Index', 'root');

        expect(findTargetPage([scenePage, targetPage], 'com.example.target')).toBe(targetPage);
        expect(findTargetPage([scenePage], 'com.example.target')).toBeUndefined();
    });
});
