

if (typeof Intl !== 'object' || typeof Intl.Collator !== 'function'
    || typeof Intl.DateTimeFormat !== 'function') {
    throw new Error('JavaScriptCore Intl is required');
}
