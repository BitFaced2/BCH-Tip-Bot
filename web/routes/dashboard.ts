import { Router } from "express";
import { getSession } from "../lib/session.js";

export const dashboardRouter = Router();

dashboardRouter.get("/", (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.type("html").send(renderLogin());
    return;
  }
  res.type("html").send(renderDashboard(session.username));
});

function renderLogin(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>BCH Tip Bot</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>${baseCss()}</style>
</head>
<body>
  <main>
    <h1>BCH Tip Bot</h1>
    <p>Sign in with your X account to view your balance, deposit address, and withdraw.</p>
    <a class="btn" href="/login">Sign in with X</a>
  </main>
</body>
</html>`;
}

function renderDashboard(username: string): string {
  const safe = escapeHtml(username);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>BCH Tip Bot</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>${baseCss()}</style>
</head>
<body>
  <main>
    <h1>BCH Tip Bot</h1>
    <p>Signed in as <strong>@${safe}</strong></p>
    <p><em>Phase 1 placeholder — balance, deposit address, and withdraw will land in Phase 2/3.</em></p>
    <form method="post" action="/logout">
      <button type="submit" class="btn-secondary">Sign out</button>
    </form>
  </main>
</body>
</html>`;
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
    main { max-width: 520px; margin: 4rem auto; padding: 0 1.5rem; }
    h1 { font-weight: 600; }
    .btn, .btn-secondary {
      display: inline-block; padding: .6rem 1.2rem; border-radius: 999px;
      font-size: 1rem; cursor: pointer; border: 0; text-decoration: none;
    }
    .btn { background: #1d9bf0; color: #fff; }
    .btn-secondary { background: transparent; color: #e7e9ea; border: 1px solid #2f3336; }
    .btn:hover { background: #1a8cd8; }
    form { margin-top: 2rem; }
  `;
}
