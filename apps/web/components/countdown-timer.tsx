"use client";

import { useState, useEffect } from "react";

interface CountdownTimerProps {
  targetTime: string;
}

/**
 * Client component that displays a live countdown to a target time.
 * Updates every minute to stay fresh without excessive re-renders.
 */
export function CountdownTimer({ targetTime }: CountdownTimerProps) {
  const [minutesRemaining, setMinutesRemaining] = useState<number>(() => {
    const target = new Date(targetTime).getTime();
    const now = Date.now();
    return Math.max(0, Math.floor((target - now) / 60000));
  });

  useEffect(() => {
    // Update immediately in case initial render was stale
    const updateCountdown = () => {
      const target = new Date(targetTime).getTime();
      const now = Date.now();
      const minutes = Math.max(0, Math.floor((target - now) / 60000));
      setMinutesRemaining(minutes);
    };

    updateCountdown();

    // Update every minute
    const interval = setInterval(updateCountdown, 60000);

    return () => clearInterval(interval);
  }, [targetTime]);

  return (
    <div className="text-right">
      <p className="text-xs font-medium text-[#1E1E1E]/50 mb-1">Starts in</p>
      <p className="text-4xl font-bold text-[#2C76FF]">
        {minutesRemaining} min
      </p>
    </div>
  );
}
