// Scheduled half of the MF drawdown alerts: runs the daily check (see
// wrangler.toml for the schedule). The site's API (functions/api/mf) shares
// the same KV namespace and logic.
import { connect } from 'cloudflare:sockets';
import { runChecks } from './core.js';
import { createMailer } from './mail.js';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env, { trigger: `cron ${event.cron}`, mailer: createMailer(env, connect) }).then(({ summary }) => {
      console.log(JSON.stringify(summary));
    }));
  },
};
