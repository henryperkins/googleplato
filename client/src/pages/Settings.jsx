import { useState, useEffect, useRef } from 'react';
import { useApp } from '../contexts/AppContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import PasswordField from '../components/PasswordField.jsx';
import {
  savePreferences,
  getLearnerProfileSummary,
  saveLearnerProfile, saveLearnerProfileSummary,
} from '../../js/storage.js';
import { updateProfile, getMyFields } from '../../js/auth.js';
import { missingRequired, pickValues, validateCustomField, validateCustomFields } from '../lib/userFields.js';
import CustomFieldInput from '../components/CustomFieldInput.jsx';
import * as orchestrator from '../../js/orchestrator.js';
import { syncInBackground } from '../lib/syncDebounce.js';
import { ensureProfileExists, mergeProfile } from '../lib/profileQueue.js';
import { aiErrorMessage } from '../lib/aiErrors.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

const SETTINGS_FIELDS_DRAFT_KEY = 'plato_settings_fields_draft';
const PROFILE_FEEDBACK_DRAFT_KEY = 'plato_profile_feedback_draft';

export default function Settings() {
  const { state, dispatch } = useApp();
  const { user, refreshUser } = useAuth();
  const [name, setName] = useState(user?.name || state.preferences?.name || '');
  const [username, setUsername] = useState(user?.username || '');
  const [profileSummary, setProfileSummary] = useState('');

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordErrors, setPasswordErrors] = useState({});
  const [passwordFeedback, setPasswordFeedback] = useState(null);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [nameFeedback, setNameFeedback] = useState(null);
  const [nameSubmitting, setNameSubmitting] = useState(false);
  const [usernameFeedback, setUsernameFeedback] = useState(null);
  const [usernameSubmitting, setUsernameSubmitting] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [userFields, setUserFields] = useState([]);
  const [fieldValues, setFieldValues] = useState(() => {
    try {
      const raw = sessionStorage.getItem(SETTINGS_FIELDS_DRAFT_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [fieldsFeedback, setFieldsFeedback] = useState(null);
  const [fieldsSaving, setFieldsSaving] = useState(false);
  const usernameRef = useRef(null);
  const newPasswordRef = useRef(null);
  const confirmPasswordRef = useRef(null);

  useEffect(() => {
    (async () => {
      setProfileSummary(await getLearnerProfileSummary());
    })();
    getMyFields()
      .then((data) => {
        setUserFields(data.userFields || []);
        let draft = {};
        try {
          const raw = sessionStorage.getItem(SETTINGS_FIELDS_DRAFT_KEY);
          if (raw) draft = JSON.parse(raw);
        } catch { /* ignore */ }
        setFieldValues({ ...(data.values || {}), ...draft });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!userFields.length) return;
    try {
      sessionStorage.setItem(SETTINGS_FIELDS_DRAFT_KEY, JSON.stringify(fieldValues));
    } catch { /* ignore */ }
  }, [userFields.length, fieldValues]);

  const handleSaveFields = async (e) => {
    e.preventDefault();
    if (fieldsSaving) return;
    setFieldsFeedback(null);
    const cfErrs = validateCustomFields(userFields, fieldValues);
    const cfIds = Object.keys(cfErrs);
    if (cfIds.length) {
      setFieldErrors(cfErrs);
      const missing = missingRequired(userFields, fieldValues);
      setFieldsFeedback({
        type: 'error',
        message: missing.length ? 'Fill in all required fields.' : cfErrs[cfIds[0]],
      });
      document.getElementById(`settings-field-${cfIds[0]}`)?.focus();
      return;
    }
    setFieldErrors({});
    setFieldsSaving(true);
    try {
      const data = await updateProfile({ customFields: pickValues(fieldValues, userFields.map((f) => f.id)) });
      try { sessionStorage.removeItem(SETTINGS_FIELDS_DRAFT_KEY); } catch { /* ignore */ }
      setFieldValues(data.customFields || {});
      setFieldsFeedback({ type: 'success', message: 'Saved!' });
    } catch (err) {
      setFieldsFeedback({ type: 'error', message: err.message || 'Failed to update' });
    } finally {
      setFieldsSaving(false);
    }
  };

  const handleSaveUsername = async (e) => {
    e.preventDefault();
    if (usernameSubmitting) return;
    setUsernameFeedback(null);
    const trimmed = username.trim();
    if (!trimmed) {
      setUsernameFeedback({ type: 'error', message: 'Username is required' });
      usernameRef.current?.focus();
      return;
    }
    setUsernameSubmitting(true);
    try {
      await updateProfile({ username: trimmed });
      await refreshUser();
      setUsernameFeedback({ type: 'success', message: 'Saved!' });
    } catch (err) {
      setUsernameFeedback({ type: 'error', message: err.message || 'Failed to update' });
    } finally {
      setUsernameSubmitting(false);
    }
  };

  const handleSaveName = async (e) => {
    e.preventDefault();
    if (nameSubmitting) return;
    setNameFeedback(null);
    setNameSubmitting(true);
    const trimmed = name.trim();
    const prefs = { ...state.preferences, name: trimmed };

    try {
      await savePreferences(prefs);
      dispatch({ type: 'SET_PREFERENCES', preferences: prefs });
      syncInBackground('preferences');
      await updateProfile({ name: trimmed });
      await refreshUser();
      setNameFeedback({ type: 'success', message: 'Saved!' });
    } catch (err) {
      setNameFeedback({ type: 'error', message: err.message || 'Failed to update' });
    } finally {
      setNameSubmitting(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (passwordSubmitting) return;
    setPasswordFeedback(null);
    const nextErrs = {};
    if (!newPassword || newPassword.length < 8) {
      nextErrs.newPassword = 'Password must be at least 8 characters.';
    }
    if (newPassword && newPassword.length >= 8 && newPassword !== confirmPassword) {
      nextErrs.confirmPassword = 'Passwords do not match.';
    }
    if (Object.keys(nextErrs).length > 0) {
      setPasswordErrors(nextErrs);
      setPasswordFeedback({ type: 'error', message: nextErrs.newPassword || nextErrs.confirmPassword });
      if (nextErrs.newPassword) newPasswordRef.current?.focus();
      else if (nextErrs.confirmPassword) confirmPasswordRef.current?.focus();
      return;
    }
    setPasswordErrors({});
    setPasswordSubmitting(true);
    try {
      await updateProfile({ password: newPassword });
      setNewPassword('');
      setConfirmPassword('');
      setPasswordFeedback({ type: 'success', message: 'Password changed!' });
    } catch (err) {
      setPasswordFeedback({ type: 'error', message: err.message || 'Failed to change password' });
    } finally {
      setPasswordSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-lg space-y-6 p-4">
      <h1 className="text-xl font-semibold">User Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle><h2>Account</h2></CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-1 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-3">
            <span className="shrink-0 text-muted-foreground">Email</span>
            <span className="min-w-0 wrap-anywhere sm:text-right">{user?.email || ''}</span>
          </div>

          <Separator />

          <form className="space-y-3" onSubmit={handleSaveUsername} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="account-username">Username</Label>
              <Input
                id="account-username"
                ref={usernameRef}
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="done"
                value={username}
                readOnly={usernameSubmitting}
                aria-invalid={usernameFeedback?.type === 'error' ? true : undefined}
                aria-describedby="username-feedback"
                onChange={(e) => { setUsername(e.target.value); setUsernameFeedback(null); }}
                onBlur={() => {
                  if (usernameFeedback?.type === 'error' && !username.trim()) {
                    setUsernameFeedback({ type: 'error', message: 'Username is required' });
                  }
                }}
              />
            </div>
            <Button type="submit" disabled={usernameSubmitting} focusableWhenDisabled aria-label={usernameSubmitting ? 'Saving username' : 'Save username'}>{usernameSubmitting ? 'Saving...' : 'Save'}</Button>
            <SettingsFeedback id="username-feedback" feedback={usernameFeedback} />
          </form>

          <Separator />

          <form className="space-y-3" onSubmit={handleSaveName} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="account-name">Name</Label>
              <Input
                id="account-name"
                type="text"
                autoComplete="name"
                enterKeyHint="done"
                value={name}
                readOnly={nameSubmitting}
                aria-invalid={nameFeedback?.type === 'error' ? true : undefined}
                aria-describedby="name-feedback"
                onChange={(e) => { setName(e.target.value); setNameFeedback(null); }}
              />
            </div>
            <Button type="submit" disabled={nameSubmitting} focusableWhenDisabled aria-label={nameSubmitting ? 'Saving name' : 'Save name'}>{nameSubmitting ? 'Saving...' : 'Save'}</Button>
            <SettingsFeedback id="name-feedback" feedback={nameFeedback} />
          </form>

          <Separator />

          <form className="space-y-3" onSubmit={handleChangePassword} noValidate>
            {/* Lets password managers attach the new password to this account. */}
            <input type="text" name="username" autoComplete="username" value={user?.email || ''} readOnly hidden />
            <div className="space-y-1.5">
              <Label htmlFor="new-password">New Password</Label>
              <PasswordField
                id="new-password"
                autoComplete="new-password"
                enterKeyHint="next"
                inputRef={newPasswordRef}
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  setPasswordFeedback(null);
                  if (passwordErrors.newPassword) setPasswordErrors((prev) => ({ ...prev, newPassword: '' }));
                }}
                onBlur={() => {
                  if (newPassword || passwordErrors.newPassword) {
                    const msg = !newPassword || newPassword.length < 8 ? 'Password must be at least 8 characters.' : '';
                    setPasswordErrors((prev) => ({ ...prev, newPassword: msg }));
                  }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); confirmPasswordRef.current?.focus(); } }}
                readOnly={passwordSubmitting}
                aria-invalid={passwordErrors.newPassword || (passwordFeedback?.type === 'error' && !passwordErrors.confirmPassword) ? true : undefined}
                aria-describedby={passwordErrors.newPassword ? 'new-password-error password-feedback' : 'password-feedback'}
              />
              {passwordErrors.newPassword && (
                <p id="new-password-error" className="text-xs text-destructive" role="alert">{passwordErrors.newPassword}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-password">Confirm Password</Label>
              <PasswordField
                id="confirm-password"
                autoComplete="new-password"
                enterKeyHint="done"
                inputRef={confirmPasswordRef}
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  setPasswordFeedback(null);
                  if (passwordErrors.confirmPassword) setPasswordErrors((prev) => ({ ...prev, confirmPassword: '' }));
                }}
                onBlur={() => {
                  if (confirmPassword || passwordErrors.confirmPassword) {
                    const msg = newPassword && confirmPassword !== newPassword ? 'Passwords do not match.' : '';
                    setPasswordErrors((prev) => ({ ...prev, confirmPassword: msg }));
                  }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); handleChangePassword(e); } }}
                readOnly={passwordSubmitting}
                aria-invalid={passwordErrors.confirmPassword ? true : undefined}
                aria-describedby={passwordErrors.confirmPassword ? 'confirm-password-error password-feedback' : 'password-feedback'}
              />
              {passwordErrors.confirmPassword && (
                <p id="confirm-password-error" className="text-xs text-destructive" role="alert">{passwordErrors.confirmPassword}</p>
              )}
            </div>
            <Button type="submit" disabled={passwordSubmitting} focusableWhenDisabled>
              {passwordSubmitting ? 'Changing...' : 'Change Password'}
            </Button>
            <SettingsFeedback id="password-feedback" feedback={passwordFeedback} />
          </form>
        </CardContent>
      </Card>

      {userFields.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle><h2>Profile</h2></CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSaveFields} noValidate>
              {userFields.map((f, idx) => (
                <CustomFieldInput
                  key={f.id}
                  field={f}
                  idPrefix="settings-field"
                  enterKeyHint={idx === userFields.length - 1 ? 'done' : 'next'}
                  value={fieldValues[f.id]}
                  error={fieldErrors[f.id]}
                  onChange={(v) => {
                    setFieldValues((prev) => ({ ...prev, [f.id]: v }));
                    setFieldsFeedback(null);
                    if (fieldErrors[f.id]) setFieldErrors((prev) => ({ ...prev, [f.id]: '' }));
                  }}
                  onBlur={() => {
                    if (f.required || fieldValues[f.id] || fieldErrors[f.id]) {
                      if (f.required && !fieldValues[f.id] && !fieldErrors[f.id] && fieldValues[f.id] === undefined) return;
                      const err = validateCustomField(f, fieldValues[f.id]);
                      setFieldErrors((prev) => ({ ...prev, [f.id]: err }));
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      const nextField = userFields[idx + 1];
                      if (nextField) {
                        document.getElementById(`settings-field-${nextField.id}`)?.focus();
                      } else {
                        handleSaveFields(e);
                      }
                    }
                  }}
                  readOnly={fieldsSaving}
                  describedBy="fields-feedback"
                />
              ))}
              <Button type="submit" disabled={fieldsSaving} focusableWhenDisabled>
                {fieldsSaving ? 'Saving...' : 'Save'}
              </Button>
              <SettingsFeedback id="fields-feedback" feedback={fieldsFeedback} />
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle><h2 id="profile-heading">Learner Profile</h2></CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">Updated automatically by the AI as you complete activities.</p>
          <div className="rounded-md bg-muted p-3 text-sm leading-relaxed" aria-labelledby="profile-heading">
            {profileSummary || <em className="text-muted-foreground">No profile yet. Complete an activity to build your profile.</em>}
          </div>
          <Button variant="outline" onClick={() => setFeedbackOpen(true)}>
            Add Feedback
          </Button>
        </CardContent>
      </Card>

      <ProfileFeedbackDialog
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        onDone={async () => {
          setProfileSummary(await getLearnerProfileSummary());
        }}
      />
    </div>
  );
}

function SettingsFeedback({ id, feedback }) {
  const color = feedback?.type === 'error' ? 'text-destructive' : 'text-success-foreground';
  return (
    <p id={id} className={feedback ? `text-sm ${color}` : 'sr-only'} role="status" aria-live="polite" aria-atomic="true">
      {feedback?.message || ''}
    </p>
  );
}

function ProfileFeedbackDialog({ open, onOpenChange, onDone }) {
  const [text, setText] = useState(() => {
    try { return sessionStorage.getItem(PROFILE_FEEDBACK_DRAFT_KEY) || ''; } catch { return ''; }
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    try {
      if (text) sessionStorage.setItem(PROFILE_FEEDBACK_DRAFT_KEY, text);
      else sessionStorage.removeItem(PROFILE_FEEDBACK_DRAFT_KEY);
    } catch { /* ignore */ }
  }, [text]);

  const handleSubmit = async () => {
    if (submitting || !text.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const profile = await ensureProfileExists();
      const result = await orchestrator.updateProfileFromFeedback(profile, text.trim(), {
        lessonName: 'Settings', activityType: 'feedback', activityGoal: 'User-provided profile feedback',
      });
      if (result?.profile) {
        const merged = mergeProfile(profile, result.profile);
        await saveLearnerProfile(merged);
        if (result.summary) await saveLearnerProfileSummary(result.summary);
        syncInBackground('profile', 'profileSummary');
      }
      try { sessionStorage.removeItem(PROFILE_FEEDBACK_DRAFT_KEY); } catch { /* ignore */ }
      onOpenChange(false);
      setText('');
      if (onDone) onDone();
    } catch (e) {
      setError(aiErrorMessage(e, 'profile-feedback'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent variant="sheet">
        <DialogHeader>
          <DialogTitle>Add Profile Feedback</DialogTitle>
          <DialogDescription>
            Tell us what your profile gets wrong or leaves out, like your device, experience level, or learning style.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="profile-feedback-input" className="sr-only">Profile feedback</Label>
          <Textarea
            id="profile-feedback-input"
            rows={4}
            placeholder="e.g. I'm a complete beginner. I use a Chromebook and don't have admin access."
            value={text}
            readOnly={submitting}
            aria-describedby="profile-feedback-error"
            onChange={(e) => { setText(e.target.value); setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSubmit(); } }}
          />
          <p id="profile-feedback-error" className={error ? 'text-sm text-destructive' : 'sr-only'} role="alert">
            {error}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting || !text.trim()} focusableWhenDisabled>
            {submitting ? 'Updating...' : 'Submit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
