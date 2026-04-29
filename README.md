<div align="center">

#  Okta Secure AI Agent Example

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-8+-orange?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![OpenID Connect](https://img.shields.io/badge/OpenID%20Connect-Certified-blue?logo=openid&logoColor=white)](https://openid.net/connect/)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-purple)](https://modelcontextprotocol.io/)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](https://opensource.org/licenses/ISC)

</div >

> [!IMPORTANT]   
> This repo requires the **SECURE_AI** feature flag to be enabled for your Okta org in order to test the offering. To enable it, work with your Okta account manager.
> For more details, see: <https://support.okta.com/help/s/article/okta-secures-ai>

## Contents

- [Overview](#overview)
  - [Architecture](#architecture)
  - [Features](#features)
- [Managed Connections](#managed-connections)
  - [1. Authorization Server connections](#1-authorization-server-connections)
  - [2. Application connections (GitHub REST API)](#2-application-connections-github-rest-api)
  - [3. MCP Server connections (Todo0 and GitHub MCP)](#3-mcp-server-connections-todo0-and-github-mcp)
  - [Connections panel](#connections-panel)
- [Packages](#packages)
- [Setup](#setup)
  - [Prerequisites](#prerequisites)
  - [Automated Configuration](#automated-configuration)
  - [Verification](#verification)
  - [Rollback](#rollback)
  - [Manual Configuration](#manual-configuration)
- [Install & build](#install--build)
- [Running the demo services](#running-the-demo-services)
- [Try it out](#try-it-out)
  - [1. ID-JAG → MCP access token (Todo0)](#1-id-jag--mcp-access-token-todo0)
  - [2. Step-up auth (expanded MCP scopes)](#2-step-up-auth-expanded-mcp-scopes)
  - [3. OAuth STS brokered consent (GitHub)](#3-oauth-sts-brokered-consent-github)
- [Notes](#notes)

## Overview

This monorepo is a runnable, end-to-end sample of the
[Okta Secure AI](https://www.okta.com/solutions/secure-ai/) offerings —
an agentic application (**agent0**) that securely integrates with another
application's (**todo0**) MCP-exposed resources.

![agent0 chat + Managed Connections panel](/docs/screenshots/hero.png)


### Architecture

```mermaid
graph TB
    User[User/Browser]
    Anthropic[Anthropic API<br/>Claude]
    Okta_Org_AS[Okta Org AS<br/>/oauth2/v1<br/>For human SSO & ID-JAGs]
    Okta_IDP
    Okta_MCP_AS[Todo MCP Authorization Server<br/>/oauth2/aus.../v1<br/>For MCP Server protection]
    Okta_STS[Okta STS<br/>/oauth2/v1/token<br/>Brokered Consent]
    GitHub[GitHub API]

    subgraph Agent0[agent0]
        subgraph ResourceServer[Resource server :3000]
            Auth[Auth Endpoints]
            Chat[Chat Endpoints]
            UI[UI Endpoints<br/>Express/React]
        end

        subgraph AgentIdentity[Agent]
            MCP_Client[MCP Client<br/>for todo0]
            LLM_Integration[LLM Integration<br/>Anthropic]
        end
    end

    subgraph Todo0[todo0]
        MCP_Server[MCP Server :5002<br/>Tools Layer<br/>Validates JWT & Scopes]
    end

    User -->|HTTP Requests| ResourceServer
    ResourceServer-->|oidc client for human sso| Okta_IDP
    LLM_Integration -->|AI Requests| Anthropic
    AgentIdentity -->| agent client w/ for ID-JAG | Okta_Org_AS
    AgentIdentity -->| agent client use ID-JAG to get MCP AT | Okta_MCP_AS
    MCP_Client -->|MCP Protocol<br/>with JWT| MCP_Server
    MCP_Server -->|Validates JWT| Okta_MCP_AS
    Chat-->AgentIdentity
    AgentIdentity -->|OAuth STS token exchange| Okta_STS
    AgentIdentity -->|ISV access token| GitHub

    style Auth fill:#99ccff
    style UI fill:#99ccff
    style Chat fill:#99ccff
    style MCP_Client fill:#e1f5ff
    style LLM_Integration fill:#e1f5ff
    style MCP_Server fill:#fff4e1
    style Okta_Org_AS fill:#e8f4f8
    style Okta_MCP_AS fill:#f0e8f4
    style Anthropic fill:#f0f0f0
    style ResourceServer fill:#cce6ff,stroke:#0066cc,stroke-width:1px
    style AgentIdentity fill:#d9f0ff,stroke:#0066cc,stroke-width:1px
    style Agent0 fill:#f0f8ff,stroke:#0066cc,stroke-width:2px
    style Okta_STS fill:#e8f4f8
    style GitHub fill:#f0f0f0
    style Todo0 fill:#fff9f0,stroke:#ff9900,stroke-width:2px
```

**Port Configuration:**

- agent0 Application: Port 3000
  - **agent0 Resource Server** (Human-Facing Services):
    - Auth Endpoints: Handle authentication flows
    - UI Endpoints: Serve React application (Express)
    - Chat Endpoints: Handle user chat interactions
    - OIDC Client (Linked App): Manages user OAuth authentication with **Okta Org AS** (`/oauth2/v1`)
  - **agent0 Agent Identity** (Registered agent in Okta):
    - MCP Client: Connects to todo0's MCP Server
    - LLM Integration: Interfaces with Anthropic's Claude API
    - Authenticates with **Okta Org AS** (`/oauth2/v1`) using Client Credentials to request ID-JAG
    - Authenticates with **Todo MCP Authorization Server** using JWT Bearer grant to exchange ID-JAG for MCP access token
- todo0 Package: Port 5002 (MCP Server)
  - **Todo MCP Server**: Tools layer for todo operations (Express + Prisma)
  - Validates JWTs issued by **Todo MCP Authorization Server**
  - Validates scopes (`mcp:connect`, `mcp:tools:read`, `mcp:tools:manage`) for authorization

**Okta Authorization Servers:**

- **Okta Org AS** (`/oauth2/v1`): Used for human SSO (Single Sign-On) and ID-JAG issuance
  - Handles user authentication for the OIDC Client
  - Issues tokens for human users accessing the Resource Server
  - Issues ID-JAG tokens for Agent Identity via Client Credentials flow
- **Todo MCP Authorization Server** (Custom AS): Used for MCP Server protection
  - Exchanges ID-JAG tokens for MCP-scoped access tokens via JWT Bearer grant
  - Issues tokens that todo0's MCP Server validates
  - Provides fine-grained authorization with MCP-specific scopes

**Architecture Flow:**

- Users interact with the Resource Server's UI, Auth, and Chat endpoints
- The Resource Server uses the Agent Identity to process AI-powered requests
- **Human Authentication**: The OIDC Client authenticates users via **Okta Org AS** (`/oauth2/v1`)
- **Agent Authentication**:
  1. Agent Identity obtains ID-JAG token from **Okta Org AS** via Client Credentials flow
  2. Agent Identity exchanges ID-JAG for MCP access token from **Todo MCP Authorization Server** via JWT Bearer grant
- The MCP Client (within Agent Identity) communicates with todo0's MCP Server on port 5002 using the MCP access token
- The todo0 MCP Server validates JWTs and scopes issued by **Todo MCP Authorization Server**
- The LLM Integration enables Claude AI capabilities for chat and agent operations
- **Third-Party Access (OAuth STS)**: Agent exchanges user's ID token via Okta STS for an ISV access token. First request triggers user consent (`interaction_required`), subsequent requests return cached token. Currently used for GitHub API access.

### Features

- MCP server with tools for managing todos
- MCP client for interacting with the MCP server
- Okta OAuth2 authentication with ID-JAG token exchange
- JWT validation and scope-based authorization
- OAuth STS brokered consent for third-party integrations (e.g., GitHub)
- **Multi-MCP**: agent0 connects to Todo0 and GitHub MCP servers concurrently, each with its own auth strategy
- **Managed Connections panel**: live view of every Okta-managed connection wired on the agent
- pnpm workspace structure

## Managed Connections

In [Okta Secure AI](https://www.okta.com/solutions/secure-ai/), a
**managed connection** is a record on the agent identity that declares
*every system the agent is authorized to reach* and under what terms.
Okta defines five connection types; this sample wires up **three of them**
— the set that maps cleanly to an end-to-end secure-agent story — and
surfaces their live status in an in-app panel.

| Kind | Okta admin label | Purpose |
|------|------------------|---------|
| `authorization_server` | Authorization Server | The AS that mints the ID-JAG the agent exchanges for MCP access tokens |
| `application` | Application | A third-party ISV (e.g., GitHub) the agent reaches via Okta-brokered OAuth STS consent |
| `mcp_server` | MCP Server | An MCP server registered in Okta (Todo0, GitHub MCP) |

`secret` and `service_account` are out of scope for this sample.

> **One ISV, two connection types.** This sample uses **GitHub as the
> example for both `application` and `mcp_server` connections**. They are
> *independent* managed connections pointing at different GitHub surfaces:
> the `application` connection is for GitHub's **REST API**
> (`api.github.com`), the `mcp_server` connection is for GitHub's **remote
> MCP endpoint** (`api.githubcopilot.com/mcp`). Each gets its own Resource
> Indicator and its own env var.

All admin-console steps below live under:
**Okta Admin Console → Directory → AI Agents → `{your agent}` → Managed connections**.

### 1. Authorization Server connections

An Authorization Server connection registers the AS that will issue
**Cross-App Access tokens (ID-JAGs)** for the agent. The agent exchanges
the user's ID token for an ID-JAG, then exchanges the ID-JAG for an
MCP-scoped access token — proving both human identity and the agent's
authorization chain without sharing the user's ID token downstream.

**In this sample:** a single AS connection — the `Todo MCP Authorization
Server` — is created automatically by `pnpm run bootstrap:okta`. It
powers the `ID token → ID-JAG → MCP access token` flow for Todo0.

**Developer steps:**

Run `pnpm run bootstrap:okta`. The script provisions the Authorization
Server, the agent identity, the JWT Bearer grant policy, and writes the
following into `packages/agent0/.env.agent`:

```env
MCP_AUTHORIZATION_SERVER=https://<org>.okta.com/oauth2/<asId>
MCP_AUTHORIZATION_SERVER_TOKEN_ENDPOINT=https://<org>.okta.com/oauth2/<asId>/v1/token
AI_AGENT_TODO_MCP_SERVER_SCOPES_TO_REQUEST=mcp:connect mcp:tools:read mcp:tools:manage
```

### 2. Application connections (GitHub REST API)

An Application connection declares a third-party ISV the agent can reach
**via Okta's brokered-consent (OAuth STS) flow**. The agent never holds
the user's ISV credentials; Okta mints an ISV access token after the user
consents at the ISV the first time.

**In this sample:** a GitHub Application connection. Powers the
`github_comment_on_pr` tool which calls `api.github.com` with the
Okta-brokered ISV access token.

**Developer steps:**

1. Make sure the `SECURE_AI_OAUTH_STS` feature flag is enabled on your
   Okta org (work with your account manager if it isn't).
2. Add the **GitHub** application from the OIN catalog to your Okta org
   and complete the **Resource Server** tab:
   - Client ID + Client Secret from your GitHub OAuth app
   - Scopes the agent will request (e.g., `repo`, `read:user`)
   - Callback URL: `https://<org>.okta.com/oauth2/v1/sts/callback`
3. **Managed connections → + Add connection → Application**, pick the
   GitHub OIN app, and save.
4. Open the newly created connection and copy the **Resource Indicator**
   — an ORN that looks like
   `orn:okta:idp:<orgId>:client-auth-settings:<id>`.
5. Paste it into `packages/agent0/.env.agent`:

   ```env
   OAUTH_STS_RESOURCE=orn:okta:idp:<orgId>:client-auth-settings:<id>
   ```

6. Restart the agent. The first PR-comment prompt triggers the consent
   popup; once consent succeeds, the `OAuth STS Application` card in the
   Connections panel flips to `LIVE`.

### 3. MCP Server connections (Todo0 and GitHub MCP)

An MCP Server connection registers an MCP endpoint (local, hosted, or
ISV-operated) as a first-class resource on the agent. Each MCP connection
carries its own Resource Indicator that the agent can target during token
exchange.

**In this sample:** *two* MCP Server connections running side by side.
Each picks the auth strategy that matches its deployment — defined in
`packages/agent0/src/connections/auth-strategy.ts`.

| MCP server | URL | Auth strategy | Resource Indicator env var |
|------------|-----|---------------|----------------------------|
| Todo0 MCP Server | `http://localhost:5002/mcp` | ID-JAG → MCP access token | `MCP_RESOURCE_INDICATOR` (optional — defaults to the MCP URL) |
| GitHub MCP Server | `https://api.githubcopilot.com/mcp/` | OAuth STS brokered consent | `OAUTH_STS_RESOURCE_GITHUB_MCP` |

Adding a third MCP is one entry in `auth-strategy.ts` + the matching env
vars — the Connections panel picks it up automatically via
`GET /api/connections/status`.

**Developer steps (GitHub MCP):**

1. **Managed connections → + Add connection → MCP Server**.
2. Provide the MCP URL (`https://api.githubcopilot.com/mcp/`). Okta
   normalizes the URL on save (e.g., strips the trailing slash) — whatever
   value Okta stores is the value you must use in env.
3. Open the created connection and copy two values:
   - **Resource Indicator** — may be URL-style
     (`https://api.githubcopilot.com/mcp`) or ORN-style
     (`orn:<okta-env>:idp:<orgId>:client-auth-settings:<id>`), depending on
     how the connection was created. Copy it verbatim.
   - **mcpServerId** — starts with `ems…`.
4. Paste into `packages/agent0/.env.agent`:

   ```env
   GITHUB_MCP_SERVER_URL=https://api.githubcopilot.com/mcp/
   OAUTH_STS_RESOURCE_GITHUB_MCP=<Resource Indicator from Okta>
   OKTA_GITHUB_MCP_SERVER_ID=ems...
   ```

5. Restart the agent. The `Github MCP Server` card appears in the
   Connections panel. Asking the agent to use a GitHub MCP tool triggers
   the consent flow and flips the card to `LIVE`.

> **Todo0 MCP is optional to register.** It runs locally and works without
> an Okta registration. If you want the full end-to-end experience, expose
> `http://localhost:5002/mcp` via a tunnel (ngrok, cloudflared) and repeat
> the steps above, setting `OKTA_MCP_SERVER_ID` and
> `MCP_RESOURCE_INDICATOR` instead.

### Connections panel

Click the 🔗 button in the header to open the panel. Each card shows:

- Connection kind + instance name (e.g. `Todo0 MCP Server`, `Github MCP Server`)
- Status chip — `LIVE` / `IDLE` / `DISABLED`
- Key identifiers (AS URL, agent ID, resource indicator, MCP URL, Okta registration ID)

The panel is backed by `GET /api/connections/status` and aggregates
per-kind status builders in
`packages/agent0/src/connections/registry.ts`. To opt a kind out entirely,
set `DISABLED_CONNECTIONS=application` (or any comma-separated list) in
`.env.agent`.

![Managed Connections panel](docs/screenshots/connections-panel.png)

## Packages

- `agent0`: Contains the MCP client implementation with Anthropic Claude integration
- `todo0`: Contains the MCP server with Express/Prisma backend

## Setup

### Prerequisites

Before running the bootstrap script, you'll need:

1. **Node.js 19 or later**
   - Download from [https://nodejs.org/](https://nodejs.org/)
   - Verify installation: `node --version`

2. **pnpm 8 or later**
   - Install via Homebrew (macOS): `brew install pnpm`
   - Or Install via npm: `npm install -g pnpm`
   - Or via standalone script: `curl -fsSL https://get.pnpm.io/install.sh | sh -`
   - Verify installation: `pnpm --version`

3. **Okta Developer Account**
   - Sign up for free at [https://developer.okta.com/signup/](https://developer.okta.com/signup/)

4. **Okta API Token** with admin permissions
   - Create via: Okta Admin Console → Security → API → Tokens → Create Token

5. **Anthropic API Key** (optional, for LLM integration)
   - Sign up at [https://console.anthropic.com/](https://console.anthropic.com/)
   - Alternative: Configure AWS Bedrock credentials instead
   - **Note** These will need to be configured in packages/agent0/.env.agent at a later step.

6. **Okta Feature Flags** (optional, for GitHub integration via OAuth STS)
   - `SECURE_AI_AGENTS` and `SECURE_AI_OAUTH_STS` must be enabled on your Okta org
   - An ISV app (e.g., GitHub) from the OIN catalog with Resource Server tab configured
   - A managed connection on the AI agent pointing to the ISV app
   - See Okta OAuth STS documentation for setup details

### Automated Configuration

Run the interactive bootstrap script to automatically configure your Okta tenant and generate all required configuration files:

```sh
pnpm install
pnpm run bootstrap:okta
```

**The script will prompt you for:**

- Okta domain (e.g., dev-12345.okta.com)
- Okta API token
- Audience values for each authorization server (or use defaults)
- Owner setup method (Standard API recommended)

**What gets automatically created:**

**In Okta:**

- 1 Authorization Server (Todo MCP Authorization Server)
- Custom scopes for MCP Server:
  - `mcp:connect` - Establish MCP connection
  - `mcp:tools:read` - Use tools that read todo data
  - `mcp:tools:manage` - Use tools that manage todo data
- 2 OIDC Applications (agent0 web app, todo0 web app)
- Agent Identity with RSA key pair for workload authentication
- Agent Connection to Todo MCP Authorization Server
- Access policies and rules with JWT Bearer grant type
- 2 Trusted Origins (ports 3000, 5002)
- User assignment to both OIDC applications

**Locally:**

- `packages/agent0/.env.app` - Agent0 resource server configuration
- `packages/agent0/.env.agent` - Agent0 agent identity configuration with MCP settings
- `packages/todo0/.env.app` - Todo0 app server configuration
- `packages/todo0/.env.mcp` - Todo0 MCP server configuration
- `packages/agent0/agent0-private-key.pem` - RSA private key (600 permissions)
- `okta-config-report.md` - Detailed configuration report
- `.okta-bootstrap-state.json` - State file for rollback

### Verification

After bootstrap completes, verify your configuration:

```sh
pnpm run validate:okta
```

This runs automated checks to ensure:

- All .env files exist with required variables
- Authorization servers are reachable
- Private key is valid
- ID-JAG token exchange flow works
- Audiences are properly separated

### Rollback

To completely remove all Okta resources and local files created by bootstrap:

```sh
pnpm run rollback:okta
```

This will:

- Delete all authorization servers, applications, and agent identities from Okta
- Remove trusted origins
- Optionally delete local .env files and private keys
- Clean up the state file

### Manual Configuration

If you prefer to manually configure Okta and create your own .env files, refer to the `.env.example` files in each package:

- `packages/agent0/.env.agent.example`
- `packages/agent0/.env.app.example`
- `packages/todo0/.env.app.example`
- `packages/todo0/.env.mcp.example`

## Install & build

### 1. Install dependencies

```sh
pnpm install
```

### 2. Init prisma client

```sh
pnpm init:prisma
```

### 3. Build

```sh
pnpm build
```

### 4. Make sure env files are correct

If you used `pnpm run bootstrap:okta`, then your .env files are 99% ready to go.

**Note** make sure that you update packages/agent0/.env.agent with either the anthropic keys and values or the aws bedrock keys and values so the agent can interact with an LLM. Comment out the set of key value pairs you are not using.

**Optional** To enable GitHub integration via OAuth STS brokered consent, set `OAUTH_STS_RESOURCE` in `packages/agent0/.env.agent` to the Resource Indicator URI from your managed connection (Directory > AI Agents > {Agent} > Managed connections > Resource Indicator).

## Running the demo services

Start all services together:

```sh
pnpm run dev
```

Or run individually in separate terminals:

```sh
pnpm run start:todo0   # Start todo0 app server (port 5001)
pnpm run start:mcp     # Start todo0 MCP server (port 5002)
pnpm run start:agent0  # Start agent0 application (port 3000)
```

## Try it out

Open <http://localhost:3000>, log in with Okta, then open the Managed
Connections panel (🔗 in the header) in a second pane so you can watch the
connection cards flip between `IDLE` and `LIVE` as each auth flow fires.

The prompts below are grouped by the Okta capability they exercise. Run them
top-to-bottom — each one leans on the context established by the previous.

### 1. ID-JAG → MCP access token (Todo0)

The agent exchanges your ID token for an **ID-JAG** at Okta Org AS, then
exchanges the ID-JAG for an MCP-scoped access token at the custom Todo MCP
Authorization Server. The MCP server validates the JWT + scopes before
serving any tool.

Try:

```
list my todos
```
```
add a todo "prep the Okta demo"
```
```
mark todo 2 as done
```

**What to look for:**
- `Authorization Server` card → `LIVE`
- `Todo0 MCP Server` card → `LIVE`
- Expand the tool-call chip above each reply to see the raw MCP tool
  arguments and result JSON.

### 2. Step-up auth (expanded MCP scopes)

Some MCP tools require a broader scope than the initial session holds. When
the MCP server returns `insufficient_scope`, the agent silently re-runs the
ID-JAG → MCP access token exchange with the extra scope and retries the
tool. No user interaction needed.

Try (right after step 1):

```
delete todo 3
```

**What to look for:**
- A second tool chip appears for the retry. The first chip shows the
  `insufficient_scope` challenge; the second shows the tool succeeding after
  the expanded-scope access token is obtained.

### 3. OAuth STS brokered consent (GitHub)

> Requires `OAUTH_STS_RESOURCE` to be set in `packages/agent0/.env.agent`
> and a managed connection to GitHub configured in Okta.

The agent exchanges your ID token at Okta STS for a GitHub access token.
The **first** exchange returns `interaction_required` — the UI shows a
consent card linking to the ISV consent page. After consent, the retry
succeeds and GitHub is called on your behalf.

Try:

```
comment "LGTM" on https://github.com/<your-org>/<your-repo>/pull/1
```

**What to look for:**
- First turn: a consent card appears in chat with a link to the GitHub
  consent screen. Complete consent in a new tab.
- After consent: the turn completes, the GitHub API call runs, and the
  `OAuth STS Application` + `Github MCP Server` cards flip to `LIVE`.
- The cached ISV token survives until its TTL; subsequent PR-comment
  prompts run without a second consent prompt.

## Notes

- See each package's README or source for more details and customization.

## Feedback & issues

Run into a problem, spotted a bug, or have a feature request?
[Open an issue](https://github.com/oktadev/okta-secure-ai-agent-example/issues/new)
on the repo — please include:

- The step or prompt that triggered it (a snippet of your chat or the command you ran)
- Relevant log output from `pnpm run dev` (redact tokens / client secrets)
- Your Okta org type (developer / preview / production) and whether the
  `SECURE_AI` feature flag is enabled

For questions that aren't bug reports, start a
[discussion](https://github.com/oktadev/okta-secure-ai-agent-example/discussions)
instead.
