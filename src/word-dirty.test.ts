import { expect, it } from 'bun:test';
import { getExpectedWordDirtyFrontier, verifyWordDirtyBaseline } from './word-dirty';
import { getWordAutomationAvailability } from './word-automation';

it('verifies the Word dirty-frontier baseline when Word tests are enabled', async () => {
  if (process.env.WORD_TESTS !== '1') {
    console.log('SKIP: set WORD_TESTS=1 to run Word dirty-frontier verification.');
    return;
  }

  const availability = getWordAutomationAvailability();
  if (!availability.available) {
    console.log('SKIP: ' + availability.reason);
    return;
  }

  const summary = await verifyWordDirtyBaseline();
  expect(summary.actualFrontierFixtureId).toBe(getExpectedWordDirtyFrontier().id);
  expect(summary.results.some(result => result.status === 'serialized-dirty')).toBe(true);
}, 300_000);
