import { useState, useEffect, useMemo } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { adminApi } from '../../pages/admin/adminApi.js';
import { useAuth } from '../../contexts/AuthContext.jsx';

/**
 * Admin "View as User" picker — single-select user search.
 *
 * Uses a bottom sheet on mobile viewports (<640px) and a centered dialog on
 * desktop so the user search input and scrollable list stay clear of the
 * virtual keyboard.
 */
export default function ViewAsUserModal({ open, onOpenChange, onStarted }) {
  const { startImpersonation, user: currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setError(null);
    setSubmitting(false);
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await adminApi('GET', '/v1/admin/users');
        if (!cancelled) setUsers(Array.isArray(data) ? data : []);
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Failed to load users');
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open]);

  const filtered = useMemo(() => {
    const others = users.filter(u => u.userId !== currentUser?.userId);
    if (!search.trim()) return others;
    const q = search.toLowerCase();
    return others.filter(u =>
      (u.name || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q) ||
      (u.username || '').toLowerCase().includes(q)
    );
  }, [users, search, currentUser]);

  async function handlePick(target) {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await startImpersonation(target.userId);
      onOpenChange(false);
      if (onStarted) onStarted(target);
    } catch (e) {
      setError(e?.message || 'Failed to start');
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent variant="sheet" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>View as User</DialogTitle>
          <DialogDescription>
            See the classroom as a specific user — read-only.
          </DialogDescription>
        </DialogHeader>

        <label htmlFor="view-as-user-search" className="sr-only">Search users</label>
        <Input
          id="view-as-user-search"
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

        <ScrollArea className="max-h-[min(16rem,45dvh)] min-h-36 rounded-md border">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground" role="status">Loading users...</div>
          ) : error ? (
            <div className="flex items-center justify-center py-8 text-sm text-destructive p-4 text-center" role="alert">{error}</div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">No users found.</div>
          ) : (
            <ul className="p-2 space-y-1" aria-label="Users">
              {filtered.map(u => {
                const label = u.name || u.username || u.email;
                const isAdmin = u.role === 'admin';
                return (
                  <li key={u.userId}>
                    <button
                      type="button"
                      onClick={() => handlePick(u)}
                      disabled={submitting}
                      aria-label={`View as ${label}${isAdmin ? ' (admin)' : ''}`}
                      className="w-full flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted text-left text-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed bg-transparent border-none outline-none focus:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex-1 min-w-0">
                        <span className="font-medium truncate block">{label}</span>
                        {u.name && <span className="text-xs text-muted-foreground truncate block">{u.email}</span>}
                      </span>
                      {isAdmin && (
                        <span className="text-xs text-muted-foreground shrink-0" aria-hidden="true">
                          Admin
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
