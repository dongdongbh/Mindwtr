import { bytesToBase64 } from './base64-bytes';
import type { NativePreparedChecklistWrite, NativeTaskCompletionRequest } from './native-host-contract-task-checklist';

export const NATIVE_WIDGET_NAMESPACE = 'tech.dongdongbh.mindwtr.native.dev';
export const PRODUCTION_WIDGET_NAMESPACE = 'tech.dongdongbh.mindwtr';
const SCOPE = '6a427f83abc15c8e99ca3ab26acb1afd9b7a82458efa3a5c34b2c133056f7d8f';
export const NATIVE_WIDGET_COMPLETION_BYTES = 2_100_000;
export const NATIVE_WIDGET_SOURCE_BYTES = 65_536;
export type NativeWidgetCompletionSource = {
    namespace: typeof NATIVE_WIDGET_NAMESPACE | typeof PRODUCTION_WIDGET_NAMESPACE; actionId: string; identifier: string; token: string; createdAt: number;
};
export type NativeWidgetCompletionResult = { actionId: string; outcome: 'completed' | 'discarded' };
export type NativeWidgetCompletionEnvelope = { source: NativeWidgetCompletionSource; checklist: {
    request: NativeTaskCompletionRequest; prepared: NativePreparedChecklistWrite;
} | null };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).length === fields.length
    && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
const bytes = (text: string) => new TextEncoder().encode(text);
const validUnicode = (text: string) => Array.from(text).every(char => {
    const code = char.codePointAt(0)!; return code < 0xd800 || code > 0xdfff;
});

export const nativeWidgetIdentifier = (taskID: string): string => SCOPE + '.'
    + bytesToBase64(bytes(taskID)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const readNativeWidgetCompletionSource = (value: unknown): NativeWidgetCompletionSource | null => {
    if (!record(value) || !exact(value, ['namespace', 'actionId', 'identifier', 'token', 'createdAt'])
        || (value.namespace !== NATIVE_WIDGET_NAMESPACE && value.namespace !== PRODUCTION_WIDGET_NAMESPACE) || typeof value.actionId !== 'string'
        || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.actionId)
        || typeof value.identifier !== 'string' || bytes(value.identifier).length > 4_096
        || typeof value.token !== 'string' || bytes(value.token).length > 8_192
        || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
        || value.createdAt < 0 || value.createdAt > 8_640_000_000_000_000) return null;
    let token: unknown;
    try { token = JSON.parse(value.token); } catch { return null; }
    if (!Array.isArray(token) || token.length !== 4 || typeof token[0] !== 'string' || !token[0]
        || token[0].length > 500 || !validUnicode(token[0]) || !Number.isSafeInteger(token[1]) || token[1] < 0
        || typeof token[2] !== 'string' || !token[2] || typeof token[3] !== 'string'
        || !['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(token[3])
        || (value.namespace === NATIVE_WIDGET_NAMESPACE ? nativeWidgetIdentifier(token[0]) : token[0]) !== value.identifier) return null;
    return { namespace: value.namespace, actionId: value.actionId, identifier: value.identifier,
        token: value.token, createdAt: value.createdAt };
};
export const nativeWidgetSourceTaskID = (source: NativeWidgetCompletionSource): string => JSON.parse(source.token)[0];

export const nativeWidgetCompletionPayload = (source: NativeWidgetCompletionSource): string => JSON.stringify(['iosWidgetCompletion', {
    actionId: source.actionId, createdAt: source.createdAt, identifier: source.identifier, namespace: source.namespace, token: source.token,
}]);
export const readNativeWidgetCompletionResult = (value: unknown, source: NativeWidgetCompletionSource): NativeWidgetCompletionResult | null =>
    record(value) && exact(value, ['actionId', 'outcome']) && value.actionId === source.actionId
        && (value.outcome === 'completed' || value.outcome === 'discarded')
        ? { actionId: source.actionId, outcome: value.outcome } : null;
