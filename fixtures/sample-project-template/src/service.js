const supportedStatuses = new Set(["active"]);

function assertSupportedStatus(status) {
  if (!supportedStatuses.has(status)) throw new Error("UNSUPPORTED_ACCOUNT_STATUS");
}

export function createAccountService(store) {
  return {
    createAccount({ id, email, status = "active" }) {
      if (typeof id !== "string" || !id.trim()) throw new Error("INVALID_ACCOUNT_ID");
      if (typeof email !== "string" || !email.includes("@")) throw new Error("INVALID_EMAIL");
      assertSupportedStatus(status);
      return store.insert({ id, email, status });
    },
    setStatus(id, status) {
      assertSupportedStatus(status);
      return store.updateStatus(id, status);
    },
    getAccount(id) {
      return store.get(id);
    },
  };
}
