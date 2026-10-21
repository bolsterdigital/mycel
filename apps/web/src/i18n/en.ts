// UI copy for the web front (ADR 007 rule 1): public chrome and the operator admin. Domain messages (validation,
// mail) live in @mycel/core's catalogs; content (labels, consent text) lives on the documents.

export const en = {
  'error.prefix': 'Error:',
  'error.summary.title': 'There is a problem',
  'form.honeypot.label': 'Leave this field empty',
  'confirm.ok.title': 'Subscription confirmed',
  'confirm.ok.body': 'Thank you, your subscription is confirmed.',
  'confirm.already.title': 'Already confirmed',
  'confirm.already.body': 'This subscription was confirmed earlier. Nothing more to do.',
  'confirm.invalid.title': 'This link does not work',
  'confirm.invalid.body':
    'The confirmation link is invalid or has expired. Sign up again to receive a new one.',
  'thanks.back': 'Back to the page',
  'admin.title': 'Mycel admin',
  'admin.signedInAs': 'Signed in as {email}.',
  'admin.logout': 'Log out',
  'admin.loggedOut.title': 'You are logged out',
  'admin.loggedOut.body': 'Your session has ended on this device.',
  'admin.login.again': 'Log in again',
  'admin.loginFailed.title': 'Login failed',
  'admin.loginFailed.body':
    'The login could not be completed, or took longer than ten minutes. Try again.',
  'admin.sites.title': 'Your sites',
  'admin.sites.none': 'No sites yet. Ask an administrator of a site to invite {email}.',
  'admin.forbidden.title': 'No access to this site',
  'admin.forbidden.body':
    'You are not a member of this site. Ask one of its administrators to invite {email}.',
  'admin.notFound.title': 'Page not found',
  'admin.error.title': 'Something went wrong',
  'admin.back': 'Back to your sites',
  'admin.yourCapabilities': 'Your capabilities on this site',
  'admin.members.title': 'Members',
  'admin.members.pending': 'has not logged in yet',
  'admin.members.capabilities': 'Capabilities of {email}',
  'admin.members.save': 'Save',
  'admin.members.remove': 'Remove',
  'admin.members.note':
    'Removing a member, or taking capabilities away, also revokes the API keys they created that go beyond what they keep.',
  'admin.invite.title': 'Invite someone',
  'admin.invite.email': 'E-mail address',
  'admin.invite.capabilities': 'Capabilities',
  'admin.invite.submit': 'Invite',
  'admin.invite.hint':
    'No invitation e-mail is sent: ask the person to log in at {url} with this address.',
  'admin.keys.title': 'API keys',
  'admin.keys.none': 'No API keys yet.',
  'admin.keys.prefix': 'Starts with',
  'admin.keys.capabilities': 'Capabilities',
  'admin.keys.created': 'Created',
  'admin.keys.lastUsed': 'Last used',
  'admin.keys.never': 'never',
  'admin.keys.revoked': 'Revoked',
  'admin.keys.revoke': 'Revoke key {name}',
  'admin.keys.create.title': 'Create an API key',
  'admin.keys.create.name': 'Name',
  'admin.keys.create.capabilities': 'Capabilities',
  'admin.keys.create.hint':
    'A key never gets tenant:admin: keys cannot manage members or other keys.',
  'admin.keys.create.submit': 'Create key',
  'admin.keys.token.title': 'Your new API key',
  'admin.keys.token.body':
    'Copy it now. This is the only time it is shown; afterwards only its first characters are listed.',
  'admin.done.invited': '{email} is invited.',
  'admin.done.updated': 'Capabilities saved.',
  'admin.done.removed': 'Member removed.',
  'admin.done.revokedKeys': 'API keys revoked with it: {n}.',
  'admin.done.revoked': 'API key revoked.',
  'admin.error.invalid':
    'Check the form: give a valid e-mail address or name and at least one capability.',
  'admin.error.inviteConflict':
    'That address is already a member, or several accounts log in with it.',
  'admin.error.lastAdmin': 'A site needs at least one member with tenant:admin.',
  'admin.error.notFound': 'That member or key no longer exists. Reload the page.',
  'admin.error.forbidden': 'You do not have the capability for this.',
} as const;

export type UiKey = keyof typeof en;
