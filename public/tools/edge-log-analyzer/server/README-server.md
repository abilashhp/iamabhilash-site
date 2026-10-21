# Pull-logs proxy — setup

This is an optional, small backend for one feature: letting the dashboard
pull logs directly from Akamai's [Edge Diagnostics grep
API](https://techdocs.akamai.com/edge-diagnostics/reference/post-grep)
instead of requiring a manual file upload/paste. Everything else about the
tool stays 100% client-side — this proxy exists only because the grep API
needs Akamai's EdgeGrid request signing, which requires a client secret that
must never reach a browser.

It's a single dependency-free Node.js file (`server.js`, no `npm install`
needed) that:
1. Validates a shared API key from the dashboard (your own secret, not
   Akamai's).
2. Signs and calls the Akamai grep API server-side with your EdgeGrid
   credentials.
3. Converts Akamai's JSON log entries into the same space-delimited text
   format the dashboard already parses from uploaded files, so no changes
   to the analyzer itself were needed.

The Node process binds to `127.0.0.1` only — it's never exposed directly to
the internet. Nginx reverse-proxies `/api/*` to it on the same HTTPS domain
the dashboard is already served from, so there's no CORS to configure and
no new public port to open.

## 1. Prerequisites

- Node.js installed on the box (any reasonably recent version — the script
  only uses built-in `http`/`https`/`crypto` modules). Check with:
  ```
  node --version
  ```
  If missing, install via your distro's package manager (e.g. `sudo apt
  install nodejs` on Debian/Ubuntu).
- An Akamai API client with the **Diagnostic Tools** / Edge Diagnostics API
  grant, giving you a host, client token, client secret, and access token
  (the same four values used in a standard `.edgerc` file). You said you
  already have these — you'll paste them directly into a file on the
  server in step 2, never into chat.

## 2. Create the secrets file

On the server, create `/etc/pull-logs.env` and lock it down so only root can
read it:

```
sudo touch /etc/pull-logs.env
sudo chmod 600 /etc/pull-logs.env
sudo chown root:root /etc/pull-logs.env
sudo nano /etc/pull-logs.env
```

Paste in these five lines, filling in your real values (the three
`AKAMAI_*` credential values come from your `.edgerc`'s `host`,
`client_token`, `client_secret`, and `access_token` fields respectively;
`PULL_LOGS_SHARED_SECRET` is a new password you make up — it's the key the
dashboard itself will ask for, separate from your Akamai credentials):

```
PULL_LOGS_PORT=8899
PULL_LOGS_SHARED_SECRET=choose-a-long-random-string-here
AKAMAI_HOST=akaa-xxxxxxxxxxxxxxxx-xxxxxxxxxxxxxxxx.luna.akamaiapis.net
AKAMAI_CLIENT_TOKEN=akab-xxxxxxxxxxxxxxxx-xxxxxxxxxxxxxxxx
AKAMAI_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
AKAMAI_ACCESS_TOKEN=akab-xxxxxxxxxxxxxxxx-xxxxxxxxxxxxxxxx
```

Save and exit. This file should never be committed to git and never be
pasted into a chat message.

## 3. Install the systemd service

```
sudo cp server/pull-logs.service.example /etc/systemd/system/pull-logs.service
sudo nano /etc/systemd/system/pull-logs.service   # fix the ExecStart path to point at your checkout
sudo systemctl daemon-reload
sudo systemctl enable --now pull-logs
sudo systemctl status pull-logs                   # should show "active (running)"
```

## 4. Wire up nginx

Open your existing Certbot-managed site config (likely under
`/etc/nginx/sites-available/`) and add the block from
`server/pull-logs.conf.example` inside the `server { listen 443 ssl; ... }`
block — alongside, not replacing, the `ssl_certificate` /
`ssl_dhparam` / `include .../options-ssl-nginx.conf` lines Certbot manages.
Then:

```
sudo nginx -t
sudo systemctl reload nginx
```

## 5. Test it

From the server itself:
```
curl -s -X POST http://127.0.0.1:8899/api/pull-logs \
  -H 'Content-Type: application/json' \
  -H 'X-Api-Key: your-PULL_LOGS_SHARED_SECRET-value' \
  -d '{"edgeIp":"<a real edge IP you have logs for>","start":"2026-10-20T00:00:00Z","end":"2026-10-20T01:00:00Z"}'
```
A 401 means the API key doesn't match `/etc/pull-logs.env`. A 502 with an
Akamai error body usually means the EdgeGrid credentials are wrong or the
API client lacks the Edge Diagnostics grant. A 200 with `"ok":true` and a
`lines` array means it's working — then try the "Pull logs directly from
Akamai Edge Diagnostics" section in the dashboard itself, using the same
API key you put in `/etc/pull-logs.env`.

## Notes

- The grep API's JSON response doesn't include WAF rule names or client
  reputation signals, so the "Top WAF Rules Triggered" and "Client
  Reputation Signals" widgets will show no data for logs pulled this way —
  only for uploaded/pasted raw log files, which do contain that data.
- Grep jobs run asynchronously on Akamai's side; the proxy polls for
  completion for up to 90 seconds before giving up. Large time windows may
  need to be split into smaller requests.
- To change the shared API key, edit `/etc/pull-logs.env` and run `sudo
  systemctl restart pull-logs`.
