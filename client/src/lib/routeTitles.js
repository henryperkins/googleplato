/**
 * Page names for classroom and admin routes, used for the document title and
 * the "Navigated to …" screen reader announcement (ScreenReaderAnnounce).
 *
 * A lesson page is named after its lesson so every tab, history entry, and
 * announcement identifies it (WCAG 2.4.2). Until lessons have loaded the name
 * is unknown; callers hold the announcement until it resolves.
 */

const ROUTE_NAMES = {
  '/lessons': 'Lessons',
  '/settings': 'Settings',
  '/onboarding': 'Welcome',
};

// Admin pages by the segment after /plato, named as their headings are.
const ADMIN_PAGE_NAMES = {
  '': 'Dashboard',
  lessons: 'Lessons',
  users: 'Users',
  customizer: 'Classroom Customizer',
  ai: 'AI Settings',
  plugins: 'Plugins',
  'setup-kb': 'Set Up Knowledge Base',
};

/**
 * The page name for an admin path, or null outside /plato and for paths that
 * only redirect. A view inside a page (a user's edit view, the lesson editor,
 * the knowledge base) shares the page's name, so moving between them isn't a
 * page change; the view names itself in its heading and title.
 */
export function adminPageName(path) {
  const [root, base, section = ''] = (path || '').split('/');
  if (root !== '' || base !== 'plato') return null;
  return Object.hasOwn(ADMIN_PAGE_NAMES, section) ? ADMIN_PAGE_NAMES[section] : null;
}

/** The lesson id in a /lessons/:id path, or null. */
export function lessonIdFromPath(path) {
  const match = /^\/lessons\/([^/]+)\/?$/.exec(path || '');
  if (!match || match[1] === 'create') return null;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

/**
 * The page name for a classroom path.
 * Returns { name, pending }: `name` is null for paths this module doesn't name,
 * and `pending` is true while a lesson's name is still loading.
 */
export function routePageName(path, { lessons = [], lessonsLoaded = false } = {}) {
  if (ROUTE_NAMES[path]) return { name: ROUTE_NAMES[path], pending: false };
  if ((path || '').startsWith('/lessons/create')) return { name: 'Create Lesson', pending: false };
  const lessonId = lessonIdFromPath(path);
  if (!lessonId) return { name: null, pending: false };
  const lessonName = lessons.find((l) => l.lessonId === lessonId)?.name;
  if (lessonName) return { name: lessonName, pending: false };
  if (lessonsLoaded) return { name: 'Lesson not found', pending: false };
  return { name: null, pending: true };
}

export function pageTitle(name, classroomName) {
  const brand = typeof classroomName === 'string' && classroomName.trim() ? classroomName.trim() : 'plato';
  return `${name} — ${brand}`;
}
