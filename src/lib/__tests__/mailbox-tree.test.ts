import { describe, it, expect } from 'vitest';
import {
  buildMailboxTree,
  flattenVisible,
  mailboxesForSiblingOf,
  ownMailboxes,
  SHARED_ACCOUNT_NODE_PREFIX,
} from '../mailbox-tree';
import type { Mailbox } from '../../api/types';

const RIGHTS: Mailbox['myRights'] = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
};

function own(id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox {
  return {
    id,
    name,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: RIGHTS,
    accountId: 'acc-1',
    isShared: false,
    ...extra,
  };
}

function shared(
  accountId: string,
  accountName: string,
  rawId: string,
  name: string,
  extra: Partial<Mailbox> = {},
): Mailbox {
  return {
    ...own(`${accountId}:${rawId}`, name, extra),
    originalId: rawId,
    accountId,
    accountName,
    isShared: true,
  };
}

describe('buildMailboxTree with shared accounts', () => {
  it('keeps own folders at the root and groups each shared account under its own node', () => {
    const tree = buildMailboxTree([
      own('inbox', 'Inbox', { role: 'inbox' }),
      own('sent', 'Sent', { role: 'sent' }),
      shared('grp-1', 'Support', 'inbox', 'Inbox', { role: 'inbox', unreadEmails: 3 }),
      shared('grp-1', 'Support', 'arch', 'Archive', { role: 'archive', unreadEmails: 1 }),
    ]);

    expect(tree.map((n) => n.id)).toEqual([
      'inbox',
      'sent',
      `${SHARED_ACCOUNT_NODE_PREFIX}grp-1`,
    ]);

    const accountNode = tree[2];
    expect(accountNode.isAccountNode).toBe(true);
    expect(accountNode.name).toBe('Support');
    // The header rolls up its account's unread so a collapsed section still
    // signals waiting mail.
    expect(accountNode.unreadEmails).toBe(4);
    expect(accountNode.children.map((n) => n.id)).toEqual(['grp-1:inbox', 'grp-1:arch']);
    expect(accountNode.children.every((n) => n.depth === 1)).toBe(true);
  });

  it('nests a shared account\'s subfolders under their own parent, not the user\'s', () => {
    const tree = buildMailboxTree([
      own('inbox', 'Inbox', { role: 'inbox' }),
      shared('grp-1', 'Support', 'inbox', 'Inbox', { role: 'inbox' }),
      shared('grp-1', 'Support', 'sub', 'Escalations', { parentId: 'grp-1:inbox' }),
    ]);

    const accountNode = tree[1];
    expect(accountNode.children).toHaveLength(1);
    expect(accountNode.children[0].children.map((n) => n.name)).toEqual(['Escalations']);
    expect(accountNode.children[0].children[0].depth).toBe(2);
  });

  it('gives each shared account its own node', () => {
    const tree = buildMailboxTree([
      shared('grp-2', 'Sales', 'inbox', 'Inbox', { role: 'inbox' }),
      shared('grp-1', 'Support', 'inbox', 'Inbox', { role: 'inbox' }),
    ]);

    expect(tree.map((n) => n.name)).toEqual(['Sales', 'Support']);
  });

  it('hides a collapsed shared account\'s folders', () => {
    const tree = buildMailboxTree([
      own('inbox', 'Inbox', { role: 'inbox' }),
      shared('grp-1', 'Support', 'inbox', 'Inbox', { role: 'inbox' }),
    ]);

    const collapsed = flattenVisible(tree, new Set());
    expect(collapsed.map((n) => n.id)).toEqual(['inbox', `${SHARED_ACCOUNT_NODE_PREFIX}grp-1`]);

    const expanded = flattenVisible(tree, new Set([`${SHARED_ACCOUNT_NODE_PREFIX}grp-1`]));
    expect(expanded.map((n) => n.id)).toEqual([
      'inbox',
      `${SHARED_ACCOUNT_NODE_PREFIX}grp-1`,
      'grp-1:inbox',
    ]);
  });
});

describe('account scoping helpers', () => {
  const all = [
    own('inbox', 'Inbox', { role: 'inbox' }),
    own('trash', 'Trash', { role: 'trash' }),
    shared('grp-1', 'Support', 'inbox', 'Inbox', { role: 'inbox' }),
    shared('grp-1', 'Support', 'trash', 'Trash', { role: 'trash' }),
    shared('grp-2', 'Sales', 'inbox', 'Inbox', { role: 'inbox' }),
  ];

  it('ownMailboxes drops every shared folder', () => {
    expect(ownMailboxes(all).map((m) => m.id)).toEqual(['inbox', 'trash']);
  });

  it('scopes to the owning shared account when the current folder is shared', () => {
    expect(mailboxesForSiblingOf(all, 'grp-1:inbox').map((m) => m.id))
      .toEqual(['grp-1:inbox', 'grp-1:trash']);
  });

  it('scopes to the user\'s own folders for an own or unknown folder', () => {
    expect(mailboxesForSiblingOf(all, 'inbox').map((m) => m.id)).toEqual(['inbox', 'trash']);
    expect(mailboxesForSiblingOf(all, 'gone').map((m) => m.id)).toEqual(['inbox', 'trash']);
    expect(mailboxesForSiblingOf(all, null).map((m) => m.id)).toEqual(['inbox', 'trash']);
  });
});
