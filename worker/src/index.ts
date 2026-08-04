import { createHandler } from "./handler";
import type { AppEnv } from "./types";

const handler = createHandler();

export default {
  fetch(request: Request, env: AppEnv): Promise<Response> {
    return handler(request, env);
  },
} satisfies ExportedHandler<AppEnv>;
