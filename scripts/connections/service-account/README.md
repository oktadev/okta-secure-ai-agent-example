# Service Account Provisioning (scaffold)

Provisioning scripts for the Service Account managed-connection type are not
yet implemented. When implemented, they will live here and mirror the layout
of `scripts/connections/secret/`:

- `setup.ts` — provision the OPA service account, Universal Directory app
  mapping, project, and assign the service account to the project
- `link.ts` — link the service-account resource to the AI agent as a managed
  connection
- `validate.ts` — verify configuration end-to-end
- `rollback.ts` — tear down everything setup created
- `lib/` — shared OPA API helpers

## Manual setup (interim)

Until the scripts land, follow Okta's docs:
https://help.okta.com/oie/en-us/content/topics/ai-agents/ai-agent-auth-service-acnt.htm

Prerequisites (summary):
- Okta Privileged Access OIN app installed in the tenant
- An AI agent registered (use `pnpm bootstrap:okta`)
- A configured service account in Okta Privileged Access
- A project in OPA with the service account assigned
- Super-admin + OPA security-admin roles

Then attach the service account to the agent as a managed connection via
the admin UI.
