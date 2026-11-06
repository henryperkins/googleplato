export async function exchangeGoogleToken(idToken, options = {}) {
  const res = await fetch('/v1/plugins/google-auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...options, idToken }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.error || "Google sign-in didn't work. Try again.");
    error.status = res.status;
    error.code = body.code;
    if (body.code === 'invite_required') {
      error.admission = {
        email: typeof body.email === 'string' ? body.email : '',
        name: typeof body.name === 'string' ? body.name : '',
        waitlisted: body.waitlisted === true,
        inviteExpired: body.inviteExpired === true,
      };
    }
    throw error;
  }
  return body;
}
