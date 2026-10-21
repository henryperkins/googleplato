/**
 * Page names for classroom routes (client/src/lib/routeTitles.js): a lesson
 * page is named after its lesson so tabs, history, and the route announcement
 * identify it (WCAG 2.4.2), not a generic "Lesson".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lessonIdFromPath, routePageName, pageTitle } from '../src/lib/routeTitles.js';

const lessons = [
  { lessonId: 'l-email', name: 'Write a Project Status Email' },
  { lessonId: 'custom-1', name: 'My Own Lesson' },
];

describe('lessonIdFromPath', () => {
  it('reads the lesson id from a lesson path', () => {
    assert.equal(lessonIdFromPath('/lessons/l-email'), 'l-email');
    assert.equal(lessonIdFromPath('/lessons/l-email/'), 'l-email');
    assert.equal(lessonIdFromPath('/lessons/caf%C3%A9'), 'café');
  });

  it('ignores the list, the create redirect, deeper paths, and malformed escapes', () => {
    assert.equal(lessonIdFromPath('/lessons'), null);
    assert.equal(lessonIdFromPath('/lessons/create'), null);
    assert.equal(lessonIdFromPath('/lessons/l-email/edit'), null);
    assert.equal(lessonIdFromPath('/settings'), null);
    assert.equal(lessonIdFromPath('/lessons/%E0%A4%A'), '%E0%A4%A');
  });
});

describe('routePageName', () => {
  it('names a lesson page after its lesson', () => {
    assert.deepEqual(
      routePageName('/lessons/l-email', { lessons, lessonsLoaded: true }),
      { name: 'Write a Project Status Email', pending: false },
    );
  });

  it('holds the name while lessons are still loading', () => {
    assert.deepEqual(routePageName('/lessons/l-email', { lessons: [], lessonsLoaded: false }), { name: null, pending: true });
  });

  it('says the lesson was not found once lessons have loaded without it', () => {
    assert.deepEqual(routePageName('/lessons/gone', { lessons, lessonsLoaded: true }), { name: 'Lesson not found', pending: false });
  });

  it('keeps the fixed route names', () => {
    assert.equal(routePageName('/lessons').name, 'Lessons');
    assert.equal(routePageName('/settings').name, 'Settings');
    assert.equal(routePageName('/lessons/create').name, 'Create Lesson');
    assert.deepEqual(routePageName('/plato'), { name: null, pending: false });
  });

  it('formats the document title with the classroom name when configured', () => {
    assert.equal(pageTitle('Write a Project Status Email'), 'Write a Project Status Email — plato');
    assert.equal(pageTitle('Write a Project Status Email', ''), 'Write a Project Status Email — plato');
    assert.equal(pageTitle('Write a Project Status Email', '   '), 'Write a Project Status Email — plato');
    assert.equal(pageTitle('Write a Project Status Email', 'AI Leaders Academy'), 'Write a Project Status Email — AI Leaders Academy');
  });
});
