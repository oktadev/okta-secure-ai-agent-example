# OPA Secret Management for Agent0

## Overview

This document explains how we integrated **Okta Privileged Access (OPA)** to securely manage LLM credentials (API keys) for the Agent0 application.

### The Problem

Before this integration, LLM credentials were stored in `.env` files:
- Easy to accidentally commit to git
- Visible in plain text on the filesystem
- No audit trail of who accessed them
- No centralized management across environments

### The Solution

OPA provides enterprise-grade secret management:
- Secrets are encrypted at rest
- Access is controlled by policies
- Full audit logging of secret access
- Centralized management with revocation capability

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SETUP TIME (One-time)                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Developer runs setup script                                        │
│          │                                                           │
│          ▼                                                           │
│   ┌──────────────┐    Encrypt & Store    ┌──────────────────┐       │
│   │ LLM API Key  │ ──────────────────►   │   OPA Vault      │       │
│   │ (plaintext)  │                       │ (encrypted JWE)  │       │
│   └──────────────┘                       └──────────────────┘       │
│                                                   │                  │
│                                          Returns Secret ID           │
│                                                   │                  │
│                                                   ▼                  │
│                                          ┌──────────────────┐       │
│                                          │   .env.agent     │       │
│                                          │ (stores IDs only)│       │
│                                          └──────────────────┘       │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         RUNTIME (Every startup)                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Agent0 starts                                                      │
│          │                                                           │
│          ▼                                                           │
│   ┌──────────────┐    Request Secret     ┌──────────────────┐       │
│   │   Agent0     │ ──────────────────►   │   OPA Vault      │       │
│   │              │    (with token)       │                  │       │
│   │              │ ◄──────────────────   │                  │       │
│   └──────────────┘   Decrypted Value     └──────────────────┘       │
│          │                                                           │
│          ▼                                                           │
│   Initialize LLM client with retrieved credentials                   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: OPA API Client

**File:** `scripts/lib/opa-api.ts`

**What it does:**
- Provides a TypeScript client to interact with OPA REST APIs
- Handles authentication (Bearer token)
- Supports CRUD operations for resource groups, projects, and secrets
- Implements JWE encryption for storing secrets securely

**Key Functions:**
| Function | Purpose |
|----------|---------|
| `listResourceGroups()` | List all resource groups in the team |
| `listProjects()` | List projects within a resource group |
| `createSecretWithEncryption()` | Encrypt and store a new secret |
| `revealSecret()` | Decrypt and retrieve a secret value |

**How encryption works:**
1. Fetch the project's public key from OPA
2. Encrypt the secret value using JWE (RSA-OAEP-256 + A256GCM)
3. Send the encrypted value to OPA for storage
4. Only OPA can decrypt it (holds the private key)

---

### Phase 2: Setup Script

**File:** `scripts/setup-opa-secrets.ts`

**What it does:**
- Interactive CLI wizard to store LLM credentials in OPA
- Creates resource groups and projects if needed
- Encrypts and stores API keys as secrets
- Updates `.env.agent` with secret IDs (not the actual keys)

**How to run:**
```bash
pnpm setup:opa-secrets
```

**What it prompts for:**
1. OPA connection details (URL, team name, bearer token)
2. Resource group selection (or create new)
3. Project selection (or create new)
4. LLM provider choice (Anthropic or AWS Bedrock)
5. LLM credentials (API keys)

**Output:**
- Secrets stored in OPA with IDs like `7d8f9a2b-...`
- `.env.agent` updated with:
  ```bash
  OPA_BASE_URL=https://your-team.pam.clouditude.com
  OPA_TEAM_NAME=your-team
  OPA_RESOURCE_GROUP_ID=abc123...
  OPA_PROJECT_ID=def456...
  OPA_LLM_PROVIDER=anthropic
  OPA_ANTHROPIC_SECRET_ID=7d8f9a2b-...
  ```

---

### Phase 3: Agent Integration

**Files:**
- `packages/agent0/src/secrets/opa-secrets.ts` - OPA fetching logic
- `packages/agent0/src/agent.ts` - Integration point

**What it does:**
- At agent startup, checks if OPA is configured
- If yes, fetches LLM credentials from OPA
- If OPA fails, falls back to environment variables
- Initializes LLM client with retrieved credentials

**Flow:**
```
Agent starts
    │
    ▼
Is OPA configured? ──No──► Use ANTHROPIC_API_KEY from env
    │
   Yes
    │
    ▼
Fetch secret from OPA
    │
    ├──Success──► Use retrieved API key
    │
    └──Failure──► Fall back to env vars
```

**Configuration Required:**
```bash
# In .env.agent (set by setup script)
OPA_BASE_URL=https://your-team.pam.clouditude.com
OPA_TEAM_NAME=your-team
OPA_RESOURCE_GROUP_ID=abc123...
OPA_PROJECT_ID=def456...
OPA_LLM_PROVIDER=anthropic
OPA_ANTHROPIC_SECRET_ID=7d8f9a2b-...

# Must be set separately (not in file for security)
export OPA_SERVICE_ACCOUNT_TOKEN="your-service-account-token"
```

---

## User Dependencies

### What the User Must Provide

| Item | Description | Who Creates It |
|------|-------------|----------------|
| OPA Team | An OPA team with API access | OPA Admin |
| Service Account | A service account with secret access | OPA Admin |
| Bearer Token | Authentication token for the service account | OPA Admin |
| Resource Group | Container for projects (can be created by script) | User or Script |
| Project | Container for secrets (can be created by script) | User or Script |
| Policy | Policy granting secret access to the service account | OPA Admin |

### Required OPA Permissions

The service account needs these capabilities:
- `secrets.reveal` - To read secret values at runtime
- `secrets.create` / `secrets.update` - To store secrets (setup only)
- `projects.get` - To fetch project public key for encryption

**Note:** The setup script also uses `resource_groups.list` and `projects.list` to show selection menus. If the service account lacks these permissions, you can modify the script to accept IDs directly.

---

## Security Model

### What's Protected

| Data | Where Stored | Protection |
|------|--------------|------------|
| LLM API Keys | OPA Vault | Encrypted (JWE), access-controlled |
| Secret IDs | .env.agent | Not sensitive (just identifiers) |
| Service Token | Environment variable | Not in files, set at runtime |

### Access Control

```
┌─────────────────────────────────────────────────────┐
│                    OPA Policy                        │
├─────────────────────────────────────────────────────┤
│                                                      │
│  Resource Group: "agent0-secrets"                    │
│       │                                              │
│       └── Project: "llm-credentials"                 │
│               │                                      │
│               ├── Secret: "agent0-anthropic-api-key" │
│               │                                      │
│               └── Policy Rule:                       │
│                   "service-account-xyz can reveal"   │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### Audit Trail

OPA logs every secret access:
- Who accessed (service account ID)
- What was accessed (secret ID)
- When (timestamp)
- From where (IP address)

---

## Testing the Integration

### 1. Verify OPA Configuration
```bash
# Check if OPA vars are set
env | grep OPA_
```

### 2. Start Agent and Check Logs
```bash
pnpm start:agent
```

**Success logs:**
```
🔐 Initializing LLM configuration...
🔐 OPA secret management detected, attempting to fetch credentials...
   Provider: anthropic
   Fetching Anthropic API key (secret: 7d8f9a2b...)
✅ Successfully retrieved Anthropic credentials from OPA
✅ LLM credentials loaded from OPA
```

**Fallback logs (if OPA fails):**
```
🔐 Initializing LLM configuration...
⚠️  Failed to fetch credentials from OPA: <error>
⚠️  Falling back to environment variables...
✅ LLM credentials loaded from environment variables
```

### 3. Verify Credential Source
The agent exports a function to check where credentials came from:
```typescript
import { getLLMConfigSource } from './agent.js';

console.log(getLLMConfigSource()); // 'opa' | 'env' | 'none'
```

---

## Troubleshooting

### Common Issues

| Error | Cause | Solution |
|-------|-------|----------|
| "OPA authentication failed" | Invalid or expired token | Get new token from OPA admin |
| "OPA authorization failed" | Missing policy | Ask OPA admin to grant `secrets.reveal` |
| "Cannot connect to OPA server" | Wrong URL or network issue | Check `OPA_BASE_URL` and connectivity |
| "Secret not found" | Wrong secret ID | Verify `OPA_ANTHROPIC_SECRET_ID` |

### Debug Mode
Set `DEBUG=opa:*` to see detailed OPA API calls:
```bash
DEBUG=opa:* pnpm start:agent
```

---

## Future Improvements

1. **Token Refresh** - OPA tokens expire; implement automatic refresh
2. **Secret Rotation** - Support rotating API keys without downtime
3. **Multi-Environment** - Different secrets per environment (dev/staging/prod)
4. **Caching** - Cache retrieved secrets to reduce OPA API calls

---

## Summary

| Phase | Component | Purpose |
|-------|-----------|---------|
| 1 | `opa-api.ts` | Low-level OPA API client |
| 2 | `setup-opa-secrets.ts` | One-time setup wizard |
| 3 | `opa-secrets.ts` + `agent.ts` | Runtime secret retrieval |

**Before OPA:**
```
.env.agent → ANTHROPIC_API_KEY=sk-ant-xxxxx (exposed!)
```

**After OPA:**
```
.env.agent → OPA_ANTHROPIC_SECRET_ID=7d8f9a2b (just an ID)
OPA Vault → Encrypted API key (protected)
```
