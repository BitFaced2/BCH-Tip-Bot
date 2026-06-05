import { Router } from "express";
import { getSession } from "../lib/session.js";
import {
  findInFlightWithdrawal,
  findOrClaimUser,
  queueWithdrawal,
} from "../lib/userDb.js";
import {
  bchToSatoshis,
  isValidAmount,
  isValidCashAddress,
  normalizeCashAddress,
} from "../lib/validation.js";
import { config } from "../lib/config.js";

export const dashboardRouter = Router();

dashboardRouter.get("/", (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.type("html").send(renderLogin());
    return;
  }
  const user = findOrClaimUser(session.twitterUserId, session.username);
  const inFlight = user ? findInFlightWithdrawal(user.id) : null;
  const notice = decodeNotice(req.query.notice as string | undefined);
  res.type("html").send(renderDashboard(session.username, user, inFlight, notice));
});

dashboardRouter.post("/withdraw", (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.redirect("/");
    return;
  }
  const user = findOrClaimUser(session.twitterUserId, session.username);
  if (!user) {
    res.redirect("/?notice=" + encodeNotice("error", "No account to withdraw from."));
    return;
  }

  const amountStr = String(req.body.amount ?? "").trim();
  const addressRaw = String(req.body.address ?? "").trim();

  if (!isValidAmount(amountStr)) {
    res.redirect("/?notice=" + encodeNotice("error", `Invalid amount: ${amountStr}`));
    return;
  }
  if (!isValidCashAddress(addressRaw)) {
    res.redirect("/?notice=" + encodeNotice("error", "Invalid BCH address."));
    return;
  }

  const amountSatoshis = bchToSatoshis(parseFloat(amountStr));
  if (amountSatoshis < config.minWithdrawalSatoshis) {
    res.redirect(
      "/?notice=" +
        encodeNotice(
          "error",
          `Minimum withdrawal is ${(config.minWithdrawalSatoshis / 1e8).toFixed(8)} BCH.`
        )
    );
    return;
  }
  if (amountSatoshis > config.maxWithdrawalSatoshis) {
    res.redirect(
      "/?notice=" +
        encodeNotice(
          "error",
          `Maximum withdrawal is ${(config.maxWithdrawalSatoshis / 1e8).toFixed(8)} BCH.`
        )
    );
    return;
  }

  const normalized = normalizeCashAddress(addressRaw);
  const result = queueWithdrawal(
    user.id,
    amountSatoshis,
    config.withdrawalFeeSatoshis,
    normalized
  );
  if (!result.ok) {
    res.redirect("/?notice=" + encodeNotice("error", result.error));
    return;
  }
  res.redirect(
    "/?notice=" +
      encodeNotice(
        "ok",
        `Queued. The bot will broadcast within ~10 seconds and DM you the txid (if your DMs work).`
      )
  );
});

function encodeNotice(kind: "ok" | "error", text: string): string {
  return encodeURIComponent(`${kind}:${text}`);
}

function decodeNotice(raw: string | undefined): { kind: string; text: string } | null {
  if (!raw) return null;
  const idx = raw.indexOf(":");
  if (idx < 0) return null;
  const kind = raw.slice(0, idx);
  if (kind !== "ok" && kind !== "error") return null;
  return { kind, text: raw.slice(idx + 1) };
}

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
  user: ReturnType<typeof findOrClaimUser>,
  inFlight: ReturnType<typeof findInFlightWithdrawal>,
  notice: { kind: string; text: string } | null
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

  const withdrawSection = user ? renderWithdrawSection(inFlight) : "";

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

      ${notice ? renderNotice(notice) : ""}
      ${accountSection}
      ${withdrawSection}

      <script>
        async function copyAddr() {
          const t = document.getElementById('addr').textContent.trim();
          try { await navigator.clipboard.writeText(t); } catch (e) { /* ignore */ }
        }
        function confirmWithdraw(form) {
          const amount = form.amount.value;
          const address = form.address.value;
          return confirm('Send ' + amount + ' BCH to ' + address + '?');
        }
      </script>
    `
  );
}

function renderNotice(notice: { kind: string; text: string }): string {
  const cls = notice.kind === "ok" ? "notice ok" : "notice error";
  return `<div class="${cls}">${escapeHtml(notice.text)}</div>`;
}

function renderWithdrawSection(
  inFlight: ReturnType<typeof findInFlightWithdrawal>
): string {
  if (inFlight) {
    return `
      <section class="card">
        <div class="label">Withdrawal in progress</div>
        <p>
          <strong>${formatBch(inFlight.amount_satoshis)} BCH</strong>
          to <code class="inline-addr">${escapeHtml(inFlight.address ?? "")}</code>
        </p>
        <p class="muted small">Status: ${escapeHtml(inFlight.status)} — created ${escapeHtml(inFlight.created_at)} UTC.
        Refresh to check.</p>
      </section>
    `;
  }
  const feeBch = (config.withdrawalFeeSatoshis / 1e8).toFixed(8);
  const minBch = (config.minWithdrawalSatoshis / 1e8).toFixed(8);
  const maxBch = (config.maxWithdrawalSatoshis / 1e8).toFixed(8);
  return `
    <section class="card">
      <div class="label">Withdraw</div>
      <form method="post" action="/withdraw" onsubmit="return confirmWithdraw(this)">
        <label class="field">
          <span>Amount (BCH)</span>
          <input name="amount" type="text" inputmode="decimal" autocomplete="off" required />
        </label>
        <label class="field">
          <span>Destination address</span>
          <input name="address" type="text" autocomplete="off" required placeholder="bitcoincash:q..." />
        </label>
        <p class="muted small">
          Min ${minBch} BCH. Max ${maxBch} BCH. Fee ${feeBch} BCH per withdrawal.
        </p>
        <button type="submit" class="btn">Withdraw</button>
      </form>
    </section>
  `;
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
    .addr, .inline-addr {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      word-break: break-all;
    }
    .addr {
      background: #0b1116; border: 1px solid #2f3336;
      border-radius: 8px; padding: .75rem; margin: .5rem 0; font-size: .95rem;
    }
    .inline-addr { background: #0b1116; padding: 2px 6px; border-radius: 4px; font-size: .9rem; }
    .field { display: flex; flex-direction: column; gap: .35rem; margin-bottom: 1rem; }
    .field span { color: #8899a6; font-size: .9rem; }
    .field input {
      background: #0b1116; border: 1px solid #2f3336; color: #e7e9ea;
      border-radius: 8px; padding: .65rem .75rem; font-size: 1rem;
      font-family: inherit;
    }
    .field input:focus { outline: none; border-color: #1d9bf0; }
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
    .notice {
      padding: .8rem 1rem; border-radius: 10px; margin-bottom: 1rem;
      border: 1px solid #2f3336;
    }
    .notice.ok { border-color: #1d9bf0; background: rgba(29,155,240,0.1); }
    .notice.error { border-color: #f4212e; background: rgba(244,33,46,0.1); }
  `;
}
