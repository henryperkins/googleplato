import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../src');
const HTML_PATH = path.resolve(__dirname, '../index.html');

describe('Mobile Web UX Audit — High-Traffic Routes Contract', () => {
  it('index.html preserves pinch-zoom and configures viewport-fit=cover + interactive-widget', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    assert.match(html, /width=device-width/);
    assert.match(html, /initial-scale=1\.0/);
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /interactive-widget=resizes-content/);
    assert.equal(/user-scalable\s*=\s*no/i.test(html), false);
    assert.equal(/maximum-scale/i.test(html), false);
  });

  it('index.css enforces color-scheme, non-overlapping 44x44px hit areas on compose chip remove buttons, and >= 16px mobile inputs', () => {
    const css = fs.readFileSync(path.join(SRC_DIR, 'index.css'), 'utf8');
    // Light unless the learner picks dark (theme.test.js); `light dark` turned native controls dark on a light page.
    assert.match(css, /color-scheme:\s*light;/);
    assert.match(css, /\.compose-chip-remove\s*\{[\s\S]*?position:\s*relative/);
    assert.match(css, /\.compose-chip-remove::after\s*\{[\s\S]*?inset:\s*-8px/);
    assert.match(css, /font-size:\s*max\(16px,\s*1rem\)/);
    // Measured sticky bars set the padding; the fallbacks keep the old 4rem / 6rem.
    assert.match(css, /scroll-padding-top:\s*calc\(var\(--sticky-top,\s*3\.5rem\)\s*\+\s*0\.5rem\)/);
    assert.match(css, /scroll-padding-bottom:\s*calc\(var\(--sticky-bottom,\s*calc\(5\.5rem\s*\+\s*env\(safe-area-inset-bottom,\s*0px\)\)\)\s*\+\s*0\.5rem\)/);
    assert.match(css, /#lesson-header,\s*\.compose-sticky-bar\s*\{\s*position:\s*static/);
  });

  it('standalone auth & onboarding routes apply safe-area insets and explicit logo dimensions to prevent notch clipping and CLS', () => {
    const authPages = [
      'pages/Login.jsx',
      'pages/Signup.jsx',
      'pages/Setup.jsx',
      'pages/Waitlist.jsx',
      'pages/ForgotPassword.jsx',
      'pages/ResetPassword.jsx',
      'pages/Privacy.jsx',
    ];

    for (const rel of authPages) {
      const src = fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');
      assert.match(src, /safe-area-inset-top/, `${rel} missing top safe-area inset`);
      assert.match(src, /safe-area-inset-bottom/, `${rel} missing bottom safe-area inset`);
      assert.match(src, /safe-area-inset-left/, `${rel} missing left safe-area inset`);
      assert.match(src, /safe-area-inset-right/, `${rel} missing right safe-area inset`);
      assert.match(src, /<img[^>]+width=/, `${rel} logo missing explicit width attribute`);
      assert.match(src, /<img[^>]+height=/, `${rel} logo missing explicit height attribute`);
      assert.match(src, /fetchPriority="high"/, `${rel} logo missing fetchPriority="high"`);
    }
  });

  it('persists non-sensitive form drafts in sessionStorage across mobile background tab discards', () => {
    const draftPages = [
      { file: 'pages/Login.jsx', key: 'plato_login_draft' },
      { file: 'pages/Signup.jsx', key: 'plato_signup_draft' },
      { file: 'pages/Setup.jsx', key: 'plato_setup_draft' },
      { file: 'pages/Waitlist.jsx', key: 'plato_waitlist_draft' },
      { file: 'pages/ForgotPassword.jsx', key: 'plato_forgot_password_draft' },
      // Lesson drafts have executable recovery/account-isolation tests in lesson-drafts.test.js.
      { file: 'pages/Settings.jsx', key: 'plato_settings_fields_draft' },
      { file: 'pages/Settings.jsx', key: 'plato_profile_feedback_draft' },
      { file: 'components/ProfileCompletionGate.jsx', key: 'plato_profile_gate_draft' },
    ];

    for (const { file, key } of draftPages) {
      const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
      assert.match(src, new RegExp(key), `${file} missing sessionStorage draft key ${key}`);
      assert.match(src, /(?:sessionStorage|storage\(\))\.getItem/, `${file} missing sessionStorage read`);
      assert.match(src, /(?:sessionStorage|storage\(\))\.setItem/, `${file} missing sessionStorage write`);
    }
  });

  it('prevents duplicate submissions on ForgotPassword and ResetPassword and wires Enter key focus progression on Waitlist and Signup', () => {
    const forgotSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/ForgotPassword.jsx'), 'utf8');
    assert.match(forgotSrc, /const \[submitting, setSubmitting\] = useState\(false\)/);
    assert.match(forgotSrc, /disabled=\{submitting\}/);

    const resetSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/ResetPassword.jsx'), 'utf8');
    assert.match(resetSrc, /const \[submitting, setSubmitting\] = useState\(false\)/);
    assert.match(resetSrc, /disabled=\{submitting\}/);

    const waitlistSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/Waitlist.jsx'), 'utf8');
    assert.match(waitlistSrc, /waitlist-field-\$\{userFields\[0\]\.id\}/);
    assert.match(waitlistSrc, /waitlist-field-\$\{nextField\.id\}/);

    const signupSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/Signup.jsx'), 'utf8');
    assert.match(signupSrc, /signup-field-\$\{userFields\[0\]\.id\}/);
    assert.match(signupSrc, /signup-field-\$\{nextField\.id\}/);
  });

  it('disables autoCapitalize, autoCorrect, and spellCheck on PasswordField even when visible is toggled', () => {
    const pwSrc = fs.readFileSync(path.join(SRC_DIR, 'components/PasswordField.jsx'), 'utf8');
    assert.match(pwSrc, /autoCapitalize="none"/);
    assert.match(pwSrc, /autoCorrect="off"/);
    assert.match(pwSrc, /spellCheck=\{false\}/);
  });

  it('ensures select controls in UserFieldsDialog, WaitlistEntryEdit, and SettingsForm use text-base md:text-sm to avoid iOS focus zoom', () => {
    const files = [
      'pages/admin/UserFieldsDialog.jsx',
      'pages/admin/WaitlistEntryEdit.jsx',
      'lib/plugins/SettingsForm.jsx',
    ];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');
      assert.match(src, /text-base md:text-sm/, `${rel} missing text-base md:text-sm on select`);
    }
  });

  it('spaces attachment chips in ComposeBar and scopes card hover shadow in LessonsList', () => {
    const composeSrc = fs.readFileSync(path.join(SRC_DIR, 'components/chat/ComposeBar.jsx'), 'utf8');
    assert.match(composeSrc, /flex flex-wrap gap-3/);
    assert.match(composeSrc, /width="80"\s+height="80"\s+decoding="async"/);

    const listSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/LessonsList.jsx'), 'utf8');
    assert.match(listSrc, /\[@media\(hover:hover\)_and_\(pointer:fine\)\]:hover:shadow-md/);
    assert.match(listSrc, /touch-manipulation/);
  });

  it('caps sticky first table column on mobile and makes lesson and invite rows identifiable and accessible', () => {
    const tableSrc = fs.readFileSync(path.join(SRC_DIR, 'components/ui/table.jsx'), 'utf8');
    assert.match(tableSrc, /\[&_td:first-child\]:max-w-\[11rem\]/);
    assert.match(tableSrc, /sm:\[&_td:first-child\]:max-w-none/);

    const lessonsSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/AdminLessons.jsx'), 'utf8');
    assert.match(lessonsSrc, /onClick=\{\(\) => openLessonEditor\(c\.lessonId\)\}/);
    assert.match(lessonsSrc, /className="touch-target truncate max-w-full rounded-sm text-left font-medium underline/);

    const usersSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/AdminUsers.jsx'), 'utf8');
    assert.match(usersSrc, /title=\{item\.email\}/);
    assert.match(usersSrc, /Pending invite/);
    assert.match(usersSrc, /plato_admin_edit_user_draft/);
  });

  it('adapts AdminLayout, AdminHome, AdminKBSetup, UserFieldsDialog, WaitlistDialog, and WaitlistEntryEdit for mobile viewports', () => {
    const layoutSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/AdminLayout.jsx'), 'utf8');
    assert.match(layoutSrc, /h-dvh/);
    assert.match(layoutSrc, /overflow-y-auto/);
    assert.match(layoutSrc, /admin-bottom-nav/);
    assert.equal(/admin-bottom-nav[^"]*fixed bottom-0/.test(layoutSrc), false);
    // Tabs show their labels from 30rem, where six fit; narrower, the label is
    // screen-reader text beside an aria-hidden icon. The active icon uses the
    // contrast-safe token (plain --primary is dimmer than inactive icons in dark mode).
    const bottomNavSrc = layoutSrc.slice(layoutSrc.indexOf('admin-bottom-nav'));
    assert.match(bottomNavSrc, /<span className=\{`sr-only min-\[30rem\]:not-sr-only /);
    assert.match(bottomNavSrc, /<Icon aria-hidden="true"/);
    assert.match(bottomNavSrc, /border-primary text-primary-text/);
    assert.equal(/\btitle=\{label\}/.test(bottomNavSrc), false, 'no hover-only tooltips standing in for labels');
    // Phones and tablets keep the bottom tabs up to the large breakpoint, so a
    // 768px tablet doesn't lose a third of its width to the sidebar.
    assert.match(layoutSrc, /className="admin-bottom-nav lg:hidden /);
    assert.match(layoutSrc, /className="hidden lg:flex lg:w-56 /);
    assert.equal(/\bmd:/.test(layoutSrc), false, 'the shell switches at one breakpoint');
    // A short window scrolls the sidebar instead of cutting off Sign Out.
    assert.match(layoutSrc, /lg:fixed lg:top-0 lg:left-0 lg:overflow-y-auto/);
    // The account menu replaces the drawer, so no text explains how to navigate.
    assert.equal(/Use the tabs/.test(layoutSrc), false);
    assert.match(layoutSrc, /<DropdownMenuTrigger\s+className="sidebar-control /);

    const homeSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/AdminHome.jsx'), 'utf8');
    assert.equal(/text-\[10px\]/.test(homeSrc), false);
    assert.equal(/\btitle=/.test(homeSrc), false);

    const kbSetupSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/AdminKBSetup.jsx'), 'utf8');
    assert.match(kbSetupSrc, /KnowledgeBaseEditor/);
    assert.match(kbSetupSrc, /Skip for now/);
    assert.equal(/<main\b/.test(kbSetupSrc), false);
    const kbEditorSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/KnowledgeBaseEditor.jsx'), 'utf8');
    assert.match(kbEditorSrc, /\/v1\/admin\/knowledge-base\/conversation/);

    const userFieldsSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/UserFieldsDialog.jsx'), 'utf8');
    assert.match(userFieldsSrc, /basis-full sm:basis-auto sm:flex-1/);

    const waitlistDialogSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/WaitlistDialog.jsx'), 'utf8');
    assert.match(waitlistDialogSrc, /<DialogContent variant="sheet">/);

    const waitlistEditSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/WaitlistEntryEdit.jsx'), 'utf8');
    assert.match(waitlistEditSrc, /flex flex-wrap items-center gap-3 pt-2/);
  });

  it('relaxes sticky bars on short viewports in em, so zoom and enlarged text count as short', () => {
    const css = fs.readFileSync(path.join(SRC_DIR, 'index.css'), 'utf8');
    const hook = fs.readFileSync(path.join(SRC_DIR, 'hooks/useVisualViewportKeyboardOffset.js'), 'utf8');
    assert.match(css, /@media \(max-height: 34em\) \{\s*#lesson-header,\s*\.compose-sticky-bar\s*\{\s*position:\s*static/);
    assert.match(hook, /SHORT_VIEWPORT_QUERY = '\(max-height: 34em\)'/);
    assert.match(hook, /matchMedia\?\.\(SHORT_VIEWPORT_QUERY\)/);
    assert.equal(/orientation: landscape/.test(css), false);
  });

  it('lets the admin page scroll as a whole on short viewports, bars included', () => {
    const css = fs.readFileSync(path.join(SRC_DIR, 'index.css'), 'utf8');
    const layoutSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/AdminLayout.jsx'), 'utf8');
    const short = css.slice(css.indexOf('@media (max-height: 34em)'));
    const block = short.slice(0, short.indexOf('\n}\n'));
    // The bars are pinned by the full-height flex column, not by position, so
    // the column itself must give way; <main> then sizes to its content
    // (a 0% flex basis would leave it short, with the page running under the tabs).
    assert.match(block, /\.admin-shell \{\s*height: auto;\s*min-height: 100dvh;\s*overflow: visible;/);
    assert.match(block, /\.admin-shell > main \{\s*flex: 1 0 auto;\s*overflow: visible;/);
    assert.equal(/\.admin-bottom-nav[^{]*\{\s*position: static/.test(block), false);
    assert.match(layoutSrc, /className="admin-shell flex h-dvh flex-col overflow-hidden /);
  });

  it('starts each admin page at its top, with focus and a skip link like the classroom', () => {
    const layoutSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/AdminLayout.jsx'), 'utf8');
    const announceSrc = fs.readFileSync(path.join(SRC_DIR, 'components/ScreenReaderAnnounce.jsx'), 'utf8');
    const css = fs.readFileSync(path.join(SRC_DIR, 'index.css'), 'utf8');
    assert.match(layoutSrc, /<a href="#main-content" className="sr-only focus:not-sr-only/);
    assert.match(layoutSrc, /id="main-content"\s+tabIndex=\{-1\}/);
    // Keyed on the page, not the path, so a view inside a page keeps its place;
    // a layout effect, so focus a page places itself still wins.
    assert.match(layoutSrc, /const page = adminPageName\(location\.pathname\);/);
    assert.match(layoutSrc, /useLayoutEffect\(\(\) => \{\s*if \(pageRef\.current === page\) return;/);
    assert.match(layoutSrc, /main\.scrollTop = 0;\s*window\.scrollTo\(0, 0\);/);
    assert.match(layoutSrc, /if \(fromChrome\) main\.focus\(\{ preventScroll: true \}\);/);
    assert.match(announceSrc, /const adminName = adminPageName\(location\.pathname\);/);
    assert.match(announceSrc, /if \(adminName\) document\.title = pageTitle\(adminName\);\s*\}, \[adminName\]\);/);
    assert.match(css, /\.admin-main:focus-visible \{\s*outline: none;/);
    assert.match(css, /\.admin-bottom-nav a:focus-visible \{\s*outline-offset: -3px;/);
  });

  it('keeps author-written names from truncating or overflowing on narrow screens', () => {
    const chatSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/LessonChat.jsx'), 'utf8');
    // The outline link follows the title, wrapping beneath a long one; the title
    // wraps rather than truncating (DESIGN.md: chat header).
    assert.match(chatSrc, /<div className="flex flex-wrap items-baseline gap-x-3 gap-y-0\.5">\s*<h1 ref=\{headingRef\}/);
    assert.match(chatSrc, /<h1 ref=\{headingRef\}[^>]*className="[^"]*break-words line-clamp-3/);

    const listSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/LessonsList.jsx'), 'utf8');
    // Filter selects shrink below their longest option instead of widening the page.
    assert.match(listSrc, /id="course-filter"[\s\S]*?className="flex h-9 min-w-0 max-w-full sm:max-w-xs/);
    // Course names wrap inside the card's meta line.
    assert.match(listSrc, /key: 'course', text: lesson\.course\.name, wrap: true/);
    assert.match(listSrc, /part\.wrap \? 'break-words' : 'whitespace-nowrap'/);
  });

  it('sizes touch targets without clipping tabs or stretching sentences', () => {
    const css = fs.readFileSync(path.join(SRC_DIR, 'index.css'), 'utf8');
    assert.match(css, /button:not\(\.truncate\):not\(\[role="tab"\]\)\s*\{[\s\S]*?white-space:\s*normal/);
    assert.match(css, /\.touch-target-inline::after\s*\{[\s\S]*?width:\s*max\(100%,\s*44px\)[\s\S]*?height:\s*max\(100%,\s*44px\)/);

    const tabsSrc = fs.readFileSync(path.join(SRC_DIR, 'components/ui/tabs.jsx'), 'utf8');
    assert.match(tabsSrc, /pointer-coarse:group-data-horizontal\/tabs:h-auto/);
    assert.match(tabsSrc, /group-data-\[variant=default\]\/tabs-list:after:hidden/);

    // Links inside sentences use the inline hit area, never a 44px-tall box.
    for (const rel of ['pages/admin/AdminHome.jsx', 'pages/admin/AdminCustomizer.jsx', 'pages/admin/AdminPlugins.jsx']) {
      const src = fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');
      assert.match(src, /touch-target-inline underline/, `${rel} inline link`);
      assert.equal(/touch-target inline-flex items-center underline/.test(src), false, `${rel} stretches its sentence`);
    }
  });
});
