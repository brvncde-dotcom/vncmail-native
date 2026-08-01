// Sign-in failures reach the UI as raw strings from the JMAP client — "Session
// discovery failed: 404 Not Found", "Network request failed". Those describe
// what the code was doing, not what the person should do next. This maps the
// ones we can recognise onto copy that names a likely cause and an action.
//
// Errors are matched by `name` and message text rather than `instanceof` so
// this module stays free of the api/ and expo dependency graph.

export interface LoginErrorCopy {
  title: string;
  detail?: string;
}

export interface LoginErrorContext {
  /** Host shown in "can't reach X" copy. */
  serverUrl?: string | null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : '';
}

function nameOf(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

function hostLabel(serverUrl: string | null | undefined): string {
  if (!serverUrl) return 'the server';
  const host = serverUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
  return host || 'the server';
}

export function describeLoginError(err: unknown, context: LoginErrorContext = {}): LoginErrorCopy {
  const name = nameOf(err);
  const message = messageOf(err);
  const lower = message.toLowerCase();
  const host = hostLabel(context.serverUrl);

  if (name === 'AuthenticationError' || lower.includes('invalid username or password')) {
    return {
      title: "That didn't work",
      detail:
        'Check your email and password. If your account uses two-factor sign-in, create an app password in the webmail and use that here.',
    };
  }

  if (lower.includes('certificate') || lower.includes('ssl') || lower.includes('tls')) {
    return {
      title: `Couldn't verify ${host}`,
      detail:
        "The server's security certificate was rejected. If this is your own server, check the certificate is valid and not expired.",
    };
  }

  // The endpoint answered, but it isn't a JMAP server — almost always a
  // mistyped host or a webmail that lives on a subpath.
  if (lower.includes('session discovery failed') && /\b40[34]\b/.test(message)) {
    return {
      title: `No mail server at ${host}`,
      detail: 'Double-check the address, or scan a sign-in code from the webmail instead.',
    };
  }

  if (
    name === 'NetworkError' ||
    name === 'TypeError' ||
    name === 'AbortError' ||
    lower.includes('network request failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('timeout') ||
    lower.includes('timed out')
  ) {
    return {
      title: `Can't reach ${host}`,
      detail: 'Check your connection and the server address, then try again.',
    };
  }

  if (lower.includes('pairing code')) {
    return {
      title: 'That code has expired',
      detail: 'Sign-in codes are good for a few minutes. Generate a fresh one in the webmail and scan again.',
    };
  }

  if (lower.includes('state mismatch')) {
    return {
      title: 'Sign-in was interrupted',
      detail: "The response didn't match the request we started. Try signing in again.",
    };
  }

  if (lower.includes('maximum of') && lower.includes('accounts')) {
    return { title: message };
  }

  // Unrecognised: show what we were told rather than inventing a cause.
  return {
    title: 'Sign-in failed',
    detail: message || 'Something went wrong. Try again.',
  };
}
