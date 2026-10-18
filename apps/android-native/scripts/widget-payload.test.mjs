import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { corePublication, firstDifference, widgetSelections } from './widget-payload.mjs';

test('independent widget preferences decode private labels and deduplicate multiple widgets', () => {
    assert.deepEqual(widgetSelections('<map><string name="42">context:@家/desk &amp; +?</string><string name="43">tag:#urgent</string><string name="44">tag:#urgent</string><string name="bad">ignored</string></map>'),
        ['context:@家/desk & +?', 'tag:#urgent']);
});

test('a removed selected context omitted from the payload fails independent publication parity', () => {
    const listSelections = widgetSelections('<map><string name="42">context:@removed</string></map>');
    const output = execFileSync('bun', ['-e', `
        import { buildAndroidWidgetPublication } from './packages/core/src/widget-payload.ts';
        const expected = buildAndroidWidgetPublication({ tasks: [], projects: [], areas: [], sections: [], settings: {} }, 'en', { listSelections: JSON.parse(process.env.CHECK_SELECTIONS) });
        console.log(JSON.stringify(expected));
    `], { cwd: new URL('../../..', import.meta.url).pathname, encoding: 'utf8', env: { ...process.env, CHECK_SELECTIONS: JSON.stringify(listSelections) } });
    const expected = JSON.parse(output.trim());
    assert.equal(expected.lists['context:@removed'].title, '@removed');
    const actual = structuredClone(expected);
    delete actual.lists['context:@removed'];
    assert.match(firstDifference(actual, expected), /context:@removed/);
    assert.throws(() => corePublication({ context: {}, payload: JSON.stringify(actual) }), /Independent persisted widget selections/);
});

test('publication map order is irrelevant while row array order remains significant', () => {
    assert.equal(firstDifference({ lists: { a: { title: 'A' }, b: { title: 'B' } } }, { lists: { b: { title: 'B' }, a: { title: 'A' } } }), null);
    assert.notEqual(firstDifference({ items: [{ id: 'a' }, { id: 'b' }] }, { items: [{ id: 'b' }, { id: 'a' }] }), null);
});
