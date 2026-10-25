/**
 * Page names for classroom and admin routes (client/src/lib/routeTitles.js): a
 * lesson page is named after its lesson so tabs, history, and the route
 * announcement identify it (WCAG 2.4.2), not a generic "Lesson".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lessonIdFromPath, routePageName, adminPageName, pageTitle } from '../src/lib/routeTitles.js';

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

describe('adminPageName', () => {
  it('names each admin page as its heading does', () => {
    assert.equal(adminPageName('/plato'), 'Dashboard');
    assert.equal(adminPageName('/plato/'), 'Dashboard');
    assert.equal(adminPageName('/plato/lessons'), 'Lessons');
    assert.equal(adminPageName('/plato/users'), 'Users');
    assert.equal(adminPageName('/plato/customizer'), 'Classroom Customizer');
    assert.equal(adminPageName('/plato/ai'), 'AI Settings');
    assert.equal(adminPageName('/plato/plugins'), 'Plugins');
    assert.equal(adminPageName('/plato/setup-kb'), 'Set Up Knowledge Base');
  });

  it('gives a view inside a page the page name, so moving between them is not a page change', () => {
    assert.equal(adminPageName('/plato/users/usr_123'), 'Users');
    assert.equal(adminPageName('/plato/users/waitlist/tok'), 'Users');
    assert.equal(adminPageName('/plato/lessons/new'), 'Lessons');
    assert.equal(adminPageName('/plato/lessons/l-email/edit'), 'Lessons');
    assert.equal(adminPageName('/plato/customizer/knowledge/edit'), 'Classroom Customizer');
  });

  it('names nothing outside admin, redirect-only paths, or inherited object keys', () => {
    assert.equal(adminPageName('/lessons'), null);
    assert.equal(adminPageName('/platonic'), null);
    assert.equal(adminPageName('/x/plato'), null);
    assert.equal(adminPageName('/plato/courses'), null);
    assert.equal(adminPageName('/plato/integrations'), null);
    assert.equal(adminPageName('/plato/constructor'), null);
    assert.equal(adminPageName(''), null);
    assert.equal(adminPageName(undefined), null);
  });

  it('keeps plato in admin titles rather than the classroom name', () => {
    assert.equal(pageTitle(adminPageName('/plato/ai')), 'AI Settings — plato');
  });
});
