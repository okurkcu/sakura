# Sample shop

A tiny storefront used as a test fixture.

## Setup

The build needs a session secret: set `SESSION_SECRET` to any string of at least 16 characters.

The shop runs on its own server (`server.mjs`), which `pnpm start` starts; `next start` is not
supported.

## Run

```bash
pnpm install
SESSION_SECRET=change-me-to-something-long pnpm build
pnpm start
```

The app listens on port 3000.
