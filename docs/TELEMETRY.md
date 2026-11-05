# Telemetry decision

Telemetry is disabled. The application has no analytics client, telemetry
endpoint, opt-in control, analytics identifier or telemetry retention store.
The deployment does not need an analytics account or key.

Image generation and description send user content to the configured model
providers as part of the requested workflow. Those calls are distinct from
telemetry. Technical provenance remains attached to its saved result.

A future telemetry proposal must specify purpose, minimum fields, explicit
consent, recipients, retention and deletion before integration. Prompts, image
bytes, selected controls, dynamic metadata and provider diagnostics must remain
outside telemetry events. This document enables no collection.

The portable API launcher disables HTTP access logging. Search terms and other
query parameters can contain saved-image content and must not become routine log
entries. Application errors and lifecycle logs remain available. Custom ASGI or
reverse-proxy deployments must apply equivalent query/body/header minimization;
the application cannot control logs produced by an independently configured proxy.
