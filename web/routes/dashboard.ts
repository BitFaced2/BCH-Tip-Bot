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
  const history = user ? getRecentActivity(user.id, 50) : [];
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
      <div class="login-hero">
        <img src="/tip-bot-logo.png" alt="BCH Tip Bot" class="brand-logo-lg" />
        <p class="muted">Sign in with your X account to view your balance, deposit address, and withdraw.</p>
        <a class="btn" href="/login">Sign in with X</a>
      </div>
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
  const disclaimer = user ? renderDisclaimer() : "";

  return page(
    "BCH Tip Bot",
    `
      <header class="top">
        <a class="brand" href="/" aria-label="BCH Tip Bot">
          <img src="/tip-bot-logo.png" alt="BCH Tip Bot" class="brand-logo" />
        </a>
        <form method="post" action="/logout">
          <span class="muted">@${safeUser}</span>
          <button type="submit" class="link">Sign out</button>
        </form>
      </header>

      ${disclaimer}
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
  const INITIAL_VISIBLE = 5;
  const visible = rows.slice(0, INITIAL_VISIBLE);
  const rest = rows.slice(INITIAL_VISIBLE);

  const renderRow = (r: HistoryRow) => {
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
  };

  const visibleHtml = visible.map(renderRow).join("");
  const moreHtml = rest.length > 0
    ? `
        <details class="history-more">
          <summary>Show ${rest.length} more</summary>
          <ul class="history">${rest.map(renderRow).join("")}</ul>
        </details>
      `
    : "";

  return `
    <section class="card">
      <div class="label">Recent activity</div>
      <ul class="history">${visibleHtml}</ul>
      ${moreHtml}
    </section>
  `;
}

function renderDisclaimer(): string {
  return `
    <div class="disclaimer small">
      Tips charge a 1% fee from the sender. Unclaimed tips return to the sender after 7 days.
    </div>
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
  <link rel="icon" type="image/png" href="/tip-bot-logo.png" />
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
    :root {
      --bch-green: #0ac18e;
      --bch-green-bright: #00ff9d;
      --bch-green-dim: #088b66;
      --bch-glow: rgba(10,193,142,0.45);
      --bch-glow-soft: rgba(10,193,142,0.12);
      --bg: #07090c;
      --bg-card: #0f141a;
      --bg-input: #060809;
      --border: #1a2530;
      --border-bright: #233040;
      --text: #e7e9ea;
      --text-muted: #6b7785;
      --danger: #f4212e;
      --warn: #d4a017;
    }
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      background-image:
        radial-gradient(ellipse at top, rgba(10,193,142,0.06), transparent 50%),
        linear-gradient(transparent 50%, rgba(255,255,255,0.012) 50%);
      background-size: 100% 100%, 100% 3px;
      min-height: 100vh;
    }
    main { max-width: 560px; margin: 2.5rem auto; padding: 0 1.5rem; }
    .top {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 1rem;
    }
    .brand {
      display: inline-flex; align-items: center;
      text-decoration: none;
    }
    .brand-logo {
      height: 64px; width: auto;
      filter: drop-shadow(0 0 14px var(--bch-glow));
      transition: filter .2s;
    }
    .brand:hover .brand-logo {
      filter: drop-shadow(0 0 20px var(--bch-green));
    }
    .brand-logo-lg {
      height: 120px; width: auto; margin-bottom: 1rem;
      filter: drop-shadow(0 0 18px var(--bch-glow));
    }
    h1 {
      font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
      font-weight: 700; font-size: 1.25rem; margin: 0;
      letter-spacing: -.01em;
    }
    .top form { display: flex; align-items: center; gap: .75rem; }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem 1.5rem;
      margin-bottom: 1rem;
      position: relative;
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
    .row.sub { margin-top: -.2rem; }
    .label {
      color: var(--text-muted); font-size: .75rem;
      text-transform: uppercase; letter-spacing: .08em; font-weight: 600;
    }
    .value {
      font-size: 1.9rem; font-weight: 700;
      font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
      color: var(--bch-green);
      text-shadow: 0 0 14px var(--bch-glow);
      letter-spacing: -.02em;
    }
    .muted { color: var(--text-muted); }
    .small { font-size: .85rem; }
    .addr, .inline-addr {
      font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
      word-break: break-all;
    }
    .addr {
      background: var(--bg-input); border: 1px solid var(--border);
      border-radius: 8px; padding: .75rem; margin: .5rem 0; font-size: .9rem;
      color: var(--bch-green);
    }
    .inline-addr {
      background: var(--bg-input); padding: 2px 6px; border-radius: 4px;
      font-size: .85rem; color: var(--text-muted);
    }
    .field { display: flex; flex-direction: column; gap: .35rem; margin-bottom: 1rem; }
    .field span {
      color: var(--text-muted); font-size: .75rem;
      text-transform: uppercase; letter-spacing: .08em; font-weight: 600;
    }
    .field input {
      background: var(--bg-input); border: 1px solid var(--border); color: var(--text);
      border-radius: 8px; padding: .7rem .85rem; font-size: 1rem;
      font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
      transition: border-color .15s, box-shadow .15s;
    }
    .field input:focus {
      outline: none;
      border-color: var(--bch-green);
      box-shadow: 0 0 0 3px var(--bch-glow-soft);
    }
    .btn, .btn-secondary, .link {
      padding: .6rem 1.4rem; border-radius: 8px; font-size: .95rem;
      cursor: pointer; border: 0; text-decoration: none; display: inline-block;
      font-weight: 600; letter-spacing: .01em;
      transition: background .15s, box-shadow .15s, transform .05s;
    }
    .btn {
      background: var(--bch-green); color: #001f15;
      box-shadow: 0 0 18px var(--bch-glow);
    }
    .btn:hover { background: var(--bch-green-bright); }
    .btn:active { transform: translateY(1px); }
    .btn-secondary {
      background: transparent; color: var(--text);
      border: 1px solid var(--border-bright); font-family: inherit;
    }
    .btn-secondary:hover { border-color: var(--bch-green); color: var(--bch-green); }
    .link {
      background: transparent; color: var(--bch-green); padding: 0;
      font-size: .9rem; font-weight: 500;
    }
    .link:hover { text-decoration: underline; }
    .notice {
      padding: .8rem 1rem; border-radius: 10px; margin-bottom: 1rem;
      border: 1px solid var(--border);
    }
    .notice.ok { border-color: var(--bch-green); background: var(--bch-glow-soft); color: var(--bch-green); }
    .notice.error { border-color: var(--danger); background: rgba(244,33,46,0.1); }
    .disclaimer {
      text-align: center; padding: .65rem 1rem; margin: 0 0 1.25rem;
      background: var(--bch-glow-soft);
      border: 1px solid rgba(10,193,142,0.25);
      border-radius: 8px;
      color: var(--text-muted);
    }
    .history { list-style: none; padding: 0; margin: .5rem 0 0; }
    .history li {
      padding: .65rem 0;
      border-bottom: 1px solid var(--border);
    }
    .history li:last-child { border-bottom: 0; }
    .hrow { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
    .hrow.sub { margin-top: .25rem; }
    .status {
      font-size: .7rem; padding: 2px 8px; border-radius: 999px;
      border: 1px solid var(--border); text-transform: uppercase;
      letter-spacing: .06em; font-weight: 600;
    }
    .status-queued, .status-pending { color: var(--warn); border-color: #6b5b00; background: rgba(212,160,23,0.08); }
    .status-confirming { color: #4dabff; border-color: #145687; background: rgba(77,171,255,0.08); }
    .status-confirmed { color: var(--bch-green); border-color: var(--bch-green-dim); background: var(--bch-glow-soft); }
    .status-completed { color: var(--text-muted); border-color: var(--border); }
    .status-returned { color: var(--warn); border-color: #6b5b00; background: rgba(212,160,23,0.08); }
    .status-failed { color: var(--danger); border-color: #6b1015; background: rgba(244,33,46,0.08); }
    .history-more { margin-top: .5rem; }
    .history-more summary {
      cursor: pointer; color: var(--bch-green); font-size: .85rem;
      padding: .4rem 0; list-style: none; font-weight: 500;
    }
    .history-more summary::-webkit-details-marker { display: none; }
    .history-more summary:hover { text-decoration: underline; }
    .history-more[open] summary { margin-bottom: .25rem; }
    .login-hero {
      text-align: center; padding: 3rem 0;
    }
    .login-hero p { margin: 0 0 1.5rem; }
  `;
}
