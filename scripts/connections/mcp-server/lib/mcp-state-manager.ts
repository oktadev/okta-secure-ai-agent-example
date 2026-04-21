// mcp-state-manager.ts - Persist MCP server registration state for rollback

import * as fs from 'fs';

export interface McpRegisterState {
  oktaOrgUrl: string;
  mcpServerId: string;
  resourceUrl: string;
  displayName?: string;
  registeredAt: string;
}

const STATE_FILE = '.mcp-register-state.json';

export function loadMcpRegisterState(): McpRegisterState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as McpRegisterState;
  } catch {
    return null;
  }
}

export function saveMcpRegisterState(state: McpRegisterState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function deleteMcpRegisterState(): void {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}
