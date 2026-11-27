import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

function resolveEnvFilePath(): string | undefined {
  const candidates = [
    path.resolve(import.meta.dirname, "../../.env"),
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../.env"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

const envFilePath = resolveEnvFilePath();
if (envFilePath) {
  dotenv.config({ path: envFilePath });
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePort(raw: string | undefined): number {
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed;
  }
  return 3000;
}

function normalizeHttpUrl(raw: string, varName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid URL in environment variable: ${varName}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol in environment variable: ${varName}`);
  }
  return raw.replace(/\/+$/, "");
}

export interface EnvConfig {
  readonly port: number;
  readonly supabaseUrl: string;
  readonly supabasePublishableKey: string;
  readonly supabaseSecretKey: string | undefined;
  readonly relayOwnerId: string | undefined;
  readonly ownerDisplayName: string;
  readonly dropboxAppKey: string | undefined;
  readonly dropboxAppSecret: string | undefined;
  readonly dropboxRefreshToken: string | undefined;
  readonly dropboxAccessToken: string | undefined;
}

export const env: EnvConfig = {
  port: parsePort(optionalEnv("PORT")),
  supabaseUrl: normalizeHttpUrl(requiredEnv("SUPABASE_URL"), "SUPABASE_URL"),
  supabasePublishableKey: requiredEnv("SUPABASE_PUBLISHABLE_KEY"),
  supabaseSecretKey: optionalEnv("SUPABASE_SECRET_KEY"),
  relayOwnerId: optionalEnv("RELAY_OWNER_ID"),
  ownerDisplayName: optionalEnv("OWNER_DISPLAY_NAME") ?? "Owner",
  dropboxAppKey: optionalEnv("DROPBOX_APP_KEY"),
  dropboxAppSecret: optionalEnv("DROPBOX_APP_SECRET"),
  dropboxRefreshToken: optionalEnv("DROPBOX_REFRESH_TOKEN"),
  dropboxAccessToken: optionalEnv("DROPBOX_ACCESS_TOKEN"),
};
