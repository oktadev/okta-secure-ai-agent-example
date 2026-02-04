import * as fs from 'fs';
const STATE_FILE_PATH = '.okta-bootstrap-state.json';
/**
 * Initialize an empty rollback state
 */
export function createEmptyState(oktaDomain) {
    return {
        oktaDomain,
        mcpAuthServerIds: [],
        agent0AppIds: [],
        todo0AppIds: [],
        agent0AppUserIds: [],
        todo0AppUserIds: [],
        agentIdentityIds: [],
        agentConnections: [],
        agentOwnerSetupMethod: undefined,
        mcpPolicyIds: [],
        mcpPolicyRuleIds: [],
        trustedOriginNames: [],
    };
}
/**
 * Load existing rollback state or create a new one
 */
export function loadRollbackState(oktaDomain) {
    if (!fs.existsSync(STATE_FILE_PATH)) {
        return createEmptyState(oktaDomain);
    }
    try {
        const content = fs.readFileSync(STATE_FILE_PATH, 'utf8');
        const state = JSON.parse(content);
        // Ensure all array fields exist (for backward compatibility)
        return {
            oktaDomain: state.oktaDomain || oktaDomain,
            mcpAuthServerIds: state.mcpAuthServerIds || [],
            agent0AppIds: state.agent0AppIds || [],
            todo0AppIds: state.todo0AppIds || [],
            agent0AppUserIds: state.agent0AppUserIds || [],
            todo0AppUserIds: state.todo0AppUserIds || [],
            agentIdentityIds: state.agentIdentityIds || [],
            agentConnections: state.agentConnections || [],
            agentOwnerSetupMethod: state.agentOwnerSetupMethod,
            mcpPolicyIds: state.mcpPolicyIds || [],
            mcpPolicyRuleIds: state.mcpPolicyRuleIds || [],
            trustedOriginNames: state.trustedOriginNames || [],
        };
    }
    catch (error) {
        console.warn('Warning: Could not parse existing state file, creating new state');
        return createEmptyState(oktaDomain);
    }
}
/**
 * Atomically update rollback state by merging with existing state
 * Uses temp file + rename for atomic writes
 */
export function updateRollbackState(currentState, updates) {
    // Merge arrays (append new items, avoid duplicates)
    const mergedState = {
        oktaDomain: updates.oktaDomain || currentState.oktaDomain,
        mcpAuthServerIds: mergeArrays(currentState.mcpAuthServerIds, updates.mcpAuthServerIds),
        agent0AppIds: mergeArrays(currentState.agent0AppIds, updates.agent0AppIds),
        todo0AppIds: mergeArrays(currentState.todo0AppIds, updates.todo0AppIds),
        agent0AppUserIds: mergeArrays(currentState.agent0AppUserIds, updates.agent0AppUserIds),
        todo0AppUserIds: mergeArrays(currentState.todo0AppUserIds, updates.todo0AppUserIds),
        agentIdentityIds: mergeArrays(currentState.agentIdentityIds, updates.agentIdentityIds),
        agentConnections: mergeConnectionArrays(currentState.agentConnections, updates.agentConnections),
        agentOwnerSetupMethod: updates.agentOwnerSetupMethod !== undefined ? updates.agentOwnerSetupMethod : currentState.agentOwnerSetupMethod,
        mcpPolicyIds: mergeArrays(currentState.mcpPolicyIds, updates.mcpPolicyIds),
        mcpPolicyRuleIds: mergeArrays(currentState.mcpPolicyRuleIds, updates.mcpPolicyRuleIds),
        trustedOriginNames: mergeArrays(currentState.trustedOriginNames, updates.trustedOriginNames),
    };
    // Write to temp file first, then rename for atomic operation
    const tempPath = `${STATE_FILE_PATH}.tmp`;
    try {
        fs.writeFileSync(tempPath, JSON.stringify(mergedState, null, 2), 'utf8');
        fs.renameSync(tempPath, STATE_FILE_PATH);
    }
    catch (error) {
        // Clean up temp file if it exists
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
        throw error;
    }
    return mergedState;
}
/**
 * Merge two arrays, avoiding duplicates
 */
function mergeArrays(existing = [], newItems = []) {
    const merged = [...existing];
    for (const item of newItems) {
        if (item && !merged.includes(item)) {
            merged.push(item);
        }
    }
    return merged;
}
/**
 * Merge two connection arrays, avoiding duplicates based on connectionId
 */
function mergeConnectionArrays(existing = [], newItems = []) {
    const merged = [...existing];
    for (const item of newItems) {
        if (item && !merged.some(conn => conn.connectionId === item.connectionId)) {
            merged.push(item);
        }
    }
    return merged;
}
