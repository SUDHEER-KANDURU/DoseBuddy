import { env } from "cloudflare:workers";
import { Container, getContainer } from "@cloudflare/containers";

export interface Env {
  ASSETS: Fetcher;
  DOSEBUDDY_CONTAINER: DurableObjectNamespace<DoseBuddyContainer>;

  DB_URL: string;
  DB_USER: string;
  DB_PASS: string;
  JWT_SECRET: string;
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GROQ_MODEL?: string;
  GEMINI_MODEL?: string;
}

export class DoseBuddyContainer extends Container {
  defaultPort = 8080;

  // Pass Cloudflare secrets into the Spring Boot container environment
  override envVars = {
    DB_URL: (env as unknown as Env).DB_URL,
    DB_USER: (env as unknown as Env).DB_USER,
    DB_PASS: (env as unknown as Env).DB_PASS,
    JWT_SECRET: (env as unknown as Env).JWT_SECRET,
    GROQ_API_KEY: (env as unknown as Env).GROQ_API_KEY || "",
    GEMINI_API_KEY: (env as unknown as Env).GEMINI_API_KEY || "",
    GROQ_MODEL: (env as unknown as Env).GROQ_MODEL || "openai/gpt-oss-20b",
    GEMINI_MODEL: (env as unknown as Env).GEMINI_MODEL || "gemini-3.6-flash",
    PORT: "8080"
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 1. Route all /api/* requests to the Spring Boot Container
    if (url.pathname.startsWith("/api")) {
      const containerStub = getContainer(env.DOSEBUDDY_CONTAINER);
      return containerStub.fetch(request);
    }

    // 2. Serve static frontend assets for everything else
    return env.ASSETS.fetch(request);
  }
};
