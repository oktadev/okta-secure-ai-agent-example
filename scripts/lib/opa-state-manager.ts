import * as fs from 'fs';

/**
 * OPA rollback state structure that tracks all resources created by setup-opa-secrets
 */
export interface OPARollbackState {
  baseUrl: string;
  teamName: string;
  resourceGroupId?: string;
  resourceGroupName?: string;
  projectId?: string;
  projectName?: string;
  folderId?: string;
  folderName?: string;
  serviceUserName?: string;
  groupName?: string;
  groupId?: string;
  securityPolicyName?: string;
  securityPolicyId?: string;
  secretIds: Array<{ name: string; id: string }>;
  serviceUserKeyIds: string[];
}

const OPA_STATE_FILE_PATH = '.opa-setup-state.json';

/**
 * Initialize an empty OPA rollback state
 */
export function createEmptyOPAState(baseUrl: string, teamName: string): OPARollbackState {
  return {
    baseUrl,
    teamName,
    secretIds: [],
    serviceUserKeyIds: [],
  };
}

/**
 * Load existing OPA rollback state or create a new one
 */
export function loadOPARollbackState(baseUrl: string, teamName: string): OPARollbackState {
  if (!fs.existsSync(OPA_STATE_FILE_PATH)) {
    return createEmptyOPAState(baseUrl, teamName);
  }

  try {
    const content = fs.readFileSync(OPA_STATE_FILE_PATH, 'utf8');
    const state = JSON.parse(content) as OPARollbackState;

    // Ensure all array fields exist (for backward compatibility)
    return {
      baseUrl: state.baseUrl || baseUrl,
      teamName: state.teamName || teamName,
      resourceGroupId: state.resourceGroupId,
      resourceGroupName: state.resourceGroupName,
      projectId: state.projectId,
      projectName: state.projectName,
      folderId: state.folderId,
      folderName: state.folderName,
      serviceUserName: state.serviceUserName,
      groupName: state.groupName,
      groupId: state.groupId,
      securityPolicyName: state.securityPolicyName,
      securityPolicyId: state.securityPolicyId,
      secretIds: state.secretIds || [],
      serviceUserKeyIds: state.serviceUserKeyIds || [],
    };
  } catch (error) {
    console.warn('Warning: Could not parse existing OPA state file, creating new state');
    return createEmptyOPAState(baseUrl, teamName);
  }
}

/**
 * Load OPA rollback state without defaults (for rollback script)
 */
export function loadOPARollbackStateOnly(): OPARollbackState | null {
  if (!fs.existsSync(OPA_STATE_FILE_PATH)) {
    return null;
  }

  try {
    const content = fs.readFileSync(OPA_STATE_FILE_PATH, 'utf8');
    return JSON.parse(content) as OPARollbackState;
  } catch (error) {
    return null;
  }
}

/**
 * Update OPA rollback state
 */
export function updateOPARollbackState(
  currentState: OPARollbackState,
  updates: Partial<OPARollbackState>
): OPARollbackState {
  // Merge arrays (append new items, avoid duplicates)
  const mergedState: OPARollbackState = {
    baseUrl: updates.baseUrl || currentState.baseUrl,
    teamName: updates.teamName || currentState.teamName,
    resourceGroupId: updates.resourceGroupId ?? currentState.resourceGroupId,
    resourceGroupName: updates.resourceGroupName ?? currentState.resourceGroupName,
    projectId: updates.projectId ?? currentState.projectId,
    projectName: updates.projectName ?? currentState.projectName,
    folderId: updates.folderId ?? currentState.folderId,
    folderName: updates.folderName ?? currentState.folderName,
    serviceUserName: updates.serviceUserName ?? currentState.serviceUserName,
    groupName: updates.groupName ?? currentState.groupName,
    groupId: updates.groupId ?? currentState.groupId,
    securityPolicyName: updates.securityPolicyName ?? currentState.securityPolicyName,
    securityPolicyId: updates.securityPolicyId ?? currentState.securityPolicyId,
    secretIds: mergeSecretArrays(currentState.secretIds, updates.secretIds),
    serviceUserKeyIds: mergeArrays(currentState.serviceUserKeyIds, updates.serviceUserKeyIds),
  };

  // Write to temp file first, then rename for atomic operation
  const tempPath = `${OPA_STATE_FILE_PATH}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(mergedState, null, 2), 'utf8');
    fs.renameSync(tempPath, OPA_STATE_FILE_PATH);
  } catch (error) {
    // Clean up temp file if it exists
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    throw error;
  }

  return mergedState;
}

/**
 * Delete OPA rollback state file
 */
export function deleteOPARollbackState(): void {
  if (fs.existsSync(OPA_STATE_FILE_PATH)) {
    fs.unlinkSync(OPA_STATE_FILE_PATH);
  }
}

/**
 * Merge two string arrays, avoiding duplicates
 */
function mergeArrays(existing: string[] = [], newItems: string[] = []): string[] {
  const merged = [...existing];
  for (const item of newItems) {
    if (item && !merged.includes(item)) {
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Merge two secret arrays, avoiding duplicates based on id
 */
function mergeSecretArrays(
  existing: Array<{ name: string; id: string }> = [],
  newItems: Array<{ name: string; id: string }> = []
): Array<{ name: string; id: string }> {
  const merged = [...existing];
  for (const item of newItems) {
    if (item && !merged.some(s => s.id === item.id)) {
      merged.push(item);
    }
  }
  return merged;
}
