# Okta Secure AI Example

## Overview

This monorepo demonstrates a full-stack todo application with Okta authentication, Prisma database, and Model Context Protocol (MCP) server and client integration using TypeScript.

### Features
- RESTful todo API with authentication (Express + Prisma)
- MCP server with tools for managing todos (create, list, update, complete, delete)
- MCP client for interacting with the MCP server
- Okta OAuth2 authentication
- pnpm workspace structure

## Packages

- `agent0`: Contains the MCP server and client implementation
- `todo0`: Contains the Express/Prisma REST API and web UI

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
```

### Start REST API (todo0)

```sh
pnpm run start:todo0
```

### Start MCP Server (agent0)

```sh
pnpm run start:agent0
```

### Start MCP Client (agent0)

```sh
pnpm run start:client0
```

## Environment Variables

- Configure Okta issuer and secrets in `.env` files as needed for authentication.

## Notes

- See each package's README or source for more details and customization.
