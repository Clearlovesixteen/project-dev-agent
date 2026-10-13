import { createAccountStore } from "./store.js";
import { createAccountService } from "./service.js";
import { createAuth } from "./auth.js";
import { createAccountView } from "./view.js";

export function createAccountSystem() {
  const service = createAccountService(createAccountStore());
  return {
    service,
    auth: createAuth(service),
    view: createAccountView(service),
  };
}
