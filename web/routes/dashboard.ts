import { Router } from "express";
import { getSession } from "../lib/session.js";
import { findOrClaimUser } from "../lib/userDb.js";

export const dashboardRouter = Router();

dashboardRouter.get("/", (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.type("html").send(renderLogin());
    return;
  }
  const user = findOrClaimUser(session.twitterUserId, session.username);
  res.type("html").send(renderDashboard(session.username, user));
});

function renderLogin(): string {
  return page(
    "BCH Tip Bot",
    `
      <h1>BCH Tip Bot</h1>
      <p>Sign in with your X account to view your balance, deposit address, and withdraw.</p>
      <a class="btn" href="/login">Sign in with X</a>
    `
  );
}

function renderDashboard(
  username: string,
  user: ReturnType<typeof findOrClaimUser>
): string {
  const safeUser = escapeHtml(username);

  const accountSection = user
    ? `
      <section class="card">
        <div class="row">
          <span class="label">Balance</span>
          <span class="value">${formatBch(user.balance_satoshis)} BCH</span>
        </div>
        <div class="row sub">
          <span></span>
          <span class="muted">${user.balance_satoshis.toLocaleString()} satoshis</span>
        </div>
      </section>

      <section class="card">
        <div class="label">Deposit address</div>
        <div class="addr" id="addr">${escapeHtml(user.deposit_address)}</div>
        <div class="row">
          <button class="btn-secondary" onclick="copyAddr()">Copy</button>
          <span class="muted small">Send BCH here. Credited after 3 confirmations.</span>
        </div>
      </section>
    `
    : `
      <section class="card">
        <p>No account yet for <strong>@${safeUser}</strong>.</p>
        <p class="muted">Have someone tip you any amount via <strong>@bchtip</strong> on X to create an account.
        Your deposit address will appear here once the tip is processed.</p>
      </section>
    `;

  return page(
    "BCH Tip Bot",
    `
      <header class="top">
        <h1>BCH Tip Bot</h1>
        <form method="post" action="/logout">
          <span class="muted">@${safeUser}</span>
          <button type="submit" class="link">Sign out</button>
        </form>
      </header>

      ${accountSection}

      <p class="muted small">Withdraw lands in the next phase.</p>

      <script>
        async function copyAddr() {
          const t = document.getElementById('addr').textContent.trim();
          try { await navigator.clipboard.writeText(t); } catch (e) { /* ignore */ }
        }
      </script>
    `
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>${baseCss()}</style>
</head>
<body>
  <main>
    ${body}
  </main>
</body>
</html>`;
}

function formatBch(satoshis: number): string {
  return (satoshis / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, ".0");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function baseCss(): string {
  return `
    body { font-family: system-ui, sans-serif; background: #0e1419; color: #e7e9ea; margin: 0; }
    main { max-width: 560px; margin: 3rem auto; padding: 0 1.5rem; }
    h1 { font-weight: 600; margin: 0; }
    .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
    .top form { display: flex; align-items: center; gap: .75rem; }
    .card {
      background: #16202a; border: 1px solid #2f3336; border-radius: 14px;
      padding: 1.25rem 1.5rem; margin-bottom: 1rem;
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
    .row.sub { margin-top: -.25rem; }
    .label { color: #8899a6; font-size: .9rem; }
    .value { font-size: 1.6rem; font-weight: 600; }
    .muted { color: #8899a6; }
    .small { font-size: .85rem; }
    .addr {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      word-break: break-all; background: #0b1116; border: 1px solid #2f3336;
      border-radius: 8px; padding: .75rem; margin: .5rem 0; font-size: .95rem;
    }
    .btn, .btn-secondary, .link {
      padding: .55rem 1.2rem; border-radius: 999px; font-size: 1rem;
      cursor: pointer; border: 0; text-decoration: none; display: inline-block;
    }
    .btn { background: #1d9bf0; color: #fff; }
    .btn:hover { background: #1a8cd8; }
    .btn-secondary { background: transparent; color: #e7e9ea; border: 1px solid #2f3336; }
    .btn-secondary:hover { border-color: #4a5158; }
    .link { background: transparent; color: #1d9bf0; padding: 0; font-size: .95rem; }
    .link:hover { text-decoration: underline; }
  `;
}
