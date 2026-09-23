# Harness status

Run `python3 -B _meta/harness-status.py` from a generated workspace, or pass its
root as the single positional argument. The checker prints JSON and writes
nothing. Exit 0 means static checks passed; exit 1 means an expected artifact or
registration is missing, changed, or unreadable.

The unsigned `generation_options.harness_inventory` records generated handler
and template hashes plus project configuration entries. Templates are not
registration. Registration in project settings is not effective configuration:
user/managed settings, feature flags and session trust may change runtime behavior.

`activation: unverified` and `trust: unknown` are intentional. This checker does
not execute commands, modify settings, approve trust, or claim live observation.
Direct handler smoke tests and delegation logs do not prove runtime invocation.

To obtain live evidence, start the intended runtime, review its hook and trust
controls, trigger a harmless configured event, and retain the runtime-origin
trace and handler outcome with runtime version, session ID, event, time and
handler digest. Do not include secret payloads. If the runtime does not expose
that link, keep activation unverified. This checker does not ingest handwritten
attestations or promote them to proof.

Changing generated hooks requires review and a new baseline through the
generation process. Older workspaces without an inventory report an error,
rather than inventing a baseline from whatever remains on disk.
