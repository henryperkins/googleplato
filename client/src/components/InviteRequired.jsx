import { useEffect, useRef } from 'react';
import { LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
} from '@/components/ui/card';

/**
 * Takes the sign-in form's place when a Google account has no plato account
 * and no invitation. Membership is by invitation, so the server created
 * nothing; this says where the person stands and what they can do next.
 * The heading takes focus because this replaces the form that had it.
 *
 * `admission` comes from the server's `invite_required` answer:
 * `{ email, name, waitlisted, inviteExpired }`.
 */
export default function InviteRequired({ classroomName, admission, waitlistOpen, onJoinWaitlist, onBack }) {
  const headingRef = useRef(null);

  useEffect(() => { headingRef.current?.focus(); }, []);

  const { email, waitlisted, inviteExpired } = admission;
  const canJoin = waitlistOpen && !waitlisted && !inviteExpired;
  const invitedHint = 'If you were invited, sign in with the Google account your invitation was sent to.';
  let standing;
  if (inviteExpired) standing = 'Your invitation has expired. Ask your program admin to send a new one.';
  else if (waitlisted) standing = "You're on the wait list. We'll email you when you're invited.";
  else if (canJoin) standing = `${invitedHint} Otherwise, you can ask to join.`;
  else standing = `${invitedHint} Otherwise, ask your program admin for an invitation.`;

  return (
    <Card className="w-full max-w-md text-center">
      <CardHeader className="justify-items-center gap-2">
        <span aria-hidden="true" className="mb-2 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <LockKeyhole className="size-7" />
        </span>
        <CardTitle as="h1" ref={headingRef} tabIndex={-1} className="text-2xl text-balance">
          Membership is by invitation only
        </CardTitle>
        <CardDescription className="text-pretty">
          Thank you for your interest in joining {classroomName}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2 text-pretty">
          <p>
            There&apos;s no account for {email
              ? <span className="font-medium [overflow-wrap:anywhere]">{email}</span>
              : 'this Google account'}.
          </p>
          <p>{standing}</p>
        </div>
        <div className="flex flex-col gap-2">
          {canJoin && (
            <Button className="h-auto min-h-10 w-full whitespace-normal py-2" onClick={onJoinWaitlist}>
              Join the wait list
            </Button>
          )}
          <Button variant="outline" className="h-auto min-h-10 w-full whitespace-normal py-2" onClick={onBack}>
            Back to sign in
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
