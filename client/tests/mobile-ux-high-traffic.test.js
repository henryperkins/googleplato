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
    assert.match(css, /color-scheme:\s*light dark/);
    assert.match(css, /\.compose-chip-remove\s*\{[\s\S]*?position:\s*relative/);
    assert.match(css, /\.compose-chip-remove::after\s*\{[\s\S]*?inset:\s*-8px/);
    assert.match(css, /font-size:\s*max\(16px,\s*1rem\)/);
    assert.match(css, /scroll-padding-top:\s*4rem/);
    assert.match(css, /scroll-padding-bottom:\s*calc\(6rem\s*\+\s*env\(safe-area-inset-bottom,\s*0px\)\)/);
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
      { file: 'pages/LessonChat.jsx', key: 'plato_compose_draft' },
      { file: 'pages/Settings.jsx', key: 'plato_settings_fields_draft' },
      { file: 'pages/Settings.jsx', key: 'plato_profile_feedback_draft' },
      { file: 'components/ProfileCompletionGate.jsx', key: 'plato_profile_gate_draft' },
    ];

    for (const { file, key } of draftPages) {
      const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
      assert.match(src, new RegExp(key), `${file} missing sessionStorage draft key ${key}`);
      assert.match(src, /sessionStorage\.getItem/, `${file} missing sessionStorage read`);
      assert.match(src, /sessionStorage\.setItem/, `${file} missing sessionStorage write`);
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
    assert.match(lessonsSrc, /className="touch-target truncate rounded-sm text-left font-medium underline/);

    const usersSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/AdminUsers.jsx'), 'utf8');
    assert.match(usersSrc, /item\._type === 'invite'\s*\?\s*\(\s*<TableRow[^>]*>\s*<TableCell className="text-muted-foreground">\s*<span className="block truncate max-w-full" title=\{item\.email\}>\{item\.email\}<\/span>/);
    assert.match(usersSrc, /plato_admin_edit_user_draft/);
  });

  it('adapts AdminLayout, AdminHome, AdminKBSetup, UserFieldsDialog, WaitlistDialog, and WaitlistEntryEdit for mobile viewports', () => {
    const layoutSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/AdminLayout.jsx'), 'utf8');
    assert.match(layoutSrc, /pb-\[calc\(3\.5rem\+env\(safe-area-inset-bottom\)\)\]/);
    assert.match(layoutSrc, /admin-bottom-nav/);

    const homeSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/AdminHome.jsx'), 'utf8');
    assert.equal(/text-\[10px\]/.test(homeSrc), false);
    assert.equal(/\btitle=/.test(homeSrc), false);

    const kbSetupSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/AdminKBSetup.jsx'), 'utf8');
    assert.match(kbSetupSrc, /min-h-dvh shrink-0/);
    assert.match(kbSetupSrc, /safe-area-inset-top/);
    assert.match(kbSetupSrc, /safe-area-inset-bottom/);
    assert.match(kbSetupSrc, /\/v1\/admin\/knowledge-base\/conversation/);

    const userFieldsSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/UserFieldsDialog.jsx'), 'utf8');
    assert.match(userFieldsSrc, /basis-full sm:basis-auto sm:flex-1/);

    const waitlistDialogSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/WaitlistDialog.jsx'), 'utf8');
    assert.match(waitlistDialogSrc, /<DialogContent variant="sheet">/);

    const waitlistEditSrc = fs.readFileSync(path.join(SRC_DIR, 'pages/admin/WaitlistEntryEdit.jsx'), 'utf8');
    assert.match(waitlistEditSrc, /flex flex-wrap items-center gap-3 pt-2/);
  });
});
