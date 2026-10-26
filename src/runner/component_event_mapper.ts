import { Component } from '../model/component';
import { Page } from '../model/page';
import { Point } from '../model/point';
import { DoubleClickEvent, TouchEvent, UIEvent } from '../event/ui_event';
import { Event } from '../event/event';
import { HapTestLogger } from '../utils/logger';

const logger = HapTestLogger.getLogger();

export type ComponentMappingStatus =
    | 'MAPPED'
    | 'NOT_APPLICABLE'
    | 'SOURCE_TARGET_UNAVAILABLE'
    | 'UNMATCHED'
    | 'AMBIGUOUS'
    | 'COORDINATE_INVALID';

export interface ComponentMatchCandidate {
    component: Component;
    score: number;
    evidence: string[];
    scoreBreakdown: ComponentScoreStep[];
    metadata: ComponentMetadata;
}

export type ComponentScoreOutcome = 'APPLIED' | 'NOT_APPLIED' | 'FILTERED';

export interface ComponentScoreStep {
    rule: string;
    points: number;
    outcome: ComponentScoreOutcome;
    detail: string;
}

export interface ComponentMetadataSummary {
    type?: string;
    id?: string;
    key?: string;
    text?: string;
    hint?: string;
    bounds?: Point[];
    origBounds?: Point[];
    visible?: boolean;
    enabled?: boolean;
    clickable?: boolean;
}

export interface ComponentMetadata extends ComponentMetadataSummary {
    parent?: ComponentMetadataSummary;
    ancestors: ComponentMetadataSummary[];
}

export interface ComponentFilterDiagnostic {
    metadata: ComponentMetadata;
    scoreBreakdown: ComponentScoreStep[];
    reason: string;
}

export interface ComponentMatchDecision {
    status: 'MAPPED' | 'UNMATCHED' | 'AMBIGUOUS';
    candidate?: ComponentMatchCandidate;
    candidates: ComponentMatchCandidate[];
    reason: string;
}

export interface ComponentMatchContext {
    sourcePage: Page;
    targetPage: Page;
}

export interface ComponentMatchResolver {
    resolve(source: Component, candidates: ComponentMatchCandidate[], context: ComponentMatchContext): ComponentMatchDecision;
}

export interface ComponentMappingResult {
    status: ComponentMappingStatus;
    mappedEvent?: Event;
    sourceComponent?: Component;
    targetComponent?: Component;
    mappedPoint?: Point;
    candidates: ComponentMatchCandidate[];
    filteredCandidates?: ComponentFilterDiagnostic[];
    evidence: string[];
    reason: string;
    sourceMetadata?: ComponentMetadata;
    targetMetadata?: ComponentMetadata;
}

export interface ScreenSize {
    width: number;
    height: number;
}

const MIN_MATCH_SCORE = 70;
const MIN_SCORE_MARGIN = 10;
const INPUT_TYPES = new Set(['TextInput', 'TextArea', 'SearchField']);
const STRUCTURAL_CONTEXT_TOKENS = new Set([
    'root',
    'container',
    'modal',
    'stack',
    'column',
    'row',
    'page',
    'component',
    'view',
    'section',
    'form',
    'layout',
    'overlay',
    'surface',
    'decor',
    'bar',
    'content',
    'wrapper',
    'frame',
    'window',
    'host',
    'panel',
]);

function normalize(value: string | undefined): string {
    return value?.trim().replace(/\s+/g, ' ').toLocaleLowerCase() ?? '';
}

function tokenizeContextValue(value: string): string[] {
    return value
        .trim()
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLocaleLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 2);
}

function isStructuralContextValue(value: string): boolean {
    const tokens = tokenizeContextValue(value);
    return tokens.length > 0 && tokens.every((token) => STRUCTURAL_CONTEXT_TOKENS.has(token));
}

function identityValues(component: Component): { id?: string; key?: string } {
    const id = normalize(component.id);
    const key = normalize(component.key);
    return { id: id || undefined, key: key || undefined };
}

function componentLabel(component: Component): string {
    const identity = identityValues(component);
    const type = normalize(component.type);
    const semanticValue = identity.key || identity.id || normalize(component.text) || normalize(component.hint);
    const rawIdentityValue = component.key?.trim() || component.id?.trim() || component.text?.trim() || component.hint?.trim() || '';
    if (semanticValue && isStructuralContextValue(rawIdentityValue) && isStructuralContextValue(component.type ?? '')) return '';
    if (semanticValue) return semanticValue;
    return isStructuralContextValue(component.type ?? '') ? '' : type;
}

function ancestorLabels(component: Component): string[] {
    const labels: string[] = [];
    let parent = component.parent;
    while (parent) {
        const label = componentLabel(parent);
        if (label) labels.push(label);
        parent = parent.parent;
    }
    return labels;
}

function contextTokens(value: string): string[] {
    return tokenizeContextValue(value).filter((token) => !STRUCTURAL_CONTEXT_TOKENS.has(token));
}

function ancestorComponents(component: Component): Component[] {
    const ancestors: Component[] = [];
    let parent = component.parent;
    while (parent) {
        ancestors.push(parent);
        parent = parent.parent;
    }
    return ancestors;
}

function isStructuralComponent(component: Component): boolean {
    return Boolean(normalize(component.type)) && componentLabel(component) === '' && isStructuralContextValue(component.type ?? '');
}

function hasCompatibleStructuralContext(source: Component, target: Component): boolean {
    const sourceAncestors = ancestorComponents(source);
    const targetAncestors = ancestorComponents(target);
    return sourceAncestors.length > 0 && targetAncestors.length > 0 && sourceAncestors.every(isStructuralComponent) && targetAncestors.every(isStructuralComponent);
}

function clonePoints(points: Point[] | undefined): Point[] | undefined {
    return points?.map((point) => ({ x: point.x, y: point.y }));
}

function componentMetadataSummary(component: Component): ComponentMetadataSummary {
    return {
        type: component.type,
        id: component.id,
        key: component.key,
        text: component.text,
        hint: component.hint,
        bounds: clonePoints(component.bounds),
        origBounds: clonePoints(component.origBounds),
        visible: component.visible,
        enabled: component.enabled,
        clickable: component.clickable,
    };
}

function componentMetadata(component: Component): ComponentMetadata {
    const ancestors = ancestorComponents(component).map(componentMetadataSummary);
    return {
        ...componentMetadataSummary(component),
        parent: ancestors[0],
        ancestors,
    };
}

function componentDepth(component: Component): number {
    let depth = 0;
    let parent = component.parent;
    while (parent) {
        depth += 1;
        parent = parent.parent;
    }
    return depth;
}

function getBounds(component: Component): { left: number; top: number; right: number; bottom: number } | undefined {
    const bounds = component.bounds;
    if (!bounds || bounds.length < 2) return undefined;
    const values = [bounds[0].x, bounds[0].y, bounds[1].x, bounds[1].y];
    if (!values.every((value) => Number.isFinite(value))) return undefined;
    const left = Math.min(bounds[0].x, bounds[1].x);
    const right = Math.max(bounds[0].x, bounds[1].x);
    const top = Math.min(bounds[0].y, bounds[1].y);
    const bottom = Math.max(bounds[0].y, bounds[1].y);
    if (right <= left || bottom <= top) return undefined;
    return { left, top, right, bottom };
}

function isPointInBounds(point: Point, bounds: ReturnType<typeof getBounds>): boolean {
    return Boolean(bounds && point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom);
}

function isInteractive(component: Component): boolean {
    return component.visible !== false && component.hasUIEvent() && Boolean(component.enabled);
}

function compatibleType(source: Component, target: Component): boolean {
    const sourceType = normalize(source.type);
    const targetType = normalize(target.type);
    if (!sourceType || !targetType) return false;
    if (sourceType === targetType) return true;
    return INPUT_TYPES.has(sourceType) && INPUT_TYPES.has(targetType);
}

function sameIdentity(source: Component, target: Component): string | undefined {
    const sourceIdentity = identityValues(source);
    const targetIdentity = identityValues(target);
    if (sourceIdentity.key && sourceIdentity.key === targetIdentity.key) return `same key=${sourceIdentity.key}`;
    if (sourceIdentity.id && sourceIdentity.id === targetIdentity.id) return `same id=${sourceIdentity.id}`;
    return undefined;
}

function sameSemanticValue(source: Component, target: Component): string | undefined {
    const sourceText = normalize(source.text);
    const targetText = normalize(target.text);
    if (sourceText && sourceText === targetText) return `same text=${sourceText}`;
    const sourceHint = normalize(source.hint);
    const targetHint = normalize(target.hint);
    if (sourceHint && sourceHint === targetHint) return `same hint=${sourceHint}`;
    return undefined;
}

interface CandidateEvaluation {
    candidate?: ComponentMatchCandidate;
    filtered?: ComponentFilterDiagnostic;
}

function scoreCandidate(source: Component, target: Component): CandidateEvaluation {
    const metadata = componentMetadata(target);
    const scoreBreakdown: ComponentScoreStep[] = [];
    const interactive = isInteractive(target);
    scoreBreakdown.push({ rule: 'target is visible, enabled, and interactive', points: 0, outcome: interactive ? 'APPLIED' : 'FILTERED', detail: interactive ? 'Target passed visibility, enabled, and UI event checks.' : 'Target failed visibility, enabled, or UI event checks.' });
    const bounds = getBounds(target);
    scoreBreakdown.push({ rule: 'target bounds are valid', points: 0, outcome: bounds ? 'APPLIED' : 'FILTERED', detail: bounds ? 'Target bounds have finite coordinates and positive area.' : 'Target bounds are missing, non-finite, or empty.' });
    const typeCompatible = compatibleType(source, target);
    scoreBreakdown.push({ rule: 'component type compatibility', points: 0, outcome: typeCompatible ? 'APPLIED' : 'FILTERED', detail: typeCompatible ? `Source type=${source.type}; target type=${target.type}.` : `Source type=${source.type}; target type=${target.type} are incompatible.` });
    if (!interactive || !bounds || !typeCompatible) {
        const failed = scoreBreakdown.filter((step) => step.outcome === 'FILTERED').map((step) => step.rule);
        const filtered = { metadata, scoreBreakdown, reason: `Filtered target component: ${failed.join(', ')}.` };
        logger.debug(`[component-event-mapping] candidate-filter=${JSON.stringify(filtered)}`);
        return { filtered };
    }

    const evidence: string[] = [`compatible type=${target.type}`];
    let score = 20;
    scoreBreakdown[2] = { rule: 'component type compatibility', points: 20, outcome: 'APPLIED', detail: `Added 20 points for compatible source/target types (${source.type}/${target.type}).` };
    const identityEvidence = sameIdentity(source, target);
    if (identityEvidence) {
        score += 60;
        evidence.push(identityEvidence);
        scoreBreakdown.push({ rule: 'stable component identity', points: 60, outcome: 'APPLIED', detail: identityEvidence });
    } else {
        scoreBreakdown.push({ rule: 'stable component identity', points: 0, outcome: 'NOT_APPLIED', detail: 'No matching non-empty id or key.' });
    }
    const semanticEvidence = sameSemanticValue(source, target);
    if (semanticEvidence) {
        score += 35;
        evidence.push(semanticEvidence);
        scoreBreakdown.push({ rule: 'semantic text or hint', points: 35, outcome: 'APPLIED', detail: semanticEvidence });
    } else {
        scoreBreakdown.push({ rule: 'semantic text or hint', points: 0, outcome: 'NOT_APPLIED', detail: 'No matching non-empty text or hint.' });
    }

    const sourceAncestors = ancestorLabels(source);
    const targetAncestors = ancestorLabels(target);
    const sharedAncestors = sourceAncestors.filter((label) => targetAncestors.includes(label));
    const sourceParent = source.parent ? componentLabel(source.parent) : '';
    const targetParent = target.parent ? componentLabel(target.parent) : '';
    if (sourceParent && sourceParent === targetParent) {
        score += 20;
        evidence.push(`same parent=${sourceParent}`);
        scoreBreakdown.push({ rule: 'parent context', points: 20, outcome: 'APPLIED', detail: `Exact semantic parent=${sourceParent}.` });
    } else if (sourceParent && targetParent && contextTokens(sourceParent).some((token) => contextTokens(targetParent).includes(token))) {
        score += 15;
        evidence.push(`related parent context=${sourceParent}~${targetParent}`);
        scoreBreakdown.push({ rule: 'parent context', points: 15, outcome: 'APPLIED', detail: `Related semantic parent context=${sourceParent}~${targetParent}.` });
    } else if (sharedAncestors.length > 0) {
        score += 15;
        evidence.push(`shared ancestor=${sharedAncestors[0]}`);
        scoreBreakdown.push({ rule: 'ancestor context', points: 15, outcome: 'APPLIED', detail: `Shared semantic ancestor=${sharedAncestors[0]}.` });
    } else if (!sourceParent && !targetParent && hasCompatibleStructuralContext(source, target)) {
        score += 15;
        evidence.push('compatible structural context with intermediate wrappers');
        scoreBreakdown.push({ rule: 'structural wrapper context', points: 15, outcome: 'APPLIED', detail: 'Both ancestor chains contain only structural wrappers; intermediate containers differ but add no semantic conflict.' });
    } else {
        scoreBreakdown.push({ rule: 'parent or ancestor context', points: 0, outcome: 'NOT_APPLIED', detail: 'No matching semantic parent/ancestor and no compatible structural-only context.' });
    }

    const candidate = { component: target, score, evidence, scoreBreakdown, metadata };
    logger.debug(`[component-event-mapping] candidate-score=${JSON.stringify({ score, metadata, scoreBreakdown, evidence })}`);
    return { candidate };
}

export class RuleBasedComponentMatchResolver implements ComponentMatchResolver {
    resolve(source: Component, candidates: ComponentMatchCandidate[], _context: ComponentMatchContext): ComponentMatchDecision {
        const ranked = [...candidates].sort((left, right) => right.score - left.score);
        if (ranked.length === 0) {
            logger.debug(`[component-event-mapping] resolution=${JSON.stringify({ status: 'UNMATCHED', threshold: MIN_MATCH_SCORE, margin: MIN_SCORE_MARGIN, reason: 'No compatible candidate survived target filtering.' })}`);
            return { status: 'UNMATCHED', candidates: [], reason: 'No visible, interactive target component reached the minimum match score.' };
        }
        const qualified = ranked.filter((candidate) => candidate.score >= MIN_MATCH_SCORE);
        if (qualified.length === 0) {
            logger.debug(`[component-event-mapping] resolution=${JSON.stringify({ status: 'UNMATCHED', threshold: MIN_MATCH_SCORE, margin: MIN_SCORE_MARGIN, ranked: ranked.map((candidate) => ({ score: candidate.score, evidence: candidate.evidence })), reason: `No candidate reached score=${MIN_MATCH_SCORE}.` })}`);
            return { status: 'UNMATCHED', candidates: ranked, reason: `No target component reached the minimum match score=${MIN_MATCH_SCORE}.` };
        }
        const best = qualified[0];
        const second = qualified[1];
        if (second && best.score - second.score < MIN_SCORE_MARGIN) {
            logger.debug(`[component-event-mapping] resolution=${JSON.stringify({ status: 'AMBIGUOUS', threshold: MIN_MATCH_SCORE, margin: MIN_SCORE_MARGIN, bestScore: best.score, secondScore: second.score, reason: 'Qualified candidates are too close to distinguish safely.' })}`);
            return { status: 'AMBIGUOUS', candidates: ranked, reason: 'Multiple target components have indistinguishable match scores.' };
        }
        logger.debug(`[component-event-mapping] resolution=${JSON.stringify({ status: 'MAPPED', threshold: MIN_MATCH_SCORE, margin: MIN_SCORE_MARGIN, bestScore: best.score, secondScore: second?.score, reason: 'Best qualified candidate has a safe score margin.' })}`);
        return { status: 'MAPPED', candidate: best, candidates: ranked, reason: `Selected target component with score=${best.score}.` };
    }
}

function extractSourceComponent(event: UIEvent, page: Page): { component?: Component; reason: string; evidence: string[] } {
    const point = event.getPoint();
    const explicit = event.getComponet();
    if (explicit) {
        const component = page.getComponents().find((item) => item === explicit);
        if (!component) return { reason: 'The event component is not part of the current source page.', evidence: [] };
        if (!isInteractive(component)) return { reason: 'The source event component is not visible and interactive.', evidence: [] };
        if (!isPointInBounds(point, getBounds(component))) return { reason: 'The source event point is outside the source component bounds.', evidence: [] };
        return { component, reason: 'Source component came from the current page event.', evidence: [`source component type=${component.type}`] };
    }

    const candidates = page.getComponents()
        .filter((component) => isInteractive(component) && isPointInBounds(point, getBounds(component)))
        .sort((left, right) => componentDepth(right) - componentDepth(left));
    if (candidates.length === 0) return { reason: 'No visible interactive source component contains the event point.', evidence: [] };
    const deepest = candidates.filter((component) => componentDepth(component) === componentDepth(candidates[0]));
    if (deepest.length !== 1) return { reason: 'Multiple source components at the deepest interactive level contain the event point.', evidence: [] };
    return { component: deepest[0], reason: 'Source component was uniquely resolved from the event point.', evidence: [`source component type=${deepest[0].type}`] };
}

function mapPoint(component: Component, screen: ScreenSize): { point?: Point; reason: string } {
    const bounds = getBounds(component);
    if (!bounds) return { reason: 'Target component bounds are missing or invalid.' };
    if (!Number.isFinite(screen.width) || !Number.isFinite(screen.height) || screen.width <= 0 || screen.height <= 0) return { reason: 'Target screen size is invalid.' };
    const point = { x: Math.round((bounds.left + bounds.right) / 2), y: Math.round((bounds.top + bounds.bottom) / 2) };
    if (point.x < 0 || point.y < 0 || point.x >= screen.width || point.y >= screen.height) return { reason: 'Mapped target point is outside the target screen.' };
    return { point, reason: `Mapped point=${point.x},${point.y} from target bounds.` };
}

export function mapClickEvent(
    event: Event,
    sourcePage: Page | undefined,
    targetPage: Page | undefined,
    screen: ScreenSize,
    resolver: ComponentMatchResolver = new RuleBasedComponentMatchResolver(),
): ComponentMappingResult {
    if (!(event instanceof TouchEvent) && !(event instanceof DoubleClickEvent)) {
        return { status: 'NOT_APPLICABLE', candidates: [], evidence: [], reason: `Event type ${event.constructor.name} is not a click mapping target.` };
    }
    if (!sourcePage || !targetPage) {
        return { status: 'SOURCE_TARGET_UNAVAILABLE', candidates: [], evidence: [], reason: 'Source or target page is unavailable for click mapping.' };
    }

    const source = extractSourceComponent(event, sourcePage);
    if (!source.component) return { status: 'SOURCE_TARGET_UNAVAILABLE', candidates: [], evidence: source.evidence, reason: source.reason };

    logger.info(`[component-event-mapping] source=${JSON.stringify(componentMetadata(source.component))}`);
    const evaluations = targetPage.getComponents().map((component) => scoreCandidate(source.component!, component));
    const candidates = evaluations.flatMap((evaluation) => evaluation.candidate ? [evaluation.candidate] : []);
    const filteredCandidates = evaluations.flatMap((evaluation) => evaluation.filtered ? [evaluation.filtered] : []);
    const decision = resolver.resolve(source.component, candidates, { sourcePage, targetPage });
    if (decision.status !== 'MAPPED' || !decision.candidate) {
        return { status: decision.status, sourceComponent: source.component, sourceMetadata: componentMetadata(source.component), candidates: decision.candidates, filteredCandidates, evidence: source.evidence, reason: decision.reason };
    }

    const point = mapPoint(decision.candidate.component, screen);
    if (!point.point) {
        return { status: 'COORDINATE_INVALID', sourceComponent: source.component, targetComponent: decision.candidate.component, sourceMetadata: componentMetadata(source.component), targetMetadata: componentMetadata(decision.candidate.component), candidates: decision.candidates, filteredCandidates, evidence: [...source.evidence, ...decision.candidate.evidence], reason: point.reason };
    }

    const mappedEvent = event instanceof DoubleClickEvent
        ? new DoubleClickEvent(decision.candidate.component)
        : new TouchEvent(decision.candidate.component);
    return {
        status: 'MAPPED',
        mappedEvent,
        sourceComponent: source.component,
        targetComponent: decision.candidate.component,
        sourceMetadata: componentMetadata(source.component),
        targetMetadata: componentMetadata(decision.candidate.component),
        mappedPoint: point.point,
        candidates: decision.candidates,
        filteredCandidates,
        evidence: [...source.evidence, ...decision.candidate.evidence, point.reason],
        reason: decision.reason,
    };
}
