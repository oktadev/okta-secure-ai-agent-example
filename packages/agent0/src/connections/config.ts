// connections/config.ts — DISABLED_CONNECTIONS env var parsing.
//
// Developers without access to every Okta feature (e.g. OIN brokered consent)
// can opt a connection kind out by adding its slug to DISABLED_CONNECTIONS in
// .env.agent. Disabled kinds are reported in the status endpoint with
// `disabled: true`, skip tool registration, and do not construct their
// handler config.

import type { ConnectionKind } from './types.js';

const VALID_KINDS: ReadonlySet<ConnectionKind> = new Set<ConnectionKind>([
  'authorization_server',
  'application',
  'mcp_server',
]);

let cached: Set<ConnectionKind> | null = null;

function parseDisabled(): Set<ConnectionKind> {
  const raw = process.env.DISABLED_CONNECTIONS ?? '';
  const out = new Set<ConnectionKind>();
  for (const token of raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0)) {
    if (VALID_KINDS.has(token as ConnectionKind)) {
      out.add(token as ConnectionKind);
    } else {
      console.warn(
        `⚠️  DISABLED_CONNECTIONS contains unknown kind "${token}" — valid values: ${[...VALID_KINDS].join(', ')}`
      );
    }
  }
  if (out.size > 0) {
    console.log(`🚫 Disabled connections: ${[...out].join(', ')}`);
  }
  return out;
}

/**
 * True if the given connection kind is opted out via the DISABLED_CONNECTIONS
 * env var. Cached on first call so all consumers agree within a process.
 */
export function isConnectionDisabled(kind: ConnectionKind): boolean {
  if (!cached) cached = parseDisabled();
  return cached.has(kind);
}

/** Returns a copy of the disabled kinds set (safe to mutate). */
export function getDisabledConnections(): Set<ConnectionKind> {
  if (!cached) cached = parseDisabled();
  return new Set(cached);
}
