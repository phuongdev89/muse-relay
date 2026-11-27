import type { NextFunction, Request, Response } from "express";
import { env } from "./env.js";

export interface OwnerAuthContext {
  userId: string;
  jwt: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: OwnerAuthContext;
    }
  }
}

function extractBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/**
 * Verifies the caller's Supabase JWT via `/auth/v1/user` and enforces the
 * optional `RELAY_OWNER_ID` allowlist before attaching `req.auth`.
 */
export async function requireOwnerAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const jwt = extractBearerToken(req.headers.authorization);
  if (!jwt) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const response = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
      method: "GET",
      headers: {
        apikey: env.supabasePublishableKey,
        Authorization: `Bearer ${jwt}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const user = (await response.json()) as { id?: unknown } | null;
    if (!user || typeof user.id !== "string" || !user.id.trim()) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    if (
      env.relayOwnerId &&
      user.id.toLowerCase() !== env.relayOwnerId.toLowerCase()
    ) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    req.auth = { userId: user.id, jwt };
    next();
  } catch {
    res.status(502).json({ error: "auth_upstream_error" });
  }
}

/** Returns the verified owner context attached by `requireOwnerAuth`. */
export function getOwnerAuth(req: Request): OwnerAuthContext {
  if (!req.auth) {
    throw new Error("Missing authenticated owner context on request");
  }
  return req.auth;
}
