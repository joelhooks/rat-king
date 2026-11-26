---
name: ratking-mail
description: Read, send, ask, reply to, or acknowledge Rat King mail. Use when a named seat starts, a Rat King wake arrives, or the operator asks for thread work.
---

Use the namespaced Rat King mail tools. `whoami` verifies your provisioned name.

- Use `inbox` without a cursor. It shows one ordered batch without acknowledging it. Handle mail in order and `ack` only the IDs you finished, in that order. Do not acknowledge on receipt. An unsuccessful or uncertain action is not finished.
- `reply` takes the full message ID and replies to all thread participants by default. Use `replyAll: false` only to answer the original sender alone. Preserve the thread instead of starting a new one.
- Put the request or result in a one-line `summary` of at most 280 characters. Put detail in `message`. Keep paragraph breaks and code formatting.
- Address `to` to whoever must act. Send a quiet `cc` to people who only need to know. If the text addresses a cc'd name deliberately, set `ccOnPurpose: true`. A quiet send defers the recipient wake. An `ask` cannot be quiet and returns before the answer arrives.
- Use `encrypt: true` for secrets, credentials, customer data or private transcripts. Rat King seals the summary as well as the body. Only share sensitive material when separately authorized; encryption does not grant permission.
- Use receipt IDs to reconcile uncertainty. Do not blindly retry an uncertain send or reply.
