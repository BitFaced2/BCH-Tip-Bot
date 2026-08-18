#!/usr/bin/env python3
"""Daily health check for BCH Tip Bot — runs on the local PC, SSHes into
qube.cash to gather signals, emails a digest via Gmail SMTP (mirrors the
qube_stats.py pattern, which works around DO's outbound-SMTP block).

Always sends an email: "Daily Health Check OK" when everything passes,
or a flagged issues list when something looks off.

Schedule alongside qube_stats.py in Windows Task Scheduler.

Reads QUBES_STATS_EMAIL_PASSWORD from env (the same secret qube_stats.py
already uses)."""

import json
import os
import re
import smtplib
import subprocess
import sys
from datetime import datetime, timezone
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

SERVER = "bit_faced@167.71.100.232"
SSH_KEY = os.path.expanduser("~/.ssh/qube_stats_key")
DB_PATH = "~/BCH-Tip-Bot/data/tipbot.db"
LOG_PATH = "~/.pm2/logs/bch-tip-bot-out.log"
PM2_PROCESS_NAME = "bch-tip-bot"

EMAIL_CONFIG = {
    "smtp_server": "smtp.gmail.com",
    "smtp_port": 587,
    "sender_email": os.environ.get("QUBES_STATS_EMAIL", "elmore253@gmail.com"),
    "sender_password": os.environ.get("QUBES_STATS_EMAIL_PASSWORD", ""),
    "recipient_email": "bit_faced@pm.me",
}

# Thresholds — alert when any check exceeds these. Mention threshold is
# above X's 7-day since_id window so a quiet stretch where the bot's own
# reactive handler clears the row doesn't trigger noise; if mentions are
# legitimately silent for >8d, that's worth knowing.
#
# The DM poller is no longer started (X's E2E rollout made DMs unreliable),
# so its last_dm_event_id naturally goes stale forever. We don't check it.
MENTION_POLLER_STALE_DAYS = 8
STUCK_WITHDRAWAL_MIN_MINUTES = 60
DISK_USAGE_ALERT_PCT = 95
RECENT_ERROR_THRESHOLD = 100
ELECTRUM_JAM_THRESHOLD = 20
ELECTRUM_HEAL_STORM_THRESHOLD = 50


def ssh(command: str, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["ssh", "-i", SSH_KEY, "-o", "BatchMode=yes", SERVER, command],
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def check_pm2() -> str | None:
    result = ssh("pm2 jlist 2>/dev/null")
    if result.returncode != 0 or not result.stdout.strip():
        return "Could not query pm2 over SSH"
    try:
        procs = json.loads(result.stdout)
    except json.JSONDecodeError:
        return "pm2 jlist did not return JSON"
    bot = next((p for p in procs if p.get("name") == PM2_PROCESS_NAME), None)
    if not bot:
        return f"PM2 process '{PM2_PROCESS_NAME}' not found"
    status = bot.get("pm2_env", {}).get("status")
    if status != "online":
        return f"PM2 process '{PM2_PROCESS_NAME}' status: {status}"
    return None


def check_poll_state() -> list[str]:
    result = ssh(
        f"sqlite3 -separator '|' {DB_PATH} \"SELECT key, updated_at FROM poll_state;\""
    )
    if result.returncode != 0:
        return [f"Could not read poll_state: {result.stderr.strip()}"]

    issues: list[str] = []
    now = datetime.now(timezone.utc)
    state: dict[str, datetime] = {}
    for line in result.stdout.strip().split("\n"):
        if not line or "|" not in line:
            continue
        key, ts = line.split("|", 1)
        state[key] = datetime.fromisoformat(ts + "+00:00")

    # Missing rows are a valid state (just-cleared by reactive handler, or
    # first run), so only alert on rows that exist and are too old.
    if "last_mention_id" in state:
        age_days = (now - state["last_mention_id"]).total_seconds() / 86400
        if age_days > MENTION_POLLER_STALE_DAYS:
            issues.append(
                f"Mention poller stale: last_mention_id updated {age_days:.1f}d ago "
                f"(threshold {MENTION_POLLER_STALE_DAYS}d)"
            )

    return issues


def check_stuck_withdrawals() -> list[str]:
    query = (
        "SELECT id, user_id, amount_satoshis, address, created_at "
        "FROM transactions "
        "WHERE type='withdrawal' AND status='pending' AND txid IS NULL "
        f"AND created_at < datetime('now', '-{STUCK_WITHDRAWAL_MIN_MINUTES} minutes') "
        "ORDER BY created_at;"
    )
    result = ssh(f"sqlite3 -separator '|' {DB_PATH} \"{query}\"")
    if result.returncode != 0:
        return [f"Could not query withdrawals: {result.stderr.strip()}"]

    lines = [ln for ln in result.stdout.strip().split("\n") if ln]
    if not lines:
        return []
    formatted = [
        f"  - tx #{p[0]} user={p[1]} amount={p[2]} sat to {p[3]} (created {p[4]} UTC)"
        for p in (ln.split("|") for ln in lines)
        if len(p) >= 5
    ]
    return [
        f"{len(formatted)} stuck withdrawal(s) older than {STUCK_WITHDRAWAL_MIN_MINUTES}m:",
        *formatted,
    ]


def check_disk() -> str | None:
    result = ssh("df --output=pcent / | tail -n 1")
    if result.returncode != 0:
        return None
    match = re.search(r"(\d+)%", result.stdout)
    if not match:
        return None
    pct = int(match.group(1))
    if pct >= DISK_USAGE_ALERT_PCT:
        return f"Disk usage at {pct}% (threshold {DISK_USAGE_ALERT_PCT}%)"
    return None


def grep_log_count(pattern: str) -> int | None:
    # grep -c prints the count even when it exits 1 (zero matches), so don't
    # append "|| echo 0" — that yields "0\n0" on zero matches, which is
    # unparseable and silently disabled this check until 2026-08-18.
    result = ssh(f"grep -c '{pattern}' {LOG_PATH} 2>/dev/null")
    lines = result.stdout.strip().splitlines()
    try:
        return int(lines[0])
    except (ValueError, IndexError):
        return None


def check_electrum_jam() -> str | None:
    # Two signatures, checked in order of severity:
    #
    # 1. Raw jam error escaping to the log means the hdWallet auto-heal
    #    (shipped 2026-08-15) is NOT catching it — that's the old hard-stuck
    #    state and needs a manual restart.
    # 2. The auto-heal's own "Electrum socket jammed" warnings are normal in
    #    ones and twos, but a large count means the bot spent hours fighting
    #    an upstream Electrum outage (e.g., 135 warns on 2026-08-18). That
    #    usually self-resolves; flag it so the outage window is visible.
    count = grep_log_count("Cannot initiate a new socket")
    if count is None:
        return None
    if count >= ELECTRUM_JAM_THRESHOLD:
        return (
            f"Electrum socket hard-jammed ({count} raw jam errors escaped the "
            f"auto-heal, threshold {ELECTRUM_JAM_THRESHOLD}). "
            "Recovery: pm2 restart bch-tip-bot."
        )

    heals = grep_log_count("Electrum socket jammed")
    if heals is None:
        return None
    if heals >= ELECTRUM_HEAL_STORM_THRESHOLD:
        return (
            f"Electrum auto-heal storm: {heals} jam-reset cycles in current log "
            f"(threshold {ELECTRUM_HEAL_STORM_THRESHOLD}) — upstream Electrum "
            "outage likely. Usually self-resolves; verify deposits are flowing "
            "and check whether the warns have stopped."
        )
    return None


def check_recent_errors() -> str | None:
    # pm2-logrotate rotates daily, so the current log is roughly last 24h.
    count = grep_log_count('"level":50')
    if count is None:
        return None
    if count >= RECENT_ERROR_THRESHOLD:
        return (
            f"{count} error-level log entries in current log "
            f"(threshold {RECENT_ERROR_THRESHOLD})"
        )
    return None


def send_email(subject: str, body: str) -> bool:
    if not EMAIL_CONFIG["sender_password"]:
        print("QUBES_STATS_EMAIL_PASSWORD not set; cannot send email.")
        return False

    msg = MIMEMultipart()
    msg["From"] = EMAIL_CONFIG["sender_email"]
    msg["To"] = EMAIL_CONFIG["recipient_email"]
    msg["Subject"] = subject
    html = (
        "<html><body><pre style=\"font-family:'Courier New',monospace;font-size:14px;\">"
        f"{body}"
        "</pre></body></html>"
    )
    msg.attach(MIMEText(html, "html", "utf-8"))

    try:
        # Without an explicit timeout smtplib will wait forever on a hung
        # socket — that's how yesterday's run produced no email at all.
        with smtplib.SMTP(
            EMAIL_CONFIG["smtp_server"], EMAIL_CONFIG["smtp_port"], timeout=30
        ) as srv:
            srv.starttls()
            srv.login(EMAIL_CONFIG["sender_email"], EMAIL_CONFIG["sender_password"])
            srv.send_message(msg)
        return True
    except Exception as e:
        print(f"Error sending email: {e}")
        return False


def main() -> int:
    # Each entry: (display name, callable returning list[str] of failure
    # reasons — empty list means passed). Wrapping Optional[str]-returning
    # checks in a list comprehension keeps the two shapes uniform.
    checks = [
        ("PM2 process online", lambda: [x for x in [check_pm2()] if x]),
        (
            f"Mention poller state fresh (<{MENTION_POLLER_STALE_DAYS}d)",
            check_poll_state,
        ),
        (
            f"No withdrawals stuck pending >{STUCK_WITHDRAWAL_MIN_MINUTES}m",
            check_stuck_withdrawals,
        ),
        (
            f"Disk usage below {DISK_USAGE_ALERT_PCT}%",
            lambda: [x for x in [check_disk()] if x],
        ),
        ("Electrum socket healthy", lambda: [x for x in [check_electrum_jam()] if x]),
        (
            f"Error-log entries below {RECENT_ERROR_THRESHOLD}",
            lambda: [x for x in [check_recent_errors()] if x],
        ),
    ]

    results: list[tuple[str, list[str]]] = []
    for name, check in checks:
        try:
            failures = check()
        except subprocess.TimeoutExpired:
            failures = ["SSH timeout"]
        except Exception as e:
            failures = [f"Check error: {e}"]
        results.append((name, failures))

    total_failures = sum(len(f) for _, f in results)
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    today = datetime.now().strftime("%Y-%m-%d")

    body_lines = [f"Health check at {now}", ""]
    for name, failures in results:
        if failures:
            body_lines.append(f"\u2717 {name}")
            for f in failures:
                # Pre-indented lines (multi-row check output like stuck
                # withdrawal details) keep their own indent; single-line
                # reasons get a nested indent under the failing check.
                body_lines.append(f if f.startswith("  ") else f"    {f}")
        else:
            body_lines.append(f"\u2713 {name}")

    if total_failures > 0:
        subject = f"[BCH Tip Bot] Health check found {total_failures} issue(s) - {today}"
    else:
        subject = f"[BCH Tip Bot] Daily Health Check OK - {today}"

    body = "\n".join(body_lines)
    print(body)
    if send_email(subject, body):
        print(f"Report sent to {EMAIL_CONFIG['recipient_email']}")
        return 0
    print("Failed to send email")
    return 1


if __name__ == "__main__":
    sys.exit(main())
