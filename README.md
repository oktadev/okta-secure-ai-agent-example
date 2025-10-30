# Okta Secure AI Example

## Overview

This monorepo demonstrates an agentic application (agent0) that has a secure integration with another application's (todo0) MCP exposed resources.

### Architecture

```mermaid
graph TB
    User[User/Browser]
    Anthropic[Anthropic API<br/>Claude]
    Okta_Org_AS[Okta Org AS<br/>/oauth2/v1<br/>For human SSO & ID-JAGs]
    Okta_Custom_AS[Okta Custom AS<br/>/oauth2/default/v1<br/>todo0 authorization server]

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
        MCP_Server[MCP Server :5002<br/>Tools Layer]
        Todo_API[Todo REST API :5001<br/>Express + Prisma]
    end

    User -->|HTTP Requests| ResourceServer
    ResourceServer-->|oidc client for human sso| Okta_Org_AS
    LLM_Integration -->|AI Requests| Anthropic
    AgentIdentity -->| agent client w/ for ID-JAG | Okta_Org_AS
    AgentIdentity -->| agent client use ID-JAG to get todo0 AT | Okta_Custom_AS
    MCP_Client -->|MCP Protocol<br/>:5002| MCP_Server
    MCP_Server -->|Internal Calls| Todo_API
    Todo_API -->|Validates JWT| Okta_Custom_AS
    Chat-->AgentIdentity

    style Auth fill:#99ccff
    style UI fill:#99ccff
    style Chat fill:#99ccff
    style MCP_Client fill:#e1f5ff
    style LLM_Integration fill:#e1f5ff
    style MCP_Server fill:#fff4e1
    style Todo_API fill:#ffe1f5
    style Okta_Org_AS fill:#e8f4f8
    style Okta_Custom_AS fill:#f0e8f4
    style Anthropic fill:#f0f0f0
    style ResourceServer fill:#cce6ff,stroke:#0066cc,stroke-width:1px
    style AgentIdentity fill:#d9f0ff,stroke:#0066cc,stroke-width:1px
    style Agent0 fill:#f0f8ff,stroke:#0066cc,stroke-width:2px
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
    - Authenticates with **Okta Org AS** (`/oauth2/v1`) using Client Credentials to request ID-JAG.
    - Authenticates with **Okta Custom AS** (`/oauth2/default/v1`) using Client Credentials to exchange ID-JAG for AT. 
- todo0 Package: Port 5001 (API) / Port 5002 (MCP Server)
  - **Todo MCP Server**: Tools layer for todo operations
  - **Todo REST API**: Express + Prisma backend
  - Protected by **Okta Custom AS** (`/oauth2/default/v1`) - validates JWTs from the Custom AS

**Okta Authorization Servers:**

- **Okta Org AS** (`/oauth2/v1`): Used for human SSO (Single Sign-On)
  - Handles user authentication for the OIDC Client
  - Issues tokens for human users accessing the Resource Server
- **Okta Custom AS** (`/oauth2/default/v1`): Used for API protection and service-to-service auth
  - Handles Agent Identity authentication via Client Credentials flow
  - Issues tokens that todo0's MCP Server validates
  - Provides fine-grained authorization for API resources

**Architecture Flow:**

- Users interact with the Resource Server's UI, Auth, and Chat endpoints
- The Resource Server uses the Agent Identity to process AI-powered requests
- **Human Authentication**: The OIDC Client authenticates users via **Okta Org AS** (`/oauth2/v1`) and shares ID tokens with the Agent Identity
- **Service Authentication**: The Agent Identity authenticates as a workload principal with the **Okta Custom AS** (`/oauth2/default/v1`) via Client Credentials flow
- The MCP Client (within Agent Identity) communicates with todo0's MCP Server on port 5002
- The todo0 MCP Server validates JWTs issued by **Okta Custom AS** (`/oauth2/default/v1`)
- The LLM Integration enables Claude AI capabilities for chat and agent operations

### Features

- RESTful todo API with authentication (Express + Prisma)
- MCP server with tools for managing todos (create, list, update, complete, delete)
- MCP client for interacting with the MCP server
- Okta OAuth2 authentication
- pnpm workspace structure

## Packages

- `agent0`: Contains the MCP client implementation with Anthropic Claude integration
- `todo0`: Contains the MCP server, Express/Prisma REST API, and web UI

## MCP Server Tools

- `create-todo`: Create a new todo (requires create:todos scope)
- `get-todos`: List todos (admins see all, users see own)
- `update-todo`: Edit the title/content of a todo
- `toggle-todo`: Toggle the completed status of a todo
- `delete-todo`: Delete a todo (own todos or admin access)

## Run Instructions

### Install dependencies

```sh
pnpm install
pnpm build
```

### Bootstrap prisma client

```sh
pnpm boostrap
```

### Start REST API (todo0)

```sh
pnpm run start:todo0
```

### Start MCP Server (todo0)

```sh
pnpm run start:mcp
```

### Start MCP Client (agent0)

```sh
pnpm run start:client0
```

## Setup

### Prerequisites

Before running the bootstrap script, you'll need:

1. **Okta Developer Account**
   - Sign up for free at [https://developer.okta.com/signup/](https://developer.okta.com/signup/)

2. **Okta API Token** with admin permissions
   - Create via: Okta Admin Console → Security → API → Tokens → Create Token
   - Required scopes: `okta.apps.manage`, `okta.authorizationServers.manage`, `okta.clients.manage`

3. **Anthropic API Key** (optional, for LLM integration)
   - Sign up at [https://console.anthropic.com/](https://console.anthropic.com/)
   - Alternative: Configure AWS Bedrock credentials instead

### Automated Configuration

Run the interactive bootstrap script to automatically configure your Okta tenant and generate all required configuration files:

```sh
pnpm run bootstrap:okta
```

**The script will prompt you for:**

- Okta domain (e.g., dev-12345.okta.com)
- Okta API token
- Audience values for each authorization server (or use defaults)
- Owner setup method (Standard API recommended)

**What gets automatically created:**

**In Okta:**

- 3 Authorization Servers (agent0 API, todo0 REST API, todo0 MCP Server)
- Custom scopes for each service:
  - agent0: `read:profile`, `write:profile`
  - todo0 REST: `create:todos`, `read:todos`, `update:todos`, `delete:todos`, `admin:todos`
  - todo0 MCP: `mcp:connect`, `mcp:tools:read`, `mcp:tools:manage`
- 2 OIDC Applications (agent0 web app, todo0 web app)
- Agent Identity with RSA key pair for workload authentication
- Agent Connection to MCP Authorization Server
- Access policies and rules with JWT Bearer grant type
- 3 Trusted Origins (ports 3000, 5001, 5002)
- User assignment to both OIDC applications

**Locally:**
- `packages/agent0/.env` - Agent configuration with all Okta settings
- `packages/todo0/.env` - Todo0 REST API and MCP server configuration
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

- `packages/agent0/.env.example`
- `packages/todo0/.env.example`

## Notes

- See each package's README or source for more details and customization.
