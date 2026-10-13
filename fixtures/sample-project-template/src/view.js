export function createAccountView(accountService) {
  return {
    getSummary(accountId) {
      const account = accountService.getAccount(accountId);
      if (!account) throw new Error("ACCOUNT_NOT_FOUND");
      return {
        id: account.id,
        email: account.email,
        status: account.status,
        statusLabel: "启用",
      };
    },
  };
}
