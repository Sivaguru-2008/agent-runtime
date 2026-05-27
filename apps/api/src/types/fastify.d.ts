import type { RuntimeContainer } from "../application/runtimeContainer.js";

declare module "fastify" {
  interface FastifyInstance {
    runtimeContainer: RuntimeContainer;
  }
}
