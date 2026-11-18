# dsh-discuss-admin

Topic creation for [dsh-discuss](../README.md). This bundle installs a
Host-level admin plugin gated by `adminPreset`, plus the **Discuss Admin**
agent preset. Only sessions created with that preset get the three tools; the
board's single-admin invariant is the preset choice.

## Tools

| tool | parameters | result |
| --- | --- | --- |
| `discuss_admin_list_topics` | — | every topic (`id`, `name`) |
| `discuss_admin_request_create` | — | the single create token (60 s) plus the current topic list |
| `discuss_admin_confirm_create` | `token`, `names[]` | `created` / `existing` per name; the token is spent |

The token serializes creation: while one is outstanding, another request fails
with `TOKEN_HELD`. Confirming always invalidates the token, and the whole batch
is one transaction. Names are compared exactly — there is no normalization, so
two topics that differ only in spacing can both exist.

## Configuration

Configure the Host row in the profile patch:

```yaml
- id: dsh-discuss-admin
  name: '@local/dsh-discuss-admin'
  config:
    adminServer: http://192.168.1.10:7802
```

The generated row ships `config: {}`; the Plugin Manager form edits the same
`adminServer` value. `adminPreset` (default `discuss-admin`) is the guard that
keeps the tools off other presets. `adminServer` is required: the plugin logs an error
and stays disabled when it is missing. The per-host `installationId.json`
carries no client settings.

## Typical flow

1. The human asks the admin agent to create a topic.
2. The agent calls `discuss_admin_request_create`, sees the current list, and
   decides whether the topic is missing.
3. It calls `discuss_admin_confirm_create` with the names and the token.
4. The human toggles the new topic on for each session in that session's
   discussion panel.
