# Security policy

Aside Pocket gives a phone control over agent sessions on a Mac, so access control is the part that matters most. The model is described in the README under "Security model".

## What counts as a vulnerability

Anything that lets someone:

- reach the API from outside the owner's tailnet, or from a Tailscale login that is not on the allow-list;
- use the API without the bearer token (other than `POST /api/pair` with a valid pairing code), or guess or reuse a pairing code;
- read files other than images inside Aside's session folders;
- start a session with more than Guard permission, or raise the permission mode of an existing one;
- obtain the token, the VAPID private key, or other content of `~/.aside-pocket`, for example through logs, error messages, `aside-pocket doctor` output or the web app.

Not a vulnerability in this project:

- Software already running under the owner's macOS account. It can read `~/.aside-pocket` and call `127.0.0.1` directly.
- A reply to an existing session keeping that session's permission mode. This is documented behaviour. Routine retry is off by default for the same reason.
- Bugs in Aside, Tailscale or iOS. Report those to their vendors.

## How to report

Use GitHub's private vulnerability reporting on this repository: Security tab > Report a vulnerability.

Do not open a public issue for a vulnerability.

## What to include

- What an attacker can do and what they need for it (same tailnet, a paired phone, local access, nothing).
- Steps to reproduce, or a request that shows it.
- The Aside Pocket version (`GET /api/health` returns it, and `aside-pocket status` shows it), the Aside version and the macOS version.

Leave out your own token, pairing codes and session content.

## What to expect

This is a hobby project maintained by one person in spare time. There is no SLA and no bounty. I read every report and fix confirmed problems as soon as I can. Fixes go into the next release, and the changelog names the issue once a fix is out.

Only the latest release is supported.
