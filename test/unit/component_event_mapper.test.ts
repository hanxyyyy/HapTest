import { describe, expect, it } from 'vitest';
import { DoubleClickEvent, InputTextEvent, ScrollEvent, TouchEvent } from '../../src/event/ui_event';
import { Direct } from '../../src/device/event_simulator';
import { Component } from '../../src/model/component';
import { Page } from '../../src/model/page';
import { Point } from '../../src/model/point';
import { ViewTree } from '../../src/model/viewtree';
import { mapClickEvent } from '../../src/runner/component_event_mapper';

function attach(parent: Component, child: Component): Component {
    child.parent = parent;
    parent.addChild(child);
    return child;
}

function component(type: string, bounds: [Point, Point], options: Partial<Component> = {}): Component {
    const result = new Component();
    result.type = type;
    result.bounds = bounds;
    Object.assign(result, options);
    return result;
}

function page(root: Component): Page {
    return new Page(new ViewTree(root), 'MainAbility', 'com.example.demo', 'pages/Home');
}

const screen = { width: 1200, height: 2000 };

describe('component event mapper', () => {
    it('maps an ID-matched click to the right component center', () => {
        const leftRoot = component('Root', [{ x: 0, y: 0 }, { x: 600, y: 1000 }]);
        const leftButton = attach(leftRoot, component('Button', [{ x: 10, y: 20 }, { x: 110, y: 80 }], { id: 'submit-page', text: 'Submit', clickable: true, enabled: true }));
        const rightRoot = component('Root', [{ x: 0, y: 0 }, { x: 1200, y: 2000 }]);
        const rightButton = attach(rightRoot, component('Button', [{ x: 700, y: 1500 }, { x: 1000, y: 1700 }], { id: 'submit-page', text: 'Submit', clickable: true, enabled: true }));

        const result = mapClickEvent(new TouchEvent(leftButton), page(leftRoot), page(rightRoot), screen);

        expect(result.status).toBe('MAPPED');
        expect(result.targetComponent).toBe(rightButton);
        expect(result.mappedPoint).toEqual({ x: 850, y: 1600 });
        expect((result.mappedEvent as TouchEvent).getPoint()).toEqual({ x: 850, y: 1600 });
    });

    it('matches a unique semantic target through device-specific structural wrappers', () => {
        const leftRoot = component('root', [{ x: 0, y: 137 }, { x: 1320, y: 2856 }]);
        const leftColumn = attach(leftRoot, component('Column', [{ x: 0, y: 137 }, { x: 1320, y: 2758 }]));
        const leftContent = attach(leftColumn, component('Column', [{ x: 56, y: 332 }, { x: 1264, y: 2758 }]));
        const leftButton = attach(leftContent, component('Button', [{ x: 56, y: 2562 }, { x: 1264, y: 2702 }], { text: 'Click Me', clickable: true, enabled: true }));

        const rightRoot = component('root', [{ x: 0, y: 42 }, { x: 3120, y: 1955 }]);
        const modal = attach(rightRoot, component('ContainerModal', [{ x: 0, y: 42 }, { x: 3120, y: 1955 }]));
        const modalColumn = attach(modal, component('Column', [{ x: 0, y: 42 }, { x: 3120, y: 1955 }]));
        const stack = attach(modalColumn, component('Stack', [{ x: 0, y: 112 }, { x: 3120, y: 1955 }], { id: 'ContainerModalStack', key: 'ContainerModalStack' }));
        const stackColumn = attach(stack, component('Column', [{ x: 0, y: 112 }, { x: 3120, y: 1955 }]));
        const rightContent = attach(stackColumn, component('Column', [{ x: 70, y: 250 }, { x: 3050, y: 1955 }]));
        const rightButton = attach(rightContent, component('Button', [{ x: 1134, y: 1568 }, { x: 1986, y: 1644 }], { text: 'Click Me', clickable: true, enabled: true }));

        const result = mapClickEvent(new TouchEvent(leftButton), page(leftRoot), page(rightRoot), { width: 3120, height: 2080 });

        expect(result.status).toBe('MAPPED');
        expect(result.targetComponent).toBe(rightButton);
        expect(result.mappedPoint).toEqual({ x: 1560, y: 1606 });
        expect(result.candidates[0].score).toBe(70);
        expect(result.candidates[0].evidence).toContain('compatible structural context with intermediate wrappers');
        expect(result.candidates[0].scoreBreakdown).toEqual(expect.arrayContaining([
            expect.objectContaining({ rule: 'component type compatibility', points: 20, outcome: 'APPLIED' }),
            expect.objectContaining({ rule: 'semantic text or hint', points: 35, outcome: 'APPLIED' }),
            expect.objectContaining({ rule: 'structural wrapper context', points: 15, outcome: 'APPLIED' }),
        ]));
        expect(result.targetMetadata?.parent?.type).toBe('Column');
        expect(result.targetMetadata?.ancestors.map((ancestor) => ancestor.type)).toContain('ContainerModal');
        expect(result.targetMetadata?.ancestors.map((ancestor) => ancestor.key)).toContain('ContainerModalStack');
    });

    it('matches different IDs using text, type, and parent context', () => {
        const leftRoot = component('Root', [{ x: 0, y: 0 }, { x: 600, y: 1000 }]);
        const leftForm = attach(leftRoot, component('Form', [{ x: 0, y: 0 }, { x: 600, y: 500 }], { id: 'profile-form' }));
        const leftButton = attach(leftForm, component('Button', [{ x: 10, y: 20 }, { x: 110, y: 80 }], { id: 'mobile-save', text: 'Save', clickable: true, enabled: true }));
        const rightRoot = component('Root', [{ x: 0, y: 0 }, { x: 1200, y: 2000 }]);
        const rightForm = attach(rightRoot, component('Form', [{ x: 0, y: 0 }, { x: 1200, y: 1000 }], { id: 'tablet-profile-form' }));
        const rightButton = attach(rightForm, component('Button', [{ x: 800, y: 1400 }, { x: 1100, y: 1600 }], { id: 'tablet-save', text: 'Save', clickable: true, enabled: true }));

        const result = mapClickEvent(new TouchEvent(leftButton), page(leftRoot), page(rightRoot), screen);

        expect(result.status).toBe('MAPPED');
        expect(result.targetComponent).toBe(rightButton);
    });

    it('uses parent context to distinguish repeated text', () => {
        const leftRoot = component('Root', [{ x: 0, y: 0 }, { x: 600, y: 1000 }]);
        const leftAccount = attach(leftRoot, component('Section', [{ x: 0, y: 0 }, { x: 600, y: 400 }], { id: 'account-section' }));
        const leftButton = attach(leftAccount, component('Button', [{ x: 10, y: 20 }, { x: 110, y: 80 }], { text: 'Open', clickable: true, enabled: true }));
        const rightRoot = component('Root', [{ x: 0, y: 0 }, { x: 1200, y: 2000 }]);
        const rightAccount = attach(rightRoot, component('Section', [{ x: 0, y: 0 }, { x: 1200, y: 800 }], { id: 'account-section' }));
        const rightAccountButton = attach(rightAccount, component('Button', [{ x: 800, y: 1400 }, { x: 1100, y: 1600 }], { text: 'Open', clickable: true, enabled: true }));
        const rightOther = attach(rightRoot, component('Section', [{ x: 0, y: 900 }, { x: 1200, y: 1300 }], { id: 'other-section' }));
        attach(rightOther, component('Button', [{ x: 800, y: 1400 }, { x: 1100, y: 1600 }], { text: 'Open', clickable: true, enabled: true }));

        const result = mapClickEvent(new TouchEvent(leftButton), page(leftRoot), page(rightRoot), screen);

        expect(result.status).toBe('MAPPED');
        expect(result.targetComponent).toBe(rightAccountButton);
    });

    it('returns AMBIGUOUS when candidates cannot be distinguished', () => {
        const leftRoot = component('Root', [{ x: 0, y: 0 }, { x: 600, y: 1000 }]);
        const leftActions = attach(leftRoot, component('Section', [{ x: 0, y: 0 }, { x: 600, y: 500 }], { id: 'actions' }));
        const leftButton = attach(leftActions, component('Button', [{ x: 10, y: 20 }, { x: 110, y: 80 }], { text: 'Open', clickable: true, enabled: true }));
        const rightRoot = component('Root', [{ x: 0, y: 0 }, { x: 1200, y: 2000 }]);
        const rightActions = attach(rightRoot, component('Section', [{ x: 0, y: 1000 }, { x: 1200, y: 1900 }], { id: 'actions' }));
        attach(rightActions, component('Button', [{ x: 700, y: 1200 }, { x: 900, y: 1400 }], { text: 'Open', clickable: true, enabled: true }));
        attach(rightActions, component('Button', [{ x: 700, y: 1500 }, { x: 900, y: 1700 }], { text: 'Open', clickable: true, enabled: true }));

        const result = mapClickEvent(new TouchEvent(leftButton), page(leftRoot), page(rightRoot), screen);

        expect(result.status).toBe('AMBIGUOUS');
        expect(result.mappedEvent).toBeUndefined();
    });

    it('returns UNMATCHED without falling back to the source coordinate', () => {
        const leftRoot = component('Root', [{ x: 0, y: 0 }, { x: 600, y: 1000 }]);
        const leftButton = attach(leftRoot, component('Button', [{ x: 10, y: 20 }, { x: 110, y: 80 }], { id: 'only-left', text: 'Only left', clickable: true, enabled: true }));
        const rightRoot = component('Root', [{ x: 0, y: 0 }, { x: 1200, y: 2000 }]);

        const result = mapClickEvent(new TouchEvent(leftButton), page(leftRoot), page(rightRoot), screen);

        expect(result.status).toBe('UNMATCHED');
        expect(result.mappedEvent).toBeUndefined();
        expect(result.mappedPoint).toBeUndefined();
    });

    it('rejects invisible, disabled, and invalid-bound targets', () => {
        const leftRoot = component('Root', [{ x: 0, y: 0 }, { x: 600, y: 1000 }]);
        const leftButton = attach(leftRoot, component('Button', [{ x: 10, y: 20 }, { x: 110, y: 80 }], { id: 'action', clickable: true, enabled: true }));
        const rightRoot = component('Root', [{ x: 0, y: 0 }, { x: 1200, y: 2000 }]);
        attach(rightRoot, component('Button', [{ x: 700, y: 900 }, { x: 900, y: 1100 }], { id: 'action', clickable: true, enabled: true, visible: false }));
        attach(rightRoot, component('Button', [{ x: 700, y: 1200 }, { x: 900, y: 1400 }], { id: 'action', clickable: true, enabled: false }));
        attach(rightRoot, component('Button', [{ x: 700, y: 1500 }, { x: 700, y: 1500 }], { id: 'action', clickable: true, enabled: true }));

        const result = mapClickEvent(new TouchEvent(leftButton), page(leftRoot), page(rightRoot), screen);

        expect(result.status).toBe('UNMATCHED');
    });

    it('rejects a matched target whose center is outside the target screen', () => {
        const leftRoot = component('Root', [{ x: 0, y: 0 }, { x: 600, y: 1000 }]);
        const leftButton = attach(leftRoot, component('Button', [{ x: 10, y: 20 }, { x: 110, y: 80 }], { id: 'action', clickable: true, enabled: true }));
        const rightRoot = component('Root', [{ x: 0, y: 0 }, { x: 1200, y: 2000 }]);
        attach(rightRoot, component('Button', [{ x: 1300, y: 1500 }, { x: 1400, y: 1700 }], { id: 'action', clickable: true, enabled: true }));

        const result = mapClickEvent(new TouchEvent(leftButton), page(leftRoot), page(rightRoot), screen);

        expect(result.status).toBe('COORDINATE_INVALID');
        expect(result.mappedEvent).toBeUndefined();
    });

    it('returns SOURCE_TARGET_UNAVAILABLE when the source component cannot be extracted', () => {
        const leftRoot = component('Root', [{ x: 0, y: 0 }, { x: 600, y: 1000 }]);
        const rightRoot = component('Root', [{ x: 0, y: 0 }, { x: 1200, y: 2000 }]);

        const result = mapClickEvent(new TouchEvent({ x: 80, y: 50 }), page(leftRoot), page(rightRoot), screen);

        expect(result.status).toBe('SOURCE_TARGET_UNAVAILABLE');
    });

    it('leaves non-click events outside the click mapper', () => {
        const leftRoot = component('Root', [{ x: 0, y: 0 }, { x: 600, y: 1000 }]);
        const leftInput = attach(leftRoot, component('TextInput', [{ x: 10, y: 20 }, { x: 300, y: 80 }], { id: 'input', enabled: true }));
        const rightRoot = component('Root', [{ x: 0, y: 0 }, { x: 1200, y: 2000 }]);
        const leftPage = page(leftRoot);
        const rightPage = page(rightRoot);

        expect(mapClickEvent(new InputTextEvent(leftInput, 'text'), leftPage, rightPage, screen).status).toBe('NOT_APPLICABLE');
        expect(mapClickEvent(new ScrollEvent(leftInput, Direct.DOWN), leftPage, rightPage, screen).status).toBe('NOT_APPLICABLE');
        expect(mapClickEvent(new DoubleClickEvent(leftInput), leftPage, rightPage, screen).status).toBe('UNMATCHED');
    });
});
