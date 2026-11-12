import * as AuthContract from "@yielded/auth/AuthContract";
import { Schema } from "effect";

export const Account = Schema.Struct({
  id: Schema.String.pipe(Schema.brand("AccountId")),
  email: Schema.String,
});

export const AuthApi = AuthContract.make("oneapp/Auth", {
  basePath: "/api/auth",
  claims: Schema.Struct({ email: Schema.String }),
  actions: (sessions) => ({ signIn: AuthContract.passwordSignIn(sessions) }),
});
