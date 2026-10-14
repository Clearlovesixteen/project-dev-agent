export function createAccountStore() {
  const accounts = new Map();

  return {
    insert(account) {
      if (accounts.has(account.id)) throw new Error("ACCOUNT_ALREADY_EXISTS");
      accounts.set(account.id, { ...account });
      return { ...account };
    },
    get(id) {
      const account = accounts.get(id);
      return account ? { ...account } : undefined;
    },
    updateStatus(id, status) {
      const account = accounts.get(id);
      if (!account) throw new Error("ACCOUNT_NOT_FOUND");
      const updated = { ...account, status };
      accounts.set(id, updated);
      return { ...updated };
    },
  };
}
