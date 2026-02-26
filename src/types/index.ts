export interface User {
  id: number;
  twitter_user_id: string;
  twitter_username: string | null;
  derivation_index: number;
  deposit_address: string;
  balance_satoshis: number;
  created_at: string;
  updated_at: string;
}

export interface Transaction {
  id: number;
  user_id: number;
  type: "deposit" | "withdrawal";
  amount_satoshis: number;
  txid: string | null;
  address: string | null;
  confirmations: number;
  status: "pending" | "confirming" | "confirmed" | "failed";
  created_at: string;
  updated_at: string;
}

export interface Tip {
  id: number;
  from_user_id: number;
  to_user_id: number;
  amount_satoshis: number;
  fee_satoshis: number;
  tweet_id: string | null;
  status: "completed" | "failed";
  created_at: string;
}

export interface PollState {
  key: string;
  value: string;
  updated_at: string;
}

export interface CommandContext {
  type: "mention" | "dm";
  senderTwitterId: string;
  senderUsername: string;
  text: string;
  tweetId?: string;
}
