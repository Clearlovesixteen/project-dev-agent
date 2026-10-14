import { randomUUID } from "node:crypto";

export function createAuth(accountService) {
  const sessions = new Map();

  return {
    login(accountId) {
      const account = accountService.getAccount(accountId);
      if (!account) throw new Error("ACCOUNT_NOT_FOUND");
      const token = randomUUID();
      sessions.set(token, account.id);
      return token;
    },
    validateSession(token) {
      const accountId = sessions.get(token);
      if (!accountId) throw new Error("INVALID_SESSION");
      const account = accountService.getAccount(accountId);
      if (!account) throw new Error("ACCOUNT_NOT_FOUND");
      return account;
    },
  };
}
