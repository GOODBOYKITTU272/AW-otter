"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { urlLooksLikeAuthCallback } from "./auth/set-password/auth-callback";

/**
 * Client-side component that detects auth callback URLs on the root page
 * and redirects to the dedicated /auth/callback handler.
 * 
 * Handles backward compatibility for magic links that redirect to / instead
 * of /auth/callback (e.g., existing emails in flight, old Supabase config).
 */
export function AuthRedirectHandler() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window === "undefined") return;

    const currentUrl = window.location.href;
    
    if (urlLooksLikeAuthCallback(currentUrl)) {
      const url = new URL(currentUrl);
      const callbackUrl = new URL("/auth/callback", url.origin);
      
      callbackUrl.search = url.search;
      callbackUrl.hash = url.hash;
      
      router.replace(callbackUrl.toString());
    }
  }, [router]);

  return null;
}
