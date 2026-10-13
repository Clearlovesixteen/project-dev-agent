import assert from "node:assert/strict";
import test from "node:test";
import { createAccountSystem } from "../src/system.js";

test("an active account can log in, validate a session and be displayed", () => {
  const { service, auth, view } = createAccountSystem();
  const account = service.createAccount({ id: "alice", email: "alice@example.test" });
  const token = auth.login(account.id);
  assert.deepEqual(auth.validateSession(token), account);
  assert.deepEqual(view.getSummary(account.id), {
    id: "alice", email: "alice@example.test", status: "active", statusLabel: "启用",
  });
});

test("the service rejects unsupported status values on creation and updates", () => {
  const { service } = createAccountSystem();
  assert.throws(() => service.createAccount({
    id: "bad", email: "bad@example.test", status: "unknown",
  }), /UNSUPPORTED_ACCOUNT_STATUS/);
  service.createAccount({ id: "alice", email: "alice@example.test" });
  assert.throws(() => service.setStatus("alice", "unknown"), /UNSUPPORTED_ACCOUNT_STATUS/);
  assert.equal(service.getAccount("alice").status, "active");
});

test("missing accounts and invalid session tokens are rejected", () => {
  const { service, auth, view } = createAccountSystem();
  assert.throws(() => service.setStatus("missing", "active"), /ACCOUNT_NOT_FOUND/);
  assert.throws(() => auth.login("missing"), /ACCOUNT_NOT_FOUND/);
  assert.throws(() => auth.validateSession("missing-token"), /INVALID_SESSION/);
  assert.throws(() => view.getSummary("missing"), /ACCOUNT_NOT_FOUND/);
});

test("callers cannot bypass the service by changing an account snapshot", () => {
  const { service } = createAccountSystem();
  service.createAccount({ id: "alice", email: "alice@example.test" });
  const snapshot = service.getAccount("alice");
  snapshot.status = "caller-change";
  assert.equal(service.getAccount("alice").status, "active");
});
