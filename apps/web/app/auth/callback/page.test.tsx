import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import AuthCallbackPage from "./page";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

vi.mock("@/lib/supabase/browser", () => ({
  getSupabaseBrowserClient: vi.fn(),
}));

vi.mock("../set-password/auth-callback", () => ({
  urlLooksLikeAuthCallback: vi.fn(),
  isGenuineAuthCallbackEvent: vi.fn(),
}));

describe("AuthCallbackPage", () => {
  const mockReplace = vi.fn();
  const mockGet = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useRouter as ReturnType<typeof vi.fn>).mockReturnValue({
      replace: mockReplace,
    });
    (useSearchParams as ReturnType<typeof vi.fn>).mockReturnValue({
      get: mockGet,
    });
  });

  it("renders loading state by default", () => {
    mockGet.mockReturnValue(null);
    render(<AuthCallbackPage />);
    expect(screen.getByText("Completing sign in...")).toBeInTheDocument();
  });

  it("shows error message when error query param is present", async () => {
    mockGet.mockImplementation((key: string) => {
      if (key === "error") return "test-error";
      if (key === "error_description") return "Test error description";
      return null;
    });

    render(<AuthCallbackPage />);

    await waitFor(() => {
      expect(screen.getByText("Authentication Failed")).toBeInTheDocument();
      expect(screen.getByText("Test error description")).toBeInTheDocument();
    });
  });

  it("redirects to login after 3 seconds on error", async () => {
    vi.useFakeTimers();
    mockGet.mockImplementation((key: string) => {
      if (key === "error") return "test-error";
      if (key === "error_description") return "Auth failed";
      return null;
    });

    render(<AuthCallbackPage />);

    await waitFor(() => {
      expect(screen.getByText("Authentication Failed")).toBeInTheDocument();
    });

    vi.advanceTimersByTime(3000);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/login");
    });

    vi.useRealTimers();
  });
});
