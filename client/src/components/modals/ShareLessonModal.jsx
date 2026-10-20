import { useState, useEffect, useMemo } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { adminApi } from '../../pages/admin/adminApi.js';

// A stable default: a fresh `[]` per render would re-run the load effect.
const NO_USERS = [];

const VISIBILITY_OPTIONS = [
  { value: 'public', label: 'Public' },
  { value: 'private', label: 'Private' },
];

export default function ShareLessonModal({
  open,
  onOpenChange,
  lessonName,
  initialSharedWith = NO_USERS,
  initialStatus = 'private',
  onConfirm,
}) {
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(new Set(initialSharedWith));
  const [status, setStatus] = useState(initialStatus);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(initialSharedWith));
    setStatus(initialStatus);
    setSearch('');
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError('');
      try {
        const data = await adminApi('GET', '/v1/admin/users');
        if (!cancelled) setUsers(Array.isArray(data) ? data : []);
      } catch (e) {
        if (!cancelled) setLoadError(e.message || 'Check your connection, then try again.');
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open, initialSharedWith, initialStatus, reloadKey]);

  const filtered = useMemo(() => {
    if (!search.trim()) return users;
    const q = search.toLowerCase();
    return users.filter(u =>
      (u.name || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q) ||
      (u.username || '').toLowerCase().includes(q)
    );
  }, [users, search]);

  function toggle(userId) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function handleConfirm() {
    onConfirm({ status, sharedWith: status === 'public' ? [] : [...selected] });
  }

  const isPublic = status === 'public';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent variant="sheet" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Visibility &amp; Sharing</DialogTitle>
          <DialogDescription>
            Control who can see <strong>{lessonName}</strong>.
          </DialogDescription>
        </DialogHeader>

        {/* Public / Private: native radios, so the group is one tab stop and
            the arrow keys move between options. The ring is drawn inset on the
            label because the input itself is visually hidden, in the
            foreground color on the filled (selected) option so it stays visible. */}
        <fieldset className="flex min-w-0 rounded-lg border border-border overflow-hidden">
          <legend className="sr-only">Lesson visibility</legend>
          {VISIBILITY_OPTIONS.map(({ value, label }) => (
            <label
              key={value}
              className={`touch-target flex flex-1 cursor-pointer items-center justify-center px-4 py-2 text-sm font-medium transition-colors has-[:focus-visible]:outline-3 has-[:focus-visible]:-outline-offset-4 ${status === value ? 'bg-primary text-primary-foreground has-[:focus-visible]:outline-primary-foreground' : 'bg-background hover:bg-muted has-[:focus-visible]:outline-ring'}`}
            >
              <input
                type="radio"
                name="lesson-visibility"
                value={value}
                checked={status === value}
                onChange={() => setStatus(value)}
                className="sr-only"
              />
              {label}
            </label>
          ))}
        </fieldset>

        {isPublic ? (
          <p className="text-sm text-muted-foreground py-4">
            This lesson will be visible to all learners in the classroom.
          </p>
        ) : (
          <>
            <label htmlFor="share-lesson-search" className="sr-only">Search users</label>
            <Input
              id="share-lesson-search"
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="Search users..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />

            <ScrollArea className="max-h-[min(16rem,40dvh)] min-h-36 rounded-md border">
              {loading ? (
                <div className="flex items-center justify-center py-8 text-sm text-muted-foreground" role="status">Loading users...</div>
              ) : loadError ? (
                <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-sm">
                  <p className="text-destructive" role="alert">Couldn&apos;t load users. {loadError}</p>
                  <Button variant="outline" size="sm" onClick={() => setReloadKey((n) => n + 1)}>Try again</Button>
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">No users found.</div>
              ) : (
                <div className="p-2 space-y-1" role="group" aria-label="User list">
                  {filtered.map(u => (
                    <label
                      key={u.userId}
                      className="touch-target flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted cursor-pointer text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(u.userId)}
                        onChange={() => toggle(u.userId)}
                        className="rounded border-input"
                        aria-label={`Share with ${u.name || u.email}`}
                      />
                      <span className="flex-1 min-w-0">
                        <span className="font-medium truncate block">{u.name || u.username || u.email}</span>
                        {u.name && <span className="text-xs text-muted-foreground truncate block">{u.email}</span>}
                      </span>
                      {u.role === 'admin' && <span className="text-xs text-muted-foreground">Admin</span>}
                    </label>
                  ))}
                </div>
              )}
            </ScrollArea>

            <div className="text-xs text-muted-foreground tabular-nums">
              {selected.size} {selected.size === 1 ? 'user' : 'users'} selected
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={!isPublic && selected.size === 0}>
            {isPublic ? 'Make Public' : `Share with ${selected.size} ${selected.size === 1 ? 'user' : 'users'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
