import test from 'node:test';
import assert from 'node:assert/strict';
import { clearLaunchContext, launchSearchForPath, parseLaunchContext } from '../public/launch-context.js';

test('assignment links become durable Homework launch context', () => {
  assert.deepEqual(parseLaunchContext('?assignment=Algebra+5.2&assignment_id=abc-123'), {
    context: 'Algebra 5.2',
    title: 'Algebra 5.2',
    category: 'Homework',
    tags: [],
    source: 'AndrewsHW Tracker',
    external_ref: 'abc-123',
    assignment_name: 'Algebra 5.2'
  });
});

test('generic callers can preload context and switching scope preserves it', () => {
  const search = '?context=Panel+7&category=Work+Photo&tags=plc%2C+wiring&source=Job+Tracker&ref=job-9&scope=work';
  assert.deepEqual(parseLaunchContext(search), {
    context: 'Panel 7', title: '', category: 'Work Photo', tags: ['plc', 'wiring'],
    source: 'Job Tracker', external_ref: 'job-9', assignment_name: ''
  });
  assert.equal(launchSearchForPath(search), '?context=Panel+7&category=Work+Photo&tags=plc%2C+wiring&source=Job+Tracker&ref=job-9');
});

test('clearing launch context removes only integration parameters', () => {
  assert.equal(clearLaunchContext('?assignment=Test&assignment_id=7&keep=yes'), '?keep=yes');
  assert.equal(parseLaunchContext('?assignment=+++'), null);
});
