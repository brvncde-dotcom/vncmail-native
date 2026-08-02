import type { Mailbox } from '../api/types';

export interface MailboxNode extends Mailbox {
  children: MailboxNode[];
  depth: number;
  /**
   * True for the virtual node that wraps a shared/group account's folders.
   * It has no server-side mailbox behind it — it can be expanded but never
   * selected or used as a move target.
   */
  isAccountNode?: boolean;
}

// Id prefix for the virtual per-shared-account node. Matches the webmail's
// `shared-account-<accountId>` convention in [lib/utils.ts].
export const SHARED_ACCOUNT_NODE_PREFIX = 'shared-account-';

/** The user's own folders — everything not owned by a shared/group account. */
export function ownMailboxes(mailboxes: Mailbox[]): Mailbox[] {
  return mailboxes.filter((m) => !m.isShared);
}

/**
 * Folders belonging to the same account as `mailboxId`. Role lookups (trash,
 * archive, junk…) must run inside one account: moving a message out of a
 * shared folder into the user's own Trash isn't a thing JMAP can express.
 * Falls back to the user's own folders when the id isn't known.
 */
export function mailboxesForSiblingOf(mailboxes: Mailbox[], mailboxId: string | null): Mailbox[] {
  const current = mailboxId ? mailboxes.find((m) => m.id === mailboxId) : undefined;
  if (!current?.isShared) return ownMailboxes(mailboxes);
  return mailboxes.filter((m) => m.isShared && m.accountId === current.accountId);
}

// Matches `ROLE_PRIORITY` from [lib/utils.ts] in the webmail.
const ROLE_PRIORITY: Record<string, number> = {
  inbox: 0,
  drafts: 1,
  sent: 2,
  archive: 3,
  junk: 4,
  spam: 4,
  trash: 5,
};

// Drop root-level folders whose name collides with an existing role mailbox
// (e.g. "Sent Mail" when a role=sent mailbox already exists). Mirrors the
// webmail's `deduplicateMailboxes`; kept minimal (single account only).
function deduplicate(mailboxes: Mailbox[]): Mailbox[] {
  const roles = mailboxes.filter((m) => m.role);
  const referencedParentIds = new Set<string>();
  for (const m of mailboxes) {
    if (m.parentId) referencedParentIds.add(m.parentId);
  }

  const result: Mailbox[] = [];
  for (const m of mailboxes) {
    if (m.role) { result.push(m); continue; }
    if (m.parentId) { result.push(m); continue; }
    const lower = m.name.toLowerCase();
    const dup = roles.find((r) => {
      const rn = r.name.toLowerCase();
      return lower.includes(rn) || rn.includes(lower);
    });
    if (!dup || referencedParentIds.has(m.id)) result.push(m);
  }
  return result;
}

function sortNodes(nodes: MailboxNode[]): void {
  nodes.sort((a, b) => {
    const ap = a.role ? (ROLE_PRIORITY[a.role] ?? 999) : 999;
    const bp = b.role ? (ROLE_PRIORITY[b.role] ?? 999) : 999;
    if (ap !== bp) return ap - bp;
    const ao = a.sortOrder ?? 0;
    const bo = b.sortOrder ?? 0;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) sortNodes(node.children);
}

function recalcDepths(nodes: MailboxNode[], base: number): void {
  for (const n of nodes) {
    n.depth = base;
    if (n.children.length > 0) recalcDepths(n.children, base + 1);
  }
}

// Build the root nodes for one account's folders (parent links only resolve
// within an account — a shared folder can't nest under an own folder).
function buildRoots(mailboxes: Mailbox[]): MailboxNode[] {
  const deduped = deduplicate(mailboxes);
  const map = new Map<string, MailboxNode>();
  const roots: MailboxNode[] = [];

  for (const m of deduped) {
    map.set(m.id, { ...m, children: [], depth: 0 });
  }
  for (const m of deduped) {
    const node = map.get(m.id)!;
    if (m.parentId && map.has(m.parentId)) {
      map.get(m.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

const ACCOUNT_NODE_RIGHTS: Mailbox['myRights'] = {
  mayReadItems: true,
  mayAddItems: false,
  mayRemoveItems: false,
  maySetSeen: false,
  maySetKeywords: false,
  mayCreateChild: false,
  mayRename: false,
  mayDelete: false,
  maySubmit: false,
};

/**
 * Own folders first, then one collapsible node per shared/group account
 * holding that account's folders — the same shape the webmail sidebar uses
 * (GitHub #151), so a Stalwart group mailbox shows up as its own section
 * rather than being mixed into the user's folder list.
 */
export function buildMailboxTree(mailboxes: Mailbox[]): MailboxNode[] {
  const own = mailboxes.filter((m) => !m.isShared);
  const shared = mailboxes.filter((m) => m.isShared);

  const roots = buildRoots(own);
  recalcDepths(roots, 0);
  sortNodes(roots);

  if (shared.length === 0) return roots;

  const byAccount = new Map<string, Mailbox[]>();
  for (const m of shared) {
    const accountId = m.accountId ?? 'unknown';
    const list = byAccount.get(accountId);
    if (list) list.push(m);
    else byAccount.set(accountId, [m]);
  }

  const accountNodes: MailboxNode[] = [];
  for (const [accountId, accountMailboxes] of byAccount) {
    const accountRoots = buildRoots(accountMailboxes);
    // Children sit at depth 1 so the account node reads as their header.
    recalcDepths(accountRoots, 1);
    sortNodes(accountRoots);

    const accountName = accountMailboxes[0]?.accountName || accountId;
    accountNodes.push({
      id: `${SHARED_ACCOUNT_NODE_PREFIX}${accountId}`,
      name: accountName,
      sortOrder: 1000,
      totalEmails: 0,
      // Roll the account's unread up to the header so a collapsed section
      // still shows there's something waiting.
      unreadEmails: accountMailboxes.reduce((sum, m) => sum + (m.unreadEmails ?? 0), 0),
      totalThreads: 0,
      unreadThreads: 0,
      myRights: ACCOUNT_NODE_RIGHTS,
      isSubscribed: true,
      accountId,
      accountName,
      isShared: true,
      isAccountNode: true,
      children: accountRoots,
      depth: 0,
    });
  }
  accountNodes.sort((a, b) => a.name.localeCompare(b.name));

  return [...roots, ...accountNodes];
}

// Flatten the tree in traversal order, skipping children of collapsed nodes.
export function flattenVisible(
  nodes: MailboxNode[],
  expanded: Set<string>,
): MailboxNode[] {
  const out: MailboxNode[] = [];
  const walk = (list: MailboxNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children.length > 0 && expanded.has(n.id)) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export function findTrashMailbox(mailboxes: Mailbox[]): Mailbox | undefined {
  const roleMatch = mailboxes.find((m) => m.role === 'trash');
  if (roleMatch) return roleMatch;

  const names = ['trash', 'bin', 'deleted', 'deleted items', 'corbeille', 'messages supprimés', 'éléments supprimés', 'supprimé', 'supprimés'];
  return mailboxes.find((m) => {
    const lower = m.name.toLowerCase();
    return names.includes(lower) || names.some((n) => lower.includes(n));
  });
}

export function findArchiveMailbox(mailboxes: Mailbox[]): Mailbox | undefined {
  const roleMatch = mailboxes.find((m) => m.role === 'archive');
  if (roleMatch) return roleMatch;

  const names = ['archive', 'archives', 'archived'];
  return mailboxes.find((m) => {
    const lower = m.name.toLowerCase();
    return names.includes(lower) || names.some((n) => lower.includes(n));
  });
}

export function findJunkMailbox(mailboxes: Mailbox[]): Mailbox | undefined {
  const roleMatch = mailboxes.find((m) => m.role === 'junk' || m.role === 'spam');
  if (roleMatch) return roleMatch;

  const names = ['junk', 'spam', 'indésirables', 'indésirable', 'courrier indésirable'];
  return mailboxes.find((m) => {
    const lower = m.name.toLowerCase();
    return names.includes(lower) || names.some((n) => lower.includes(n));
  });
}
