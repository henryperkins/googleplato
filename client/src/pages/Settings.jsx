import { useState, useEffect, useRef } from 'react';
import { useApp } from '../contexts/AppContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import NameFields from '../components/NameFields.jsx';
import { sendKeyOf, SEND_KEYS, sendHint } from '../lib/chatPrefs.js';
import PasswordField from '../components/PasswordField.jsx';
import {
  savePreferences,
  getLearnerProfileSummary,
  getLearnerProfile,
} from '../../js/storage.js';
import { updateProfile, getMyFields, authenticatedFetch } from '../../js/auth.js';
import { missingRequired, pickValues, validateCustomField, validateCustomFields } from '../lib/userFields.js';
import CustomFieldInput from '../components/CustomFieldInput.jsx';
import { addLearnerNote, removeLearnerNote, MAX_LEARNER_NOTE_LENGTH } from '../lib/profileQueue.js';
import { aiErrorMessage } from '../lib/aiErrors.js';
import { assertTurnOwner } from '../../js/turnPersistence.js';
import { settingsDrafts, enabledSettingsValues } from '../lib/settingsDrafts.js';
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

export default function Settings() {
  const { user, impersonatedUser } = useAuth();
  if (impersonatedUser) return <p className="p-4">Account settings are unavailable while viewing as another user.</p>;
  return <AccountSettings key={user?.userId || 'signed-out'} />;
}

function AccountSettings() {
  const { state, dispatch } = useApp();
  const { user, refreshUser } = useAuth();
  const [name, setName] = useState({ firstName: user?.firstName || user?.name || '', lastName: user?.lastName || '' });
  const [learnerNotes, setLearnerNotes] = useState([]);
  const [removingNote, setRemovingNote] = useState(false);
  const [chatSaving, setChatSaving] = useState(false);
  const [selectedSendKey, setSelectedSendKey] = useState(() => sendKeyOf(state.preferences));
  const [chatFeedback, setChatFeedback] = useState(null);
  const [username, setUsername] = useState(user?.username || '');
  const [profileSummary, setProfileSummary] = useState('');
  const [profileFeedback, setProfileFeedback] = useState(null);

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
  const [fieldValues, setFieldValues] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [fieldsFeedback, setFieldsFeedback] = useState(null);
  const [fieldsSaving, setFieldsSaving] = useState(false);
  const usernameRef = useRef(null);
  const newPasswordRef = useRef(null);
  const confirmPasswordRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const options = { expectedUserId: user?.userId };
        const [summary, profile] = await Promise.all([getLearnerProfileSummary(options), getLearnerProfile(options)]);
        await assertTurnOwner(user?.userId);
        if (!cancelled) { setProfileSummary(summary); setLearnerNotes(profile?.learnerNotes || []); }
      } catch (error) { if (!cancelled) setProfileFeedback({ type: 'error', message: error.message }); }
    })();
    getMyFields(user?.userId)
      .then((data) => {
        if (cancelled) return;
        const fields = (data.userFields || []).filter(field => field.enabled !== false && field.disabled !== true);
        setUserFields(fields);
        const draft = settingsDrafts.read(user?.userId, 'fields');
        setFieldValues(enabledSettingsValues({ ...(data.values || {}), ...draft }, fields));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user?.userId]);

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
      const data = await updateProfile({ customFields: pickValues(fieldValues, userFields.map((f) => f.id)) }, user?.userId);
      await assertTurnOwner(user?.userId);
      settingsDrafts.clear(user?.userId, 'fields', fieldValues);
      setFieldValues(enabledSettingsValues(data.customFields, userFields));
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
      await updateProfile({ username: trimmed }, user?.userId);
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
    if (nameSubmitting || chatSaving) return;
    setNameFeedback(null);
    setNameSubmitting(true);
    const firstName = name.firstName.trim(), lastName = name.lastName.trim();
    const prefs = { ...state.preferences, name: [firstName, lastName].filter(Boolean).join(' ') };

    try {
      await updateProfile({ firstName, lastName }, user?.userId);
      await assertTurnOwner(user?.userId);
      await savePreferences(prefs, { expectedUserId: user?.userId });
      await assertTurnOwner(user?.userId);
      dispatch({ type: 'SET_PREFERENCES', preferences: prefs });
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
      await updateProfile({ password: newPassword }, user?.userId);
      setNewPassword('');
      setConfirmPassword('');
      setPasswordFeedback({ type: 'success', message: 'Password changed. Your other devices will need to sign in again.' });
    } catch (err) {
      setPasswordFeedback({ type: 'error', message: err.message || 'Failed to change password' });
    } finally {
      setPasswordSubmitting(false);
    }
  };

  const handleRemoveNote = async note => {
    if (removingNote) return;
    setRemovingNote(true);
    setProfileFeedback(null);
    try {
      const result = await removeLearnerNote(note, { expectedUserId: user?.userId });
      await assertTurnOwner(user?.userId);
      setLearnerNotes(result.profile.learnerNotes || []);
      setProfileFeedback({ type: 'success', message: 'Note removed. Future profile updates use your remaining notes.' });
    } catch (error) { setProfileFeedback({ type: 'error', message: error.message }); }
    finally { setRemovingNote(false); }
  };

  const handleChatPreference = async sendKey => {
    if (chatSaving || nameSubmitting) return;
    setSelectedSendKey(sendKey);
    setChatSaving(true); setChatFeedback(null);
    try {
      const preferences = { ...state.preferences, sendKey };
      await savePreferences(preferences, { expectedUserId: user?.userId });
      await assertTurnOwner(user?.userId);
      dispatch({ type: 'SET_PREFERENCES', preferences });
      setChatFeedback({ type: 'success', message: 'Saved.' });
    } catch (error) { setSelectedSendKey(sendKeyOf(state.preferences)); setChatFeedback({ type: 'error', message: error.message }); }
    finally { setChatSaving(false); }
  };

  return (
    <div className="mx-auto max-w-lg space-y-6 p-4">
      <h1 className="text-xl font-semibold">Settings</h1>

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
            <NameFields idPrefix="account" value={name} onChange={value => { setName(value); setNameFeedback(null); }} readOnly={nameSubmitting} inferred={user?.nameSource === 'auto'} />
            <Button type="submit" disabled={nameSubmitting || chatSaving} focusableWhenDisabled aria-label={nameSubmitting ? 'Saving name' : 'Save name'}>{nameSubmitting ? 'Saving...' : 'Save'}</Button>
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
                    const next = enabledSettingsValues({ ...fieldValues, [f.id]: v }, userFields);
                    settingsDrafts.write(user?.userId, 'fields', next);
                    setFieldValues(next);
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
        <CardHeader><CardTitle><h2>Chat</h2></CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <fieldset disabled={chatSaving || nameSubmitting} className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Send a message with</legend>
            {[SEND_KEYS.MOD_ENTER, SEND_KEYS.ENTER].map(key => <label key={key} className="flex items-center gap-2 text-sm">
              <input type="radio" name="send-key" value={key} checked={selectedSendKey === key} onChange={() => handleChatPreference(key)} />
              {key === SEND_KEYS.ENTER ? 'Enter (Shift+Enter for a new line)' : sendHint(key).replace(' to send', '')}
            </label>)}
          </fieldset>
          <SettingsFeedback id="chat-feedback" feedback={chatFeedback} />
        </CardContent>
      </Card>
      <EmailPreferences userId={user?.userId} />

      <Card>
        <CardHeader>
          <CardTitle><h2 id="profile-heading">Learner Profile</h2></CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">Your profile can be updated from demonstrated lesson work and optional learning preferences. Your own notes are kept verbatim.</p>
          <div className="rounded-md bg-muted p-3 text-sm leading-relaxed" aria-labelledby="profile-heading">
            {profileSummary || <em className="text-muted-foreground">No profile yet. Complete an activity to build your profile.</em>}
          </div>
          {learnerNotes.length > 0 && <div className="space-y-2">
            <h3 className="text-sm font-medium">Your notes</h3>
            <ul aria-label="Your notes" className="space-y-2">
              {learnerNotes.map(note => <li key={`${note.at}:${note.text}`} className="rounded-md border p-3 space-y-2">
                <p className="text-sm wrap-anywhere">{note.text}</p>
                <Button size="sm" variant="outline" disabled={removingNote} onClick={() => handleRemoveNote(note)} aria-label={`Remove note: ${note.text}`}>Remove note</Button>
              </li>)}
            </ul>
          </div>}
          <Button variant="outline" onClick={() => setFeedbackOpen(true)}>
            Add Feedback
          </Button>
          <SettingsFeedback id="profile-feedback-status" feedback={profileFeedback} />
        </CardContent>
      </Card>

      <ProfileFeedbackDialog
        userId={user?.userId}
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        onDone={({ profile, summary, modelError }) => {
          setProfileSummary(summary);
          setLearnerNotes(profile?.learnerNotes || []);
          setProfileFeedback({ type: 'success', message: modelError ? 'Your note is saved. The optional profile rewrite was unavailable; your note will be included in future updates.' : 'Your note is saved.' });
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

function ProfileFeedbackDialog({ open, onOpenChange, onDone, userId }) {
  const [text, setText] = useState(() => settingsDrafts.read(userId, 'feedback'));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const noteAt = useRef(null);

  const handleSubmit = async () => {
    if (submitting || !text.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      await assertTurnOwner(userId);
      noteAt.current ??= Date.now();
      const result = await addLearnerNote(text.trim(), { expectedUserId: userId, at: noteAt.current });
      await assertTurnOwner(userId);
      settingsDrafts.clear(userId, 'feedback', text);
      onOpenChange(false);
      setText('');
      noteAt.current = null;
      if (onDone) onDone(result);
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
            maxLength={MAX_LEARNER_NOTE_LENGTH}
            placeholder="e.g. I'm a complete beginner. I use a Chromebook and don't have admin access."
            value={text}
            readOnly={submitting}
            aria-describedby="profile-feedback-error"
            onChange={(e) => { settingsDrafts.write(userId, 'feedback', e.target.value); setText(e.target.value); noteAt.current = null; setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSubmit(); } }}
          />
          <p id="profile-feedback-error" className={error ? 'text-sm text-destructive' : 'sr-only'} role="alert">
            {error}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting || !text.trim()} focusableWhenDisabled>
            {submitting ? 'Updating...' : 'Update profile'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const EMAIL_KINDS = [
  { key: 'nudge', label: 'Reminders to finish a lesson I started' },
  { key: 'digest', label: 'A weekly summary of my progress and new lessons' },
  { key: 'messages', label: 'Messages from my classroom' },
];
function EmailPreferences({ userId }) {
  const [optOut, setOptOut] = useState(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    authenticatedFetch('/v1/me/notifications', { expectedUserId: userId })
      .then(async response => {
        if (!response.ok) throw new Error('Email preferences could not be loaded.');
        const data = await response.json();
        await assertTurnOwner(userId);
        if (!cancelled) { setOptOut(data.optOut || {}); setFeedback(null); }
      }).catch(error => { if (!cancelled) setFeedback({ type: 'error', message: error.message }); });
    return () => { cancelled = true; };
  }, [userId, attempt]);
  const update = async (key, receive) => {
    if (saving) return;
    const before = optOut;
    setOptOut({ ...optOut, [key]: !receive });
    setSaving(true); setFeedback(null);
    try {
      const response = await authenticatedFetch('/v1/me/notifications', { expectedUserId: userId,
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ optOut: { [key]: !receive } }),
      });
      if (!response.ok) throw new Error('Email preference could not be saved. Try again.');
      const data = await response.json();
      await assertTurnOwner(userId);
      setOptOut(data.optOut || { ...optOut, [key]: !receive });
      setFeedback({ type: 'success', message: 'Saved.' });
    } catch (error) { setOptOut(before); setFeedback({ type: 'error', message: error.message }); }
    finally { setSaving(false); }
  };
  return <Card>
    <CardHeader><CardTitle><h2>Email</h2></CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <fieldset disabled={!optOut || saving} className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Email me</legend>
        {EMAIL_KINDS.map(kind => <label key={kind.key} className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={!optOut?.[kind.key]} onChange={e => update(kind.key, e.target.checked)} />
          <span>{kind.label}</span>
        </label>)}
      </fieldset>
      <SettingsFeedback id="email-feedback" feedback={feedback} />
      {!optOut && feedback && <Button variant="outline" onClick={() => setAttempt(n => n + 1)}>Retry loading email preferences</Button>}
    </CardContent>
  </Card>;
}
