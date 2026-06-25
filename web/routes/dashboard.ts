import { Router } from "express";
import { getSession } from "../lib/session.js";
import {
  findInFlightWithdrawal,
  findOrClaimUser,
  getRecentActivity,
  queueWithdrawal,
  type HistoryRow,
} from "../lib/userDb.js";
import { ensureUserViaBot } from "../lib/botInternalClient.js";
import { getBchUsd, formatUsd } from "../lib/priceClient.js";
import pino from "pino";

const logger = pino({ name: "dashboard" });
import {
  bchToSatoshis,
  isValidAmount,
  isValidCashAddress,
  normalizeCashAddress,
} from "../lib/validation.js";
import { config } from "../lib/config.js";

export const dashboardRouter = Router();

dashboardRouter.get("/", async (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.type("html").send(renderLogin());
    return;
  }
  let user = findOrClaimUser(session.twitterUserId, session.username);

  // First-time signer with no tip history: ask the bot to bootstrap them.
  // The bot has the HD seed and derives a deposit address. We then re-query
  // by twitter_user_id. If the bot is unreachable, fall through to the
  // "no account yet" UI so the page still renders.
  if (!user) {
    try {
      await ensureUserViaBot(session.twitterUserId, session.username);
      user = findOrClaimUser(session.twitterUserId, session.username);
    } catch (err) {
      logger.error({ err, username: session.username }, "ensureUserViaBot failed");
    }
  }

  const inFlight = user ? findInFlightWithdrawal(user.id) : null;
  const history = user ? getRecentActivity(user.id, 15) : [];
  const notice = decodeNotice(req.query.notice as string | undefined);
  const bchUsd = await getBchUsd();
  res
    .type("html")
    .send(renderDashboard(session.username, user, inFlight, history, notice, bchUsd));
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
  history: HistoryRow[],
  notice: { kind: string; text: string } | null,
  bchUsd: number | null
): string {
  const safeUser = escapeHtml(username);

  const balanceUsd = user ? formatUsd(user.balance_satoshis, bchUsd) : null;
  const accountSection = user
    ? `
      <section class="card">
        <div class="row">
          <span class="label">Balance</span>
          <span class="value">${formatBch(user.balance_satoshis)} BCH</span>
        </div>
        <div class="row sub">
          <span></span>
          <span class="muted">${user.balance_satoshis.toLocaleString()} satoshis${balanceUsd ? " · " + balanceUsd : ""}</span>
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
  const historySection = user && history.length > 0 ? renderHistorySection(history, bchUsd) : "";

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
      ${historySection}

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

function renderHistorySection(rows: HistoryRow[], bchUsd: number | null): string {
  const items = rows
    .map((r) => {
      const typeLabel = labelFor(r.type);
      const link = r.txid
        ? `<a class="link" href="https://blockchair.com/bitcoin-cash/transaction/${escapeHtml(r.txid)}" target="_blank" rel="noopener">TX</a>`
        : "";
      const counterparty = r.counterparty
        ? `<span class="muted small">${escapeHtml(counterpartyLabel(r.type, r.counterparty))}</span>`
        : "";
      const usd = formatUsd(r.amount_satoshis, bchUsd);
      return `
        <li>
          <div class="hrow">
            <span><strong>${typeLabel}</strong> ${formatBch(r.amount_satoshis)} BCH${usd ? ` <span class="muted small">${usd}</span>` : ""}</span>
            <span class="status status-${escapeHtml(r.status)}">${escapeHtml(r.status)}</span>
          </div>
          <div class="hrow sub">
            <span class="muted small">${escapeHtml(r.created_at)} UTC ${counterparty}</span>
            ${link}
          </div>
        </li>
      `;
    })
    .join("");
  return `
    <section class="card">
      <div class="label">Recent activity</div>
      <ul class="history">${items}</ul>
    </section>
  `;
}

function labelFor(type: HistoryRow["type"]): string {
  switch (type) {
    case "deposit":
      return "Deposit";
    case "withdrawal":
      return "Withdrawal";
    case "tip_received":
      return "Tip received";
    case "tip_sent":
      return "Tip sent";
  }
}

function counterpartyLabel(type: HistoryRow["type"], cp: string): string {
  if (type === "tip_received") return `from @${cp}`;
  if (type === "tip_sent") return `to @${cp}`;
  return shorten(cp);
}

function shorten(addr: string): string {
  if (addr.length <= 24) return addr;
  return `${addr.slice(0, 14)}…${addr.slice(-8)}`;
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
    .history { list-style: none; padding: 0; margin: .5rem 0 0; }
    .history li { padding: .6rem 0; border-bottom: 1px solid #2f3336; }
    .history li:last-child { border-bottom: 0; }
    .hrow { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
    .hrow.sub { margin-top: .2rem; }
    .status { font-size: .8rem; padding: 2px 8px; border-radius: 999px; border: 1px solid #2f3336; }
    .status-queued { color: #c5a700; border-color: #6b5b00; }
    .status-pending { color: #c5a700; border-color: #6b5b00; }
    .status-confirming { color: #1d9bf0; border-color: #145687; }
    .status-confirmed { color: #00ba7c; border-color: #00513a; }
    .status-completed { color: #8899a6; border-color: #2f3336; }
    .status-returned { color: #c5a700; border-color: #6b5b00; }
    .status-failed { color: #f4212e; border-color: #6b1015; }
  `;
}
