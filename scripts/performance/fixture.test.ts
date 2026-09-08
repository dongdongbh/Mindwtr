import { expect, test } from 'bun:test';
import { fixture } from './fixture.mjs';
test('fixtures are deterministic and versioned with empty and large datasets', () => {
  expect(fixture(1000)).toEqual(fixture(1000));
  expect(fixture(0).data.tasks).toHaveLength(0);
  expect(fixture(10000).data.tasks).toHaveLength(10000);
  expect(fixture(0).id).not.toBe(fixture(1000).id);
  expect(() => fixture(-1)).toThrow();
});
