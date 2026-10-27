# Managed webhooks

Mycel sends `POST` to the HTTPS destination registered on a tenant's managed connection. The destination must use port 443 and resolve only to public IPv4 or IPv6 addresses when saved and on every delivery. Mycel pins the checked address to the TLS connection, verifies the certificate against the configured hostname, follows no redirect and stops a request after five seconds. A change of destination or signing secret increments the connection version; older intents cannot move to the new destination.

Today Mycel sends only an explicitly requested synthetic test (`connections.test`). It does not subscribe a person, copy a real supporter or install a provisional form action. The configured signing secret is stored encrypted and installation-local, and is available only to the `connections.run` worker. Replace it after importing a tenant export. Real payloads need a source-specific, authorized contract per category; none exists yet.

## Receiver contract `mycel.webhook.v1`

The JSON body has `version`, `eventId`, `timestamp`, `idempotencyKey`, `category` and `data`. The only category so far is `synthetic.test`, with `data: {"synthetic":true}`. Headers include `Content-Type: application/json`, `X-Mycel-Event-Id`, `X-Mycel-Timestamp` and `X-Mycel-Signature: sha256=<hex>`. The signature is HMAC-SHA256 using the connection's secret over the exact UTF-8 bytes of `<timestamp>.<body>`. Compare the MAC in constant time and reject timestamps outside your chosen short window. Keep a durable record of `eventId` before returning 2xx, and treat a repeated `eventId` as the same event. Different events may arrive out of order; do not assume their arrival order represents the supporter's state. A 2xx response means the receiver has durably accepted the event, not merely received the request bytes.

## Operator response

Pause stops pending and new work. Disconnect removes the local credential and stops the connection permanently; it does not delete an external copy. The admin page shows a redacted state and whether an external-copy action is requested, confirmed, failed or manual. For an `unknown` outcome, give the receiver the event ID and ask whether it was durably accepted. The generic webhook adapter has no receiver status API, so it cannot prove absence and does not resend an uncertain request. A replay request keeps that uncertainty and only schedules guarded reconciliation. Check the external system or arrange a new, explicit action after resolving the state. Never infer delivery from a timeout, a broken connection or a redirect response.
