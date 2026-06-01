# Realms and Organizations

`tyo-mq` uses realms as the low-level routing and authorization boundary.
Organizations should be modeled as the higher-level business concept that maps
to realms.

## Core Model

Use one realm per organization by default:

```text
org acme   -> realm org:acme
org tyolab -> realm org:tyolab
```

A realm is a hard isolation boundary. Producers and consumers authenticated into
one realm do not see producers, consumers, subscriptions, or messages from
another realm.

An organization is the manager-facing concept. Normal operators should think in
terms of orgs, while the server enforces access through the mapped realm.

## Naming Convention

Use this realm naming pattern:

```text
org:<org_id>
```

Examples:

```text
org:acme
org:tyolab
org:client-x
```

Use lowercase, stable IDs for `org_id`. Prefer letters, numbers, and hyphens.
Avoid using display names directly as IDs because organization names may change.

## Settings Shape

The current server enforces realms through `auth.realms` and `auth.tokens`.
The recommended organization layer can be represented like this:

```json
{
  "auth": {
    "orgs": {
      "acme": {
        "name": "Acme Pty Ltd",
        "realm": "org:acme",
        "enabled": true
      }
    },
    "realms": {
      "org:acme": {
        "required": true
      }
    },
    "tokens": [
      {
        "token": "client-token",
        "realm": "org:acme",
        "role": "consumer",
        "org_id": "acme",
        "client_id": "worker-01",
        "client_name": "Acme Worker 01"
      }
    ]
  }
}
```

`auth.orgs` is the friendly management layer. `auth.realms` and `auth.tokens`
remain the enforcement layer.

## Authorization Requests

Client authorization requests should eventually use `org_id` instead of asking
clients to know the raw realm name:

```json
{
  "org_id": "acme",
  "client_id": "worker-01",
  "client_name": "Acme Worker 01",
  "client_token": "requested-client-token",
  "role": "consumer",
  "challenge_response": {
    "ticket": "helpdesk-123"
  }
}
```

The server or manager resolves:

```text
org_id=acme -> realm=org:acme
```

When approved, the token is stored against the resolved realm.

## Manager UX

Managers should operate on organizations:

- create org
- rename org display name
- enable or disable org auth
- list org clients
- approve or reject client authorization requests for an org

Raw realm operations should remain available for admin/debug workflows, but
they should not be the normal user-facing interface.

## Multiple Realms Per Organization

Start with one org mapped to one realm. If an organization later needs multiple
isolated areas, use org-scoped realm names:

```text
org:acme:prod
org:acme:dev
org:acme:billing
```

This should be added only when there is a real isolation requirement. The simple
default is:

```text
one organization = one realm
```

## Super Admin

Admin tokens use the special realm:

```text
*
```

An admin in realm `*` can manage realms, organizations, and authorization
requests. Normal clients should never use the `*` realm.

