# BCH Tip Bot — FAQ

**What is the BCH Tip Bot?**
A Twitter/X bot that lets you send Bitcoin Cash (BCH) tips to other users by mentioning the bot in a tweet.

**Is this a custodial service?**
Yes. The BCH Tip Bot is **fully custodial** — when you deposit BCH or receive a tip, the bot holds the funds on your behalf. You do not control the private keys. You should treat the bot like a hot wallet for small amounts and withdraw to your own wallet for long-term storage.

**How do I tip someone?**
Mention the bot in a tweet or reply:
`@bchtip tip @username 0.001 BCH`

**Can I tip multiple people in one tweet?**
Yes! List multiple usernames before the amount (up to 5 per tweet):
`@bchtip tip @user1 @user2 @user3 0.001 BCH`
Each person receives the full 0.001 BCH. Note: all recipients get the same amount. You cannot specify different amounts per person — only the first tip command in a tweet is processed.

**What's the minimum tip amount?**
100 satoshis (0.000001 BCH).

**Is there a fee for tipping?**
A 1% fee is added on top of each tip to cover server costs. The recipient receives the full tip amount. When tipping multiple people, the fee is charged per recipient.

**Do I need an account to receive tips?**
No. If someone tips you and you don't have an account yet, one is created automatically. DM the bot to access your funds.

**Can I tip myself?**
No, self-tipping is not allowed.

**How do I deposit BCH into my account?**
Send a DM to the bot with the word `deposit`. It will reply with your unique BCH deposit address.

**How many confirmations are required for deposits?**
3 block confirmations before the balance is credited.

**How do I check my balance?**
DM the bot with `balance`. It will reply with your balance in both BCH and satoshis.

**How do I withdraw BCH?**
DM the bot: `withdraw <amount> <address>`
Example: `withdraw 0.005 bitcoincash:qr4vfr3n...`

**What are the withdrawal limits?**
- Minimum: 10,000 satoshis (0.0001 BCH)
- Maximum: 1 BCH per withdrawal
- Fee: 500 satoshis per withdrawal

**What address format is supported?**
Bitcoin Cash CashAddr format (e.g., `bitcoincash:qr...`).

**What DM commands are available?**
- `deposit` — get your deposit address
- `balance` — check your balance
- `withdraw <amount> <address>` — withdraw BCH
- `help` — show available commands

**Where can I verify my transactions?**
Withdrawal transactions link to [Blockchair](https://blockchair.com/bitcoin-cash) for on-chain verification.

## Contributing

Contributions are welcome! Please fork the repo and submit a pull request. All PRs are reviewed before merging.
